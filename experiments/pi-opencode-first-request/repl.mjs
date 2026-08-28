import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { MODEL_ID } from "./config.mjs";
import { promptForDivergence } from "./divergence-ui.mjs";
import { formatModelResponse } from "./response-display.mjs";

const experimentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(experimentDirectory, "../..");
const runner = path.join(experimentDirectory, "run.mjs");
const openCodeLabel = "OpenCode";
const piLabel = "Pi + OpenCode extension";
const sessionId = `repl-${Date.now()}`;
let turn = 0;
const ansiPattern = /\u001b\[[0-9;]*m/g;
const colorEnabled = stdout.isTTY && !process.env.NO_COLOR;

function color(code, value) {
  return colorEnabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function padStyled(value, width) {
  const visibleLength = value.replace(ansiPattern, "").length;
  return `${value}${" ".repeat(Math.max(0, width - visibleLength))}`;
}

function styleOutputLine(value) {
  return value
    .replace(/^\[commentary\]/, color("34;1", "[commentary]"))
    .replace(/^\[tool\]/, color("33;1", "[tool]"))
    .replace(/^\[final\]/, color("32;1", "[final]"));
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const interactive = typeof options.onDivergence === "function";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: interactive ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    });
    let capturedStdout = "";
    let capturedStderr = "";
    let interactionError;
    child.stdout.on("data", (chunk) => (capturedStdout += chunk));
    child.stderr.on("data", (chunk) => (capturedStderr += chunk));
    if (interactive) {
      child.on("message", (message) => {
        if (!message || message.type !== "divergence" || typeof message.id !== "string") return;
        Promise.resolve(options.onDivergence(message.divergence))
          .then((useOpenCode) => {
            if (child.connected) {
              child.send({
                type: "divergence-decision",
                id: message.id,
                useOpenCode: Boolean(useOpenCode),
              });
            }
          })
          .catch((error) => {
            interactionError = error;
            if (child.connected) {
              child.send({ type: "divergence-decision", id: message.id, useOpenCode: false });
            }
          });
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (interactionError) {
        reject(interactionError);
        return;
      }
      if (code === 0) {
        resolve({ stdout: capturedStdout, stderr: capturedStderr });
        return;
      }
      reject(
        new Error(
          [
            `Comparison exited with ${code ?? `signal ${signal}`}`,
            capturedStderr.trim(),
            capturedStdout.trim(),
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      );
    });
  });
}

function wrapLine(line, width) {
  if (line.length === 0) return [""];
  const chunks = [];
  let remaining = line;
  while (remaining.length > width) {
    let split = remaining.lastIndexOf(" ", width);
    if (split < Math.floor(width / 2)) split = width;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).replace(/^ /, "");
  }
  chunks.push(remaining);
  return chunks;
}

function wrapText(value, width) {
  return String(value)
    .replace(/\t/g, "  ")
    .split("\n")
    .flatMap((line) => wrapLine(line, width));
}

