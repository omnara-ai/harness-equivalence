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
const runId = `tool-sequence-test-${process.pid}`;
const fixture = path.join(experimentDirectory, ".state", "runs", runId, "fixture");
const readme = path.join(fixture, "README.md");
const notes = path.join(fixture, "notes.txt");
let upstreamCalls = 0;
let contentUrl;

const steps = [
  () => toolResponse("read", { filePath: readme }, upstreamCalls),
  () =>
    toolResponse("apply_patch", {
      patchText: [
        "*** Begin Patch",
        "*** Add File: notes.txt",
        "+alpha",
        "+beta",
        "*** Update File: README.md",
        "@@",
        "-OpenCode and Pi receive identical copies of this workspace.",
        "+Both harnesses receive identical copies of this workspace.",
        "*** End Patch",
      ].join("\n"),
    }, upstreamCalls),
  () => toolResponse("glob", { pattern: "notes.txt" }, upstreamCalls),
  () => toolResponse("grep", { pattern: "Both harnesses", path: fixture }, upstreamCalls),
  () => toolResponse("bash", { command: "printf shell-ok" }, upstreamCalls),
  () =>
    toolResponse("todowrite", {
      todos: [{ content: "Compare tools", status: "completed", priority: "high" }],
    }, upstreamCalls),
  () => toolResponse("webfetch", { url: contentUrl, format: "markdown" }, upstreamCalls),
  () => toolResponse("skill", { name: "demo" }, upstreamCalls),
  () => toolResponse("skill", { name: "customize-opencode" }, upstreamCalls),
];

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/content") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><body><h1>Fixture</h1><p>Fetched content.</p></body></html>");
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  upstreamCalls += 1;
  request.resume();
  request.on("end", () => {
    const step = steps[upstreamCalls - 1];
    if (step) {
      sendResponse(response, step());
      return;
    }
    if (upstreamCalls === steps.length + 1) {
      sendResponse(response, textResponse("All tool results were received.", upstreamCalls));
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
  assert.equal(upstreamCalls, steps.length + 1);
  assert.deepEqual(comparison.requestCount, { openCode: steps.length + 1, pi: steps.length + 1 });
  assert.equal(comparison.requests.length, steps.length + 1);
  assert.equal(comparison.completeParsedRequest, true, JSON.stringify(comparison.firstDifference, null, 2));
  assert.equal(comparison.exactModelVisibleRequest, true, JSON.stringify(comparison.firstDifference, null, 2));
  assert.equal(comparison.openCodeOutput, "All tool results were received.");
  assert.equal(comparison.piOutput, "All tool results were received.");
  console.log("Terra tool-loop equivalence test passed");
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
