# Architecture and MCP API

**English** | [简体中文](架构与接口.md) · [Home](../README.md)

## 1. Purpose and data flow

Codex plans and delegates, DeepSeek executes through the official Harness, and Codex independently reviews. The local bridge adds an MCP interface, persistent queue, supervision, artifact access, and review records. It reuses upstream agent execution, tools, sessions, and credentials.

![Complete architecture](architecture.svg)

[Editable Mermaid source](architecture.mmd) · [Chinese diagram](architecture.zh-CN.svg)

Solid arrows show the normal task flow; dashed arrows show optional paths. Results return when queried. They do not wake an ended Codex turn.

**Codex/MCP is the primary entry point.** The selected Codex model plans and checks work; the bridge does not add a Codex/OpenAI API layer. DeepSeek requests use a separate account and billing path. **The dashboard is optional**, for monitoring or direct submissions; direct tasks require independent user or later Codex review.

The client starts MCP stdio. Tool discovery only lists interfaces. The first valid task operation connects to or starts the daemon. When queued work executes, the daemon starts official Harness headless. Neither the dashboard nor the original Harness Web service is a prerequisite. `cancel_task` stops one task; global maintenance shutdown is available to a main agent with local command access. A later task operation can restart the daemon.

## 2. Modules

| Module | Source | Responsibility |
| --- | --- | --- |
| MCP | [mcp-server.mjs](../src/mcp-server.mjs), [tools.mjs](../src/tools.mjs) | Seven tools through the official SDK, strict arguments, bounded responses. |
| RPC client | [client.mjs](../src/client.mjs) | Connect/start daemon, obtain local authentication, forward operations. |
| Daemon | [daemon.mjs](../src/daemon.mjs) | Own tasks, loopback HTTP and dashboard, singleton and shutdown lifecycle. |
| Task manager | [task-manager.mjs](../src/task-manager.mjs) | Serial queue, idempotency, mode, continuation, cancellation, state, persistence, reviews. |
| Harness runner | [harness-runner.mjs](../src/harness-runner.mjs), [child-lifecycle.mjs](../src/child-lifecycle.mjs) | Official headless startup, stored authentication, event parsing, limits, actual process exit. |
| Monitor | [harness-monitor.mjs](../src/harness-monitor.mjs) | Throttled model/tool progress metadata; supervisor heartbeat is tracked separately. |
| Workspace | [workspace.mjs](../src/workspace.mjs) | Validate/copy explicit inputs, collect output manifest, page files, detect artifact changes. |
| Files guard | [harness-guard.mjs](../src/harness-guard.mjs) | Restrict tools, paths, links, permissions, and size in files mode. |
| Windows initializer | [windows-workspace.mjs](../src/windows-workspace.mjs) | Authorized initialization of new empty task roots before descendants are created. |
| Configuration | [config.mjs](../src/config.mjs), [setup.mjs](../scripts/setup.mjs) | Local paths, model, project MCP; no global client changes. |
| Dashboard | [public](../public), [launcher.mjs](../src/launcher.mjs) | Optional Chinese UI for task operations and review. |
| Agent instructions | [SKILL.md](../.agents/skills/codex-ds-harness/SKILL.md) | Delegation scope, request IDs, supervision, independent checks. |

The daemon owns work, not MCP or a browser process. One queued task runs at a time. Each run uses its own Harness child process; continuation retains the task's session and workspace.

## 3. Execution modes and permissions

### Files mode

Distribution default. Only `read`, `write`, and `edit` are model-visible. Reads are confined to input/output; writes and edits to output. Execution checks regular files, real paths, symlinks, junctions, hardlinks, device paths, and Windows alternate data streams. No shell, browser, search, or subagent tool is provided.

### Native agent mode

Explicit opt-in removes the files-mode tool allowlist and uses the installed Harness headless tools. The agent may create a project, run commands, install permitted dependencies, and test inside its workspace. A plugin existing in the repository does not mean the active profile enables or configures it.

After authorization, merge these fields into local config rather than replacing the whole file:

```json
{
  "enableNativeAgent": true,
  "defaultMode": "agent",
  "maxRuntimeSeconds": 0,
  "maxToolCalls": 0,
  "maxStreamBytes": 0
}
```

`enableNativeAgent` controls permission to select agent mode; `defaultMode` controls omission. A default alone cannot bypass disabled native execution. You may enable agent while keeping files as default.

The runner retains native `workspace-write` and approval handling. Headless has no human approval responder and fails closed on requests requiring approval. Windows confinement is partial: the task directory is not complete read/network/process isolation. `readRoots` governs input copying, not an OS-wide agent read allowlist.

Both modes copy explicit inputs and deliver through output. Native project files outside output are not automatically returned. Old records without a mode mean files; continuation retains mode, limits, session, and directory. New inputs or a mode change require a new task.

### Optional Windows directory initialization

An owned folder can inherit Modify without `WRITE_OWNER`, causing `SetNamedSecurityInfoW` / `Win32 5`. Earlier failed initialization may also leave descendants without required sandbox inheritance. This is a specific filesystem setup issue, not a requirement for every Windows machine.

