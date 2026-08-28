import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCaptureServer } from "./capture-server.mjs";
import { MODEL_ID, OPENAI_API_BASE_URL } from "./config.mjs";

const experimentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(experimentDirectory, "../..");
const runId = process.env.HARNESS_RUN_ID;
if (runId && !/^[a-zA-Z0-9_-]+$/.test(runId)) {
  throw new Error("HARNESS_RUN_ID may contain only letters, numbers, underscores, and hyphens");
}
const artifactsDirectory = runId
  ? path.join(experimentDirectory, "artifacts", "runs", runId)
  : path.join(experimentDirectory, "artifacts", "verify");
const capturesDirectory = path.join(artifactsDirectory, "captures");
const stateDirectory = runId
  ? path.join(experimentDirectory, ".state", "runs", runId)
  : path.join(experimentDirectory, ".state", "verify");
const fixtureDirectory = path.join(stateDirectory, "fixture");
const fixtureSnapshotDirectory = path.join(stateDirectory, "fixture-snapshot");
const openCodeXdgDirectory = path.join(stateDirectory, "opencode-xdg");
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
const prompt = process.env.HARNESS_PROMPT ?? "Reply with exactly OK. Do not call a tool.";
const model = MODEL_ID;
const providerMode = process.env.HARNESS_PROVIDER_MODE ?? "fixture";
const shell =
  process.env.HARNESS_SHELL ??
  process.env.SHELL ??
  (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
const quiet = process.env.HARNESS_QUIET === "1";
const allowDifferences = process.env.HARNESS_ALLOW_DIFFERENCES === "1";
const interactiveDivergence = process.env.HARNESS_INTERACTIVE_DIVERGENCE === "1";
let divergenceMessageOrdinal = 0;

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

const requestOptionKeys = [
  "temperature",
  "top_p",
  "max_output_tokens",
  "text",
  "store",
  "include",
  "prompt_cache_key",
  "prompt_cache_retention",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "service_tier",
  "truncation",
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    if (options.input !== undefined) child.stdin.end(options.input);
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

function harnessEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  delete environment.OPENAI_API_KEY;
  return environment;
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

function requestOptions(body) {
  return Object.fromEntries(
    requestOptionKeys.filter((key) => key in body).map((key) => [key, body[key]]),
  );
}

function modelVisible(body) {
  return stable({
    model: body.model,
    input: body.input,
    tools: body.tools ?? [],
    requestOptions: requestOptions(body),
  });
}

function firstSystemPrompt(body) {
  const systems = body.input.filter(
    (message) => (message.role === "system" || message.role === "developer") && typeof message.content === "string",
  );
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
  if (!["fixture", "replay"].includes(providerMode)) {
    throw new Error(`HARNESS_PROVIDER_MODE must be fixture or replay. Received: ${providerMode}`);
  }
  if (interactiveDivergence && typeof process.send !== "function") {
    throw new Error("Interactive divergence handling requires an IPC parent process");
  }
}

function requestDivergenceDecision(divergence) {
  const id = `divergence-${++divergenceMessageOrdinal}`;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    const onMessage = (message) => {
      if (!message || message.type !== "divergence-decision" || message.id !== id) return;
      cleanup();
      resolve(Boolean(message.useOpenCode));
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("The REPL disconnected while waiting for a divergence decision"));
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    process.send({ type: "divergence", id, divergence }, (error) => {
      if (!error) return;
      cleanup();
      reject(error);
    });
  });
}

