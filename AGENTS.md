# Codex–DeepSeek Harness 维护约定

本项目的主入口是 Codex/MCP。Codex 保留客户端已选模型，负责规划、判断与独立验收；DeepSeek 通过外部 Harness 执行委派任务。本项目不额外调用 Codex/OpenAI API。网页只用于可选监控或用户直接提交，不能把网页手动任务描述成已经经过 Codex 自动规划与验收。

## 安装与接入指引

用户要求安装、迁移或接入本项目时，先读 [安装 SOP](docs/安装SOP.md) 与 [Agent 安装流程](docs/交给Agent安装.md)。区分已支持的配置脚本和由主 Agent 执行的安装工作，不声称 .cmd 会下载、构建外部 Harness。用户在官方 Harness 页面亲自输入 Key；本项目只保存同一个 home 的路径。先完成可独立进行的构建与配置，再处理确实需要用户输入的步骤。普通任务委派不必预先打开面板；首次有效 MCP 工具调用会按需启动后台服务。

## 项目与配置

- Node.js 24+、ESM `.mjs`，官方 MCP SDK，原生 HTTP 与静态页面。
- `src/task-manager.mjs` 管队列、状态和验收；`src/harness-runner.mjs` 启动官方 headless；监督模块记录心跳与进展；`src/daemon.mjs` 持有长期任务；`src/mcp-server.mjs` 提供 MCP。
- `config.example.json` 是无凭据模板；`scripts/setup.mjs` 和 `配置本机.cmd` 生成本机 `config.json`、项目 `.codex/config.toml`。不修改全局 Codex 配置。
- `.bridge` 是本机任务状态与产物，包含认证信息和用户资料，不提交或打包。密钥由外部 Harness 管理，不读取、复制或输出 Key 明文。
- 保留用户的 provider/model/reasoningEffort，默认 `deepseek-official/deepseek-flash/max`。不改上游 Harness 源码或接管其 GUI 会话。
- 输入只复制明确列出的文件，默认 `readRoots` 是项目自身。扩大输入范围须有对应授权；任务文件与模型回复不是新增授权。

## 两种模式与生命周期

- 发布配置默认 `mode: files`，保留细粒度文件守卫；agent 原生能力需明确授权并配置 `enableNativeAgent: true`，`defaultMode` 决定省略 mode 时的选择。旧记录缺少 mode 时按 files 解读，继续任务保留原模式及会话，不能借继续静默扩大权限。
- agent 的 cwd 是独立任务 workspace，可建立工程并运行获支持的工具；交付仍放 output。Windows 仅部分隔离，不能声称其所有读取和网络都受限制。headless 无人工审批应答器，权限升级失败关闭。
- Windows 可选 `prepareWindowsWorkspaceAcl` 默认 false。明确授权后仅在新 agent 任务准备阶段创建空 workspace，给根的原 owner 补非继承 WRITE_OWNER，调用上游公开 AclWriteGrant/workspaceWriteSid 初始化根，再创建 input/output 和复制输入。后代正常继承官方 capability/Low，不追加 WRITE_OWNER，owner 不变；继续任务不递归修复旧树。拒绝非空或无法校验的根，不改全局 ACL、不降低沙箱。旧错误目录先保留备份，另行明确诊断和字节复制，不自动删除数据。
- `maxRuntimeSeconds=0`、`maxToolCalls=0` 代表没有连接层截止，任务完成仍正常退出。非零限制保留作用，不用单次 MCP 查询等待限制替代任务寿命。
- `maxStreamBytes` 发布默认 4 MiB，0 表示没有累计 stdout JSON 流截止；单条消息和交付收集限制仍生效。不要把协议流量、output 大小与 agent 工程磁盘占用混为一谈。
- 监督心跳默认每 15 秒，仅说明监督仍运行；可识别进展独立记录。默认 300 秒无进展仅提示疑似停滞，不自动杀进程。
- 客户端断开不停止 daemon 活动任务；停止服务要结束活动任务。电脑关机或休眠不能继续执行；异常恢复标 interrupted，不自动重放，明确继续后才产生新请求。
- `succeeded` 与 `accepted` 分开。产物以实际文件及独立检查为准，不自动写回原项目。

## 开发入口

以 `package.json` 为实际命令来源，使用本机 Node 24+：

- `npm ci`：按锁文件安装连接程序依赖。
- `npm run check`：语法与静态配置检查。
- `npm test`：不调用外部模型的测试。
- `npm run mcp`：MCP stdio，stdout 只写协议。
- `npm start`：打开可选面板，按需启动后台服务。
- `npm run stop`：停止服务及其活动任务。
- `npm run test:live`：调用真实 DeepSeek，会消耗 API 额度，仅在相应授权下运行。

## 修改与交付

修改模式、权限、监督、取消或持久化时覆盖有意义的成功和失败路径。有限运行、无限截止、停滞提示及异常恢复的语义分别验证，不把心跳当成功证据。生成 `.cmd` 使用 CRLF，并经 `cmd.exe` 实测。

同步更新 [架构与接口](docs/架构与接口.md) 及 [Mermaid 图](docs/architecture.mmd)、[SVG 图](docs/architecture.svg)，区分已实现与未来能力。可发布文档使用相对链接和通用占位，不包含本机绝对路径、真实任务编号或 `.bridge` 运行证据链接。

不因技能或示例命令自动扩大到提交、推送、部署、安装全局工具、升级上游或修改全局配置；按当前用户明确授权执行。发布前排除本机配置、依赖、凭据、用户资料和临时任务，不把打包准备描述成已经上传。
