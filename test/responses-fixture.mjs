import { MODEL_ID } from "../experiments/pi-opencode-first-request/config.mjs";

const createdAt = 1_787_529_600;

function created(responseId) {
  return {
    type: "response.created",
    sequence_number: 1,
    response: {
      id: responseId,
      created_at: createdAt,
      model: MODEL_ID,
      service_tier: null,
    },
  };
}

function completed(responseId, output, sequenceNumber) {
  return {
    type: "response.completed",
    sequence_number: sequenceNumber,
    response: {
      id: responseId,
      status: "completed",
      output,
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
  };
}

export function textResponse(text, ordinal = 1) {
  const responseId = `resp_fixture_${ordinal}`;
  const messageId = `msg_fixture_${ordinal}`;
  const item = {
    type: "message",
    id: messageId,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
  };
  return [
    created(responseId),
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      output_index: 0,
      content_index: 0,
      item_id: messageId,
      delta: text,
      logprobs: [],
    },
    {
      type: "response.output_item.done",
      sequence_number: 4,
      output_index: 0,
      item,
    },
    completed(responseId, [item], 5),
  ];
}

export function toolResponse(name, arguments_, ordinal = 1) {
  const responseId = `resp_fixture_${ordinal}`;
  const reasoningBase = {
    type: "reasoning",
    id: `rs_fixture_${ordinal}`,
    summary: [],
  };
  const reasoning = {
    ...reasoningBase,
    encrypted_content: `encrypted_fixture_${ordinal}`,
    status: "completed",
  };
  const itemId = `fc_fixture_${ordinal}`;
  const callId = `call_fixture_${ordinal}`;
  const argumentsJson = JSON.stringify(arguments_);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: argumentsJson,
    status: "completed",
  };
  return [
    created(responseId),
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { ...reasoningBase, status: "in_progress" },
    },
    {
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 0,
      item: reasoning,
    },
    {
      type: "response.output_item.added",
      sequence_number: 4,
      output_index: 1,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 5,
      output_index: 1,
      item_id: itemId,
      delta: argumentsJson,
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 6,
      output_index: 1,
      item_id: itemId,
      arguments: argumentsJson,
    },
    {
      type: "response.output_item.done",
      sequence_number: 7,
      output_index: 1,
      item,
    },
    completed(responseId, [reasoning, item], 8),
  ];
}

export function sendResponse(response, events) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end("data: [DONE]\n\n");
}
