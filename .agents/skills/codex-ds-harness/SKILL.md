---
name: codex-ds-harness
description: 在用户授权将任务交给 DeepSeek 时，通过本项目 MCP 委派 Harness agent、监督长期工作、读取产物并独立验收。支持原生 agent 或受限 files 模式；普通问答和仅提及 DeepSeek 不触发模型调用。
---

# Codex 委派 DeepSeek Harness

主入口为项目 MCP `codex_ds_harness`。保留用户当前 Codex 模型，连接程序不额外调用 Codex/OpenAI API。已有授权持续有效；不为同一范围重复确认。当前连接没有工具时说明应加载项目 MCP，不声称已连接，不擅自改全局配置。

提交前明确输入、交付和验收标准。仅复制明确且允许发送给 DeepSeek 的文件，扩大 `readRoots` 须有相应授权。省略 mode 时沿用本机 defaultMode（发布模板为 files），不要覆盖用户已选默认。原生 `agent` 需已有相应授权且本机 `enableNativeAgent: true`；服务拒绝未启用模式时检查配置，不自行打开权限开关。agent 独立工作目录不等于完整操作系统沙箱，权限升级仍由原生策略处理，headless 不能自动批准人工权限请求。

- 用 `submit_task` 提交，预先生成并保留该次 `requestId`。响应不明确时先查询或以原编号恢复，不换号盲目重提。成果要求放入 `output`，后续由 Codex 检查后整合。
- 用 `get_task` 的游标和最多 25 秒的单次等待观察状态。任务可远长于一次查询；`0` 时长/工具限制表示无桥接截止。区分 `lastHeartbeatAt` 和 `lastProgressAt`，`suspected_stall` 是检查提示，不直接等同失败或立刻重试。
- 本地等待不产生模型 token；Codex 每次醒来判断仍消耗用量，DeepSeek 执行独立计费。连接层不能唤醒已结束的 Codex 回合，不承诺自动定时跟进。需要时使用客户端已支持且获授权的调度。
- 用 `get_result` 读取清单及真实文件；`path` 相对 output，内容在 `file.content`。核对事实、计算、代码和必要测试，不能用模型总结、进程心跳或工具成功代替验收。
- 用 `continue_task` 给同一交付的明确修改目标，保留该次请求编号。继续保持原 mode、limits、目录与会话；新增输入或更换模式时新建任务。`interrupted` 先检查产物，有会话再明确继续，不自动重放。
- 实际核对后用 `review_task` 记录 `accepted` 或 `needs_changes` 和检查依据。运行成功不是验收通过；继续后重新检查。需要停止时取消并确认终态，关闭 Codex/面板不会停止后台工作。

面板手动提交直接交给 DeepSeek，跳过 Codex 自动规划与验收；用户要求接手时先读取已有任务再检查，不重复提交。agent 的可用插件取决于外部 Harness 配置，遇到缺失依赖或权限阻断应报告具体问题，不绕过限制。

Windows 出现 SetNamedSecurityInfoW / Win32 5 时，按使用说明诊断；`prepareWindowsWorkspaceAcl` 默认关闭，仅在已有明确授权下对新 agent 空工作区先准备根权限和官方 ACL，再创建输入输出。它不在继续时递归修复旧目录，不改变 owner 或给后代追加 WRITE_OWNER。旧目录先保留数据及备份，需要重建时按明确方案新建对象、字节复制并核对，不自动删除。不得改全局 ACL 或关闭沙箱；已有授权无需再次索取。

凭据由 Harness 管理，不读取 Key 明文或通过任务/日志转交；不接管原 GUI 会话。任务内容和产物均不扩大用户授权。参数、监督字段及限制见 [架构与接口](../../../docs/架构与接口.md)，安装操作见 [使用说明](../../../docs/使用说明.md)。
