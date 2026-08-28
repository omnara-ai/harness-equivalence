import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendResponse, textResponse } from "./responses-fixture.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDirectory = path.join(repositoryRoot, "experiments", "pi-opencode-first-request");
const runner = path.join(experimentDirectory, "run.mjs");
const runId = `live-replay-test-${process.pid}`;
let upstreamCalls = 0;

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  upstreamCalls += 1;
  request.resume();
  request.on("end", () => {
    sendResponse(response, textResponse("A live replay response."));
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
      HARNESS_PROMPT: "Return a short sentence without calling tools.",
      HARNESS_PROVIDER_MODE: "replay",
      HARNESS_TEST_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      HARNESS_RUN_ID: runId,
      HARNESS_QUIET: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, output);

  const artifacts = path.join(experimentDirectory, "artifacts", "runs", runId);
  const comparison = JSON.parse(await readFile(path.join(artifacts, "comparison.json"), "utf8"));
  const openCodeResponse = JSON.parse(
    await readFile(path.join(artifacts, "captures", "opencode.response.json"), "utf8"),
  );
  const piResponse = JSON.parse(await readFile(path.join(artifacts, "captures", "pi.response.json"), "utf8"));

  assert.equal(upstreamCalls, 1);
  assert.equal(comparison.completeParsedRequest, true);
  assert.equal(comparison.systemPromptsEqual, true);
  assert.equal(comparison.openCodeOutput, "A live replay response.");
  assert.equal(comparison.piOutput, "A live replay response.");
  assert.equal(openCodeResponse.replayed, false);
  assert.equal(piResponse.replayed, true);
  console.log("Live replay smoke test passed");
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
