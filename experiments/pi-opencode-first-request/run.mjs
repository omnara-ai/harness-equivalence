import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCaptureServer } from "./capture-server.mjs";

const experimentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(experimentDirectory, "../..");
const artifactsDirectory = path.join(experimentDirectory, "artifacts");
const capturesDirectory = path.join(artifactsDirectory, "captures");
const stateDirectory = path.join(experimentDirectory, ".state");
const fixtureDirectory = path.join(stateDirectory, "fixture");
const openCodeBinary = path.join(repositoryRoot, "node_modules", ".bin", "opencode");
const piCli = path.join(
  repositoryRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);
const extension = path.join(experimentDirectory, "pi-opencode-compat.ts");
const prompt = "Reply with exactly OK. Do not call a tool.";
const model = "gpt-4o-mini";

const versions = {
  openCode: {
    package: "opencode-ai@1.18.22",
    commit: "18b4cb6819d7de0b37927fef60d03927e678c9dd",
  },
  pi: {
    package: "@earendil-works/pi-coding-agent@0.84.3",
    commit: "dcd461925db2edf69a43c8135db1180d418afd54",
  },
};

const generationKeys = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "stop",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning_effort",
  "response_format",
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          [
            `${command} exited with ${code ?? `signal ${signal}`}`,
            stdout && `stdout:\n${stdout}`,
            stderr && `stderr:\n${stderr}`,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    });
  });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value) {
  return sha256(typeof value === "string" ? value : JSON.stringify(stable(value))).slice(0, 12);
}

function generationParameters(body) {
  return Object.fromEntries(generationKeys.filter((key) => key in body).map((key) => [key, body[key]]));
}

function modelVisible(body) {
  return stable({
    model: body.model,
    messages: body.messages,
    tools: body.tools ?? [],
    generation: generationParameters(body),
  });
}

function firstSystemPrompt(body) {
  const systems = body.messages.filter((message) => message.role === "system");
  if (systems.length !== 1 || typeof systems[0].content !== "string") {
    throw new Error(`Expected one string system message from OpenCode, received ${systems.length}`);
  }
  return systems[0].content;
}

function firstDifference(left, right, pointer = "$") {
  if (isDeepStrictEqual(left, right)) return undefined;
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const difference = firstDifference(left[index], right[index], `${pointer}[${index}]`);
      if (difference) return difference;
    }
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const difference = firstDifference(left[key], right[key], `${pointer}.${key}`);
      if (difference) return difference;
    }
  }
  return { pointer, openCode: left, pi: right };
}

function extractOpenCodeOutput(stdout) {
  const pieces = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "text" && typeof event.part?.text === "string") pieces.push(event.part.text);
  }
  return pieces.join("");
}