function printSideBySide(left, right) {
  const terminalWidth = Math.max(72, Math.min(stdout.columns ?? 120, 180));
  const columnWidth = Math.floor((terminalWidth - 3) / 2);
  const leftLines = wrapText(left || "(no text output)", columnWidth);
  const rightLines = wrapText(right || "(no text output)", columnWidth);
  const count = Math.max(leftLines.length, rightLines.length);
  const leftHeader = color("36;1", openCodeLabel);
  const rightHeader = color("35;1", piLabel);
  console.log(`${padStyled(leftHeader, columnWidth)} | ${rightHeader}`);
  console.log(color("2", `${"-".repeat(columnWidth)}-+-${"-".repeat(columnWidth)}`));
  for (let index = 0; index < count; index += 1) {
    const leftLine = (leftLines[index] ?? "").padEnd(columnWidth);
    const rightLine = rightLines[index] ?? "";
    console.log(`${styleOutputLine(leftLine)} | ${styleOutputLine(rightLine)}`);
  }
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function readModelResponses(artifactDirectory, harness, count) {
  return Promise.all(
    Array.from({ length: count }, (_, index) => {
      const ordinal = index + 1;
      const suffix = ordinal === 1 ? "" : `.${ordinal}`;
      return readFile(
        path.join(artifactDirectory, "captures", `${harness}${suffix}.response.raw`),
        "utf8",
      ).then(formatModelResponse);
    }),
  );
}

function printModelCalls(comparison, openCodeResponses, piResponses) {
  const count = Math.max(openCodeResponses.length, piResponses.length);
  for (let index = 0; index < count; index += 1) {
    const request = comparison.requests[index];
    const matched = request?.completeParsedRequest === true;
    const label = color("1;34", `[Model call ${index + 1}]`);
    const difference = matched ? "" : color("31;1", " requests differ");
    console.log(`\n${label}${difference}`);
    printSideBySide(openCodeResponses[index], piResponses[index]);
  }

  const matched = comparison.requests.filter((request) => request.completeParsedRequest).length;
  const noun = count === 1 ? "model call" : "model calls";
  if (matched === count && openCodeResponses.length === piResponses.length) {
    console.log(`\n${color("32;1", "✓")} All ${count} ${noun} matched`);
  } else {
    console.log(`\n${color("31;1", "✗")} ${matched}/${count} ${noun} matched`);
  }
}

async function comparePrompt(userPrompt, readline) {
  turn += 1;
  const runId = `${sessionId}-turn-${String(turn).padStart(3, "0")}`;
  const artifactDirectory = path.join(experimentDirectory, "artifacts", "runs", runId);
  process.stdout.write(`\nRunning ${openCodeLabel} and ${piLabel}...\n`);
  await runProcess(process.execPath, [runner], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HARNESS_PROMPT: userPrompt,
      HARNESS_PROVIDER_MODE: "replay",
      HARNESS_RUN_ID: runId,
      HARNESS_QUIET: "1",
      HARNESS_ALLOW_DIFFERENCES: "1",
      HARNESS_INTERACTIVE_DIVERGENCE: "1",
    },
    onDivergence: (divergence) => promptForDivergence(readline, divergence),
  });

  const comparison = await readJson(path.join(artifactDirectory, "comparison.json"));
  const openCodeResponses = await readModelResponses(
    artifactDirectory,
    "opencode",
    comparison.requestCount.openCode,
  );
  const piResponses = await readModelResponses(
    artifactDirectory,
    "pi",
    comparison.requestCount.pi,
  );
  printModelCalls(comparison, openCodeResponses, piResponses);
}

function assertConfiguration() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 10)) {
    throw new Error(`Node 22.10 or newer is required. Current version: ${process.versions.node}`);
  }
}

async function ensureApiKey() {
  if (process.env.OPENAI_API_KEY?.trim()) return;
  if (!stdin.isTTY) throw new Error("Set OPENAI_API_KEY before starting the REPL.");

  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const secretInput = createInterface({ input: stdin, output: mutedOutput, terminal: true });
  stdout.write("OpenAI API key: ");
  try {
    const apiKey = (await secretInput.question("")).trim();
    if (!apiKey) throw new Error("An OpenAI API key is required.");
    process.env.OPENAI_API_KEY = apiKey;
  } finally {
    secretInput.close();
    stdout.write("\n");
  }
}

async function main() {
  assertConfiguration();
  await ensureApiKey();
  console.log(`\n${openCodeLabel} vs ${piLabel}`);
  console.log(`Model: ${MODEL_ID}`);
  console.log("Each input starts a fresh run. Type :quit to exit.\n");

  const readline = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const input = (await readline.question("you> ")).trim();
      if (!input) continue;
      if ([":quit", ":q", ":exit"].includes(input)) break;
      try {
        await comparePrompt(input, readline);
      } catch (error) {
        console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    readline.close();
  }
}

await main();
