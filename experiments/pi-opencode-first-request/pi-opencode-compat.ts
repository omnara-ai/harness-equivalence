import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOpenCodeToolRuntime } from "./opencode-tools.mjs";

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

const EXPLORE_SYSTEM_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Use Bash for file operations like copying, moving, or listing directory contents
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Do not create any files, or run bash commands that modify the user's system state in any way

Complete the user's search request efficiently and report your findings clearly.`;

function exploreSystemPrompt(systemPrompt: string) {
  const environment = systemPrompt.match(/\n\nYou are powered by the model named [\s\S]*?<\/env>/)?.[0];
  if (!environment) throw new Error("Could not extract OpenCode's model and environment suffix");
  return EXPLORE_SYSTEM_PROMPT + environment;
}

function loadContract(): OpenCodeContract {
  const filename = process.env.OPENCODE_CONTRACT_PATH;
  if (!filename) throw new Error("OPENCODE_CONTRACT_PATH is required");
  return JSON.parse(readFileSync(filename, "utf8"));
}

function normalizeProviderPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("messages" in payload)) return payload;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return payload;
  const normalized = {
    ...payload,
    messages: messages.map((message) => {
      if (
        !message ||
        typeof message !== "object" ||
        !("role" in message) ||
        message.role !== "assistant" ||
        !("tool_calls" in message) ||
        !("content" in message) ||
        message.content !== null
      ) {
        return message;
      }
      return { ...message, content: "" };
    }),
  };
  if (process.env.OPENCODE_SUBAGENT_TYPE && "temperature" in normalized) {
    const { temperature: _temperature, ...withoutTemperature } = normalized;
    return withoutTemperature;
  }
  return normalized;
}

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          [
            `Nested Pi task exited with ${code ?? `signal ${signal}`}`,
            stdout.trim() && `stdout:\n${stdout.trim()}`,
            stderr.trim() && `stderr:\n${stderr.trim()}`,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    });
  });
}

function sessionUuid(taskId: string) {
  const compact = taskId.replace(/^ses_/, "").replaceAll("-", "").padEnd(32, "0").slice(0, 32);
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

async function runTask(
  params: { prompt: string; subagent_type: string; task_id: string },
  context: { cwd: string; signal?: AbortSignal },
) {
  const depth = Number(process.env.OPENCODE_TASK_DEPTH ?? "0");
  if (depth >= 1) {
    throw new Error("Subagent depth limit reached (1). Increase subagent_depth to allow nested subagents.");
  }
  const cli = process.env.OPENCODE_PI_CLI;
  const extension = process.env.OPENCODE_PI_EXTENSION;
  const provider = process.env.OPENCODE_COMPAT_PROVIDER;
  const model = process.env.OPENCODE_COMPAT_MODEL;
  const sessionDirectory = process.env.OPENCODE_TASK_SESSION_DIR;
  if (!cli || !extension || !provider || !model || !sessionDirectory) {
    throw new Error("Nested Pi task configuration is incomplete");
  }
  const tools =
    params.subagent_type === "explore"
      ? "bash,glob,grep,read,webfetch"
      : "bash,edit,glob,grep,read,skill,webfetch,write";
  const result = await run(
    process.execPath,
    [
      cli,
      "--print",
      "--provider",
      provider,
      "--model",
      model,
      "--thinking",
      "off",
      "--session-id",
      sessionUuid(params.task_id),
      "--session-dir",
      sessionDirectory,
      "--no-builtin-tools",
      "--no-extensions",
      "--extension",
      extension,
      "--tools",
      tools,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      params.prompt,
    ],
    {
      cwd: context.cwd,
      signal: context.signal,
      env: {
        ...process.env,
        OPENCODE_SUBAGENT_TYPE: params.subagent_type,
        OPENCODE_TASK_DEPTH: String(depth + 1),
      },
    },
  );
  return result.stdout.replace(/\u001b\[[0-9;]*m/g, "").trim();
}

export default function opencodeCompatibilityProfile(pi: ExtensionAPI) {
  const contract = loadContract();
  let currentPrompt: string | undefined;
  const runtime = createOpenCodeToolRuntime({
    runTask,
    onTodos(todos: unknown) {
      pi.appendEntry("opencode.todos", todos);
    },
  });

  for (const tool of contract.tools) {
    pi.registerTool({
      name: tool.function.name,
      label: tool.function.name,
      description: tool.function.description ?? "",
      parameters: tool.function.parameters,
      async execute(toolCallId, params, signal, _onUpdate, context) {
        return runtime.execute(tool.function.name, params, {
          ...context,
          signal: signal ?? context.signal,
          toolCallId,
        });
      },
    });
  }

  pi.on("before_agent_start", (event) => {
    currentPrompt = event.prompt;
    return {
      systemPrompt:
        process.env.OPENCODE_SUBAGENT_TYPE === "explore"
          ? exploreSystemPrompt(contract.systemPrompt)
          : contract.systemPrompt,
    };
  });

  pi.on("before_provider_request", (event) => normalizeProviderPayload(event.payload));

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
