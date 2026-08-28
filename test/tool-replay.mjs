import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendResponse, textResponse, toolResponse } from "./responses-fixture.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDirectory = path.join(repositoryRoot, "experiments", "pi-opencode-first-request");
const runner = path.join(experimentDirectory, "run.mjs");
const runId = `tool-replay-test-${process.pid}`;
const fixtureFile = path.join(experimentDirectory, ".state", "runs", runId, "fixture", "README.md");
let upstreamCalls = 0;

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  upstreamCalls += 1;
  request.resume();
  request.on("end", () => {
    if (upstreamCalls === 1) {
      sendResponse(response, toolResponse("read", { filePath: fixtureFile }, upstreamCalls));
      return;
    }
    if (upstreamCalls === 2) {
      sendResponse(response, textResponse("The tool result was received.", upstreamCalls));
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
      HARNESS_TEST_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
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
  const followUp = JSON.parse(await readFile(path.join(artifacts, "opencode.2.request.json"), "utf8"));
  const reasoning = followUp.input.find((item) => item.type === "reasoning");
  assert.equal(upstreamCalls, 2);
  assert.deepEqual(comparison.requestCount, { openCode: 2, pi: 2 });
  assert.equal(comparison.requests.length, 2);
  assert.equal(comparison.requests[0].completeParsedRequest, true);
  assert.equal(comparison.requests[1].completeParsedRequest, true);
  assert.equal(comparison.completeParsedRequest, true);
  assert.equal(reasoning?.encrypted_content, "encrypted_fixture_1");
  assert.equal(comparison.openCodeOutput, "The tool result was received.");
  assert.equal(comparison.piOutput, "The tool result was received.");
  console.log("Read-tool and encrypted-reasoning replay equivalence test passed");
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
