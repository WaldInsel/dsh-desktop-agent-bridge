# DSH Desktop Agent Bridge

[English](docs/README.en.md)

让 Codex、Hermes、Grok Bot 和其他 MCP 客户端，把任务交给**已经运行的 DeepSeek Harness 桌面应用**。用户在同一个 DSH 窗口查看原生会话、插话、审批、接管或停止任务。

这是独立的第三方插件，与 DeepSeek AI 无隶属关系。当前版本 `0.1.1` 为预览版；已验证的宿主是 **Windows + DSH `0.2.1-rc.2`**，其他系统和版本尚未确认兼容。

**本机 stdio 连接不需要域名、服务器或公网服务。** 只有云端父 Agent 无法连接本机进程时，才需要它可访问的 HTTPS 入口。远程入口可以采用托管隧道或自建 HTTPS，不强制购买域名或 VPS；托管隧道目前只是可选部署建议，尚未集成或实测，也没有一键配置。默认安装仅配置本机插件，不安装新服务、不创建账号、不触发付费。

## 能做什么

- 在左侧工作区下方显示「Agent 协作」，按外部客户端身份分组展示多条会话。
- 外部 agent 创建任务、读取结果、继续自己的会话，并选择用户授权的工作区、已有能力包、模型和该模型支持的思考强度。
- 复用 DSH 原生聊天、工具和审批，不另外启动 headless/web DSH 实例。
- 每个客户端使用独立令牌；服务端检查会话归属和资源授权。新身份默认没有资源权限。
- 用户可在 DSH 直接补充消息、接管、交还或停止；普通会话只有经用户明确交接才可被外部 agent 使用。
- 可选将审批和问题转交到父 Agent 聊天；**按客户端默认关闭**，且依赖父 Agent 忠实回传用户决定。

能力包是 DSH 已有的会话能力配置，包括其 Skill 和 MCP 等工具。本插件选择已有能力包，不提供任意安装 Skill/MCP、修改全局模型或外部 agent 自行提权的接口。

## 在 DSH 中直接安装

已验证的宿主版本为 **DSH 桌面端 `0.2.1-rc.2`**。先完成或停止正在运行的协作任务，在 DSH 左侧打开「插件 → 添加插件」，输入：

```text
https://github.com/WaldInsel/dsh-desktop-agent-bridge
```

点击「安装」，按插件页提示启用 `dsh-agent-collaboration`，然后**完全退出并重新打开 DSH**。这是 DSH 自带的插件安装流程，不需要先运行本仓库的构建或离线安装脚本。若要固定已审查的代码，可改用 `github:WaldInsel/dsh-desktop-agent-bridge#<完整提交 SHA>`；先核对该提交已推送。仓库随 Git 提供预构建的 `dist/` 和第三方许可文件，安装时无需批准仓库执行 `prepare`/构建脚本。插件会在现有桌面宿主中运行，不启动第二个 DSH 实例。

也可在相同输入框填写本地源码目录的**绝对路径**（目录内须有 `package.json`、`cordis.patch.yml` 和 `dist/`），例如 `C:\Projects\dsh-desktop-agent-bridge`。本地目录用于开发或离线安装；普通使用建议选择 GitHub 地址。安装时会执行来自该来源的插件代码，请先确认来源可信。[DSH 官方插件安装说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/develop/basic/publish.zh.md)介绍了 bundle 与 profile 的关系。

