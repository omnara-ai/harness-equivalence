# Harness equivalence

Run the same task through vanilla OpenCode and Pi configured with OpenCode's system prompt and tools, then compare their exact model requests and outputs.

```shell
OPENAI_API_KEY="your-key" npx -y github:omnara-ai/harness-equivalence
```

Requires Node.js 22.10 or newer. If you omit `OPENAI_API_KEY`, the CLI prompts for it instead.

## Methodology

OpenCode runs first in a generated fixture. Pi runs second in a restored copy of that fixture with one extension supplying OpenCode's system prompt, tool definitions, and compatible tool implementations. Both use GPT-5.6 Terra through OpenAI's Responses API with medium reasoning.

A local relay captures every provider request. When Pi sends the same parsed request as OpenCode, the relay returns the exact response bytes OpenCode received instead of calling the model again. This keeps model randomness from creating a difference when both harnesses sent the same thing.

Because matching requests receive the same model-response bytes, text, reasoning, and tool calls from replayed responses are normalized automatically. If the independently executed tool result differs, the CLI shows both results and asks which one to keep. It only asks once because the histories have diverged after that point.

The initial request and tested ordinary tool loops match after parsing.

See [the experiment README](experiments/pi-opencode-first-request/README.md) for tool coverage and known differences. To run the deterministic checks locally, use `npm test` and `./verify`.
