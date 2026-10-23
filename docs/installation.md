# Manual installation SOP

**English** | [简体中文](安装SOP.md) · [Home](../README.md)

Install the bridge and official Harness, save your own Key in Harness, and delegate directly from Codex. Once configured, daily use does not require manually starting a service or opening a webpage. This procedure targets Windows 11 and Node 24+. If you prefer not to use a terminal, use the [agent installation prompt](agent-setup.md).

## 0. Prerequisites and directories

You need access to GitHub and package registries, your own DeepSeek API account, and a local client that supports files and stdio MCP. Keep the two projects separate:

```text
AI-Tools/
  deepseek-harness/          Official executor, tools, and provider
    .local/dsh-home/         Settings and credentials for this installation
  codex-deepseek-harness/    This bridge, queue, supervision, optional dashboard
```

The commands below create a new installation. Reuse a compatible existing installation without resetting its source or deleting its settings. Stop at the first failed command and resolve the actual error before continuing. Never paste GitHub tokens or API Keys into chat.

## 1. Prepare Node, Git, and pnpm

Install or reuse [Node.js](https://nodejs.org/en/download) 24+ and [Git for Windows](https://git-scm.com/downloads/win). In a newly opened PowerShell, check:

```powershell
node --version
npm.cmd --version
git --version
pnpm.cmd --version
```

The tested Harness declares **pnpm 11.28.5**. Reuse that version if available. If it is missing and global tool installation is permitted on your machine:

```powershell
npm.cmd install --global pnpm@11.28.5
pnpm.cmd --version
```

A local agent may instead prepare a project-local pnpm. The `.cmd` spelling avoids PowerShell execution-policy restrictions on same-named `.ps1` launchers; do not loosen global execution policy. If a command is missing, check existing installations and PATH before reinstalling everything.

## 2. Download and build Harness

```powershell
$installRoot = Join-Path $env:USERPROFILE 'AI-Tools'
New-Item -ItemType Directory -Path $installRoot -Force
$harnessRoot = Join-Path $installRoot 'deepseek-harness'
git clone https://github.com/deepseek-ai/deepseek-harness.git $harnessRoot
Set-Location -LiteralPath $harnessRoot
git checkout --detach 687f282e8625c6b8d11ff58211a90524be2e4317
pnpm.cmd install --frozen-lockfile
pnpm.cmd run build
```

Both install and build must succeed. This commit is official **`dsh-v0.2.1-rc.2`**, a pre-release and the current [verified integration baseline](upgrade-20261018.md). It supports Flash 1017. Consult its [upstream README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/README.md) for platform prerequisites. Native packages normally use available prebuilt binaries; missing binaries or explicit source builds may need extra tools. Diagnose the error before installing large system components or changing permissions.

### Upgrading an existing Harness

Read [official releases](https://github.com/deepseek-ai/deepseek-harness/releases) and the target [upgrade guides](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/docs/upgrade-guide). Check CLI entry points, providers, plugin configuration, and persisted data.

1. Record the current commit, tool versions, and local changes. Preserve bridge configuration, MCP configuration, the actual Harness home, and local launchers. Any backup containing credentials stays local; do not display its contents.
2. Ensure every bridge sharing the installation has no active or queued tasks, then stop its daemon and the official Web service gracefully.
3. Fetch upstream. Fast-forward an existing branch only if local modifications can be preserved. Handle divergent branches or detached installations explicitly, or validate in a separate installation. Do not use destructive reset/clean commands or delete the data directory.
4. Use the target's declared pnpm version; reinstall locked dependencies and build. Update `harnessRoot` only if the location changes; retain the real `harnessHome`.
5. Update the bridge too. Since Harness 0.2.1, shipped headless ignores GUI-stored credentials by default. This bridge restores the official `credentials`, `authorization`, and `deepseek-account` rows in each task overlay; an older bridge may fail authentication even when a Key is saved.
6. Repeat environment and MCP checks, then an authorized small real task. If native mode is enabled, verify commands and tests as well. A successful build alone is not task acceptance.

## 3. Enter your own API Key in Harness

In the same PowerShell, still at the Harness source root:

```powershell
$harnessHome = Join-Path $harnessRoot '.local\dsh-home'
New-Item -ItemType Directory -Path $harnessHome -Force
$env:DSH_HOME = $harnessHome
pnpm.cmd dsh web
```

Use the webpage opened by the program, or its actual local address. This is the **official Harness settings UI**, not this bridge's dashboard.

| Screen | Action |
| --- | --- |
| Get started | Select **Add API Key**. |
| First-run API Key form | Paste your Key into **API key**, then **Save and continue**. |
| Existing configuration | **Settings → Models → DeepSeek (`deepseek-official`) → Edit → API key → Apply**. |
| No Key yet | [Create a Key](https://platform.deepseek.com/api_keys) and [add API credit](https://platform.deepseek.com/top_up) in your own DeepSeek account. |

Use the official provider's endpoint defaults unless you intentionally have another route. Do not place a second copy of the Key in bridge config, chat, MCP arguments, or GitHub. Do not ask the installation agent to read or screenshot it.

Harness stores credentials under this `DSH_HOME`. After saving, press Ctrl+C in the temporary Web-service terminal and wait for its prompt to return. Closing a browser tab alone does not stop that foreground process. You can check existence without reading secrets:

```powershell
Test-Path -LiteralPath (Join-Path $harnessHome '.credentials.yaml')
```

`True` proves only that the file exists, not that the Key works or has credit. For an existing installation, select its actual home instead. Upstream defaults to `~/.dsh` when `DSH_HOME` is unset. The bridge and GUI must use the same directory.

## 4. Download and configure the bridge

Download **Code → Download ZIP** from [this repository](https://github.com/WiscOBKenobi/codex-deepseek-harness-bridge), or clone it with your Git client. Extract it beside Harness. Select the root containing `package.json`, `README.md`, and four `.cmd` files.

On Windows, double-click **`配置本机.cmd`** (configure this machine). Select the Harness source root, then its data directory. If bridge dependencies are missing, allow the locked dependency installation and wait for success. This configures `config.json` and project `.codex/config.toml`; it does not download Harness or Node, enter a Key, or edit global Codex settings.

An agent or terminal user can use the equivalent path-based setup after installing bridge dependencies:

```powershell
Set-Location -LiteralPath '<bridge source directory>'
npm.cmd ci --ignore-scripts --no-audit --no-fund
node scripts/setup.mjs --harness-root '<absolute Harness root>' --harness-home '<actual absolute data directory>' --node-path '<absolute node.exe path>'
npm.cmd run check
```

Replace the angle-bracket paths. Preserve existing configuration rather than replacing it with a sample. Alternatively double-click **`检查环境.cmd`** (check environment). Checks do not consume API credit.

## 5. Select task capabilities

The template defaults to `files`. For native coding, commands, and tests, explicitly authorize and enable `agent` as described in [usage](usage.md#execution-modes). Preserve all unrelated config fields.

For long work, `maxRuntimeSeconds: 0` and `maxToolCalls: 0` remove bridge cutoffs. You may explicitly set `maxStreamBytes: 0` too. Normal completion still ends a task.

On some Windows folders, native sandbox initialization needs `WRITE_OWNER`. Optional `prepareWindowsWorkspaceAcl` handles only newly created empty task roots: it adds non-inherited permission for the original owner, initializes the official sandbox, then creates input/output. Enable only with authorization for that local permission change. It does not change owners, whole-drive permissions, or disable the sandbox. See [troubleshooting](usage.md#troubleshooting).

## 6. Connect MCP without calling a model

Open the bridge folder in your local Codex client. Handle project trust as required, then create a new chat or reload MCP. Existing chats may not hot-load the new configuration. Ask:

> Check whether codex_ds_harness is connected. List its tools, then list tasks. Do not submit a model task or read any API Key.

Expect seven tools: `submit_task`, `get_task`, `get_result`, `continue_task`, `cancel_task`, `list_tasks`, and `review_task`. Listing tasks starts the daemon if necessary but does not call DeepSeek. You do not need to open the dashboard.

A regular ChatGPT webpage does not load a local `.codex/config.toml`. Other clients need local stdio MCP support and their own configuration format. See [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

## 7. Verify one small task

This step consumes your DeepSeek API credit. When you are ready, ask:

> I authorize one small DeepSeek verification. Through the bridge's files mode, read examples/numbers.json and create output/result.json with count and sum. Independently inspect the actual file and check count=5 and sum=28, then record the review. Submit once; diagnose failure instead of repeatedly resubmitting.

Acceptance requires a successful run, an actual output file, and an independent check. A connected tool list or model claim alone is insufficient. If native coding is enabled, separately authorize a small command-and-test task; files verification does not test shell execution.

After setup, delegate and cancel in Codex. The dashboard is optional, and an idle service does not generate model requests.

## Completion criteria

| Area | Required outcome |
| --- | --- |
| Tools | Node 24+, locked dependencies installed, Harness build succeeded. |
| Paths | `harnessRoot` points to source; `harnessHome` matches the GUI's `DSH_HOME`. |
| Key | User saved it privately in Harness; no Key in shared source or task text. |
| Connection | Current client discovers seven tools and queries tasks. |
| Execution | An authorized small task produces independently verified files. |
| Scope | Native mode and optional Windows initialization reflect explicit authorization. |

The SOP is checked against the pinned source and [reported integration tests](upgrade-20261018.md). It is not a claim that every step was rerun on a blank machine. Other systems and missing components require their own verification.

## Optional event wake verification

Question/answer support needs no extra service. Automatic follow-up requires a local Codex CLI whose `codex queue --help` succeeds, an executable reachable by the daemon (`codexPath`), and the originating thread UUID (`submit_task.codexThreadId`). Do not run a paid verification until authorized. On Windows use the native Codex executable rather than a shell wrapper. See [event configuration](usage.md#event-wake-configuration) and [verification](question-verification.md). Binding must be explicit when an MCP process is shared; do not change global client configuration.
