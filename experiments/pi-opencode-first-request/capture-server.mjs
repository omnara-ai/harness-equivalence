import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { MODEL_ID } from "./config.mjs";
import { createDivergenceController } from "./divergence.mjs";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

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

function endpointName(url) {
  if (url.endsWith("/responses")) return "responses";
  return undefined;
}

function sendFixedResponse(response, body) {
  const model = typeof body.model === "string" ? body.model : MODEL_ID;
  const events = [
    {
      type: "response.created",
      sequence_number: 1,
      response: {
        id: "resp_harness_equivalence",
        created_at: 1_787_529_600,
        model,
        service_tier: null,
      },
    },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: {
        type: "message",
        id: "msg_harness_equivalence",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      output_index: 0,
      item_id: "msg_harness_equivalence",
      delta: "OK",
      logprobs: null,
    },
    {
      type: "response.output_item.done",
      sequence_number: 4,
      output_index: 0,
      item: {
        type: "message",
        id: "msg_harness_equivalence",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "OK", annotations: [], logprobs: [] }],
      },
    },
    {
      type: "response.completed",
      sequence_number: 5,
      response: {
        id: "resp_harness_equivalence",
        status: "completed",
        output: [],
        incomplete_details: null,
        service_tier: null,
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function responseHeaders(headers) {
  const result = {};
  for (const name of ["content-type", "cache-control"]) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

async function requestUpstream(upstream, rawBody) {
  const headers = {
    accept: "text/event-stream",
    "content-type": "application/json",
    ...(upstream.apiKey ? { authorization: `Bearer ${upstream.apiKey}` } : {}),
    ...(upstream.headers ?? {}),
  };
  const response = await fetch(`${upstream.baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers,
    body: rawBody,
    signal: AbortSignal.timeout(upstream.timeoutMs ?? 120_000),
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers),
    rawBody: Buffer.from(await response.arrayBuffer()),
  };
}

async function recordResponse(
  outputDirectory,
  harness,
  suffix,
  upstreamResponse,
  replayed,
  details = {},
) {
  const metadata = {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: upstreamResponse.headers,
    replayed,
    ...details,
  };
  await writeFile(
    path.join(outputDirectory, `${harness}${suffix}.response.json`),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await writeFile(path.join(outputDirectory, `${harness}${suffix}.response.raw`), upstreamResponse.rawBody);
}

async function recordCapture(outputDirectory, harness, suffix, capture) {
  await writeFile(
    path.join(outputDirectory, `${harness}${suffix}.capture.json`),
    `${JSON.stringify(capture, null, 2)}\n`,
  );
}

function sendBufferedResponse(response, upstreamResponse) {
  response.writeHead(upstreamResponse.status, upstreamResponse.headers);
  response.end(upstreamResponse.rawBody);
}

export async function startCaptureServer(outputDirectory, options = {}) {
  await mkdir(outputDirectory, { recursive: true });
  const mode = options.mode ?? "fixture";
  if (mode === "replay" && !options.upstream?.baseUrl) {
    throw new Error(`Capture mode ${mode} requires an upstream base URL`);
  }
  if (!["fixture", "replay"].includes(mode)) throw new Error(`Unknown capture mode: ${mode}`);
  const requestCounts = new Map();
  const openCodeExchanges = new Map();
  const piResponsesReplayed = new Map();
  const resolveDivergence = createDivergenceController(options.onDivergence);

  const server = createServer(async (request, response) => {
    try {
      const url = request.url ?? "/";
      if (request.method === "GET" && url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }

      const harness = harnessName(url);
      const endpoint = endpointName(url);
      if (request.method !== "POST" || !endpoint || !harness) {
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

      if (mode === "fixture") {
        await recordCapture(outputDirectory, harness, suffix, capture);
        sendFixedResponse(response, body);
        return;
      }

      if (mode === "replay" && harness === "pi") {
        const recorded = openCodeExchanges.get(ordinal);
        let effectiveBody = body;
        let overrideApplied = false;
        let automaticOverrides = [];

        if (recorded) {
          const resolved = await resolveDivergence(recorded.request, body, ordinal, {
            previousResponseReplayed: piResponsesReplayed.get(ordinal - 1) === true,
          });
          effectiveBody = resolved.effectiveBody;
          overrideApplied = resolved.overrideApplied;
          automaticOverrides = resolved.automaticOverrides;
          if (resolved.decision) {
            await writeFile(
              path.join(outputDirectory, "divergence.json"),
              `${JSON.stringify(resolved.decision, null, 2)}\n`,
            );
          }
        }

        if (overrideApplied) {
          capture.overrideApplied = true;
          capture.effectiveBody = effectiveBody;
        }
        if (automaticOverrides.length > 0) {
          capture.automaticOverrides = automaticOverrides;
        }
        await recordCapture(outputDirectory, harness, suffix, capture);

        if (recorded && isDeepStrictEqual(stable(recorded.request), stable(effectiveBody))) {
          piResponsesReplayed.set(ordinal, true);
          await recordResponse(outputDirectory, harness, suffix, recorded.response, true, {
            overrideApplied,
            automaticOverrides: automaticOverrides.length,
          });
          sendBufferedResponse(response, recorded.response);
          return;
        }

        const effectiveRawBody = overrideApplied ? JSON.stringify(effectiveBody) : rawBody;
        const upstreamResponse = await requestUpstream(options.upstream, effectiveRawBody);
        piResponsesReplayed.set(ordinal, false);
        await recordResponse(outputDirectory, harness, suffix, upstreamResponse, false, {
          overrideApplied,
          automaticOverrides: automaticOverrides.length,
        });
        sendBufferedResponse(response, upstreamResponse);
        return;
      }

      await recordCapture(outputDirectory, harness, suffix, capture);
      const upstreamResponse = await requestUpstream(options.upstream, rawBody);
      if (mode === "replay" && harness === "opencode") {
        openCodeExchanges.set(ordinal, { request: body, response: upstreamResponse });
      }
      await recordResponse(outputDirectory, harness, suffix, upstreamResponse, false);
      sendBufferedResponse(response, upstreamResponse);
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