function extractPiOutput(stdout) {
  return stdout.replace(/\u001b\[[0-9;]*m/g, "").trim();
}

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node 22.19 or newer is required. Current version: ${process.versions.node}`);
  }
}

async function writeOpenCodeConfig(baseUrl) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `capture/${model}`,
    enabled_providers: ["capture"],
    share: "disabled",
    provider: {
      capture: {
        name: "Local request capture",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          [model]: {
            name: "Harness equivalence fixture",
            release_date: "2024-07-18",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            cost: { input: 0, output: 0 },
            limit: { context: 128000, output: 16384 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
        options: {
          apiKey: "capture-key",
          baseURL: `${baseUrl}/v1/opencode`,
        },
      },
    },
  };
  const filename = path.join(stateDirectory, "opencode.json");
  await writeFile(filename, `${JSON.stringify(config, null, 2)}\n`);
  return filename;
}

async function captureOpenCode(baseUrl) {
  const config = await writeOpenCodeConfig(baseUrl);
  const xdgDirectory = path.join(stateDirectory, "opencode-xdg");
  await mkdir(xdgDirectory, { recursive: true });
  const result = await run(
    openCodeBinary,
    [
      "run",
      ...prompt.split(" "),
      "--model",
      `capture/${model}`,
      "--title",
      "Harness equivalence fixture",
      "--format",
      "json",
    ],
    {
      cwd: fixtureDirectory,
      env: {
        ...process.env,
        OPENCODE_CONFIG: config,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        OPENCODE_CLIENT: "cli",
        XDG_CACHE_HOME: path.join(xdgDirectory, "cache"),
        XDG_CONFIG_HOME: path.join(xdgDirectory, "config"),
        XDG_DATA_HOME: path.join(xdgDirectory, "data"),
        XDG_STATE_HOME: path.join(xdgDirectory, "state"),
      },
    },
  );
  await writeFile(path.join(artifactsDirectory, "opencode.stdout.jsonl"), result.stdout);
  await writeFile(path.join(artifactsDirectory, "opencode.stderr.txt"), result.stderr);
  return result;
}

async function writePiConfig(baseUrl, openCodeBody) {
  const tools = openCodeBody.tools ?? [];
  const emitsStrict = tools.some((tool) => "strict" in (tool.function ?? {}));
  const generation = generationParameters(openCodeBody);
  const maxTokens = generation.max_tokens ?? generation.max_completion_tokens ?? 16384;
  const config = {
    providers: {
      capture: {
        baseUrl: `${baseUrl}/v1/pi`,
        api: "openai-completions",
        apiKey: "capture-key",
        authHeader: true,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStrictMode: emitsStrict,
          maxTokensField: "max_tokens",
        },
        models: [
          {
            id: openCodeBody.model,
            name: "OpenCode equivalence capture fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens,
            samplingParams: generation,
          },
        ],
      },
    },
  };
  const piAgentDirectory = path.join(stateDirectory, "pi-agent");
  await mkdir(piAgentDirectory, { recursive: true });
  await writeFile(path.join(piAgentDirectory, "models.json"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(
    path.join(piAgentDirectory, "settings.json"),
    `${JSON.stringify({ defaultProjectTrust: "never", defaultTools: [] }, null, 2)}\n`,
  );
  return piAgentDirectory;
}

async function capturePi(baseUrl, contractPath, openCodeBody) {
  const piAgentDirectory = await writePiConfig(baseUrl, openCodeBody);
  const result = await run(
    process.execPath,
    [
      piCli,
      "--print",
      "--provider",
      "capture",
      "--model",
      openCodeBody.model,
      "--thinking",
      "off",
      "--no-session",
      "--no-builtin-tools",
      "--no-extensions",
      "--extension",
      extension,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      prompt,
    ],
    {
      cwd: fixtureDirectory,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: piAgentDirectory,
        OPENCODE_CONTRACT_PATH: contractPath,
      },
    },
  );
  await writeFile(path.join(artifactsDirectory, "pi.stdout.txt"), result.stdout);
  await writeFile(path.join(artifactsDirectory, "pi.stderr.txt"), result.stderr);
  return result;
}

async function readCapture(harness) {
  return JSON.parse(await readFile(path.join(capturesDirectory, `${harness}.capture.json`), "utf8"));
}

async function writeContract(openCodeBody) {
  const contract = {
    source: {
      captured: {
        repository: "https://github.com/sst/opencode",
        ...versions.openCode,
      },
      reproducedBy: {
        repository: "https://github.com/earendil-works/pi",
        ...versions.pi,
      },
    },
    model: openCodeBody.model,
    systemPrompt: firstSystemPrompt(openCodeBody),
    tools: openCodeBody.tools ?? [],
    generation: generationParameters(openCodeBody),
  };
  const filename = path.join(artifactsDirectory, "opencode-contract.json");
  await writeFile(filename, `${JSON.stringify(contract, null, 2)}\n`);
  return filename;
}

function comparisonRows(openCodeBody, piBody, openCodeOutput, piOutput) {
  const openCodeVisible = modelVisible(openCodeBody);
  const piVisible = modelVisible(piBody);
  const canonicalOpenCodeBody = JSON.stringify(stable(openCodeBody));
  const canonicalPiBody = JSON.stringify(stable(piBody));
  return [
    {
      field: "Model",
      openCode: String(openCodeBody.model),
      pi: String(piBody.model),
      equal: openCodeBody.model === piBody.model,
    },
    {
      field: "Messages",
      openCode: `${openCodeBody.messages.length} · ${shortHash(openCodeBody.messages)}`,
      pi: `${piBody.messages.length} · ${shortHash(piBody.messages)}`,
      equal: isDeepStrictEqual(openCodeVisible.messages, piVisible.messages),
    },
    {
      field: "Tools",
      openCode: `${(openCodeBody.tools ?? []).length} · ${shortHash(openCodeBody.tools ?? [])}`,
      pi: `${(piBody.tools ?? []).length} · ${shortHash(piBody.tools ?? [])}`,
      equal: isDeepStrictEqual(openCodeVisible.tools, piVisible.tools),
    },
    {
      field: "Generation controls",
      openCode: shortHash(generationParameters(openCodeBody)),
      pi: shortHash(generationParameters(piBody)),
      equal: isDeepStrictEqual(openCodeVisible.generation, piVisible.generation),
    },
    {
      field: "Parsed request body",
      openCode: sha256(canonicalOpenCodeBody).slice(0, 12),
      pi: sha256(canonicalPiBody).slice(0, 12),
      equal: canonicalOpenCodeBody === canonicalPiBody,
    },
    {
      field: "Observed output",
      openCode: JSON.stringify(openCodeOutput),
      pi: JSON.stringify(piOutput),
      equal: openCodeOutput === piOutput,
    },
  ];
}

function printTable(rows) {
  const headers = ["Field", "OpenCode", "Pi", "Equal"];
  const values = rows.map((row) => [row.field, row.openCode, row.pi, row.equal ? "yes" : "NO"]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => String(row[index]).length)),
  );
  const line = (row) => row.map((value, index) => String(value).padEnd(widths[index])).join("  ");
  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of values) console.log(line(row));
}

async function compare(openCodeResult, piResult) {
  const openCodeCapture = await readCapture("opencode");
  const piCapture = await readCapture("pi");
  const openCodeBody = openCodeCapture.body;
  const piBody = piCapture.body;
  const openCodeVisible = modelVisible(openCodeBody);
  const piVisible = modelVisible(piBody);
  const canonicalOpenCodeBody = stable(openCodeBody);
  const canonicalPiBody = stable(piBody);
  const openCodeOutput = extractOpenCodeOutput(openCodeResult.stdout);
  const piOutput = extractPiOutput(piResult.stdout);
  const rows = comparisonRows(openCodeBody, piBody, openCodeOutput, piOutput);
  const exactModelVisibleRequest = isDeepStrictEqual(openCodeVisible, piVisible);
  const completeParsedRequest = isDeepStrictEqual(canonicalOpenCodeBody, canonicalPiBody);
  const rawBytesEqual = openCodeCapture.rawBody === piCapture.rawBody;
  const compactJson =
    openCodeCapture.rawBody === JSON.stringify(openCodeBody) && piCapture.rawBody === JSON.stringify(piBody);
  const rawDifferenceOnlyKeyOrder = !rawBytesEqual && compactJson && completeParsedRequest;
  const difference = firstDifference(openCodeVisible, piVisible);
  const outputEqual = openCodeOutput === piOutput;

  const result = {
    versions,
    prompt,
    deterministicProviderResponse: "OK",
    exactModelVisibleRequest,
    completeParsedRequest,
    rawBytesEqual,
    rawDifferenceOnlyKeyOrder,
    outputEqual,
    openCodeRawBodySha256: sha256(openCodeCapture.rawBody),
    piRawBodySha256: sha256(piCapture.rawBody),
    openCodeCanonicalBodySha256: sha256(JSON.stringify(canonicalOpenCodeBody)),
    piCanonicalBodySha256: sha256(JSON.stringify(canonicalPiBody)),
    firstDifference: difference,
  };

  await writeFile(path.join(artifactsDirectory, "opencode.request.json"), `${JSON.stringify(openCodeBody, null, 2)}\n`);
  await writeFile(path.join(artifactsDirectory, "pi.request.json"), `${JSON.stringify(piBody, null, 2)}\n`);
  await writeFile(
    path.join(artifactsDirectory, "opencode.request.canonical.json"),
    `${JSON.stringify(canonicalOpenCodeBody, null, 2)}\n`,
  );
  await writeFile(
    path.join(artifactsDirectory, "pi.request.canonical.json"),
    `${JSON.stringify(canonicalPiBody, null, 2)}\n`,
  );
  await writeFile(path.join(artifactsDirectory, "comparison.json"), `${JSON.stringify(result, null, 2)}\n`);

  const markdownRows = rows
    .map((row) => `| ${row.field} | \`${row.openCode}\` | \`${row.pi}\` | ${row.equal ? "yes" : "no"} |`)
    .join("\n");
  const report = `# Pi and OpenCode first-request comparison

User input: \`${prompt}\`

Provider response: deterministic local fixture returning \`OK\`

| Field | OpenCode | Pi | Equal |
|---|---|---|---:|
${markdownRows}

| Exact comparison | Equal |
|---|---:|
| Complete model-visible request | ${exactModelVisibleRequest ? "yes" : "no"} |
| Complete parsed provider JSON body | ${completeParsedRequest ? "yes" : "no"} |
| Raw HTTP request-body bytes | ${rawBytesEqual ? "yes" : "no"} |
| Raw-byte difference is only JSON object-key order | ${rawDifferenceOnlyKeyOrder ? "yes" : "no"} |

${difference ? `First model-visible difference: \`${difference.pointer}\`\n\n\`\`\`json\n${JSON.stringify(difference, null, 2)}\n\`\`\`\n` : "No model-visible differences found.\n"}
The complete parsed requests are available in [opencode.request.json](opencode.request.json) and [pi.request.json](pi.request.json). Their canonical forms can be compared directly:

