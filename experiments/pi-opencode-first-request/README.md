# Pi as OpenCode, first-request equivalence

This experiment asks a narrow question. Can unmodified Pi produce the same first provider request as OpenCode by loading an ordinary extension?

At the pinned versions, the answer is yes. The parsed JSON request bodies are equal. Their raw HTTP bytes differ only in JSON object-key order.

The comparison includes:

- model ID
- ordered messages and their literal contents
- ordered tool names, descriptions, and JSON schemas
- generation controls
- the complete parsed request body
- the assistant output observed by each harness

It does not compare tool implementations, later turns, permissions, compaction, persistence, or recovery behavior.

## Versions

- OpenCode `1.18.22`, corresponding to source commit `18b4cb6819d7de0b37927fef60d03927e678c9dd`
- Pi `0.84.3`, corresponding to source commit `dcd461925db2edf69a43c8135db1180d418afd54`
- OpenAI-compatible `gpt-4o-mini` fixture route

## Method

The experiment starts a local OpenAI-compatible HTTP endpoint. OpenCode sends its normal first request to `/v1/opencode/chat/completions`. The endpoint records that request and returns the deterministic assistant response `OK`.

The runner extracts OpenCode's system prompt, tool contracts, model ID, and generation controls. Pi then loads [`pi-opencode-compat.ts`](pi-opencode-compat.ts), which uses Pi's public extension API to install the same prompt and tool contracts. Pi sends its request to `/v1/pi/chat/completions`, where it is recorded and receives the same response.

The extension uses `before_agent_start`, `registerTool`, and `context`. It does not use Pi's `before_provider_request` hook, which could replace the complete provider payload and make the result trivial.

Run from the repository root:

```sh
./verify
```

The generated `artifacts/` directory contains both raw captures, normalized request JSON, harness output, and a Markdown report.

OpenCode prompt and tool text captured during the run is covered by OpenCode's MIT license. See [`THIRD_PARTY_NOTICE.md`](THIRD_PARTY_NOTICE.md).
