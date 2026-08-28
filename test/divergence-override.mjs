import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startCaptureServer } from "../experiments/pi-opencode-first-request/capture-server.mjs";
import { MODEL_ID } from "../experiments/pi-opencode-first-request/config.mjs";

let upstreamCalls = 0;
const upstreamBodies = [];
const upstream = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    upstreamCalls += 1;
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`response-${upstreamCalls}`);
  });
});

await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", resolve);
});
const address = upstream.address();
if (!address || typeof address === "string") throw new Error("Test server did not bind a port");

const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-divergence-override-"));
const decisions = [];
const capture = await startCaptureServer(outputDirectory, {
  mode: "replay",
  upstream: { baseUrl: `http://127.0.0.1:${address.port}/v1` },
  onDivergence(divergence) {
    decisions.push(divergence);
    return true;
  },
});

const user = { role: "user", content: "Exercise the tools." };
const firstCall = {
  type: "function_call",
  call_id: "call_1",
  name: "bash",
  arguments: JSON.stringify({ command: "printf result" }),
};
const secondCall = {
  type: "function_call",
  call_id: "call_2",
  name: "read",
  arguments: JSON.stringify({ filePath: "notes.txt" }),
};
const toolResult = (callId, output) => ({ type: "function_call_output", call_id: callId, output });
const requestBody = (input) => ({ model: MODEL_ID, input, stream: true });

async function send(captureServer, harness, body) {
  const response = await fetch(`${captureServer.baseUrl}/v1/${harness}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.text();
}

const openCodeRequests = [
  requestBody([user]),
  requestBody([user, firstCall, toolResult("call_1", "OpenCode result")]),
  requestBody([
    user,
    firstCall,
    toolResult("call_1", "OpenCode result"),
    secondCall,
    toolResult("call_2", "OpenCode second result"),
  ]),
];
const piRequests = [
  requestBody([user]),
  requestBody([user, firstCall, toolResult("call_1", "Pi result")]),
  requestBody([
    user,
    firstCall,
    toolResult("call_1", "Pi result"),
    secondCall,
    toolResult("call_2", "Pi second result"),
  ]),
];

try {
  const openCodeResponses = [];
  for (const body of openCodeRequests) {
    openCodeResponses.push(await send(capture, "opencode", body));
  }

  assert.equal(await send(capture, "pi", piRequests[0]), openCodeResponses[0]);
  assert.equal(await send(capture, "pi", piRequests[1]), openCodeResponses[1]);
  assert.equal(await send(capture, "pi", piRequests[2]), "response-4");

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, "tool result");
  assert.equal(decisions[0].pointer, "$.input[2]");
  assert.equal(decisions[0].detailPointer, "$.input[2].output");
  assert.equal(upstreamCalls, 4);

  const effectiveThirdRequest = upstreamBodies[3];
  assert.equal(effectiveThirdRequest.input[2].output, "OpenCode result");
  assert.equal(effectiveThirdRequest.input[4].output, "Pi second result");

  const divergence = JSON.parse(await readFile(path.join(outputDirectory, "divergence.json"), "utf8"));
  assert.equal(divergence.decision, "use-opencode");
  assert.equal(divergence.effectiveRequestMatches, true);

  const secondPiResponse = JSON.parse(
    await readFile(path.join(outputDirectory, "pi.2.response.json"), "utf8"),
  );
  assert.equal(secondPiResponse.replayed, true);
  assert.equal(secondPiResponse.overrideApplied, true);

  const keepDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-divergence-keep-pi-"));
  const keepDecisions = [];
  const keepCapture = await startCaptureServer(keepDirectory, {
    mode: "replay",
    upstream: { baseUrl: `http://127.0.0.1:${address.port}/v1` },
    onDivergence(divergenceValue) {
      keepDecisions.push(divergenceValue);
      return false;
    },
  });
  try {
    const openCodeResponse = await send(keepCapture, "opencode", openCodeRequests[1]);
    const piResponse = await send(keepCapture, "pi", piRequests[1]);
    assert.equal(openCodeResponse, "response-5");
    assert.equal(piResponse, "response-6");
    assert.equal(keepDecisions.length, 1);
    assert.equal(upstreamBodies[5].input[2].output, "Pi result");

    const keepDecision = JSON.parse(
      await readFile(path.join(keepDirectory, "divergence.json"), "utf8"),
    );
    assert.equal(keepDecision.decision, "keep-pi");
  } finally {
    await keepCapture.close();
    await rm(keepDirectory, { recursive: true, force: true });
  }

  console.log("Interactive first-divergence choices passed");
} finally {
  await capture.close();
  await new Promise((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
  await rm(outputDirectory, { recursive: true, force: true });
}
