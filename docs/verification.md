# Initial v0.2.0 verification record

**English** | [简体中文](验收记录.md) · [Home](../README.md)

For the new question and event-wake feature, see [October 23 verification](question-verification.md). Historical limitations below describe the initial release.

For current compatibility, see the [October 18 upgrade](upgrade-20261018.md). The [September 30 report](upgrade-20260930.md) records the intervening upgrade. This page preserves the **September 27, 2026** initial verification; its versions and counts are historical.

Environment: Windows 11, Node 24.19.0, MCP SDK 1.30.1, zod 4.3.6; upstream Harness commit `477b4f420553e8a52c2fbccc464d7561b239c443`. No upstream source, global Codex config, or copied API Key was required.

## Delivered capabilities

Seven MCP tools, an independent daemon and queue, files/native modes, persisted results, continuation/cancellation, heartbeat and stall supervision, separate reviews, a Chinese dashboard, and four Windows shortcuts. Codex retained its selected model; official Harness headless executed DeepSeek tasks.

Native mode was explicitly authorized locally; the distribution template still defaulted to files with native execution and Windows directory initialization off. Zero duration/tool limits were supported without automatic endless retries.

## Checks performed at that time

| Check | Historical result |
| --- | --- |
| Full regression | 117 passed, 0 failed/skipped, including real local Harness integration. |
| Official file-tool integration | Only edit/read/write; 7 denial paths; no model request. An isolated home avoided personal credentials and sessions. About 2.3 seconds alone and about 2.7 seconds each with three concurrent instances. |
| Fresh Windows CI | Passed; only the external Harness integration explicitly skipped because that installation was absent. [Workflow](https://github.com/WiscOBKenobi/codex-deepseek-harness-bridge/actions/workflows/check.yml). |
| Windows initializer | 35 tests, including actual PowerShell read-only module compatibility, initialization-before-descendants, and no recursive old-tree migration. |
| Native Windows confinement | Fresh-directory preparation and actual child execution: inside write succeeded, outside write denied, sentinel unchanged; no model request. |
| Real files | Two MCP/Harness/DeepSeek runs, 7 file tool calls, same-session continuation, independently checked artifacts, accepted review. |
| Real native agent | Same-session continuation; final run 10 tool calls, 6 actual tests passed, independent rerun exited 0, accepted. |
| Browser behavior | 18 checks, 0 page errors: submit, authentication, preview, continue, cancel, review, stale review after artifact edits. Real service with a simulated runner, no model call. |
| Visual layout | Desktop 1440px and narrow 390px, no horizontal overflow; HTML-like outputs displayed as text. |
| Windows shortcuts | All four CMD files used CRLF and passed actual cmd.exe --self-test. |
| Setup/config | 11 tests preserving model choices, permissions, and other MCP entries; rejected unsupported formats and linked directories. |
| Syntax/environment | 38 JavaScript files; prerequisite paths and credential-file existence checked without reading the Key. |
| Diagrams/skill | Mermaid parsing, SVG rendering, and skill structure checks passed. |

Keyless tests do not call external models. The official Harness integration explicitly skips when its external installation is absent; other tests continue. Commands are in [maintainer instructions](../AGENTS.md).

## Real tasks and the Windows repair

Real tasks used the saved Harness credential and existing `deepseek-official / deepseek-flash / max`. The MCP client connected through the official SDK; the bridge launched official headless rather than directly calling a model endpoint.

The files task copied an input with a random marker, produced count=5 and sum=28, then continued the same session to set status=verified. Actual disk content, marker, and calculations were checked.

The first native command exposed a Windows permission failure and was not reported as success. With explicit authorization, only the workspace original owner received non-inherited WRITE_OWNER. Old descendants were preserved; new objects received byte-copied files with hashes checked. Keyless inside-write/outside-denial checks passed before continuing the same model session. The generated module and six tests were inspected and rerun independently.

The optional new-task initializer subsequently implemented empty root → root permission preparation → official ACL initialization → descendants → input copies. A separately authorized fresh actual prepareWorkspace check succeeded with inside-write/outside-denial and unchanged sentinel. Windows PowerShell modules were loaded explicitly to avoid incompatible cross-version module paths.

Task/session IDs, checkpoints, inputs, and artifacts stayed in ignored `.bridge`. Live scripts reuse checkpoints unless explicitly asked for a new paid run.

## Limits

- Protocol checks do not prove an existing Codex chat hot-loaded a new project MCP entry.
- Browser checks covered local Edge, not all browsers or Windows versions. Graphical folder picking and missing-dependency installation were not manually verified end to end.
- Native file editing and commands were tested; paid dependency installation, browser, search, and subagent plugins were not.
- Windows confinement remained partial. Human approval requests failed closed.
- No 24-hour endurance run was performed. Unlimited configuration, segmented timers, separate heartbeat/progress, stalls, cancellation, and recovery had automated coverage.
- Local waiting creates no model request; Codex interpretation and DeepSeek work consume their respective usage. The bridge cannot wake ended Codex turns or run during shutdown/sleep.
- Output size is not a workspace disk quota; duration and tool-count caps are not monetary caps.
- Reviews refer to SHA-256 artifact snapshots; changed files require rechecking. Execution success alone is not acceptance.
- Runtime data is private. Raw reasoning, raw stderr, and API Keys are not retained in bridge logs; requirements, copied inputs, results, and bounded progress remain locally.
