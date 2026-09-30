# 安装 SOP：用户手动操作

目标：在自己的电脑安装连接程序与 DeepSeek Harness，在 Harness 中填写自己的 API Key，最后从 Codex 直接委派任务。安装完成后，日常使用不需要手动启动服务或打开网页面板。

本流程以已验证的 Windows 11 + Node.js 24 环境为基准。手动流程包含少量 PowerShell 命令；不想操作终端，请改用 [交给自己的 Agent 安装](交给Agent安装.md)。两条流程安装的是同一套程序。

## 0. 准备条件与目录

你需要可以访问 GitHub 和软件包仓库的网络、自己的 DeepSeek API Key，以及支持本机文件和本地 stdio MCP 的 Codex 客户端。本项目源码可从 GitHub 下载。不要为了下载而把 GitHub 令牌或 API Key 发到聊天里。

推荐把两个项目放在同一个父目录，互不覆盖：

```text
AI-Tools/
  deepseek-harness/          官方 Harness：执行器、工具及模型接入
    .local/dsh-home/         此安装专用的设置与凭据目录
  codex-deepseek-harness/    本项目：Codex MCP、队列、监督、可选面板
```

下面命令只适用于创建新的安装目录。若已安装 Harness，保留原目录、版本、数据和凭据；核实兼容性后直接复用，不在已有工程中强制 checkout、删除文件或重复安装。每一步出错时先处理错误，不继续粘贴下一步。

## 1. 准备 Node、Git 和 pnpm

