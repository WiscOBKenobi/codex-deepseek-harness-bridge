# Usage guide

**English** | [简体中文](使用说明.md) · [Home](../README.md)

## Main entry point

Ask Codex to delegate selected work, then inspect and independently review the actual deliverables. Codex retains the model selected in your client; the bridge adds no Codex/OpenAI API layer. The optional Chinese dashboard can monitor tasks or submit directly to DeepSeek. Direct submissions do not automatically pass through Codex planning and review.

Choose [manual installation](installation.md) or [agent installation](agent-setup.md). Preserve local `config.json` (paths, model, input roots, limits) and `.codex/config.toml` (project MCP startup). Neither file is distributed. Migration to another computer requires that computer's paths and its owner's Key.

## First task and automatic startup

Open the project in a local Codex client and load `codex_ds_harness`, handling project trust and starting a new chat if required. A normal ChatGPT webpage does not read local project config. See [official MCP guidance](https://learn.chatgpt.com/docs/extend/mcp).

| Trigger | What starts | Model request? |
| --- | --- | --- |
| Client loads MCP | MCP stdio process | No. |
| First valid task operation | Local daemon, or connection to an existing one | Listing/querying does not call DeepSeek. |
| Submitted/continued task begins executing | Its own official Harness headless process | Yes, as required by the task. |

Tool discovery alone does not start a Harness task. You do not need the dashboard or original Harness webpage open. An idle daemon never creates model work by itself.

Example:

> Use the Harness MCP to have DeepSeek read examples/numbers.json, calculate count, sum, and average, and write output/result.json plus a short explanation. Read the actual files and independently verify the calculations before accepting them.

Codex supplies absolute input paths, retains the task ID, observes progress, and reads the results. For native coding after authorization and enablement:

> Delegate this small feature in agent mode. Build an example in its task workspace, install permitted project dependencies, run tests, and deliver inspectable source and test evidence under output. Review the files before integrating them into my project.

Available commands, browser tools, search, and subagents depend on the actual Harness configuration. Selecting `agent` does not install every optional plugin.

## Using another project

The Harness and bridge installation paths are saved once. You do not need to repeat them in every prompt. However, this repository's setup writes **project-local MCP configuration**, not a global registration for every project.

When opening another project, have the main agent connect to the same bridge through that client's supported MCP configuration. Its launch command points to the installed Node, `src/mcp-server.mjs`, and the bridge root as `cwd`. Preserve other MCP entries. Alternatively, use an existing authorized global MCP registration if you already have one; this installer does not create one automatically.

Explicitly authorize any additional input directory before adding it to bridge `readRoots`. The default is the bridge project only. Sharing an installation also shares its daemon, queue, and local model configuration; it does not create per-project independent accounts.

Reusable task prompt:

> Use the already configured codex_ds_harness MCP to delegate only the work I authorize to DeepSeek. Preserve my current main-agent model and saved DeepSeek model settings. State the task scope, explicit input files, deliverables under output, and acceptance criteria. Reuse one requestId for each logical submission; query existing state before retrying an unclear response. Observe progress with cursors, inspect suspected stalls, read actual outputs, and independently verify code or calculations before recording review_task. Integrate only approved results into this project. Do not read Keys, widen input permissions, or change execution mode without authorization.

## Execution modes

| Mode | Behavior |
| --- | --- |
| `files` (default) | Only `read`, `write`, `edit`; reads input/output, writes output. No shell, dependency installation, browser, or subagents. |
| `agent` (opt-in) | Native Harness tools in an independent task workspace, subject to installed plugins and native permissions. |

The template uses `defaultMode: files` and `enableNativeAgent: false`. To authorize native coding, retain other config fields and set `enableNativeAgent: true`; optionally set `defaultMode: agent`. Changing the default alone cannot bypass enablement. Settle active work before restarting the daemon to apply configuration.

Old task records without a mode mean `files`. Continuation retains the original mode, limits, directory, and session. Create a new task for new inputs or a different mode.

## Inputs and deliverables

```text
.bridge/tasks/<task-id>/
  task.json            Requirements, state, runs, supervision, review
  workspace/
    input/             Copies of explicitly selected files
    output/            Deliverables for independent review
    ...                Agent project, dependencies, temporary files
```

`inputs` accepts up to 30 explicit absolute regular-file paths, not directories or globs. Each source must be inside an authorized `readRoots` entry. An authorized root is not automatically imported. Files retain their basename, so duplicate input names are rejected.

Copying rejects links, sensitive locations and filenames, and recognized secret patterns. Detection cannot replace the user's judgment about what may be sent to DeepSeek. Native `agent` isolation on Windows is partial; independent directories and `readRoots` do not constitute a complete OS read/network sandbox.

Only `output` enters the deliverable manifest. Project dependencies or temporary files elsewhere in the workspace are not automatically returned. The bridge never applies artifacts to the original project. A model's final summary is not independent verification.

## Long-running work

`maxRuntimeSeconds=0` and `maxToolCalls=0` mean no bridge cutoff. Tasks still end on completion, failure, cancellation, or denied permissions; the bridge does not endlessly reprompt the model. Nonzero project limits cannot be enlarged or bypassed with 0 in a task request. Continuation retains the original limits.

A `get_task` call can wait at most 25 seconds. That is a query timeout, not the task lifetime. Cursor-based incremental queries avoid rereading old events.

| Signal | Meaning |
| --- | --- |
| 15-second supervisor heartbeat | The parent supervisor is running; not proof of child progress. |
| Recognized progress | Model stream, tool start/end, or background output metadata was observed. |
| `suspected_stall` after 300 seconds without progress | Inspect recent activity; it does not automatically kill or retry the task. |

A long quiet command can be legitimate. Inspect the active tools and last progress before deciding to wait or cancel. Local waiting and heartbeat processing do not generate model tokens. Codex reading and interpreting state consumes its own usage; DeepSeek execution is billed separately. No cutoff is not a promise of free usage or unlimited context.

The bridge cannot wake a finished Codex turn. Automatic follow-up requires scheduling supplied by the client. Sleep prevents continued execution; shutdown or daemon failure interrupts work. Restored incomplete tasks become `interrupted` and require explicit inspection and continuation.

## Cancel, continue, and stop

| Action | Effect |
| --- | --- |
| Close dashboard/Codex or disconnect MCP | Submitted background work continues while the computer and daemon run. |
| `cancel_task` | Stops one queued or running task; preserves written files. Wait for a terminal state. |
| Stop service | Ends active work, cancels queued tasks, closes this daemon. |
| Continue | Reuses a terminal task's valid session and workspace with explicit follow-up instructions. |
| Accept review | Records an independent check; does not apply or publish files. |

The seven tools contain no global daemon shutdown. A main agent with local command access can use the maintenance stop entry point; MCP-only access can cancel individual tasks. A later valid task operation starts the daemon again. To stop using the integration entirely, disable its MCP configuration and stop its daemon.

Use a stable `requestId` for each submit/continue request. If the response is unclear, query the existing task or reuse the same ID. A new ID can duplicate paid work.

Continuation resets review to `pending`. `accepted` is allowed only after a successful run and should refer to the latest actual files. `needs_changes` records feedback but does not start another run. After interruption, inspect preserved output; continue only with a valid session, otherwise submit explicitly as a new task.

## Optional dashboard and Windows shortcuts

| Filename | Purpose |
| --- | --- |
| `配置本机.cmd` | Select existing Harness/home paths and configure local files; may install missing bridge dependencies. |
| `检查环境.cmd` | Check local prerequisites; does not validate API credentials or credit. |
| `打开任务面板.cmd` | Open the authenticated local dashboard, starting the daemon if needed. |
| `停止任务服务.cmd` | Stop this service and its active/queued tasks; does not close Codex or uninstall Harness. |

The dashboard is local and Chinese-language. Use its launcher rather than constructing an authentication URL. Closing the browser does not stop tasks. Leaving it open does not create model requests. To have Codex review a dashboard task, ask it to inspect that existing task rather than submitting it again.

## Model and credentials

The Key remains in the Harness home. Enter or replace it in the original Harness settings. The bridge passes the home path and restores the official stored-authentication composition in headless 0.2.1; it does not transfer the Key through MCP.

The default route is `provider: deepseek-official`, `model: deepseek-flash`, `reasoningEffort: max`. These fields in local `config.json` choose the model independently of the GUI's current selection. The Key identifies the account, not a single model.

As verified on **2026-10-18**, [DeepSeek's API mapping](https://api-docs.deepseek.com/quick_start/pricing/) maps `deepseek-flash` to **DeepSeek-V4.1-Flash-1017**. Keep the supported API name; do not invent a dated model ID from a release title. A future server-side alias update may change the served version without a new Key. An upstream Harness update may still be required for tool behavior; the [1017 announcement](https://api-docs.deepseek.com/news/news261017/) recommends Harness 0.2.1-rc.1 or later. This project's tested baseline is 0.2.1-rc.2.

| Setting | Distribution default | Meaning |
| --- | --- | --- |
| `defaultMode` | `files` | Mode when omitted. |
| `enableNativeAgent` | `false` | Explicit native execution enablement. |
| `prepareWindowsWorkspaceAcl` | `false` | Authorized initialization of new empty agent workspaces. |
| `maxRuntimeSeconds` | `0` | No bridge duration cutoff; nonzero applies per run. |
| `maxToolCalls` | `0` | No bridge tool-count cutoff. |
| `maxStreamBytes` | `4194304` | Cumulative JSON stdout cap; 0 removes it. |
| `stallWarningSeconds` | `300` | No-progress warning threshold. |
| `maxInputBytes` | `2000000` | Total copied-input limit. |
| `maxOutputBytes` | `5000000` | Deliverable collection limit; also constrains files-mode writes. |
| `readRoots` | `["."]` | Allowed explicit input sources, relative to bridge root. |

Even with `maxStreamBytes: 0`, each protocol line is limited to 256 KiB. Protocol traffic, output deliverables, and agent project disk usage are separate limits; output size is not a whole-workspace disk quota. Settle active work and restart the daemon after config changes.

## Troubleshooting

**Tools missing:** check project MCP creation and current-client loading. File existence does not prove connection. The installer does not register MCP globally in all projects.

**Saved Key but authentication fails after upgrade:** use the updated bridge that restores stored authentication for headless. Confirm the GUI and bridge use the same home. Check account errors privately; never paste the Key into task text.

**Permission request or input denied:** files mode only accesses input/output. Headless has no human approval responder and fails closed on operations requiring additional approval. Diagnose scope and prerequisites without bypassing protections.

**Windows `SetNamedSecurityInfoW` / `Win32 5`:** owning a directory does not imply inherited Modify includes `WRITE_OWNER`. After a failed initialization, old descendants may also lack expected sandbox inheritance. Diagnose before changing ACLs. If explicitly authorized, enable `prepareWindowsWorkspaceAcl`: validate a new empty owned workspace; add non-inherited `WRITE_OWNER` for its original owner; initialize the official root ACL; then create input/output and copies. Owners remain unchanged, no whole-drive ACL is changed, and the sandbox stays enabled.

This option defaults off. It does not recursively repair existing tasks, change descendant `WRITE_OWNER`, or automatically undo persistent ACL changes when disabled. Nonempty, incorrectly owned, linked, or unverifiable directories fail explicitly. Preserve failed task data; any reconstruction needs a specific plan using new objects and byte-verified copies, not deletion or an assumed repair by continuation.

**Missing plugin:** verify the external Harness installed and enabled it, along with its prerequisites. Native mode is not an all-plugins installer.

**Heartbeat but no artifacts:** inspect last progress and active tools. A heartbeat is not completion evidence.

**Interrupted after restart:** inspect artifacts and session availability before an explicit continuation; no automatic replay occurs.

**Need periodic Codex follow-up:** arrange supported client scheduling separately. The bridge's heartbeat is not a Codex scheduler.

## Distribution

Share source, docs, examples, and tests. Recipients install their own prerequisites and enter their own Key. Exclude `config.json`, generated `.codex/config.toml`, `.bridge`, dependencies, and local runtimes. Share only explicitly selected deliverables, not complete task folders. See [architecture/API](architecture.md) and [verification](upgrade-20261018.md).