async function writeOpenCodeConfig(baseUrl) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `openai/${model}`,
    shell,
    enabled_providers: ["openai"],
    share: "disabled",
    skills: {
      paths: [path.join(fixtureDirectory, "skills")],
    },
    provider: {
      openai: {
        name: "Local request capture",
        npm: "@ai-sdk/openai",
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
  await mkdir(openCodeXdgDirectory, { recursive: true });
  const result = await run(
    openCodeBinary,
    [
      "run",
      "--model",
      `openai/${model}`,
      "--title",
      "Harness equivalence fixture",
      "--format",
      "json",
    ],
    {
      cwd: fixtureDirectory,
      input: prompt,
      env: harnessEnvironment({
        PWD: fixtureDirectory,
        OPENCODE_CONFIG: config,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        OPENCODE_CLIENT: "cli",
        XDG_CACHE_HOME: path.join(openCodeXdgDirectory, "cache"),
        XDG_CONFIG_HOME: path.join(openCodeXdgDirectory, "config"),
        XDG_DATA_HOME: path.join(openCodeXdgDirectory, "data"),
        XDG_STATE_HOME: path.join(openCodeXdgDirectory, "state"),
      }),
    },
  );
  await writeFile(path.join(artifactsDirectory, "opencode.stdout.jsonl"), result.stdout);
  await writeFile(path.join(artifactsDirectory, "opencode.stderr.txt"), result.stderr);
  return result;
}

async function writePiConfig(baseUrl, openCodeBody) {
  const tools = openCodeBody.tools ?? [];
  const emitsStrict = tools.some((tool) => "strict" in tool);
  const options = requestOptions(openCodeBody);
  const maxTokens = options.max_output_tokens ?? 16384;
  const config = {
    providers: {
      capture: {
        baseUrl: `${baseUrl}/v1/pi`,
        api: "openai-responses",
        apiKey: "capture-key",
        authHeader: true,
        compat: {
          supportsDeveloperRole: true,
          supportsStrictMode: emitsStrict,
        },
        models: [
          {
            id: openCodeBody.model,
            name: "OpenCode equivalence capture fixture",
            reasoning: true,
            input: ["text"],
            contextWindow: 1050000,
            maxTokens,
            samplingParams: options,
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
  const taskSessionDirectory = path.join(stateDirectory, "pi-task-sessions");
  await mkdir(taskSessionDirectory, { recursive: true });
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
      "medium",
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
      env: harnessEnvironment({
        PWD: fixtureDirectory,
        PI_CODING_AGENT_DIR: piAgentDirectory,
        OPENCODE_CONTRACT_PATH: contractPath,
        OPENCODE_COMPAT_PROVIDER: "capture",
        OPENCODE_COMPAT_MODEL: openCodeBody.model,
        OPENCODE_COMPAT_SHELL: shell,
        OPENCODE_PI_CLI: piCli,
        OPENCODE_PI_EXTENSION: extension,
        OPENCODE_SUBAGENT_TYPE: "",
        OPENCODE_TASK_DEPTH: "0",
        OPENCODE_RG_PATH: path.join(openCodeXdgDirectory, "cache", "opencode", "bin", "rg"),
        OPENCODE_SKILL_PATHS: path.join(fixtureDirectory, "skills"),
        OPENCODE_TRUNCATION_DIR: path.join(openCodeXdgDirectory, "data", "opencode", "tool-output"),
        OPENCODE_TASK_SESSION_DIR: taskSessionDirectory,
      }),
    },
  );
  await writeFile(path.join(artifactsDirectory, "pi.stdout.txt"), result.stdout);
  await writeFile(path.join(artifactsDirectory, "pi.stderr.txt"), result.stderr);
  return result;
}

async function readCaptures(harness) {
  const matcher = new RegExp(`^${harness}(?:\\.(\\d+))?\\.capture\\.json$`);
  const files = (await readdir(capturesDirectory))
    .map((filename) => ({ filename, match: filename.match(matcher) }))
    .filter((entry) => entry.match)
    .map((entry) => ({ filename: entry.filename, ordinal: entry.match[1] ? Number(entry.match[1]) : 1 }))
    .sort((left, right) => left.ordinal - right.ordinal);
  return Promise.all(
    files.map(async (entry) => ({
      ordinal: entry.ordinal,
      ...(JSON.parse(await readFile(path.join(capturesDirectory, entry.filename), "utf8"))),
    })),
  );
}

async function readCapture(harness, ordinal = 1) {
  const captures = await readCaptures(harness);
  const capture = captures.find((entry) => entry.ordinal === ordinal);
  if (!capture) throw new Error(`Missing ${harness} provider capture ${ordinal}`);
  return capture;
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
    requestOptions: requestOptions(openCodeBody),
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
      field: "Input",
      openCode: `${openCodeBody.input.length} · ${shortHash(openCodeBody.input)}`,
      pi: `${piBody.input.length} · ${shortHash(piBody.input)}`,
      equal: isDeepStrictEqual(openCodeVisible.input, piVisible.input),
    },
    {
      field: "Tools",
      openCode: `${(openCodeBody.tools ?? []).length} · ${shortHash(openCodeBody.tools ?? [])}`,
      pi: `${(piBody.tools ?? []).length} · ${shortHash(piBody.tools ?? [])}`,
      equal: isDeepStrictEqual(openCodeVisible.tools, piVisible.tools),
    },
    {
      field: "Request options",
      openCode: shortHash(requestOptions(openCodeBody)),
      pi: shortHash(requestOptions(piBody)),
      equal: isDeepStrictEqual(openCodeVisible.requestOptions, piVisible.requestOptions),
    },
    {
      field: "Parsed request body",
      openCode: sha256(canonicalOpenCodeBody).slice(0, 12),
      pi: sha256(canonicalPiBody).slice(0, 12),
      equal: canonicalOpenCodeBody === canonicalPiBody,
    },
    {
      field: "Observed output",
      openCode: outputSummary(openCodeOutput),
      pi: outputSummary(piOutput),
      equal: openCodeOutput === piOutput,
    },
  ];
}

function outputSummary(output) {
  const oneLine = output.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 36) return JSON.stringify(oneLine);
  return `${oneLine.length} chars · ${shortHash(output)}`;
}

function printTable(rows) {
  const headers = ["Field", "OpenCode", "Pi + extension", "Equal"];
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
  const openCodeCaptures = await readCaptures("opencode");
  const piCaptures = await readCaptures("pi");
  const openCodeByOrdinal = new Map(openCodeCaptures.map((capture) => [capture.ordinal, capture]));
  const piByOrdinal = new Map(piCaptures.map((capture) => [capture.ordinal, capture]));
  const ordinals = [...new Set([...openCodeByOrdinal.keys(), ...piByOrdinal.keys()])].sort((a, b) => a - b);
  const openCodeOutput = extractOpenCodeOutput(openCodeResult.stdout);
  const piOutput = extractPiOutput(piResult.stdout);
  const requests = ordinals.map((ordinal) => {
    const openCodeCapture = openCodeByOrdinal.get(ordinal);
    const piCapture = piByOrdinal.get(ordinal);
    if (!openCodeCapture || !piCapture) {
      return {
        ordinal,
        presentInOpenCode: Boolean(openCodeCapture),
        presentInPi: Boolean(piCapture),
        exactModelVisibleRequest: false,
        completeParsedRequest: false,
        rawBytesEqual: false,
        rawDifferenceOnlyKeyOrder: false,
        firstDifference: {
          pointer: `$requests[${ordinal}]`,
          openCode: openCodeCapture ? "present" : "missing",
          pi: piCapture ? "present" : "missing",
        },
      };
    }
    const openCodeBody = openCodeCapture.body;
    const piBody = piCapture.effectiveBody ?? piCapture.body;
    const openCodeVisible = modelVisible(openCodeBody);
    const piVisible = modelVisible(piBody);
    const canonicalOpenCodeBody = stable(openCodeBody);
    const canonicalPiBody = stable(piBody);
    const completeParsedRequest = isDeepStrictEqual(canonicalOpenCodeBody, canonicalPiBody);
    const rawBytesEqual = openCodeCapture.rawBody === piCapture.rawBody;
    const compactJson =
      openCodeCapture.rawBody === JSON.stringify(openCodeBody) && piCapture.rawBody === JSON.stringify(piBody);
    return {
      ordinal,
      presentInOpenCode: true,
      presentInPi: true,
      exactModelVisibleRequest: isDeepStrictEqual(openCodeVisible, piVisible),
      completeParsedRequest,
      rawBytesEqual,
      rawDifferenceOnlyKeyOrder: !rawBytesEqual && compactJson && completeParsedRequest,
      overrideApplied: Boolean(piCapture.overrideApplied),
      openCodeRawBodySha256: sha256(openCodeCapture.rawBody),
      piRawBodySha256: sha256(piCapture.rawBody),
      openCodeCanonicalBodySha256: sha256(JSON.stringify(canonicalOpenCodeBody)),
      piCanonicalBodySha256: sha256(JSON.stringify(canonicalPiBody)),
      firstDifference: firstDifference(openCodeVisible, piVisible),
    };
  });
  const firstOpenCodeCapture = openCodeByOrdinal.get(1);
  const firstPiCapture = piByOrdinal.get(1);
  if (!firstOpenCodeCapture || !firstPiCapture) throw new Error("Both harnesses must produce a first provider request");
  const openCodeBody = firstOpenCodeCapture.body;
  const piBody = firstPiCapture.effectiveBody ?? firstPiCapture.body;
  const canonicalOpenCodeBody = stable(openCodeBody);
  const canonicalPiBody = stable(piBody);
  const rows = comparisonRows(openCodeBody, piBody, openCodeOutput, piOutput);
  const exactModelVisibleRequest = requests.every((request) => request.exactModelVisibleRequest);
  const completeParsedRequest = requests.every((request) => request.completeParsedRequest);
  const rawBytesEqual = requests.every((request) => request.rawBytesEqual);
  const rawDifferenceOnlyKeyOrder = requests.every(
    (request) => request.rawBytesEqual || request.rawDifferenceOnlyKeyOrder,
  );
  const differingRequest = requests.find((request) => request.firstDifference);
  const difference = differingRequest?.firstDifference
    ? { ...differingRequest.firstDifference, request: differingRequest.ordinal }
    : undefined;
  const outputEqual = openCodeOutput === piOutput;

  const result = {
    versions,
    prompt,
    providerMode,
    deterministicProviderResponse: providerMode === "fixture" ? "OK" : undefined,
    requestCount: { openCode: openCodeCaptures.length, pi: piCaptures.length },
    overridesApplied: piCaptures.filter((capture) => capture.overrideApplied).length,
    requests,
    exactModelVisibleRequest,
    completeParsedRequest,
    rawBytesEqual,
    rawDifferenceOnlyKeyOrder,
    outputEqual,
    openCodeRawBodySha256: sha256(firstOpenCodeCapture.rawBody),
    piRawBodySha256: sha256(firstPiCapture.rawBody),
    openCodeCanonicalBodySha256: sha256(JSON.stringify(canonicalOpenCodeBody)),
    piCanonicalBodySha256: sha256(JSON.stringify(canonicalPiBody)),
    systemPromptsEqual: firstSystemPrompt(openCodeBody) === firstSystemPrompt(piBody),
    openCodeSystemPromptSha256: sha256(firstSystemPrompt(openCodeBody)),
    piSystemPromptSha256: sha256(firstSystemPrompt(piBody)),
    openCodeOutput,
    piOutput,
    firstDifference: difference,
  };

  for (const capture of openCodeCaptures) {
    const suffix = capture.ordinal === 1 ? "" : `.${capture.ordinal}`;
    await writeFile(
      path.join(artifactsDirectory, `opencode${suffix}.request.json`),
      `${JSON.stringify(capture.body, null, 2)}\n`,
    );
    await writeFile(
      path.join(artifactsDirectory, `opencode${suffix}.request.canonical.json`),
      `${JSON.stringify(stable(capture.body), null, 2)}\n`,
    );
  }
  for (const capture of piCaptures) {
    const suffix = capture.ordinal === 1 ? "" : `.${capture.ordinal}`;
    const requestBody = capture.effectiveBody ?? capture.body;
    await writeFile(
      path.join(artifactsDirectory, `pi${suffix}.request.json`),
      `${JSON.stringify(requestBody, null, 2)}\n`,
    );
    await writeFile(
      path.join(artifactsDirectory, `pi${suffix}.request.canonical.json`),
      `${JSON.stringify(stable(requestBody), null, 2)}\n`,
    );
    if (capture.effectiveBody) {
      await writeFile(
        path.join(artifactsDirectory, `pi${suffix}.request.original.json`),
        `${JSON.stringify(capture.body, null, 2)}\n`,
      );
    }
  }
  await writeFile(path.join(artifactsDirectory, "comparison.json"), `${JSON.stringify(result, null, 2)}\n`);

  const markdownRows = rows
    .map((row) => `| ${row.field} | \`${row.openCode}\` | \`${row.pi}\` | ${row.equal ? "yes" : "no"} |`)
    .join("\n");
  const requestRows = requests
    .map(
      (request) =>
        `| ${request.ordinal} | ${request.exactModelVisibleRequest ? "yes" : "no"} | ${request.completeParsedRequest ? "yes" : "no"} | ${request.rawBytesEqual ? "yes" : request.rawDifferenceOnlyKeyOrder ? "key order" : "no"} |`,
    )
    .join("\n");
  const report = `# OpenCode and Pi extension provider-request comparison

User input: \`${prompt}\`

Provider mode: \`${providerMode}\`${providerMode === "fixture" ? ", returning deterministic `OK`" : ""}

| Field | OpenCode | Pi + OpenCode extension | Equal |
|---|---|---|---:|
${markdownRows}

| Exact comparison | Equal |
|---|---:|
| Complete model-visible request | ${exactModelVisibleRequest ? "yes" : "no"} |
| Complete parsed provider JSON body | ${completeParsedRequest ? "yes" : "no"} |
| Raw HTTP request-body bytes | ${rawBytesEqual ? "yes" : "no"} |
| Raw-byte difference is only JSON object-key order | ${rawDifferenceOnlyKeyOrder ? "yes" : "no"} |

| Provider request | Model-visible equal | Parsed body equal | Raw bytes |
|---:|---:|---:|---:|
${requestRows}

${difference ? `First model-visible difference in request ${difference.request}: \`${difference.pointer}\`\n\n\`\`\`json\n${JSON.stringify(difference, null, 2)}\n\`\`\`\n` : "No model-visible differences found.\n"}
${result.overridesApplied > 0 ? `The model-facing Pi request includes the accepted OpenCode value. Pi's original request is preserved in the corresponding \`pi*.request.original.json\` artifact.\n` : ""}
The complete parsed requests are available as numbered OpenCode and Pi request artifacts. Their canonical forms can be compared directly:

\`\`\`sh
diff -u opencode.request.canonical.json pi.request.canonical.json
\`\`\`

${providerMode === "fixture" ? "The fixed response removes model stochasticity. Equal observed outputs show that both harnesses accepted and rendered the same provider response. They do not test real-model output quality." : "When Pi sends the same parsed request as OpenCode, the relay gives Pi the exact response bytes returned to OpenCode. A differing request makes its own upstream call."}
`;
  await writeFile(path.join(artifactsDirectory, "REPORT.md"), report);

  if (!quiet) {
    console.log("\nOpenCode vs Pi + OpenCode extension\n");
    console.log(`User input: ${JSON.stringify(prompt)}`);
    console.log(
      `Provider:   ${providerMode === "fixture" ? 'local deterministic fixture returning "OK"' : providerMode}\n`,
    );
    printTable(rows);
    console.log(`\nProvider requests: OpenCode ${openCodeCaptures.length}, Pi ${piCaptures.length}`);
    for (const request of requests) {
      console.log(
        `  ${request.ordinal}: model-visible ${request.exactModelVisibleRequest ? "equal" : "DIFFERENT"}, parsed ${request.completeParsedRequest ? "equal" : "DIFFERENT"}`,
      );
    }
    console.log(`\nRaw HTTP bodies equal: ${rawBytesEqual ? "yes" : "no, JSON object-key order differs"}`);
    console.log(`Artifacts: ${path.relative(repositoryRoot, artifactsDirectory)}/`);
    console.log(
      `\nResult: ${exactModelVisibleRequest && completeParsedRequest ? "equivalent provider requests" : "not equivalent"}`,
    );
  }

  const outputMustMatch = providerMode === "fixture" || (providerMode === "replay" && completeParsedRequest);
  if (
    !allowDifferences &&
    (!exactModelVisibleRequest || !completeParsedRequest || (outputMustMatch && !outputEqual))
  ) {
    process.exitCode = 1;
  }
}

