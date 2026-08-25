import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type OpenCodeTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
};

type OpenCodeContract = {
  systemPrompt: string;
  tools: OpenCodeTool[];
};

function loadContract(): OpenCodeContract {
  const filename = process.env.OPENCODE_CONTRACT_PATH;
  if (!filename) throw new Error("OPENCODE_CONTRACT_PATH is required");
  return JSON.parse(readFileSync(filename, "utf8"));
}

export default function opencodeCompatibilityProfile(pi: ExtensionAPI) {
  const contract = loadContract();
  let currentPrompt: string | undefined;

  for (const tool of contract.tools) {
    pi.registerTool({
      name: tool.function.name,
      label: tool.function.name,
      description: tool.function.description ?? "",
      parameters: tool.function.parameters,
      async execute() {
        throw new Error("This experiment captures only the first model request. Tool execution is disabled.");
      },
    });
  }

  pi.on("before_agent_start", (event) => {
    currentPrompt = event.prompt;
    return { systemPrompt: contract.systemPrompt };
  });

  pi.on("context", (event) => {
    if (currentPrompt === undefined) return;
    const userIndexes = event.messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
    if (userIndexes.length !== 1) return;
    const userIndex = userIndexes[0];
    return {
      messages: event.messages.map((message, index) =>
        index === userIndex && message.role === "user" ? { ...message, content: currentPrompt } : message,
      ),
    };
  });
}
