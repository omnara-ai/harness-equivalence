import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startCaptureServer } from "../experiments/pi-opencode-first-request/capture-server.mjs";
import { MODEL_ID } from "../experiments/pi-opencode-first-request/config.mjs";

let upstreamCalls = 0;
const upstream = createServer((request, response) => {
  upstreamCalls += 1;
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${upstreamCalls}\n\ndata: [DONE]\n\n`);
  });
});

await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", resolve);
});
const address = upstream.address();
if (!address || typeof address === "string") throw new Error("Test server did not bind a port");

const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-replay-guard-"));
const capture = await startCaptureServer(outputDirectory, {
  mode: "replay",
  upstream: { baseUrl: `http://127.0.0.1:${address.port}/v1` },
});

try {
  const send = (harness, content) =>
    fetch(`${capture.baseUrl}/v1/${harness}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL_ID,
        input: [{ role: "user", content }],
        stream: true,
      }),
    });

  await (await send("opencode", "first request")).arrayBuffer();
  await (await send("pi", "different request")).arrayBuffer();

  assert.equal(upstreamCalls, 2);
  const metadata = JSON.parse(await readFile(path.join(outputDirectory, "pi.response.json"), "utf8"));
  assert.equal(metadata.replayed, false);
  console.log("Replay mismatch guard passed");
} finally {
  await capture.close();
  await new Promise((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
  await rm(outputDirectory, { recursive: true, force: true });
}
