# 类似项目与定位

核查日期：2026-10-20。以下依据项目自己的 README、许可证与 GitHub 元数据，
没有安装或运行它们；最近推送时间不能代表当前质量或兼容性。文档未说明的能力不等于不存在。

| 项目 | 主要用途和与本项目的关系 | 许可 / 最近推送（UTC） |
|---|---|---|
| [Harness Relay MCP](https://github.com/tonytanglab/deepseek-harness-relay-mcp) | 最接近：外部 MCP Agent 向已有 DSH Host 分派任务，提供模型/预设选择、持久状态、继续/停止、审批与问题转交。推荐安装形态针对 web profile；应单独核对目标 DSH 版本。我们参考了其公开网关集成模式并保留许可说明。 | MIT / 2026-10-18 |
| [DSH Collab](https://github.com/FuJackGao/dsh-collab) | Codex 主导、DSH 编码、独立评审的工作流；包含 MCP 与宿主网关。若主要需要编码与评审分工，这个项目值得先看。 | MIT / 2026-08-14 |
| [DSH Agent Bridge](https://github.com/zmh2000829/DSH-agent-bridge) | 通过 ACP 把 Grok Build 作为 Agent 接进 DSH Web，复用原生展示和审批。方向与本项目不同：它让用户在 DSH 内使用外部 Agent；本项目让外部 Agent 调用 DSH。也是本项目名称加入 Desktop 的原因。 | MIT / 2026-08-25 |
| [Reason Network](https://github.com/reason-machines/reason-network) | 跨机器 Agent 发现、消息及人工确认。README 明确 DSH 通过检查收件箱收消息。适合 Agent 通信与团队协作，不直接等同于本项目的 DSH 任务生命周期与桌面归属管理。 | MIT OR Apache-2.0 / 2026-10-20 |
| [dsh-relay](https://github.com/sorsama/deepseek-harness-relay) | 为 DSH Web 提供 TLS、设备配对、登录与撤销，重点是让人从手机或其他设备访问 DSH。与按身份限制任务工具的 MCP 接口层次不同。 | MIT / 2026-08-28 |

## 本项目保留的重点

DSH Desktop Agent Bridge 聚焦**已有 DSH 桌面中的可见协作**：

- 在左侧协作区按父 Agent 分组，直接打开原生会话。
- 每个调用身份只能操作自己获授权的会话与资源。
- 人可以插话，并明确接管、交还、停止。
- 可按身份开启父 Agent 聊天转交问题与审批，默认关闭。
- 同项目的插件任务串行执行，已有能力包和模型按授权选择。

这些功能并非全部独有，也不构成“比其他项目更安全”的结论。如果只需要通用
DSH MCP 控制，优先比较 Harness Relay MCP；如果需要现有桌面里的上述协作操作，
再评估本项目。当前真实桌面兼容范围为 Windows 11 + DSH `0.2.1-rc.2`。
