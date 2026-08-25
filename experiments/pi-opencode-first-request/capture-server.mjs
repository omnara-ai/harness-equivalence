import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function harnessName(url) {
  return url.match(/\/v1\/(opencode|pi)\//)?.[1];
}

function completionChunk(model, delta, finishReason = null, usage) {
  return {
    id: "chatcmpl-harness-equivalence",
    object: "chat.completion.chunk",
    created: 1_787_529_600,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function sendFixedCompletion(response, body) {
  const model = typeof body.model === "string" ? body.model : "gpt-4o-mini";
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify(completionChunk(model, { role: "assistant", content: "OK" }))}\n\n`);
  response.write(`data: ${JSON.stringify(completionChunk(model, {}, "stop"))}\n\n`);
  response.write(
    `data: ${JSON.stringify(
      completionChunk(model, {}, null, {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      }),
    )}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

export async function startCaptureServer(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const requestCounts = new Map();

  const server = createServer(async (request, response) => {
    try {
      const url = request.url ?? "/";
      if (request.method === "GET" && url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }

      const harness = harnessName(url);
      if (request.method !== "POST" || !url.endsWith("/chat/completions") || !harness) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `Unhandled capture path: ${request.method} ${url}` } }));
        return;
      }

      const rawBody = await readBody(request);
      const body = JSON.parse(rawBody);
      const ordinal = (requestCounts.get(harness) ?? 0) + 1;
      requestCounts.set(harness, ordinal);
      const suffix = ordinal === 1 ? "" : `.${ordinal}`;
      const capture = {
        method: request.method,
        url,
        headers: Object.fromEntries(
          Object.entries(request.headers)
            .filter(([, value]) => value !== undefined)
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
        rawBody,
        body,
      };
      await writeFile(
        path.join(outputDirectory, `${harness}${suffix}.capture.json`),
        `${JSON.stringify(capture, null, 2)}\n`,
      );
      sendFixedCompletion(response, body);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Capture server did not bind a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
