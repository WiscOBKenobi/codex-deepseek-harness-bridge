# Codex × DeepSeek Harness

**让 Codex 负责规划和验收，让 DeepSeek 通过本机 Harness 执行你委派的任务。** 你仍然在 Codex 中提出需求；需要分工时，Codex 通过本项目提供的 MCP 接口，把指定任务交给 DeepSeek，例如整理文件、生成代码，或在已启用的编码模式下运行命令和测试。DeepSeek 通过官方 Harness 的工具操作独立任务目录，Codex 再读取实际产物、检查结果并整合到你的工作中。

本项目提供连接两者所需的本地后台：接收任务、管理队列、保存执行状态和产物，并让 Codex 查询进度、取消任务或要求继续修改。附带网页面板用于查看进度或手动提交，日常通过 Codex 委派时无需打开它。

Codex 继续使用你在客户端选择的模型。本项目不会额外调用 Codex 或 OpenAI API，也不会替换主模型；委派任务使用你自己的 DeepSeek API，费用由 DeepSeek 单独收取。

## 使用前需要准备什么

### 1. 先在本机安装官方 DeepSeek Harness

请先从 **[DeepSeek Harness 官方 GitHub 仓库](https://github.com/deepseek-ai/deepseek-harness)** 下载并安装。本项目依赖它执行任务，仓库中不附带 Harness 本体。当前对接方式使用已构建的 Harness 源码目录，具体下载、依赖安装和构建步骤见 [手动安装 SOP](docs/安装SOP.md#2-下载并构建官方-harness)；该流程固定到指定上游提交，兼容性以 [验收记录](docs/验收记录.md) 为准。已有兼容安装可以复用，更新时按 [已有安装的升级步骤](docs/安装SOP.md#更新已有-harness) 操作。

也可以把这一步交给自己的本机 Agent，按下面的 Agent 安装流程完成下载、构建和接入。

### 2. 配置 Harness 的安装目录和数据目录

**需要提供本机的实际目录。** 双击本项目的 `配置本机.cmd` 选择以下两个文件夹，或把路径告诉负责安装的 Agent；配置工具会保存路径，无需自己编辑配置文件。

| 配置项 | 选择哪个目录 |
| --- | --- |
| `harnessRoot`：安装目录 | 官方 Harness 的源码根目录，即包含 `package.json` 和 `apps/cli` 的那一层。 |
| `harnessHome`：数据目录 | 这份 Harness 实际使用、保存设置与 API 凭据的目录，必须与填写 Key 时使用的 `DSH_HOME` 一致。 |

本项目安装 SOP 使用 Harness 目录下的 `.local/dsh-home` 作为数据目录；如果复用原有安装，请选择它实际使用的位置。上游在未指定 `DSH_HOME` 时默认使用用户目录下的 `.dsh`。这里只需要选择目录，不需要打开凭据文件或复制其中的 Key。

### 3. 准备自己的 DeepSeek API Key，并在 Harness 中填写

使用者需要自己的 DeepSeek 开放平台账号、API Key 和可用的 API 余额。请前往 **[DeepSeek 官方开放平台](https://platform.deepseek.com/)** 登录，**[创建自己的 API Key](https://platform.deepseek.com/api_keys)**，并按需 **[充值 API 余额](https://platform.deepseek.com/top_up)**。本项目不提供 Key 或调用额度。

取得 Key 后，在本机 **官方 Harness 的界面**中填写：首次使用时选择“添加 API Key”，填入后“保存并继续”；已有配置则进入 **设置 / Settings → 模型 / Models → DeepSeek（`deepseek-official`）→ 编辑 / Edit → API 密钥 / API key → 保存 / Apply**。具体操作见 [填写 API Key 的步骤](docs/安装SOP.md#3-打开-harness并亲自填写-api-key)。

Key 由 Harness 保存，本项目通过上面配置的数据目录使用它。**不要把 Key 填进 Codex 对话、本项目的 `config.json` 或 GitHub 文件。** 完成配置后，无需一直开着 Harness 设置网页，Codex 委派任务时会按需启动执行进程。

## 先选择安装方式

| 方式 | 适合谁 | 按哪份说明操作 |
| --- | --- | --- |
| 自己逐步安装 | 希望了解每一步，按顺序准备环境和填写配置。 | [手动安装 SOP](docs/安装SOP.md)：获取两个项目、准备运行环境、构建 Harness、填写自己的 API Key、连接 Codex、验证。 |
| 让自己的 Agent 安装 | 已有具备本机文件和命令权限的 Codex 或其他编码 Agent。 | [交给 Agent 安装](docs/交给Agent安装.md)：复制安装任务，由 Agent 检查已有环境并完成授权范围内的下载、构建和配置；你在本机 Harness 中填写 Key。 |

两种方式最终安装的是同一套程序。第二种是让 Agent 按步骤执行，不是另一个“一键全包安装器”；本仓库不附带 Node.js、官方 Harness 或任何 API Key。源码可从 [GitHub 仓库](https://github.com/WiscOBKenobi/codex-deepseek-harness-bridge) 下载。

完成安装后，在 Codex 中打开本项目，创建新任务并加载服务名为 `codex_ds_harness` 的项目 MCP。你可以直接说：“把这个小任务交给 DeepSeek，完成后读取实际文件并独立验收。”**日常无需先双击任何启动文件，也不用先打开本项目面板或原 Harness 网页。** 前提是当前本地客户端已经加载 MCP 配置；普通 ChatGPT 网页不会自动读取你电脑上的项目配置。

新增配置不保证热加载到已有 Codex 任务。工具不可用时，按客户端提示处理项目信任，并在本项目新任务中加载。项目技能位于 [.agents/skills/codex-ds-harness/SKILL.md](.agents/skills/codex-ds-harness/SKILL.md)，使用与排障见 [详细使用说明](docs/使用说明.md)。

![Codex 与 DeepSeek Harness 架构](docs/architecture.svg)

[可编辑 Mermaid 图](docs/architecture.mmd) · [架构与接口](docs/架构与接口.md)

## 它什么时候启动

1. 本地客户端加载项目 MCP 时，由客户端启动 MCP 接口进程。
2. Codex 首次调用提交、列出或查询任务等有效工具时，接口按需启动或连接本项目的后台服务。后台负责队列、进度和结果保存。
3. 某项任务实际开始运行时，后台才为它启动独立 Harness headless 进程，并通过 Harness 使用 DeepSeek API。闲置后台不会自行向模型发请求。

因此，“后台服务已启动”不表示“DeepSeek 正在做任务”。关闭网页或断开 MCP 也不会自动停止已提交的后台任务。完整生命周期见 [使用说明](docs/使用说明.md#7-关闭取消继续与验收)。

## 两种执行模式

| 模式 | 用途 | 能力与范围 |
| --- | --- | --- |
| `agent`，需显式启用 | 编码、依赖安装、运行测试、分析和多步骤工作。 | 使用 Harness 原生工具和插件，在独立任务工作目录运行；具体能力取决于已安装和配置的 Harness。 |
| `files`，默认 | 只需指定文件的整理、转换和草稿。 | 只开放 `read`、`write`、`edit`；读取任务 `input/output`，只写 `output`。 |

发布默认使用 files，`enableNativeAgent` 默认为 false。需要原生编码能力时，明确授权并在本机配置启用 agent；默认配置不会开放这些工具。`defaultMode` 决定省略 mode 的选择，启用 agent 后也可以保持 files 为默认。

输入按明确清单复制；工作成果留在任务 `output`。`agent` 可以在任务工作目录中建立工程与临时文件，只有 `output` 进入交付清单。两种模式都不会由连接程序自动将产物写回原项目，Codex 应先核验再整合。

`agent` 沿用 Harness 原生权限策略，Windows 仅有部分系统隔离；独立目录不等于完整沙箱。后台入口遇到需要人工批准的权限请求时会拒绝继续，不自动批准。浏览器、搜索、子代理等插件也不保证无需配置即可使用。

## 持续运行与监督

默认 `maxRuntimeSeconds=0`、`maxToolCalls=0`，表示连接层不按时长或工具次数截断任务；任务正常完成仍会结束。可为具体任务设定有限上限。发布模板仍有 4 MiB 累计协议流限制；长期任务可显式设 `maxStreamBytes: 0`，单条消息和 output 交付检查继续保留。

后台服务每 15 秒记录监督心跳，默认 300 秒没有可识别进展时提示“疑似停滞”，不会因此直接终止任务。心跳只表示监督进程仍在响应，不代表模型持续取得进展。

关闭 Codex 或网页不会自动结束后台工作；停止任务服务会结束其活动任务并取消排队任务。电脑休眠时无法持续执行，关机后也不能继续运行；异常重启会将遗留任务标为 `interrupted`，由用户或 Codex 检查后明确继续，不自动无限重试。

本地等待和心跳不会自行生成模型 token。Codex 醒来理解状态、判断是否返工时仍消耗自身用量，DeepSeek 执行另行计费。连接层不能主动唤醒已经结束的 Codex 回合；需要持续自动跟进时，须由客户端提供调度，本项目未实现这种唤醒服务。

## 四个 CMD 是安装和维护入口

| 文件 | 什么时候用 | 实际作用 |
| --- | --- | --- |
| `配置本机.cmd` | 首次安装或迁移路径时。 | 选择已有 Harness 和数据目录，生成本机配置；可安装连接程序依赖，不下载 Node.js 或 Harness。 |
| `检查环境.cmd` | 安装后检查或排查环境问题时。 | 检查路径、文件与配置，不验证 API Key 是否有效或额度是否充足。 |
| `打开任务面板.cmd` | 想查看进度或手动提交任务时。 | 按需启动连接后台并打开浏览器；面板是可选入口。 |
| `停止任务服务.cmd` | 要结束全部后台工作、维护或准备关机时。 | 停止活动任务、取消排队任务并关闭本项目后台；不关闭 Codex，也不卸载原 Harness。 |

通过 Codex 可用 `cancel_task` 取消单项任务。目前七个 MCP 工具没有“关闭全部后台”的工具；主 Agent 具有本机命令权限时可执行维护停服，只有 MCP 权限时可逐项取消任务。停止服务后，下次有效任务工具调用仍会自动启动后台；要彻底停用，应在客户端禁用该 MCP，并停止后台。

网页手动提交不经过 Codex 的自动规划与验收，结果需要你自己检查，或另行让 Codex 接手核对。日常通过 Codex/MCP 委派时，无需打开或保持面板运行。

## 文档与发布范围

- [手动安装 SOP](docs/安装SOP.md)：从准备环境到首次成功委派的操作顺序。
- [交给 Agent 安装](docs/交给Agent安装.md)：可复制的安装任务与人工填写 Key 的环节。
- [使用说明](docs/使用说明.md)：日常委派、自动启动、长期任务、配置和故障处理。
- [架构与接口](docs/架构与接口.md)：模块、七个 MCP 工具、监督字段、权限和持久化。
- [维护约定](AGENTS.md)：开发入口和修改时的验证要求。
- [验收记录](docs/验收记录.md)：实际执行的验证及未验证范围。

本仓库只包含连接程序、面板、文档和测试；**不打包外部 Harness 的源码、运行环境或凭据**。本机配置、任务记录、复制输入和产物不随源码发布。安装基线为官方 `dsh-v0.2.0-rc.2` 的上游提交 [`639ed015397290b3745d163aafe02ffee4aa3f84`](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84)，兼容性以 [验收记录](docs/验收记录.md) 为准；其他版本需重新验证入口和插件兼容性。上游发布新版本不会自动替换本机安装，先查看 [官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases) 和升级步骤，再在空闲时更新与验收。
