import assert from "node:assert/strict";
import { describeDivergence } from "../experiments/pi-opencode-first-request/divergence.mjs";

const request = (input, tools = []) => ({ model: "fixture", input, tools });
const user = { role: "user", content: "Run the task." };

const toolCall = describeDivergence(
  request([user, { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" }]),
  request([
    user,
    {
      type: "function_call",
      call_id: "call_1",
      name: "bash",
      arguments: JSON.stringify({ command: "pwd" }),
    },
  ]),
  1,
);
assert.equal(toolCall.kind, "tool call");
assert.equal(toolCall.pointer, "$.input[1]");

const modelOutput = describeDivergence(
  request([user, { role: "assistant", content: "OpenCode" }]),
  request([user, { role: "assistant", content: "Pi" }]),
  2,
);
assert.equal(modelOutput.kind, "model output");

const chatToolResult = describeDivergence(
  { model: "fixture", messages: [user, { role: "tool", tool_call_id: "call_1", content: "OpenCode" }] },
  { model: "fixture", messages: [user, { role: "tool", tool_call_id: "call_1", content: "Pi" }] },
  2,
);
assert.equal(chatToolResult.kind, "tool result");
assert.equal(chatToolResult.pointer, "$.messages[1]");

const toolDefinition = describeDivergence(
  request([user], [{ type: "function", name: "read", description: "OpenCode" }]),
  request([user], [{ type: "function", name: "read", description: "Pi" }]),
  1,
);
assert.equal(toolDefinition.kind, "tool definition");
assert.equal(toolDefinition.pointer, "$.tools[0]");

console.log("Divergence classification passed");
