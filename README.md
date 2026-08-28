# Harness equivalence

Run the same task through vanilla OpenCode and Pi configured with OpenCode's system prompt and tools, then compare their exact model requests and outputs.

```shell
OPENAI_API_KEY="your-key" npx -y github:omnara-ai/harness-equivalence
```

Requires Node.js 22.10 or newer. If you omit `OPENAI_API_KEY`, the CLI prompts for it instead.

## How it works

OpenCode runs the task first. Pi then runs the same task with OpenCode's prompt and tools. Both use the same model and start from identical workspaces.

If both harnesses send the model the same input, their behavior should be equivalent. Models are nondeterministic though, so making the same call twice can still produce different outputs. To remove that noise, Pi receives the exact output OpenCode received whenever their inputs match. The CLI shows each model call side by side and only asks what to do if the tools return different results.

See [the experiment README](experiments/pi-opencode-first-request/README.md) for implementation details and limitations.