**如果此前用 `scripts/install-local.mjs` 手工装过本插件，不要直接再点「安装」。** 先按下文[旧安装迁移](#旧安装迁移)移除旧配置层，保留状态和凭据，再从插件页安装，避免同一个插件 ID 重复加载。

### 首次连接外部 Agent

1. 重启后确认左侧出现「Agent 协作」，打开「Agent 协作 → 设置」。
2. 为 Codex、Hermes 等外部客户端分别创建身份，选择可用工作区、已有能力包和模型，保存授权。新身份默认没有资源权限。
3. 记下各自 `client-<id>.json` 连接文件的路径；文件内有令牌，只在本机配置中引用其路径，不要粘贴到聊天或提交到仓库。
4. 为本机 MCP 客户端配置 stdio 启动命令。**这一外部命令需要系统可用的 Node.js 22+**；DSH 插件页安装本身由 DSH 管理。

```json
{
  "mcpServers": {
    "dsh_collaboration": {
      "command": "node",
      "args": [
        "<DSH desktop profile>/node_modules/dsh-agent-collaboration/dist/mcp.mjs",
        "--connection",
        "<协作数据目录>/client-codex.json"
      ]
    }
  }
}
```

默认 desktop profile 为 `~/.dsh/profiles/desktop`，协作数据目录为 `~/.dsh/agent-collaboration`。将占位符换成绝对路径，并**核对实际安装后的包入口是否存在**；不要假定每个平台的物理 pnpm 存储路径相同。客户端配置格式可能不同，例如 Hermes 使用 `mcp_servers`。每个客户端只使用自己的连接文件。

重载 MCP 或新建客户端会话后，实际调用 `dsh_health` 和 `dsh_catalog`。Grok Bot 等云端客户端需要独立认证的 HTTP 适配器和可达 HTTPS 通道，见[远程连接](docs/remote.md)；本机连接无需部署公网服务。

## 分派任务

正常流程是 `dsh_health → dsh_catalog → dsh_start_task → dsh_wait_task`。先读取授权目录，再使用目录中的精确资源标识：

```json
{
  "requestId": "example-task-001",
  "task": "检查工作区中的 README，给出需要修正的内容。",
  "title": "检查 README",
  "workspaceId": "<dsh_catalog 返回的 workspaceId>",
  "preset": "<dsh_catalog 返回的 preset id>",
  "selection": {
    "provider": "<目录中的 provider>",
    "model": "<目录中的 model>"
  }
}
```

`selection.reasoningEffort` 可选，只接受所选模型支持的值。省略 `sessionId` 创建会话；带上自己已有的 `sessionId` 则开始下一轮，沿用该会话的工作区和能力包。

同一请求重试应保留 `requestId` 和全部参数，避免重复执行；新一轮使用新编号。同一规范化项目目录下的协作任务串行执行。这个队列不覆盖 DSH 普通会话或其他程序。

| 工具 | 用途 |
| --- | --- |
| `dsh_health` | 检查现有桌面宿主、调用身份和 UI 同步信息 |
| `dsh_catalog` | 列出当前身份获授权的资源 |
| `dsh_start_task` | 新建或继续自己的任务 |
| `dsh_get_task` / `dsh_wait_task` | 读取状态与本轮结果；单次等待最多 25 秒 |
| `dsh_list_sessions` | 列出自己的协作会话 |
| `dsh_send_message` | 向执行中的任务补充或排队消息 |
| `dsh_cancel_task` | 停止自己仍有控制权的任务 |
| `dsh_list_interactions` | 开启转交后，读取当前任务的审批和问题 |
| `dsh_respond_interaction` | 回传用户对指定请求的实际答复 |

`queued`、`running`、`waiting_approval`、`waiting_input` 都不是完成。`completed` 表示 DSH 结束了该轮，调用方仍应读取结果并核验交付物；`failed`、`cancelled`、`blocked`、`unknown` 不能当作成功。提交结果不确定时先核查原会话，不自动重发。

MCP 返回的文本最多为本轮结果的末尾 60,000 字符，`truncated` 表明是否截断；完整原生会话仍在 DSH 中。

## 用户如何介入

点击协作区中的会话即可打开原生聊天，用户可以直接输入消息。

| 操作 | 行为 |
| --- | --- |
| 接管 | 撤销外部指挥权，撤回尚未消费的外部排队指令；当前 DSH 工作继续 |
| 交还 | 恢复外部指挥权，不重放已撤回的消息 |
| 停止 | 停止当前工作，不回滚已产生的文件修改 |
| 交接普通会话 | 用户明确选定普通会话和目标身份后交接；已有归属的协作会话不能转给另一身份 |

撤销资源授权会阻止后续提交，并在排队任务执行前重新检查；它不等同于停止当前执行。需要马上停止时使用「停止」。

## 在父 Agent 聊天中审批与回答

默认由用户在 DSH 中处理。只有用户在对应客户端设置中勾选「在父 Agent 处审批与回答」并保存后，才允许转交。

父 Agent 必须先通过 `dsh_list_interactions` 读取请求，向用户展示操作、路径、原因或完整问题，等待用户答复，再调用 `dsh_respond_interaction`。`dsh_send_message` 不能批准操作。审批只支持 `allowed-once` 或 `rejected`，不支持永久授权。

**这是需要信任父 Agent 的聊天转发功能，不是对真人点击的密码学证明。** 服务端验证身份、归属、请求有效性和答复格式，但不能证明 `userReply` 确实由真人输入。不要为会自行代批或编造用户答复的客户端开启此功能。

DSH 原生界面仍可直接处理；两处同时答复时，以原生流程先收到的有效答复为准。接管、停止、关闭开关或修改授权会使旧请求编号失效。`submitted` 仅表示提交，随后仍需读取任务状态。网络中断不会自动批准，也不会自动重放结果不确定的批准。

## 验证范围与限制

| 范围 | 当前证据 |
| --- | --- |
| Windows + DSH `0.2.1-rc.2` | 已在现有桌面宿主验证任务、续聊、结果回读和协作 UI |
| 用户控制 | 已人工验证原生会话、接管、交还、停止及 DSH 原生审批 |
| 父 Agent 审批与回答 | Codex 已完成真人聊天往返；Grok/Hermes 为接口可调用及跨身份拒绝验证，尚无该功能的真人往返验收 |
| 自动检查 | 仓库提供单元测试与构建检查；通过这些检查不等于各客户端实际接入通过 |
| 其他 DSH 版本、macOS、Linux | 未确认兼容 |

此前 `0.1.0` 优化版已安装到现有 DSH 桌面端，并完成同会话两轮对话、接管、交还、停止、父 Agent 问答及一次允许/拒绝审批的真实验收。GitHub 插件页安装路径需要与功能验收分别核对；安装成功后仍应实际调用 `dsh_health`、`dsh_catalog` 并检查原生会话。

本插件依赖 DSH `0.2.1-rc.2` 的会话模型选择、原生交互和 UI 插槽接口，升级宿主后需要重新验收。外部客户端断开时，DSH 已开始的任务可以继续；桌面退出或崩溃不保证继续执行，插件不自动恢复或重发中断任务。

身份隔离是插件接口的访问控制，**不是同一操作系统用户下的进程隔离**。能读取连接文件的程序可以取得对应凭据。状态文件还包含任务文本、会话归属及审批回复记录，详见[安全说明](SECURITY.md)。

## 更新与卸载

**从 DSH「插件」页安装的版本**：先完成或停止协作任务，再从该插件的详情页执行「更新」；按页面提示启用并重启 DSH，重新调用 `dsh_health`、`dsh_catalog` 核验。卸载也在同一插件页完成。DSH 移除插件包不会删除独立的 `~/.dsh/agent-collaboration` 状态目录、DSH 原生会话和已执行的文件修改；外部客户端的 MCP 注册与远程适配器/隧道须分别清理。

`scripts/update-local.mjs` 和 `scripts/uninstall-local.mjs` **只用于先前由 `scripts/install-local.mjs` 手工维护的安装**，不要拿它们操作插件页安装的 bundle。反过来，也不要在手工托管块仍存在时通过插件页叠加安装。

### 旧安装迁移

1. 完成或停止全部协作任务，**完全退出 DSH**。把 `~/.dsh/agent-collaboration` 复制到只有自己能读取的备份位置；其中包含明文令牌和任务记录，不要提交到仓库。
2. 在本仓库源码目录运行 `node scripts/uninstall-local.mjs`。脚本会另备份原 profile 配置与旧插件包，移除带 `BEGIN/END dsh-agent-collaboration` 标记的旧配置及旧包，保留协作状态、连接凭据和 DSH 原生会话。记下返回的 `backup` 路径；报错时不要强行删除配置。
3. 启动 DSH，按上文从「插件 → 添加插件」安装；启用后完全退出并重开。检查原有客户端授权及连接文件，再实际调用 `dsh_health` 和 `dsh_catalog`。旧 MCP 配置若指向已删除的文件路径，改为新安装的包入口后重载客户端。

极早期手工配置若缺少 `stateDirectory`，卸载脚本会拒绝。确认原数据目录后，在原 `BEGIN/END dsh-agent-collaboration` 标记块的 `config` 下按原缩进补入真实绝对路径：

```yaml
stateDirectory: '<原有协作数据目录的真实绝对路径>'
```

旧默认目录为 `~/.dsh/agent-collaboration`，写入 YAML 时须展开为绝对路径。保留原状态和凭据，不要创建空状态目录、移动数据或改 `--home` 绕过检查，再重新运行卸载。

迁移或旧式离线维护遇到宿主占用锁、并发维护锁或未完成任务时会拒绝操作；确认真实状态后再处理。旧脚本的 `--home`、`--profile`、`--state-dir` 和 `--backup` 只用于明确指定旧安装的位置，不能用来迁移状态或绕过检查。出现额外插件行或未知配置时也会保守拒绝，避免误删无关配置。

## 开发与来源

项目沿用内部包名 `dsh-agent-collaboration`、插件 ID `agent-collaboration` 和现有 MCP 工具名，避免破坏已安装连接；对外名称为 **DSH Desktop Agent Bridge**，仓库为 [dsh-desktop-agent-bridge](https://github.com/WaldInsel/dsh-desktop-agent-bridge)。

参见[架构](docs/architecture.md)、[贡献指南](CONTRIBUTING.md)、[更新记录](CHANGELOG.md)和[发布流程](docs/releasing.md)。本项目并非首个 DSH 控制桥；已有项目与取舍见[类似项目](docs/alternatives.md)。感谢 [Harness Relay MCP](https://github.com/tonytanglab/deepseek-harness-relay-mcp) 提供的公开设计参考，许可及复用范围见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本项目采用 [MIT License](LICENSE)。
