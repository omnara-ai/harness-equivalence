import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const experimentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(experimentDirectory, "../..");
const runner = path.join(experimentDirectory, "run.mjs");
const arguments_ = process.argv.slice(2);
const fixture = arguments_.includes("--fixture");
const independent = arguments_.includes("--independent");
const initialPrompt = arguments_.filter((argument) => !["--fixture", "--independent"].includes(argument)).join(" ");
const providerMode = fixture ? "fixture" : independent ? "independent" : "replay";
const model = process.env.HARNESS_MODEL ?? "gpt-4o-mini";
const temperature = process.env.HARNESS_TEMPERATURE ?? "0";
const apiBaseUrl = process.env.HARNESS_API_BASE_URL ?? "https://api.openai.com/v1";
const apiKey = process.env.HARNESS_API_KEY ?? process.env.OPENAI_API_KEY;
const sessionId = `repl-${Date.now()}`;
let turn = 0;
let lastRun;

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let capturedStdout = "";
    let capturedStderr = "";
    child.stdout.on("data", (chunk) => (capturedStdout += chunk));
    child.stderr.on("data", (chunk) => (capturedStderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
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
  console.log(`\n${"OpenCode".padEnd(columnWidth)} | Pi`);
  console.log(`${"-".repeat(columnWidth)}-+-${"-".repeat(columnWidth)}`);
  for (let index = 0; index < count; index += 1) {
    console.log(`${(leftLines[index] ?? "").padEnd(columnWidth)} | ${rightLines[index] ?? ""}`);
  }
}

function systemMessages(request) {
  return request.messages.filter((message) => message.role === "system");
}

function exactContent(content) {
  return typeof content === "string" ? content : JSON.stringify(content, null, 2);
}

function printExactSystemPrompts(run) {
  const pairs = [["OpenCode", run.openCodeRequests], ["Pi", run.piRequests]];
  for (const [harness, requests] of pairs) {
    for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
      const messages = systemMessages(requests[requestIndex]);
      console.log(
        `\n===== ${harness} request ${requestIndex + 1} system message${messages.length === 1 ? "" : "s"} =====`,
      );
      messages.forEach((message, messageIndex) => {
        if (messages.length > 1) console.log(`\n--- system message ${messageIndex + 1} ---`);
        process.stdout.write(exactContent(message.content));
        if (!exactContent(message.content).endsWith("\n")) process.stdout.write("\n");
      });
      console.log(`===== end ${harness} request ${requestIndex + 1} system =====`);
    }
  }
}

function printExactRequests(run) {
  for (const [harness, requests] of [["OpenCode", run.openCodeRequests], ["Pi", run.piRequests]]) {
    requests.forEach((request, index) => {
      console.log(`\n===== ${harness} parsed provider request ${index + 1} =====`);
      console.log(JSON.stringify(request, null, 2));
      console.log(`===== end ${harness} request ${index + 1} =====`);
    });
  }
}

