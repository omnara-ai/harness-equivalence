# Harness equivalence

Reproducible experiments for testing when two agent harnesses send the same requests to a model.

The first experiment compares OpenCode with unmodified Pi loaded with one extension. The extension supplies OpenCode's system prompt, tool definitions, and compatible tool implementations. Both use GPT-5.6 Terra through OpenAI's Responses API with medium reasoning. The initial request and tested ordinary tool loops match after parsing.

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

Enter a task and both harnesses run against separate copies of the same fixture. OpenCode calls the model first. If Pi sends the same parsed request, it receives the exact same response bytes. A differing request makes its own model call. Outputs appear side by side, and the REPL reports whether every parsed request matched.

```text
:system    print every exact system message sent to the model
:requests  print every complete parsed provider request
:artifacts show the generated files for the last comparison
:quit      exit
```

See [the experiment README](experiments/pi-opencode-first-request/README.md) for the method, tool coverage, and known differences.
