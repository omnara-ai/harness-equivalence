# Pi as OpenCode

This experiment compares OpenCode with unmodified Pi loaded with one extension. The extension supplies OpenCode's system prompt, tool definitions, and compatible tool implementations.

At the pinned versions, Pi produces the same initial Responses API request as OpenCode. The test suite also replays model responses through real tool loops. OpenCode exposes nine tools to GPT-5.6 Terra. The extension implements all nine, and the tested ordinary tool paths produce equal parsed requests through the loop.

The `task` tool launches another agent. Pi does that too. Later request bodies differ because each harness generates its own child session state, including a cache key and an ID embedded in the tool result. The resulting child and parent behavior still matches.

## Versions

- OpenCode `1.18.22`, source commit `18b4cb6819d7de0b37927fef60d03927e678c9dd`
- Pi `0.84.3`, source commit `dcd461925db2edf69a43c8135db1180d418afd54`
- Model `gpt-5.6-terra`
- API `responses`, reasoning effort `medium`

## What is implemented

| Tool | Pi implementation | Provider-boundary coverage |
|---|---|---|
| `apply_patch` | OpenCode's patch grammar and file mutation behavior | Add and update in one patch |
| `bash` | Shell execution, working directory, timeout, combined output, and tail truncation | Successful short command |
| `glob` | OpenCode's ripgrep invocation and output format | Newly written file glob |
| `grep` | OpenCode's ripgrep JSON parsing and output format | Content match |
| `read` | Files, directories, line limits, byte limits, binary checks, and images | Text file |
| `skill` | Skill lookup, instruction loading, and sampled file list | Local and built-in fixture skills |
| `task` | Foreground child Pi session, general and explore tool sets, depth limit, and session resume | Behavior equal; later bodies differ by generated child session state |
| `todowrite` | Todo replacement, session entry, and result format | One completed todo |
| `webfetch` | Fetch limits and OpenCode's HTML to text or Markdown conversion | HTML to Markdown |

The tool schemas, names, descriptions, order, system prompt, model, messages, and request options are captured from OpenCode rather than maintained as a second handwritten contract.

The extension uses Pi's provider-request hook for one narrow transport normalization. OpenCode omits optional Responses item metadata when sending prior function calls and encrypted reasoning, while Pi includes it. The hook removes those fields only. It does not replace a request with the captured OpenCode payload.

The replay fixture includes opaque encrypted reasoning and verifies that both harnesses send the same encrypted payload on the next model call.

## Run the checks

From the repository root:

```sh
npm test
./verify
```

`./verify` compares a deterministic first request. `npm test` also runs replay tests through tool loops. OpenCode executes first. The fixture is then restored to its original bytes before Pi runs. A response is replayed byte for byte only when Pi's parsed request matches OpenCode's. A mismatch makes its own upstream call.

Generated captures and reports are written under `artifacts/verify/` and `artifacts/runs/`.

## Interactive comparison

```sh
export OPENAI_API_KEY=your-key
./repl
```

Each prompt starts a fresh comparison. The model can call tools inside a generated fixture repository. OpenCode and Pi outputs are shown side by side. When Pi sends the same parsed request as OpenCode, the relay gives it the exact same model response. If the requests differ, Pi makes its own model call.

Useful commands:

```text
:system    print every captured system message
:requests  print every complete provider request
:artifacts show the generated files for the last comparison
:quit      exit
```

The `bash` adapter does not implement OpenCode's permission gate. Commands start in the copied fixture, but a command using absolute paths still has the permissions of your account. Inspect model-generated commands before using this against an untrusted provider.

## Remaining differences

This is an implementation equivalence experiment, not a claim that the products are identical.

- OpenCode permissions, command parsing, plugin hooks, snapshots, formatter integration, LSP diagnostics, and event publication are not reproduced.
- `read` does not inject project instruction reminders. PDF attachments are reported but not sent as a native Pi image part.
- Long-output truncation saves files under the same configured directory, but generated filenames are not equal.
- The `task` adapter uses Pi's session store and generates different child session state.
- Error presentation, cancellation races, image results, and every edge case have not been proven equal.
- Compaction, persistence, recovery, UI behavior, and permission UX remain harness behavior outside this tool experiment.

The narrow result is still useful. The default prompt, schemas, and the normal model-visible behavior of ordinary OpenCode tools fit in a Pi extension. `task` needs session orchestration, but it does not require modifying Pi's core.

OpenCode-derived material is covered by its MIT license. See [`THIRD_PARTY_NOTICE.md`](THIRD_PARTY_NOTICE.md).