安装或复用 [Node.js](https://nodejs.org/en/download) 24 或更高版本，以及 [Git for Windows](https://git-scm.com/downloads/win)。重新打开 PowerShell 后逐条检查：

```powershell
node --version
npm.cmd --version
git --version
pnpm.cmd --version
```

本项目需要 Node 24+；对接的 Harness 基线在 package.json 中固定 pnpm 11.7.0。如果已有相同版本，无需再次安装。仅当缺少这个版本时，在你允许安装 npm 全局工具的环境执行：

```powershell
npm.cmd install --global pnpm@11.7.0
pnpm.cmd --version
```

Windows 示例使用 npm.cmd、pnpm.cmd，避免同名 PowerShell 脚本被执行策略拦截；不需要为这些命令放宽全局执行策略。这一步只安装 pnpm，不安装模型，也不会调用 DeepSeek。若命令不存在，先核对已有安装和 PATH；不要先认定整套环境都需要重装。

## 2. 下载并构建官方 Harness

以下示例使用当前用户可写的 AI-Tools 目录。也可以换成你自己的安装目录；之后所有路径须保持一致。

```powershell
$installRoot = Join-Path $env:USERPROFILE 'AI-Tools'
New-Item -ItemType Directory -Path $installRoot -Force
$harnessRoot = Join-Path $installRoot 'deepseek-harness'
git clone https://github.com/deepseek-ai/deepseek-harness.git $harnessRoot
Set-Location -LiteralPath $harnessRoot
git checkout --detach 639ed015397290b3745d163aafe02ffee4aa3f84
pnpm.cmd install --frozen-lockfile
pnpm.cmd run build
```

最后两步须成功结束。这个固定提交对应官方 `dsh-v0.2.0-rc.2`，是本流程的安装基线；兼容性以 [验收记录](验收记录.md) 为准，不代表任意最新版都兼容。安装完成后按第 6、7 步核验本机接入与任务执行，日后升级也须重新验证。参考 [上游该版本 README](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/README.md)。

标准 Windows 安装优先使用原生依赖提供的预构建文件；预构建缺失或强制源码编译时，仍可能需要额外工具。遇到错误先查对应上游说明，不通过关闭沙箱跳过，也不预先安装 Docker、WSL 或整套大型编译环境。

### 更新已有 Harness

已有安装不要重做克隆和初次配置。先查看 [官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases) 和 [该提交的升级指南目录](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84/docs/upgrade-guide)，核对 headless 入口、提供方、插件及数据迁移是否影响本连接程序；确认目标版本已完成兼容验收再升级。

1. 记录当前 Harness 提交与工具版本，确认源码修改和分支状态；保留本项目 config.json、项目 MCP 配置、Harness 的实际数据目录及本机 Node、pnpm 和启动器。需要备份时仅留在本机，不打开或输出凭据内容。
2. 查询本项目任务列表，待活动和排队任务都结束后停止后台；如果官方 Harness 网页服务也在运行，先正常关闭。更新共用安装会影响所有使用它的项目。
3. 获取官方更新。已有分支只在可以快进且不会覆盖本机修改时快进；存在改动、分叉或独立固定提交时，先处理具体情况，必要时另建安装目录核验。不要执行 git reset 或 git clean，也不要为了升级删除数据目录或重复配置 Key。
4. 在选定的 Harness 目录使用其声明的 pnpm 版本，重新执行 `pnpm.cmd install --frozen-lockfile` 和 `pnpm.cmd run build`；每一步成功后才继续。目录改变时再更新桥接的 harnessRoot，harnessHome 仍指向原来的实际数据目录。
5. 重新检查环境与 MCP 连接，按第 6 步查询任务列表。在已获 API 调用授权时，再做第 7 步小文件任务；启用了 agent 时，还要核验原生命令和测试。没有完成这些检查时，标记升级待验收，不宣称可以正常执行任务。

## 3. 打开 Harness，并亲自填写 API Key

仍在 Harness 目录的同一 PowerShell 中执行：

```powershell
$harnessHome = Join-Path $harnessRoot '.local\dsh-home'
New-Item -ItemType Directory -Path $harnessHome -Force
$env:DSH_HOME = $harnessHome
pnpm.cmd dsh web
```

使用程序自动打开的网页，或终端实际显示的本机地址，不照抄其他电脑的端口。这里打开的是 **官方 Harness 的设置界面**，不是本项目的任务面板。

| 页面状态 | 你要做什么 |
| --- | --- |
| 先出现“开始使用 / Get started” | 点击“添加 API Key / Add API Key”，进入密钥输入页，无需先登录。 |
| 首次出现“添加一个 API Key 开始使用” | 在“API 密钥 / API key”字段粘贴你自己的 Key，点击“保存并继续 / Save and continue”。 |
| 已跳过引导或要更换 Key | 打开“设置 / Settings”→“模型 / Models”→官方 DeepSeek 提供方的“编辑 / Edit”，填写 API key，点击“保存 / Apply”。提供方标识为 deepseek-official。 |
| 没有 Key | 先到 [DeepSeek 开放平台](https://platform.deepseek.com/) 创建自己的 API Key，再回到上述输入框。 |

默认服务地址使用该版本官方提供方的默认值即可，不要在本项目中另填一份 Key。不要把 Key 填入 Codex 对话、任务指令、config.json、项目 MCP 配置或 GitHub 文件，也不要让安装 Agent读取或截图密钥内容。

保存的凭据由 Harness 管理，位于这次指定的 DSH_HOME 下的 `.credentials.yaml`。这里只需要记住数据目录路径，不需要打开文件查看内容。保存成功后，回到刚才启动 Web 的 PowerShell，按 Ctrl+C 结束这个临时设置服务；如提示是否终止批处理，确认终止。等待命令提示符回来，再执行下面的存在性检查。只关闭网页标签不会结束这个前台进程。

可以只检查文件是否存在：

```powershell
Test-Path -LiteralPath (Join-Path $harnessHome '.credentials.yaml')
```

应返回 True；这仅证明已创建凭据文件，不证明 Key 有效或有额度。之后本项目会直接启动官方 headless 执行任务，不要求原 Harness 网页或刚才的设置服务一直开着。如果使用已有 Harness 且未指定 DSH_HOME，其默认数据目录为用户目录下的 `.dsh`；后面的配置必须选择实际使用的同一个目录。

## 4. 下载本项目，并配置本机

从 [GitHub 仓库](https://github.com/WiscOBKenobi/codex-deepseek-harness-bridge) 的 Code → Download ZIP 下载源码并解压，或使用有访问权限的 Git 客户端克隆。选择解压后包含 package.json、README.md 和四个 .cmd 文件的那一层，不要把它放进官方 Harness 内部。

双击 **配置本机.cmd**，依次完成：

1. 选择第 2 步的 deepseek-harness 源码根目录。
2. 选择第 3 步的 `.local/dsh-home` 数据目录；已有安装则选择它实际使用的数据目录。
3. 若提示缺少本项目依赖，允许安装锁文件中的依赖，等待成功提示。

这个配置入口会查找已有 Node，按需安装连接程序依赖，然后生成 `config.json` 与项目 `.codex/config.toml`。它不会下载或构建 Harness、安装 Node、替你填写 Key，也不会改全局 Codex 配置。

随后双击 **检查环境.cmd**，应看到所需文件检查通过。遇到 Node 不存在，先重新打开客户端以更新 PATH，或重新选择已有 Node；不要在配置里粘贴别人的绝对路径。对路径的检查不会消耗 DeepSeek 额度。

## 5. 选择任务能力

发布模板默认 files，只处理指定文件。若需要编码、运行命令和测试，按 [使用说明中的模式设置](使用说明.md#4-agent-与-files-怎样选择) 在本机明确启用 agent；保留已有路径和其他字段，不用示例 JSON 覆盖整个配置。

希望长期工作时可保留 `maxRuntimeSeconds: 0`、`maxToolCalls: 0`，并明确将 `maxStreamBytes` 设为 0。它们表示不按这些累计数值截断任务，任务正常完成仍会退出。

Windows 的可选 `prepareWindowsWorkspaceAcl` 只处理新建任务空目录，涉及给原所有者补非继承 WRITE_OWNER，再由官方沙箱初始化；需要用户同意这项局部目录权限变更后再启用。不更改 owner、不改整盘权限、不关闭沙箱。详细条件与旧任务处理见 [故障处理](使用说明.md#10-常见问题)。不熟悉配置编辑时，可把这一步交给主 Agent，明确你选择的模式和授权范围。

## 6. 在 Codex 接入，先做不计模型调用的检查

在 Codex 中打开本项目文件夹，按客户端提示确认项目信任，然后新建对话或重新加载 MCP。已有旧对话不保证立即加载新增工具。

对 Codex 说：

> 检查本项目的 codex_ds_harness MCP 是否已连接，列出工具，再查询任务列表。不要提交模型任务，也不要读取任何 Key。

成功标准：能发现 submit_task、get_task、get_result、continue_task、cancel_task、list_tasks、review_task 七个工具，并能取得任务列表。仅查询会按需启动本项目后台服务，但不会提交 DeepSeek 模型任务；不需要先双击“打开任务面板”。

Codex 的项目 MCP 配置只在受信任项目中加载；普通 ChatGPT 网页不会读取电脑里的 `.codex/config.toml`。其他主 Agent 需要支持本机 stdio MCP，并按其客户端格式接入；不能只把网址发给无法操作本机的网页聊天就视为已安装。[OpenAI 官方 MCP 说明](https://learn.chatgpt.com/docs/extend/mcp)

## 7. 做一次小任务验收，再开始日常使用

下面这一步会调用 DeepSeek 并消耗自己的 API 额度。愿意验证时，对 Codex 说：

> 允许做一次小规模 DeepSeek 验收。用本项目 MCP 的 files 模式读取 examples/numbers.json，生成 output/result.json，包含 count 和 sum。你独立读取实际结果，检查 count=5、sum=28 后记录验收。只提交一次；失败时报告原因，不自动反复重试。

应同时看到任务执行成功、实际 output 文件存在、主 Agent 独立核对通过；仅“工具已连接”或模型声称完成都不算真实任务验收。若启用了 agent，后续再用一个明确授权的小编码任务检查命令及测试能力，不能把 files 验收当作原生命令验收。

安装完成后，只需在 Codex 中交代“把这个任务交给 DeepSeek，完成后你验收”。取消任务也在对话里说；网页和双击入口的具体作用见 [使用说明](使用说明.md#7-关闭取消继续与验收)。没有活动任务的后台服务不会自动持续调用 DeepSeek。

## 完成检查

| 检查点 | 完成标准 |
| --- | --- |
| 依赖 | 已有可用 Node 24+，Harness 安装和构建成功，本项目依赖安装成功。 |
| 路径 | 桥接使用的 harnessRoot 指向源码，harnessHome 与保存 Key 时的 DSH_HOME 相同。 |
| 凭据 | 用户在官方 Harness 设置中亲自保存；源码、任务指令、配置和日志不包含 Key。 |
| 接入 | 当前客户端实际发现七个 MCP 工具，任务列表查询成功。 |
| 功能 | 在允许 API 调用后，一次小任务产物和独立核验通过。 |
| 限制 | 已知是否启用 agent；Windows 局部权限处理只在明确授权后启用。 |

这份 SOP 的命令根据固定基线源码核对，具体功能验收与未验证范围见 [验收记录](验收记录.md)；没有声称重新在一台空白电脑上逐步执行过整份安装 SOP。不同系统、网络和缺失组件仍需按实际错误处理。
