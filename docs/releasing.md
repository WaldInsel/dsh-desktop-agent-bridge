# 发布与维护

本项目通过 DSH 桌面端「插件 → 添加插件」从 GitHub 仓库或本地目录安装。仓库保留预构建的 `dist/*.mjs` 和 `dist/THIRD_PARTY_LICENSES.txt`；Git 安装不依赖 `prepare`，不要求用户授权安装时构建。`package.json` 的 `private: true` 防止误发 npm，不影响 DSH 从 Git 安装或本地 `npm pack`。内部包名 `dsh-agent-collaboration` 保持不变；`engines.dsh` 固定为已经验证的 `0.2.1-rc.2`，不要在未实测的版本上放宽范围。

## 每次发布前

1. 更新源码、测试、中英文 README 和 CHANGELOG；若变更了协议，同步 `package.json` 与 `src/protocol.mjs` 的版本及锁文件。
2. 在干净的检出目录运行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm pack --ignore-scripts
```

`check` 包含测试、构建、MCP 校验与发布扫描。构建会生成所有运行入口和所打包依赖的许可文本。将**本次构建的 `dist/` 文件**与对应源码、锁文件一同提交；不能发布只含源码、缺少运行入口的 Git 提交。`npm pack --ignore-scripts` 用于检查可选压缩包，不是 Git 安装的前置条件。

3. 检查 `git diff --check`、`git diff --cached --check`、暂存清单和 `npm pack --dry-run --ignore-scripts` 的实际文件。核对预构建代码来自本次源码，且没有连接文件、令牌、本机状态、私人路径或验收日志进入仓库或压缩包。
4. 提交并推送后，等待 GitHub Actions 的 Windows/Linux × Node 22/24 检查全部通过。CI 使用替身宿主，不代表相应系统的 DSH 桌面已获兼容性验证。

## 安装验收

功能验收和**安装形式验收**分开记录：

- 使用与 `engines.dsh` 相同的 DSH 版本，在隔离 profile 以本地目录安装，确认 bundle 层包含 `agent-collaboration`，所有预构建入口可读取，无需执行仓库构建脚本。
- 推送后，在真实 DSH 插件页填写 `https://github.com/WaldInsel/dsh-desktop-agent-bridge`，核对安装、启用、重启、协作 UI、`dsh_health` 与 `dsh_catalog`；不要把本地目录通过当成 GitHub 下载通过。需要固定源码时可使用 `github:WaldInsel/dsh-desktop-agent-bridge#<sha>`，先核对实际提交。
- 对现有旧式手工安装的机器，先完成任务并退出 DSH；私下备份 `~/.dsh/agent-collaboration`，运行 `node scripts/uninstall-local.mjs` 移除托管配置层并保留状态，再从插件页安装。**不能在旧层上叠加安装**。
- 验收任务创建与续聊、回读、接管/交还/停止，以及 DSH 和父 Agent 审批/回答的实际范围。记录宿主版本、客户端、成功与失败路径。其他系统/版本、远程部署、断网与重启行为若未测，应明确标注。

此前 `0.1.0` 优化版已在现有 Windows + DSH `0.2.1-rc.2` 桌面端完成同会话两轮对话、用户控制及允许/拒绝审批的真实验收；新 GitHub 安装路径需要另行验收，不从功能验收推断安装成功。

## 更新、卸载与回滚

插件页安装的版本，通过该插件的详情页更新或卸载；安装后按页面提示启用、重启，并核对实际 MCP 连接。旧 `update-local.mjs`、`uninstall-local.mjs` 只维护旧式手工安装，不能操作插件页管理的 bundle。状态目录和原生会话不随插件包删除；外部客户端的 MCP 注册及远程通道也需分别处理。

发布失败时不要用旧的整份 DSH 配置覆盖用户当前配置。先保存错误与当前状态；若是旧式手工安装，维护脚本生成的 `backup` 包含原配置和包，可在确认没有并发修改后按清单恢复。插件页安装应使用插件页管理的版本/来源回退，任何已执行任务的文件改动都不会因卸载自动回滚。

需要 GitHub Release 附件时，可在人工核对 `npm pack` 产物后创建草稿，并按实际版本替换标签和文件名：

```sh
gh release create v0.1.1 dsh-agent-collaboration-0.1.1.tgz --draft --title "v0.1.1 — Preview" --notes-file CHANGELOG.md
```

本项目没有自动 npm 发布、自动创建 Release，或对用户桌面的无提示自动更新。
