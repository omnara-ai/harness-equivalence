import assert from "node:assert/strict";
import { formatModelResponse } from "../experiments/pi-opencode-first-request/response-display.mjs";

const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const response = [
  event({
    type: "response.output_item.done",
    item: { type: "reasoning", encrypted_content: "opaque" },
  }),
  event({
    type: "response.output_item.done",
    item: {
      type: "message",
      phase: "commentary",
      content: [{ type: "output_text", text: "I will inspect the project." }],
    },
  }),
  event({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "read",
      arguments: JSON.stringify({ filePath: "/tmp/run/fixture/README.md" }),
    },
  }),
  event({
    type: "response.output_item.done",
    item: {
      type: "message",
      phase: "final_answer",
      content: [{ type: "output_text", text: "A small fixture." }],
    },
  }),
  "data: [DONE]\n\n",
].join("");

assert.equal(
  formatModelResponse(response),
  [
    "[commentary] I will inspect the project.",
    '[tool] read {"filePath":"README.md"}',
    "[final] A small fixture.",
  ].join("\n"),
);

console.log("Model-response display formatting passed");
