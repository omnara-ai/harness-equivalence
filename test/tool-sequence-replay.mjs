import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDirectory = path.join(repositoryRoot, "experiments", "pi-opencode-first-request");
const runner = path.join(experimentDirectory, "run.mjs");
const runId = `tool-sequence-test-${process.pid}`;
const fixture = path.join(experimentDirectory, ".state", "runs", runId, "fixture");
const readme = path.join(fixture, "README.md");
const notes = path.join(fixture, "notes.txt");
let upstreamCalls = 0;
let contentUrl;

function chunk(delta, finishReason = null, usage) {
  return {
    id: `chatcmpl-tool-sequence-${upstreamCalls}`,
    object: "chat.completion.chunk",
    created: 1_787_529_600,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function send(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const value of chunks) response.write(`data: ${JSON.stringify(value)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function toolResponse(name, args) {
  return [
    chunk({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          index: 0,
          id: `call_${upstreamCalls}_${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
    chunk({}, "tool_calls"),
    chunk({}, null, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ];
}

const steps = [
  () => toolResponse("read", { filePath: readme }),
  () => toolResponse("write", { filePath: notes, content: "alpha\nbeta\n" }),
  () =>
    toolResponse("edit", {
      filePath: readme,
      oldString: "OpenCode and Pi receive identical copies of this workspace.",
      newString: "Both harnesses receive identical copies of this workspace.",
    }),
  () => toolResponse("glob", { pattern: "notes.txt" }),
  () => toolResponse("grep", { pattern: "Both harnesses", path: fixture }),
  () => toolResponse("bash", { command: "printf shell-ok" }),
  () =>
    toolResponse("todowrite", {
      todos: [{ content: "Compare tools", status: "completed", priority: "high" }],
    }),
  () => toolResponse("webfetch", { url: contentUrl, format: "markdown" }),
  () => toolResponse("skill", { name: "demo" }),
  () => toolResponse("skill", { name: "customize-opencode" }),
];

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/content") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><body><h1>Fixture</h1><p>Fetched content.</p></body></html>");
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  upstreamCalls += 1;
  request.resume();
  request.on("end", () => {
    const step = steps[upstreamCalls - 1];
    if (step) {
      send(response, step());
      return;
    }
    if (upstreamCalls === steps.length + 1) {
      send(response, [
        chunk({ role: "assistant", content: "All tool results were received." }),
        chunk({}, "stop"),
        chunk({}, null, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      ]);
      return;
    }
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `Unexpected upstream call ${upstreamCalls}` } }));
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Test server did not bind a port");
contentUrl = `http://127.0.0.1:${address.port}/content`;

try {
  const child = spawn(process.execPath, [runner], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HARNESS_PROMPT: "Exercise each available tool, following the returned tool calls.",
      HARNESS_PROVIDER_MODE: "replay",
      HARNESS_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      HARNESS_MODEL: "gpt-4o-mini",
      HARNESS_TEMPERATURE: "0",
      HARNESS_RUN_ID: runId,
      HARNESS_QUIET: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (value) => (output += value));
  child.stderr.on("data", (value) => (output += value));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, output);

  const artifacts = path.join(experimentDirectory, "artifacts", "runs", runId);
  const comparison = JSON.parse(await readFile(path.join(artifacts, "comparison.json"), "utf8"));
  assert.equal(upstreamCalls, steps.length + 1);
  assert.deepEqual(comparison.requestCount, { openCode: steps.length + 1, pi: steps.length + 1 });
  assert.equal(comparison.requests.length, steps.length + 1);
  assert.equal(comparison.completeParsedRequest, true, JSON.stringify(comparison.firstDifference, null, 2));
  assert.equal(comparison.exactModelVisibleRequest, true, JSON.stringify(comparison.firstDifference, null, 2));
  assert.equal(comparison.openCodeOutput, "All tool results were received.");
  assert.equal(comparison.piOutput, "All tool results were received.");
  console.log("Nine-tool replay equivalence test passed");
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
