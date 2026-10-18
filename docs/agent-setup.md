# Let your local agent install the bridge

**English** | [简体中文](交给Agent安装.md) · [Home](../README.md)

This route delegates the [manual SOP](installation.md) to an agent with local file, command, and network access. It installs the same bridge and official Harness. It does not replace your agent's model or supply someone else's API Key. A browser-only conversation cannot install local software from a repository link.

## Copy this installation request

Choose a location and change the mode or permissions below if needed. Sending the prompt with these options constitutes authorization for those specific actions; the installer should not repeatedly ask for the same approval.

```text
Install Codex × DeepSeek Harness on this computer:
https://github.com/WiscOBKenobi/codex-deepseek-harness-bridge

Location: use a separate AI-Tools folder writable by my user. Prefer a location I have already specified or an existing compatible installation.
Mode: agent. I authorize DeepSeek to run commands, install project dependencies, and run tests inside newly created task workspaces. Keep the native sandbox; do not automatically approve requests requiring extra permissions. I understand that Windows does not fully isolate reads or network access.
New workspace permissions: on Windows only, I authorize adding non-inherited WRITE_OWNER for the original owner of each new empty task workspace, followed by official sandbox initialization. Do not change ownership, other users, whole-drive permissions, or existing project trees.
Limits: no total duration, tool-count, or cumulative protocol-stream cutoff. Keep per-message and deliverable limits, cancellation, and stall warnings.
Real verification: after I save my Key, I authorize one small files check and one small agent command-and-test check. Diagnose failures instead of endlessly retrying.

Read README.md, AGENTS.md, docs/installation.md, and docs/agent-setup.md first. Preserve my main agent's selected model.
Check existing tools; download the compatible official Harness; install locked dependencies; build; configure bridge paths and project MCP; perform checks that need no model. Install tools only when missing, using official sources and preferably a project-local runtime. Explain any required large system component or wider permission change separately.
When a Key is needed, open the official Harness API Key form so I can enter it myself. Do not ask me to send it in chat, read it, echo it, or save it in this repository.
After setup, explain how to delegate from my main agent and cancel tasks. Daily use should not require manually opening or stopping a dashboard.
```

For file-only tasks, replace the mode authorization with `files` and omit native commands and the Windows ACL option. A machine's existing authorization does not transfer to another person's machine.

## Installer procedure

### A. Inspect and reuse

Inspect the requested directories, source changes, current Harness commit, build state, Node, Git, and pnpm. A missing command may be a PATH or shell issue. Reuse available installations; do not install large components preemptively or overwrite existing user configuration.

For a new Harness checkout, pin official `dsh-v0.2.1-rc.2` at `687f282e8625c6b8d11ff58211a90524be2e4317` and use its declared pnpm **11.28.5**. The checkout command in the SOP applies to a newly cloned directory. Existing installations follow the [upgrade procedure](installation.md#upgrading-an-existing-harness), preserving data and launchers. Check native command exit codes and stop the dependent sequence on failure.

### B. Build and configure

Install Harness dependencies with its lockfile, then build. For the bridge use `npm.cmd ci --ignore-scripts --no-audit --no-fund`. Dependency installation does not itself require a model task.

Choose the actual Harness data directory. For a new installation, the SOP uses `<Harness>/.local/dsh-home`; do not guess an existing home from its name. The GUI's `DSH_HOME` and bridge's `harnessHome` must match.

From the bridge root, configure existing paths without a GUI picker:

```powershell
node scripts/setup.mjs --harness-root '<absolute Harness root>' --harness-home '<actual absolute data directory>' --node-path '<absolute node.exe path>'
```

The script creates local `config.json` and project `.codex/config.toml`, preserving existing model choices and other MCP entries. It does not install Harness, read credentials, or safely rewrite every possible TOML layout. If it refuses an unsupported existing format, preserve the file and resolve the specific issue.

Apply only the user's authorized settings, retaining unrelated fields. Native mode requires `enableNativeAgent: true`; `defaultMode: agent` selects it when a request omits mode. Set the three cumulative limits to 0 only when chosen. Set `prepareWindowsWorkspaceAcl: true` only for authorized new Windows task directories.

Configure project MCP only. For another main-agent client, use its local stdio MCP format: `command` is the actual Node executable, `args` points to this bridge's `src/mcp-server.mjs`, and `cwd` is the bridge root. Do not change global model selection, expose ports publicly, or create a tunnel. Reloading the client or starting a new chat may be needed.

### C. Let the user save the Key; finish independent checks

Launch official `pnpm dsh web` with the same `DSH_HOME`. Direct the user to **Add API Key** or **Settings → Models → DeepSeek → Edit**. The user enters and saves it privately. Check only file existence; do not inspect `.credentials.yaml` contents or mistake existence for API validity.

Complete build, configuration, syntax checks, and MCP protocol checks while input is pending. Run `npm run check`; use `npm test` as appropriate. Report pass, failure, and skip separately. If only the unsaved credential file is missing, preserve the other completed preparation.

Through an MCP client, verify initialization, seven tools, and `list_tasks`. `tests/mcp.test.mjs` verifies the protocol implementation but cannot prove that the user's current client loaded the configuration. Report those two facts separately. No model submission is needed for discovery or listing.

The bridge restores stored authentication for the 0.2.1 headless profile with an official overlay. Do not work around an old bridge by copying the user's Key into an environment script or repository config.

### D. Verify and hand over

Only after API use is authorized and the Key is saved, execute the [small files task](installation.md#7-verify-one-small-task). Retain `requestId`; if the response is unclear, inspect the original task instead of blindly resubmitting.

When authorized, verify native mode with a tiny module and tests in a fresh task workspace. Require actual command execution and a report under `output`, then independently rerun the tests. For Windows initialization, exercise the real new-directory sequence, not just a config flag. Record `review_task` only after checking actual artifacts.

Do not publish task records, copied inputs, runtime logs, credentials, or local config. Select only enough paid work to validate the authorized behavior. A failure requires diagnosis, not disabling the sandbox or unbounded API retries.

| Handover item | Report without secrets |
| --- | --- |
| Installation | Both source directories, Harness commit, Node/pnpm versions, actual data directory. |
| Key | Whether the user saved it; no value. |
| Mode | files/agent, optional Windows initialization, limits. |
| MCP | Config location; whether the current main-agent client really discovers tools. |
| Verification | Keyless checks and actual paid task results, with independent artifact checks. |
| Daily use | Delegate or cancel in the main agent; no dashboard prerequisite. |
| Maintenance | Daemon starts on demand; manual shortcuts are for setup and maintenance. |
| Remaining scope | Unverified platforms, optional plugins, or concrete blockers. |

Installation does not include public hosting, a plugin marketplace, other users' data, or every optional upstream plugin. See [lifecycle](usage.md#cancel-continue-and-stop) for exact start/stop behavior.