`prepareWindowsWorkspaceAcl` defaults false. With explicit authorization, new agent workspaces are prepared in this order:

1. Create and validate the exact empty task root; reject linked paths and ancestors, wrong ownership, or unverifiable paths.
2. Add non-inherited `WRITE_OWNER` only for the root's original owner when needed. Do not change ownership.
3. Initialize the root through the installed Harness public `AclWriteGrant` and `workspaceWriteSid` interfaces.
4. Create input/output and copy inputs only after initialization succeeds, so descendants inherit official capability permissions and the Low integrity label.

Files mode skips this preparation. Continuation does not recursively repair old directories. No descendant gets extra `WRITE_OWNER`, no whole-drive ACL is changed, and no sandbox is disabled. ACL changes persist; disabling the option does not undo existing filesystem permissions.

Failures include `NONEMPTY_WORKSPACE`, `WORKSPACE_OWNER_MISMATCH`, `WORKSPACE_ACL_DENIED`, `WORKSPACE_PATH_MISMATCH`, `WORKSPACE_ACL_PREPARE_FAILED`, `WINDOWS_SANDBOX_UNAVAILABLE`, and `WINDOWS_SANDBOX_PREPARE_FAILED`. The initializer never deletes existing data to pass a check. Diagnose old failed directories separately, preserving backups; an authorized reconstruction uses new objects and byte-verified copies rather than moving old ACLs back into place.

## 4. Limits and supervision

0 duration or tool-count limits mean no bridge cutoff; nonzero values constrain each run and cannot exceed configured project limits. Completion still exits. The daemon does not automatically keep prompting a finished model.

`maxStreamBytes` separately caps cumulative stdout JSON at 4 MiB by default. Setting 0 removes that cap, while each message remains bounded to 256 KiB. Output delivery size is separate again; it is not a quota for the agent's entire project directory.

`get_task.waitSeconds` is at most 25 seconds per query. It does not constrain task lifetime. A 15-second parent-supervisor heartbeat is distinct from recognized model/tool/job progress; stream progress is throttled to five seconds. The monitor does not save raw reasoning or tool bodies. A heartbeat does not refresh last-progress time or prove that a child event loop is responsive.

| Summary field | Meaning |
| --- | --- |
| `lastHeartbeatAt` | Last supervisor heartbeat. |
| `lastProgressAt` | Last recognized progress. |
| `health.state` | `healthy`, `suspected_stall`, or `stopped`. |
| `health.lastHeartbeatAt`, `health.lastProgressAt` | Same timestamps in the health view. |
| `health.lastProgressKind` | Most recent progress category. |
| `health.activeToolCount` | Observed active tools, possibly including native concurrent work. |
| `health.stallWarningSeconds` | Default 300-second no-progress threshold. |

A suspected stall is a warning, not an automatic kill or retry. Process health, successful execution, and accepted artifacts are separate facts. Local waiting uses no model tokens; Codex interpretation and DeepSeek execution have their own usage. The bridge cannot wake an ended Codex turn. Sleep/shutdown prevent continued work; recovery marks unfinished tasks interrupted and requires explicit continuation.

## 5. Seven MCP tools

The configured service is `codex_ds_harness`; a client may prefix internal tool names. No tool accepts a Key or changes the main agent's model. DeepSeek routing comes from local bridge config.

### submit_task

Immediately returns an accepted task summary, not completed execution.

| Argument | Constraints |
| --- | --- |
| `instruction` | Required, 1–32000 characters, not whitespace-only. Include goal, deliverables, checks. |
| `inputs` | Optional, up to 30 explicit absolute regular-file paths; no directories. |
| `mode` | Optional `files` or `agent`; defaults to local config, with agent enablement enforced. |
| `requestId` | Recommended, 8–128 letters/digits/dots/hyphens/underscores. Retain for one logical request. |
| `maxRuntimeSeconds` | Optional nonnegative integer; 0 cannot bypass a nonzero project cap. |
| `maxToolCalls` | Same semantics for tool count. |

```json
{
  "instruction": "Read input/numbers.json. Deliver count, sum, and average in output/result.json and a short output/report.md.",
  "inputs": ["<absolute project path>/examples/numbers.json"],
  "mode": "files",
  "requestId": "numbers-report-001",
  "maxRuntimeSeconds": 0,
  "maxToolCalls": 0
}
```

Replace the placeholder. Summary fields `mode` and `actualMode` report the registered mode. Reusing a request ID with identical arguments returns the existing task; different arguments conflict. Retain the ID before calling to avoid duplicate paid submissions after uncertain responses.

### get_task

Arguments: `taskId`, optional nonnegative `afterEvent` (default 0), and `waitSeconds` (0–25, default 0). Returns `{ task, events, nextCursor, eventsTruncated }`. Use nextCursor for incremental queries. Events are retained in a bounded window; truncation means older events are unavailable, not that a complete log was read.

### get_result

Arguments: `taskId`, optional `path`, `offset`, `maxBytes`. Without path, returns summary and manifest. With path, reads a bounded file segment under output.

