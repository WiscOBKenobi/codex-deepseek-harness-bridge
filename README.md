# Codex × DeepSeek Harness

**让 Codex 负责规划和验收，让 DeepSeek 通过本机 Harness 执行任务。** 本项目是两者之间的 MCP 连接程序：Codex 提交工作，本地服务持续运行并保存状态，DeepSeek 生成产物，Codex 读取、核对并整合结果。

Codex 继续使用你在客户端选择的模型。本项目不会额外调用 Codex 或 OpenAI API，也不会替换主模型；委派任务使用 DeepSeek API 独立计费。

![Codex 与 DeepSeek Harness 架构](docs/architecture.svg)

[可编辑 Mermaid 图](docs/architecture.mmd) · [架构与接口](docs/架构与接口.md) · [详细使用说明](docs/使用说明.md)

## 从 Codex 开始

1. 准备 **Node.js 24 或更高版本**，以及已安装依赖、可运行的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。先在 Harness 中保存自己的 API Key。
2. 双击 **配置本机.cmd**，选择已有 Harness 及其数据目录；缺少连接程序依赖时按提示安装。它生成本机 `config.json` 和项目 `.codex/config.toml`，不会修改全局 Codex 配置。
3. 在 Codex 中打开本项目，创建新任务并加载项目 MCP 配置。工具服务名为 `codex_ds_harness`；是否需要确认项目信任，以客户端提示为准。
4. 在 Codex 中安排工作，例如：“把这个小任务交给 DeepSeek：读取提供的样例数据，完成计算并保存报告。你再检查实际文件并验收。”

项目技能位于 [.agents/skills/codex-ds-harness/SKILL.md](.agents/skills/codex-ds-harness/SKILL.md)。新增配置不保证热加载到已有 Codex 任务；当前连接没有工具时，在本项目新任务中加载。安装、配置与故障处理见 [使用说明](docs/使用说明.md)。

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

关闭 Codex 或网页不会自动结束后台工作；停止任务服务会结束其活动任务。电脑休眠时无法持续执行，关机后也不能继续运行；异常重启会将遗留任务标为 `interrupted`，由用户或 Codex 检查后明确继续，不自动无限重试。

本地等待和心跳不会自行生成模型 token。Codex 醒来理解状态、判断是否返工时仍消耗自身用量，DeepSeek 执行另行计费。连接层不能主动唤醒已经结束的 Codex 回合；需要持续自动跟进时，须由客户端提供调度，本项目未实现这种唤醒服务。

## 网页是可选入口

双击 **打开任务面板.cmd** 可以监控任务，也可以手动直接提交给 DeepSeek。手动提交不经过 Codex 的自动规划与验收，结果需要你自己检查，或另行让 Codex 接手核对。

**检查环境.cmd** 检查本机环境；**停止任务服务.cmd** 停止本项目的后台服务。日常通过 Codex/MCP 委派时不必打开面板。

## 文档与发布范围

- [使用说明](docs/使用说明.md)：配置、Codex 委派、长期任务、可选面板和故障处理。
- [架构与接口](docs/架构与接口.md)：模块、七个 MCP 工具、监督字段、权限和持久化。
- [维护约定](AGENTS.md)：开发入口和修改时的验证要求。
- [验收记录](docs/验收记录.md)：实际执行的验证及未验证范围。

本仓库只包含连接程序、面板、文档和测试；**不打包外部 Harness 的源码、运行环境或凭据**。本机配置、任务记录、复制输入和产物不随源码发布。对接基线为上游提交 [`477b4f420553e8a52c2fbccc464d7561b239c443`](https://github.com/deepseek-ai/deepseek-harness/tree/477b4f420553e8a52c2fbccc464d7561b239c443)，其他版本需重新验证入口和插件兼容性。
