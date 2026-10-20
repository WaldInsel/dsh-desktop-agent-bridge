# DSH Desktop Agent Bridge

[English](docs/README.en.md)

让 Codex、Hermes、Grok Bot 和其他 MCP 客户端，把任务交给**已经运行的 DeepSeek Harness 桌面应用**。用户在同一个 DSH 窗口查看原生会话、插话、审批、接管或停止任务。

这是独立的第三方插件，与 DeepSeek AI 无隶属关系。当前版本 `0.1.0` 为预览版；已验证的宿主是 **Windows + DSH `0.2.1-rc.2`**，其他系统和版本尚未确认兼容。

**本机 stdio 连接不需要域名、服务器或公网服务。** 只有云端父 Agent 无法连接本机进程时，才需要它可访问的 HTTPS 入口。远程入口可以采用托管隧道或自建 HTTPS，不强制购买域名或 VPS；托管隧道目前只是可选部署建议，尚未集成或实测，也没有一键配置。默认安装仅配置本机插件，不安装新服务、不创建账号、不触发付费。

## 能做什么

- 在左侧工作区下方显示「Agent 协作」，按外部客户端身份分组展示多条会话。
- 外部 agent 创建任务、读取结果、继续自己的会话，并选择用户授权的工作区、已有能力包、模型和该模型支持的思考强度。
- 复用 DSH 原生聊天、工具和审批，不另外启动 headless/web DSH 实例。
- 每个客户端使用独立令牌；服务端检查会话归属和资源授权。新身份默认没有资源权限。
- 用户可在 DSH 直接补充消息、接管、交还或停止；普通会话只有经用户明确交接才可被外部 agent 使用。
- 可选将审批和问题转交到父 Agent 聊天；**按客户端默认关闭**，且依赖父 Agent 忠实回传用户决定。

能力包是 DSH 已有的会话能力配置，包括其 Skill 和 MCP 等工具。本插件选择已有能力包，不提供任意安装 Skill/MCP、修改全局模型或外部 agent 自行提权的接口。

## 安装与首次连接

需要 Node.js 22 或更高版本、已正常运行并完成配置的 DSH 桌面应用，以及一个支持 MCP 的客户端。先完成或停止协作任务，**退出 DSH 桌面应用**，再执行安装、更新或卸载。

