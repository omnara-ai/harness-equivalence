import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDirectory = path.join(repositoryRoot, "experiments", "pi-opencode-first-request");
const runner = path.join(experimentDirectory, "run.mjs");
const subagentType = process.env.TASK_TEST_TYPE ?? "general";
if (!["general", "explore"].includes(subagentType)) throw new Error(`Unsupported TASK_TEST_TYPE: ${subagentType}`);
const runId = `task-${subagentType}-replay-test-${process.pid}`;
let upstreamCalls = 0;

function chunk(delta, finishReason = null, usage) {
  return {
    id: `chatcmpl-task-replay-${upstreamCalls}`,
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
              id: "call_task_fixture",
              type: "function",
              function: {
                name: "task",
                arguments: JSON.stringify({
                  description: "Inspect fixture",
                  prompt: "Return exactly CHILD DONE without calling tools.",
                  subagent_type: subagentType,
                }),
              },
            },
          ],
        }),
        chunk({}, "tool_calls"),
        chunk({}, null, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      ]);
      return;
    }
    const text = upstreamCalls === 2 ? "CHILD DONE" : "Parent received the child result.";
    send(response, [
      chunk({ role: "assistant", content: text }),
      chunk({}, "stop"),
      chunk({}, null, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]);
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
      HARNESS_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      HARNESS_MODEL: "gpt-4o-mini",
      HARNESS_TEMPERATURE: "0",
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
  assert.equal(upstreamCalls, 3);
  assert.deepEqual(comparison.requestCount, { openCode: 3, pi: 3 });
  assert.equal(comparison.requests[0].completeParsedRequest, true);
  assert.equal(comparison.requests[1].completeParsedRequest, true);
  assert.equal(comparison.completeParsedRequest, false);
  assert.equal(comparison.openCodeOutput, "Parent received the child result.");
  assert.equal(comparison.piOutput, "Parent received the child result.");
  console.log(
    `${subagentType} task child request matched; the parent follow-up differs only by the generated child session ID`,
  );
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
