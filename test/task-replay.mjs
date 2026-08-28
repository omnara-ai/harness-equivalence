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
const subagentType = process.env.TASK_TEST_TYPE ?? "general";
if (!["general", "explore"].includes(subagentType)) throw new Error(`Unsupported TASK_TEST_TYPE: ${subagentType}`);
const runId = `task-${subagentType}-replay-test-${process.pid}`;
let upstreamCalls = 0;

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  upstreamCalls += 1;
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const serializedInput = JSON.stringify(body.input);
    const isParentFollowUp = body.input.some(
      (item) => item.type === "function_call" && item.name === "task",
    );
    const isChild = serializedInput.includes("Return exactly CHILD DONE without calling tools.");
    if (!isParentFollowUp && !isChild) {
      sendResponse(
        response,
        toolResponse(
          "task",
          {
            description: "Inspect fixture",
            prompt: "Return exactly CHILD DONE without calling tools.",
            subagent_type: subagentType,
          },
          upstreamCalls,
        ),
      );
      return;
    }
    const text = isParentFollowUp ? "Parent received the child result." : "CHILD DONE";
    sendResponse(response, textResponse(text, upstreamCalls));
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
      HARNESS_PROMPT: "Delegate this task to the general subagent.",
      HARNESS_PROVIDER_MODE: "replay",
      HARNESS_TEST_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      HARNESS_RUN_ID: runId,
      HARNESS_QUIET: "1",
      HARNESS_ALLOW_DIFFERENCES: "1",
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
  // The initial Pi request matches and replays. Child sessions use different
  // cache keys, and the parent results contain different generated child IDs,
  // so those requests are sent upstream independently.
  assert.equal(upstreamCalls, 5);
  assert.deepEqual(comparison.requestCount, { openCode: 3, pi: 3 });
  assert.equal(comparison.requests[0].completeParsedRequest, true);
  assert.equal(comparison.requests[1].completeParsedRequest, false);
  assert.equal(comparison.completeParsedRequest, false);
  assert.equal(comparison.openCodeOutput, "Parent received the child result.");
  assert.equal(comparison.piOutput, "Parent received the child result.");
  console.log(
    `${subagentType} task behavior matched; generated child session state keeps later request bodies distinct`,
  );
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