function printHelp() {
  console.log(`
Commands
  :system    Print both exact system messages sent to the model
  :requests  Print both complete parsed provider requests
  :artifacts Show the files generated for the last comparison
  :help      Show these commands
  :quit      Exit
`);
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function readRequests(artifactDirectory, harness, count) {
  return Promise.all(
    Array.from({ length: count }, (_, index) => {
      const ordinal = index + 1;
      const suffix = ordinal === 1 ? "" : `.${ordinal}`;
      return readJson(path.join(artifactDirectory, `${harness}${suffix}.request.json`));
    }),
  );
}

async function comparePrompt(userPrompt) {
  turn += 1;
  const runId = `${sessionId}-turn-${String(turn).padStart(3, "0")}`;
  const artifactDirectory = path.join(experimentDirectory, "artifacts", "runs", runId);
  process.stdout.write("\nRunning OpenCode and Pi...\n");
  await runProcess(process.execPath, [runner], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HARNESS_PROMPT: userPrompt,
      HARNESS_MODEL: model,
      HARNESS_TEMPERATURE: temperature,
      HARNESS_PROVIDER_MODE: providerMode,
      HARNESS_API_BASE_URL: apiBaseUrl,
      ...(apiKey ? { HARNESS_API_KEY: apiKey } : {}),
      HARNESS_RUN_ID: runId,
      HARNESS_QUIET: "1",
      HARNESS_ALLOW_DIFFERENCES: "1",
    },
  });

  const comparison = await readJson(path.join(artifactDirectory, "comparison.json"));
  const openCodeRequests = await readRequests(
    artifactDirectory,
    "opencode",
    comparison.requestCount.openCode,
  );
  const piRequests = await readRequests(artifactDirectory, "pi", comparison.requestCount.pi);
  const run = { artifactDirectory, comparison, openCodeRequests, piRequests };
  lastRun = run;

  console.log(
    `Requests equal: ${comparison.completeParsedRequest ? "yes" : "NO"}  |  ` +
      `System prompts equal: ${comparison.systemPromptsEqual ? "yes" : "NO"}  |  ` +
      `Temperature: ${comparison.temperature}`,
  );
  console.log(
    `Provider calls: OpenCode ${comparison.requestCount.openCode}  |  Pi ${comparison.requestCount.pi}`,
  );
  console.log(
    `System prompt SHA-256: OpenCode ${comparison.openCodeSystemPromptSha256.slice(0, 12)}  |  ` +
      `Pi ${comparison.piSystemPromptSha256.slice(0, 12)}`,
  );
  printSideBySide(comparison.openCodeOutput, comparison.piOutput);
  console.log(`\nExact requests: ${path.relative(repositoryRoot, artifactDirectory)}/`);
  console.log("Type :system to print both exact system prompts.");
  return run;
}

function assertConfiguration() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node 22.19 or newer is required. Current version: ${process.versions.node}`);
  }
  if (!fixture && !apiKey && /^https:\/\/api\.openai\.com(?:\/|$)/.test(apiBaseUrl)) {
    throw new Error(
      "Set OPENAI_API_KEY or HARNESS_API_KEY. For another OpenAI-compatible provider, also set HARNESS_API_BASE_URL.",
    );
  }
}

async function handleCommand(input) {
  if (input === ":quit" || input === ":q" || input === ":exit") return "quit";
  if (input === ":help") {
    printHelp();
    return "handled";
  }
  if (input === ":system") {
    if (!lastRun) console.log("Run a prompt first.");
    else printExactSystemPrompts(lastRun);
    return "handled";
  }
  if (input === ":requests") {
    if (!lastRun) console.log("Run a prompt first.");
    else printExactRequests(lastRun);
    return "handled";
  }
  if (input === ":artifacts") {
    if (!lastRun) console.log("Run a prompt first.");
    else console.log(lastRun.artifactDirectory);
    return "handled";
  }
  if (input.startsWith(":")) {
    console.log(`Unknown command: ${input}. Type :help for available commands.`);
    return "handled";
  }
  return "prompt";
}

async function main() {
  assertConfiguration();
  console.log("\nHarness equivalence REPL");
  console.log(`Model: ${model}`);
  console.log(
    `Provider mode: ${providerMode}${providerMode === "replay" ? " (one model response replayed exactly to both harnesses)" : ""}`,
  );
  console.log(`Temperature: ${temperature}`);
  console.log("Each input starts a fresh comparison session. Type :help for inspection commands.\n");

  if (initialPrompt) {
    await comparePrompt(initialPrompt);
    return;
  }

  const readline = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const input = (await readline.question("you> ")).trim();
      if (!input) continue;
      const action = await handleCommand(input);
      if (action === "quit") break;
      if (action === "prompt") {
        try {
          await comparePrompt(input);
        } catch (error) {
          console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
  } finally {
    readline.close();
  }
}

await main();