- `path` is relative to output, e.g. `result.json`, not `output/result.json`, an absolute path, or traversal.
- `offset` is a nonnegative byte offset, default 0. `maxBytes` defaults to 12000, maximum 24000.
- Returns `task`, `summary`, `artifacts`, `review`, `changedSinceRun`, `reviewStale`, plus `file` when requested.
- Manifest entries include `path`, `size`, `sha256`. Text is in `file.content`; page with `file.nextOffset`. Inspect binary artifacts locally with an appropriate viewer.

The model summary is not a review. `changedSinceRun` compares current artifacts with the run-end snapshot; `reviewStale` flags changes since review. Files outside output are not automatically listed.

### continue_task

Arguments: `taskId`, new `instruction`, optional `requestId`. Requeues a terminal task with a valid session, retaining workspace, mode, and limits. Active tasks, missing sessions, or an agent task after native enablement is revoked are rejected. No additional inputs or mode switching. Review resets to pending. Interrupted tasks require explicit inspection first.

### cancel_task

Argument: `taskId`. Removes queued work or moves running work through cancelling until its process exits. Previously written files remain. Confirm a terminal state before claiming cancellation finished.

### list_tasks

No arguments. Returns `{ tasks: [...] }` with recent summaries in descending creation order. Query full events and artifacts separately.

### review_task

Arguments: `taskId`, `status` (`accepted` or `needs_changes`), and `note` (1–4000 characters describing actual checks). Reviews require terminal execution; accepted additionally requires succeeded. The stored artifact snapshot records what was checked but does not prove the reviewer ran tests. Manual dashboard reviews must not be presented as automatic Codex reviews. Feedback alone does not trigger another run.

### Responses and errors

Tools return structured data and concise text; failures are explicit, not disguised as empty lists. Typical errors include native mode disabled, rejected input, request conflict, active task, missing session, oversized output, and access failure. MCP stdout contains only protocol; diagnostics use stderr. Credentials and raw reasoning are not ordinary error output.

## 6. State and persistence

| Execution state | Meaning |
| --- | --- |
| `queued` | Accepted and waiting. |
| `running` | Harness executing; see health for progress. |
| `cancelling` | Waiting for exit and cleanup. |
| `succeeded` | Execution succeeded; review still required. |
| `failed` | Startup, execution, exit, or artifact validation failed. |
| `cancelled` | Cancellation finished. |
| `timed_out` | Configured nonzero duration exceeded. |
| `interrupted` | Recovery found unfinished work from an earlier daemon. |

Review is separately pending/accepted/needs_changes. Continuation resets it; changed artifacts can make it stale. A final model reply cannot substitute for successful process exit and artifact validation.

```text
config.example.json             Distributable template without credentials
config.json                     Local generated config
.codex/config.toml               Local generated project MCP config
.bridge/server.json             Daemon address and local authentication
.bridge/tasks/<id>/task.json     Requirements, inputs, mode, runs, health, review
.bridge/tasks/<id>/workspace/
  input/                        Input copies
  output/                       Delivered manifest source
  ...                           Agent project and temporary files
```

Records are written atomically. Client disconnect does not clear the queue. Shutdown ends active work; unexpected recovery preserves records and does not repeat API requests automatically.

## 7. Credentials and local access

The Key stays in external Harness storage. The runner sets `DSH_HOME`, removes inherited `DEEPSEEK_API_KEY`, and explicitly restores the official `credentials`, `authorization`, and `deepseek-account` rows that shipped headless 0.2.1 disables. Harness loads its own saved credential. The selected `deepseek-official` route remains unchanged; no Key is copied through MCP, dashboard tasks, or bridge config. This follows the [upstream restoration patch](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/headless/README.md#credentials).

Each run disables telemetry and session uploads. Local Harness history needed for continuation still exists; disabled upload does not mean no local records. Requirements, inputs, results, and reviews are private local data and must not be bundled wholesale.

The daemon listens on a random 127.0.0.1 port with local authentication in its state file. The dashboard launcher supplies an auth fragment, which the page removes from the address and retains in its browser session. Requests validate authentication, Host, and Origin; no cross-origin access is exposed. This targets one local user, not public hosting or strong protection against malicious same-user processes.

## 8. Maintenance and distribution

The repository excludes external Harness, Node, installed dependencies, credentials, and runtime data. Windows setup can install missing bridge dependencies using existing npm; the setup CLI only configures paths. The tested source baseline is [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317), **0.2.1-rc.2**. Check launch, plugins, events, cancellation, persistence, and credentials on later upgrades.

Use [package.json](../package.json) for actual commands: `npm ci`, `npm run check`, `npm test`. Live scripts consume API credit. `npm run test:ui` requires separately available Playwright and Edge (`msedge`), with optional `PLAYWRIGHT_MODULE`; normal dependencies do not install Playwright. See [verification](upgrade-20261018.md).

Implemented: MCP delegation, persistent tasks, two modes, supervision, continuation/cancellation, artifact review, optional dashboard. Not implemented: waking finished Codex turns, execution across powered-off machines, public hosting, unbounded automatic rework, or automatic setup of every plugin.
