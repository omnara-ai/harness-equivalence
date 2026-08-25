# Harness equivalence

Reproducible experiments for testing when two agent harnesses send the same requests to a model.

The first experiment reproduces OpenCode with an ordinary Pi extension. It matches the initial provider request and implements OpenCode's ten default tools. A replay test exercises nine ordinary tools and gets equal parsed provider requests through the entire loop. The `task` tool also runs a child Pi agent. Its child request matches, while the parent follow-up contains a different randomly generated child session ID.

## Run it

You need Node.js 22.19 or newer. The deterministic checks do not need an API key.

```sh
git clone git@github.com:omnara-ai/harness-equivalence.git
cd harness-equivalence
npm ci
npm test
./verify
```

The commands write complete requests, responses, outputs, and comparison reports under `experiments/pi-opencode-first-request/artifacts/`.

## Interactive comparison

```sh
export OPENAI_API_KEY=your-key
./repl
```

Enter a task and both harnesses will run against separate copies of the same fixture. OpenCode calls the model first. The relay then sends each exact model response to Pi. Outputs appear side by side, and the REPL reports whether every parsed provider request matched.

```text
:system    print every exact system message sent to the model
:requests  print every complete parsed provider request
:artifacts show the generated files for the last comparison
:quit      exit
```

Use `./repl --independent` to make separate model calls. Set `HARNESS_API_BASE_URL`, `HARNESS_API_KEY`, and `HARNESS_MODEL` for OpenRouter, LiteLLM, Ollama, or another OpenAI-compatible endpoint.

See [the experiment README](experiments/pi-opencode-first-request/README.md) for the method, tool coverage, and known differences.