\`\`\`sh
diff -u opencode.request.canonical.json pi.request.canonical.json
\`\`\`

The fixed response removes model stochasticity. Equal observed outputs show that both harnesses accepted and rendered the same provider response. They do not test real-model output quality.
`;
  await writeFile(path.join(artifactsDirectory, "REPORT.md"), report);

  console.log("\nPi as OpenCode, first provider request\n");
  console.log(`User input: ${JSON.stringify(prompt)}`);
  console.log('Provider:   local deterministic fixture returning "OK"\n');
  printTable(rows);
  console.log(`\nRaw HTTP bodies equal: ${rawBytesEqual ? "yes" : "no, JSON object-key order differs"}`);
  console.log(`Artifacts: ${path.relative(repositoryRoot, artifactsDirectory)}/`);
  console.log(
    `\nResult: ${exactModelVisibleRequest && completeParsedRequest && outputEqual ? "equivalent first request" : "not equivalent"}`,
  );

  if (!exactModelVisibleRequest || !completeParsedRequest || !outputEqual) process.exitCode = 1;
}

async function main() {
  assertSupportedNode();
  await rm(stateDirectory, { recursive: true, force: true });
  await rm(artifactsDirectory, { recursive: true, force: true });
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(artifactsDirectory, { recursive: true });
  await mkdir(fixtureDirectory, { recursive: true });
  await run("git", ["init", "--quiet"], { cwd: fixtureDirectory, env: process.env });

  const server = await startCaptureServer(capturesDirectory);
  let openCodeResult;
  let piResult;
  try {
    openCodeResult = await captureOpenCode(server.baseUrl);
    const openCodeCapture = await readCapture("opencode");
    const contractPath = await writeContract(openCodeCapture.body);
    piResult = await capturePi(server.baseUrl, contractPath, openCodeCapture.body);
  } finally {
    await server.close();
  }
  await compare(openCodeResult, piResult);
}

await main();
