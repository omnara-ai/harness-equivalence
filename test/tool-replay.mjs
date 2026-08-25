import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDirectory = path.join(repositoryRoot, "experiments", "pi-opencode-first-request");
const runner = path.join(experimentDirectory, "run.mjs");
const runId = `tool-replay-test-${process.pid}`;
const fixtureFile = path.join(experimentDirectory, ".state", "runs", runId, "fixture", "README.md");
let upstreamCalls = 0;

function chunk(delta, finishReason = null, usage) {
  return {
    id: `chatcmpl-tool-replay-${upstreamCalls}`,
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

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  upstreamCalls += 1;
  request.resume();
  request.on("end", () => {
    if (upstreamCalls === 1) {
      send(response, [
        chunk({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: "call_read_fixture",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ filePath: fixtureFile }) },
            },
          ],
        }),
        chunk({}, "tool_calls"),
        chunk({}, null, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      ]);
      return;
    }
    if (upstreamCalls === 2) {
      send(response, [
        chunk({ role: "assistant", content: "The tool result was received." }),
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

try {
  const child = spawn(process.execPath, [runner], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HARNESS_PROMPT: "Read the fixture README and then confirm that you read it.",
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
  assert.equal(upstreamCalls, 2);
  assert.deepEqual(comparison.requestCount, { openCode: 2, pi: 2 });
  assert.equal(comparison.requests.length, 2);
  assert.equal(comparison.requests[0].completeParsedRequest, true);
  assert.equal(comparison.requests[1].completeParsedRequest, true);
  assert.equal(comparison.completeParsedRequest, true);
  assert.equal(comparison.openCodeOutput, "The tool result was received.");
  assert.equal(comparison.piOutput, "The tool result was received.");
  console.log("Read-tool replay equivalence test passed");
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
