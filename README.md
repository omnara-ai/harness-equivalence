# Harness equivalence

Reproducible experiments for asking when two agent harnesses send the same request to a model.

The first experiment reproduces OpenCode's first model request with unmodified Pi and a small Pi extension. It compares the complete parsed provider request, including the model, messages, system prompt, tool definitions, and generation controls.

## Run it

You need Node.js 22.19 or newer. No API key or model access is required.

```sh
git clone git@github.com:omnara-ai/harness-equivalence.git
cd harness-equivalence
./verify
```

The command prints a side-by-side summary and writes the complete requests and outputs to `experiments/pi-opencode-first-request/artifacts/verify/`.

## Interactive comparison

Set an OpenAI API key and start the prompt loop:

```sh
export OPENAI_API_KEY=your-key
./repl
```

Enter a prompt to run a fresh first turn through OpenCode and Pi. Their outputs appear in two columns. The REPL also reports whether the complete requests and system prompts match.

```text
you> Explain how a B-tree works without using tools.
```

Useful commands:

```text
:system    print both exact system messages sent to the model
:requests  print both complete parsed provider requests
:artifacts show the generated files for the last comparison
:quit      exit
```

By default, the relay makes one real model call for OpenCode and replays the exact response bytes to Pi. This removes model stochasticity from the harness comparison. Both requests use temperature `0`, but temperature zero alone does not guarantee deterministic hosted inference.

Use `./repl --independent` to make a separate model call for each harness. You can also run one prompt without entering the loop:

```sh
./repl "Explain how a B-tree works without using tools."
```

For OpenRouter, LiteLLM, Ollama, or another OpenAI-compatible endpoint, set `HARNESS_API_BASE_URL`, `HARNESS_API_KEY`, and `HARNESS_MODEL` as needed.

The current REPL compares fresh first turns. The OpenCode tool contracts are present, but their Pi implementations are still stubs. Use prompts that do not require tool calls. Full tool-loop and multi-turn equivalence are separate experiments.

## How the comparison works

Both harnesses receive the same user input and point to the same local OpenAI-compatible server. During `./verify`, the server records each complete request and returns a fixed `OK` response. The report then compares what each harness sent and what each harness printed.

This isolates harness request construction from model stochasticity. In verification mode, the local server is only a capture endpoint. In REPL mode, it relays or replays responses from the configured upstream provider.

The current experiment covers the first model request. It does not claim equivalence for tool implementations, subsequent turns, permissions, compaction, persistence, or recovery.

See [the experiment README](experiments/pi-opencode-first-request/README.md) for the exact scope and method.