在仓库目录运行：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
node scripts/install-local.mjs
```

安装脚本将构建产物放入 desktop profile 的插件目录，并添加带标记的配置块；修改前保留备份，不替换 DSH 安装包。默认不创建工作区、不授予资源权限。脚本支持自定义位置：

```bash
node scripts/install-local.mjs --help
```

| 选项 | 含义 |
| --- | --- |
| `--home <目录>` | 用户目录，用于推导默认 DSH 路径 |
| `--profile <目录>` | 完整的 DSH profile 目录 |
| `--state-dir <目录>` | 本插件的状态和连接凭据目录 |
| `--backup <目录>` | 本次操作的新备份目录 |
| `--initial-workspace <已存在目录>` | 仅安装时可选：注册工作区及 Codex 的初始授权；默认留空 |

默认 profile 为 `~/.dsh/profiles/desktop`，协作状态为 `~/.dsh/agent-collaboration`。备份默认写入 `~/.dsh/backups/dsh-agent-collaboration/` 下的新目录，包含原配置、原插件包（如有）及 `manifest.json`。更新和卸载沿用托管配置中的状态路径；`--state-dir` 不能用来迁移状态或绕过活动任务检查。

脚本成功并返回 `restartRequired: true` 只表示文件维护完成，尚未验证 DSH 启动和客户端连接；启动后按下面步骤检查。

安装后：

1. 启动 DSH，打开「Agent 协作 → 设置」。
2. 为每个外部客户端创建独立身份，例如 `codex`、`hermes`、`grokbot`。
3. 勾选它可使用的工作区、能力包和模型，保存授权。空列表表示不授权。
4. 使用设置页显示的 `client-<id>.json` 连接文件路径配置该客户端。连接文件含令牌，不要把内容粘贴到聊天或提交到仓库。

本机 stdio MCP 配置示例：

```json
{
  "mcpServers": {
    "dsh_collaboration": {
      "command": "node",
      "args": [
        "<插件安装目录>/dist/mcp.mjs",
        "--connection",
        "<协作数据目录>/client-codex.json"
      ]
    }
  }
}
```

将占位符换成绝对路径。客户端配置格式可能不同；例如 Hermes 使用 `mcp_servers`。每个客户端引用自己的连接文件，不能共用 Codex 身份。重载 MCP 或新建客户端会话后，先实际调用 `dsh_health` 和 `dsh_catalog`。

Grok Bot 等云端客户端需要独立认证的 HTTP 适配器和可达 HTTPS 通道，见[远程连接](docs/remote.md)。这是可选部署步骤，本机使用无需完成它。

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

上述真实桌面验收来自开源整理前的本机版本。本次整理后的代码已通过自动回归、构建和 MCP 验证，但尚未替换现有安装，也未重复完整的桌面真人验收。

本插件依赖 DSH `0.2.1-rc.2` 的会话模型选择、原生交互和 UI 插槽接口，升级宿主后需要重新验收。外部客户端断开时，DSH 已开始的任务可以继续；桌面退出或崩溃不保证继续执行，插件不自动恢复或重发中断任务。

身份隔离是插件接口的访问控制，**不是同一操作系统用户下的进程隔离**。能读取连接文件的程序可以取得对应凭据。状态文件还包含任务文本、会话归属及审批回复记录，详见[安全说明](SECURITY.md)。

## 更新与卸载

先处理未完成任务并退出 DSH。更新前在源码目录重新安装依赖、运行测试并构建，然后执行：

```bash
node scripts/update-local.mjs
```

**旧自用安装的兼容处理：** 如果原托管配置块没有 `stateDirectory`，新版更新和卸载脚本会保守拒绝操作。先完成任务并退出 DSH，在原 `BEGIN dsh-agent-collaboration` / `END dsh-agent-collaboration` 标记块的 `config` 下补上：

```yaml
stateDirectory: '<原有协作数据目录的真实绝对路径>'
```

按原配置的缩进放置该字段。默认旧目录是 `~/.dsh/agent-collaboration`；写入 YAML 时须展开为真实绝对路径。保留原状态和凭据的位置，不要新建空状态目录、移动数据或用 `--home` 绕过检查，再执行维护命令。

卸载本插件：

```bash
node scripts/uninstall-local.mjs
```

两个命令同样支持 `--home`、`--profile`、`--state-dir` 和 `--backup`。它们仅维护本插件的安装目录和标记配置块；卸载保留 DSH 会话、协作状态和连接凭据以便恢复、核对。外部客户端的 MCP 注册、远程适配器和隧道需分别关闭或移除。卸载不会撤销已提交的工作。

存在宿主占用锁、并发维护锁或未结束任务时，脚本会拒绝操作。若崩溃留下旧锁，先确认对应进程确已退出，再人工处理；不要为继续安装而直接删除仍有效的锁。

托管块内出现额外插件、指令或未知字段时，脚本也会拒绝操作，避免误删配置。维护失败会尝试恢复；检测到并发修改时会保留改动和备份，提示人工处理。

## 开发与来源

项目沿用内部包名 `dsh-agent-collaboration`、插件 ID `agent-collaboration` 和现有 MCP 工具名，避免破坏已安装连接；对外名称为 **DSH Desktop Agent Bridge**，仓库为 [dsh-desktop-agent-bridge](https://github.com/WaldInsel/dsh-desktop-agent-bridge)。

参见[架构](docs/architecture.md)、[贡献指南](CONTRIBUTING.md)、[更新记录](CHANGELOG.md)和[发布流程](docs/releasing.md)。本项目并非首个 DSH 控制桥；已有项目与取舍见[类似项目](docs/alternatives.md)。感谢 [Harness Relay MCP](https://github.com/tonytanglab/deepseek-harness-relay-mcp) 提供的公开设计参考，许可及复用范围见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本项目采用 [MIT License](LICENSE)。