async function prepareFixture() {
  await mkdir(fixtureDirectory, { recursive: true });
  const source = process.env.HARNESS_FIXTURE_SOURCE;
  if (source) {
    await cp(path.resolve(source), fixtureDirectory, { recursive: true, force: true });
  } else {
    await mkdir(path.join(fixtureDirectory, "src"), { recursive: true });
    await mkdir(path.join(fixtureDirectory, "skills", "demo"), { recursive: true });
    await writeFile(
      path.join(fixtureDirectory, "README.md"),
      "# Harness equivalence fixture\n\nOpenCode and Pi receive identical copies of this workspace.\n",
    );
    await writeFile(
      path.join(fixtureDirectory, "src", "example.ts"),
      'export function greeting(name: string) {\n  return `Hello, ${name}!`;\n}\n',
    );
    await writeFile(
      path.join(fixtureDirectory, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: A deterministic fixture skill\n---\n\n# Demo skill\n\nReturn deterministic fixture output.\n",
    );
    await writeFile(path.join(fixtureDirectory, "skills", "demo", "reference.txt"), "fixture reference\n");
  }
  await run("git", ["init", "--quiet"], { cwd: fixtureDirectory, env: process.env });
  await cp(fixtureDirectory, fixtureSnapshotDirectory, { recursive: true, force: true });
}

async function restoreFixture() {
  await rm(fixtureDirectory, { recursive: true, force: true });
  await cp(fixtureSnapshotDirectory, fixtureDirectory, { recursive: true, force: true });
}

async function main() {
  assertSupportedNode();
  await rm(stateDirectory, { recursive: true, force: true });
  await rm(artifactsDirectory, { recursive: true, force: true });
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(artifactsDirectory, { recursive: true });
  await prepareFixture();
  await restoreFixture();

  const server = await startCaptureServer(capturesDirectory, {
    mode: providerMode,
    onDivergence: interactiveDivergence ? requestDivergenceDecision : undefined,
    upstream:
      providerMode === "fixture"
        ? undefined
        : {
            baseUrl: process.env.HARNESS_TEST_API_BASE_URL ?? OPENAI_API_BASE_URL,
            apiKey: process.env.OPENAI_API_KEY,
          },
  });
  let openCodeResult;
  let piResult;
  try {
    openCodeResult = await captureOpenCode(server.baseUrl);
    const openCodeCapture = await readCapture("opencode");
    const contractPath = await writeContract(openCodeCapture.body);
    await restoreFixture();
    piResult = await capturePi(server.baseUrl, contractPath, openCodeCapture.body);
  } finally {
    await server.close();
  }
  await compare(openCodeResult, piResult);
}

await main();
