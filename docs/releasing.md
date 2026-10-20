# 发布与维护

本项目以 GitHub 源码为主要交付方式，采用 MIT 许可证。
`package.json` 保留 `"private": true`，防止误发到 npm；这不影响 GitHub 开源或
`npm pack`。内部包名 `dsh-agent-collaboration` 用于兼容已有安装，不随品牌改名。

## 本地检查

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm pack --ignore-scripts
```

`check` 执行测试、构建和发布文件检查。构建会收集实际打包依赖的许可文本到
`dist/THIRD_PARTY_LICENSES.txt`，并检查清单与协议版本一致。
包内只有运行文件、安装脚本、说明与许可证；源码仓库不包含本机配置或验收记录。

自动检查不能替代真实桌面验收。发行说明要分别列出：

- 实际操作系统、DSH 版本和客户端。
- 任务创建、继续、结果回读、接管/交还/停止的结果。
- 审批和问题在 DSH 或父 Agent 处实际验证到哪一步。
- 未测试的平台、版本、远程部署、断网与重启行为。

## 首次推送

确认 GitHub 目标账号、仓库可见性、MIT 许可及暂存文件内容后：

```sh
git init -b main
git add .github .gitattributes .gitignore src test scripts docs examples package.json package-lock.json cordis.patch.yml README.md LICENSE THIRD_PARTY_NOTICES.md CONTRIBUTING.md SECURITY.md CHANGELOG.md
git diff --cached --stat
git diff --cached --check
git commit -m "Initial open-source release"
gh repo create WaldInsel/dsh-desktop-agent-bridge --public --source . --remote origin
git push -u origin main
```

已初始化、已配置 remote 或已有提交时不要重复执行对应步骤。
公开推送前检查完整暂存内容，尤其是日志、连接文件、令牌、私人项目路径和截图。
不要将 `.dsh` 目录或旧验收报告复制进仓库。

## 后续版本

1. 同步修改 `package.json` 与 `src/protocol.mjs` 的版本，运行
   `npm install --package-lock-only --ignore-scripts`。
2. 更新 CHANGELOG，运行完整检查及对应真实桌面验收。
3. 提交并推送。等待 GitHub Actions 的 Windows/Linux 与 Node 22/24 检查完成。
   这些 CI 检查使用替身宿主，不代表对应平台的 DSH 桌面已经通过验证。
4. `npm pack --ignore-scripts` 后检查生成的压缩包，创建人工审核的 Release 草稿：

```sh
gh release create v0.1.0 dsh-agent-collaboration-0.1.0.tgz --draft --title "v0.1.0 — Preview" --notes-file CHANGELOG.md
```

按实际版本替换标签与文件名。确认内容后在 GitHub 发布草稿。
当前没有自动 npm 发布、自动创建 GitHub Release 或对用户桌面的自动更新。

## 安装与回滚

参考 README 的离线维护步骤：先完成或停止协作任务并退出 DSH，再安装、更新或卸载。
备份包含配置和原插件包；并发更改或回滚冲突时保留现场并报告路径，不用旧的
整份 DSH 配置强行覆盖当前配置。卸载保留协作状态、凭据和 DSH 原生会话。
