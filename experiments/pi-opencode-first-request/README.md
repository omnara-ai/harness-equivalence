# Pi as OpenCode

This experiment tests how much of OpenCode can be reproduced as a Pi extension.

At the pinned versions, Pi produces the same initial provider request as OpenCode. The test suite also replays model responses through real tool loops. Nine OpenCode tools produce the same model-visible results on their tested paths, so every provider request in the sequence is equal after parsing.

The tenth tool, `task`, launches another agent. Pi now does that too. The child agent's provider request is equal to OpenCode's in the fixture test. The parent follow-up differs because both harnesses generate a random child session ID and place their own ID in the tool result.

## Versions

- OpenCode `1.18.22`, source commit `18b4cb6819d7de0b37927fef60d03927e678c9dd`
- Pi `0.84.3`, source commit `dcd461925db2edf69a43c8135db1180d418afd54`
- OpenAI-compatible `gpt-4o-mini` fixture route

## What is implemented

| Tool | Pi implementation | Provider-boundary coverage |
|---|---|---|
| `bash` | Shell execution, working directory, timeout, combined output, and tail truncation | Successful short command |
| `edit` | OpenCode's replacement algorithm, BOM preservation, and line-ending preservation | Existing-file replacement |
| `glob` | OpenCode's ripgrep invocation and output format | Newly written file glob |
| `grep` | OpenCode's ripgrep JSON parsing and output format | Content match |
| `read` | Files, directories, line limits, byte limits, binary checks, and images | Text file |
| `skill` | Skill lookup, instruction loading, and sampled file list | Local and built-in fixture skills |
| `task` | Foreground child Pi session, general and explore tool sets, depth limit, and session resume | Child request equal; parent result differs by random session ID |
| `todowrite` | Todo replacement, session entry, and result format | One completed todo |
| `webfetch` | Fetch limits and OpenCode's HTML to text or Markdown conversion | HTML to Markdown |
| `write` | Parent creation, overwrite, and BOM preservation | New text file |

The tool schemas, names, descriptions, order, system prompt, model, messages, and generation controls are captured from OpenCode rather than maintained as a second handwritten contract.

The extension uses Pi's provider-request hook for two narrow transport normalizations. OpenCode serializes a tool-calling assistant message with `content: ""`, while Pi emits `content: null`. Pi also inherits the parent temperature in a child session while OpenCode omits it. The hook changes those fields only. It does not replace a request with the captured OpenCode payload.

## Run the checks

From the repository root:

```sh
npm test
./verify
```

`./verify` compares a deterministic first request. `npm test` also runs replay tests through tool loops. OpenCode executes first. The fixture is then restored to its original bytes before Pi runs. Each response returned to OpenCode is replayed byte for byte to Pi.

Generated captures and reports are written under `artifacts/verify/` and `artifacts/runs/`.

## Interactive comparison

```sh
export OPENAI_API_KEY=your-key
./repl
```

Each prompt starts a fresh comparison. The model can call tools inside a generated fixture repository. OpenCode and Pi outputs are shown side by side. The relay calls the model for OpenCode and replays each response to Pi, which removes sampling differences between the two runs.

Useful commands:

```text
:system    print every captured system message
:requests  print every complete provider request
:artifacts show the generated files for the last comparison
:quit      exit
```

To compare behavior against a copy of another project, set `HARNESS_FIXTURE_SOURCE` to its path. The source is copied before either harness runs.

The `bash` adapter does not implement OpenCode's permission gate. Commands start in the copied fixture, but a command using absolute paths still has the permissions of your account. Inspect model-generated commands before using this against an untrusted provider.

## Remaining differences

This is an implementation equivalence experiment, not a claim that the products are identical.

- OpenCode permissions, command parsing, plugin hooks, snapshots, formatter integration, LSP diagnostics, and event publication are not reproduced.
- `read` does not inject project instruction reminders. PDF attachments are reported but not sent as a native Pi image part.
- Long-output truncation saves files under the same configured directory, but generated filenames are not equal.
- The `task` adapter uses Pi's session store and generates a different opaque child session ID.
- Error presentation, cancellation races, image results, and every edge case have not been proven equal.
- Compaction, persistence, recovery, UI behavior, and permission UX remain harness behavior outside this tool experiment.

The narrow result is still useful. The default prompt, schemas, and the normal model-visible behavior of ordinary OpenCode tools fit in a Pi extension. `task` needs session orchestration, but it does not require modifying Pi's core.

OpenCode-derived material is covered by its MIT license. See [`THIRD_PARTY_NOTICE.md`](THIRD_PARTY_NOTICE.md).
