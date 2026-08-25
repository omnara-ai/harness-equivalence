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

The command prints a side-by-side summary and writes the complete requests and outputs to `experiments/pi-opencode-first-request/artifacts/`.

## How the comparison works

Both harnesses receive the same user input and point to the same local OpenAI-compatible server. The server records each complete request and returns a fixed `OK` response. The report then compares what each harness sent and what each harness printed.

This isolates harness request construction from model stochasticity. The local server is a capture endpoint, not a model and not a proxy to an upstream provider.

The current experiment covers the first model request. It does not claim equivalence for tool implementations, subsequent turns, permissions, compaction, persistence, or recovery.

See [the experiment README](experiments/pi-opencode-first-request/README.md) for the exact scope and method.
