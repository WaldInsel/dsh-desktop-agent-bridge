# DSH Desktop Agent Bridge

[中文](../README.md)

Delegate work from Codex, Hermes, Grok Bot, or another MCP client to an **already running DeepSeek Harness desktop application**. Watch native conversations, add instructions, approve operations, take control, or stop work in the same DSH window.

This is an independent third-party plugin, not affiliated with DeepSeek AI. Version `0.1.1` is a preview. **Windows with DSH `0.2.1-rc.2`** is the verified host combination; other systems and DSH versions are unverified.

**Local stdio connections require no domain, server, or public service.** A cloud parent agent that cannot reach a local process needs a reachable HTTPS endpoint. A managed tunnel or self-hosted HTTPS can provide it; buying a domain or VPS is not required. Managed tunnels are an optional deployment suggestion, not an integrated or tested one-click feature. Default installation configures only the local plugin; it installs no new service, creates no account, and initiates no paid service.

## Features

- An **Agent collaboration** area below the workspace list, grouping multiple sessions by external client.
- Per-client credentials, session ownership, and user-selected workspaces, existing capability presets, and models.
- Session-specific model and supported reasoning-effort selection.
- Native DSH conversations, tools, permissions, and human interaction; no second headless or web DSH process.
- User takeover, release, stop, and explicit handoff of ordinary sessions.
- Optional forwarding of approvals and questions to the parent agent's chat, **disabled by default for each client**.

Capability presets reuse existing DSH compositions, including their skills and MCP tools. The bridge does not install arbitrary skills or MCP servers, change global model defaults, or expose a permission-escalation API.

## Install directly in DSH

The verified host is **DSH Desktop `0.2.1-rc.2`**. Finish or stop active collaboration tasks, then open **Plugins → Add plugin** in the DSH sidebar. Enter:

```text
https://github.com/WaldInsel/dsh-desktop-agent-bridge
```

Select **Install**, enable `dsh-agent-collaboration` if prompted, then **fully exit and restart DSH**. DSH manages this installation; you do not need to build the repository or run its legacy offline installer first. To pin reviewed code, use `github:WaldInsel/dsh-desktop-agent-bridge#<full-commit-sha>` after checking that the commit has been pushed. The Git repository includes prebuilt `dist/` files and bundled dependency licenses, so installation needs no permission to run a repository `prepare`/build script. The plugin runs inside the existing desktop host.

The same field also accepts an **absolute local directory path** containing `package.json`, `cordis.patch.yml`, and `dist/`, such as `C:\Projects\dsh-desktop-agent-bridge`. That route is useful for development or offline installation. Review the source before installing any plugin: its code runs with your DSH user's permissions. See the [official DSH bundle installation guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/develop/basic/publish.md).

**If you previously used `scripts/install-local.mjs`, do not install over it.** First follow [migrate a legacy installation](#migrate-a-legacy-installation) to remove its manually managed layer while preserving state and credentials.

### Connect an external agent

1. After restart, confirm the **Agent collaboration** area appears and open **Agent collaboration → Settings**.
2. Create separate identities for Codex, Hermes, or other clients. Grant each only the intended workspaces, existing capability presets, and models. New identities have no resource grants.
3. Use each client's displayed `client-<id>.json` connection-file path. It contains a token; reference the file locally instead of pasting its contents into a chat or repository.
4. Configure the local MCP client to launch the stdio bridge. **That external command needs Node.js 22+ on the system PATH**; the DSH plugin-page installation itself is managed by DSH.

```json
{
  "mcpServers": {
    "dsh_collaboration": {
      "command": "node",
      "args": [
        "<DSH desktop profile>/node_modules/dsh-agent-collaboration/dist/mcp.mjs",
        "--connection",
        "<collaboration-state-directory>/client-codex.json"
      ]
    }
  }
}
```

The default desktop profile is `~/.dsh/profiles/desktop`; state defaults to `~/.dsh/agent-collaboration`. Replace placeholders with absolute paths and **check that the installed package entry exists**. Do not assume a platform-independent physical pnpm store path. Adapt the client configuration format as needed; Hermes uses `mcp_servers`. Do not share one client's connection file with another.

Reload MCP or start a new client conversation, then actually call `dsh_health` and `dsh_catalog`. Cloud clients such as Grok Bot need an independently authenticated HTTP adapter and a reachable HTTPS channel; see [remote setup](remote.md). That is optional for local use.

## Task workflow

1. Call `dsh_health`, then `dsh_catalog`.
2. Call `dsh_start_task` using exact authorized resource IDs.
3. Retain the returned `runId` and `sessionId`.
4. Read `dsh_wait_task` or `dsh_get_task` until a terminal state or a request for user input.
5. To continue, submit a new request with the owned `sessionId`; omit it for a new session.

```json
{
  "requestId": "example-task-001",
  "task": "Review the workspace README and report corrections.",
  "title": "Review README",
  "workspaceId": "<workspaceId from dsh_catalog>",
  "preset": "<preset id from dsh_catalog>",
  "selection": {
    "provider": "<provider from dsh_catalog>",
    "model": "<model from dsh_catalog>"
  }
}
```

`selection.reasoningEffort` is optional and must be supported by the selected model. Existing sessions keep their workspace and capability preset. Retries must reuse the same `requestId` and identical parameters; a new turn needs a new ID.

| Tool | Purpose |
| --- | --- |
| `dsh_health` | Check the desktop host, identity, and UI synchronization |
| `dsh_catalog` | Discover authorized resources |
| `dsh_start_task` | Create or continue an owned task |
| `dsh_get_task` / `dsh_wait_task` | Read status and turn results; each wait lasts at most 25 seconds |
| `dsh_list_sessions` | List the client's own collaboration sessions |
| `dsh_send_message` | Steer or queue input for active work |
| `dsh_cancel_task` | Stop an owned task while the agent retains control |
| `dsh_list_interactions` | List pending approvals and questions when forwarding is enabled |
| `dsh_respond_interaction` | Forward the user's actual answer to one request |

`queued`, `running`, `waiting_approval`, and `waiting_input` are not completion. `completed` means the turn ended: still inspect the result and verify artifacts. Do not treat `failed`, `cancelled`, `blocked`, or `unknown` as success. Uncertain dispatch is not automatically replayed.

Results are bounded to the final 60,000 characters of that turn's text, with a `truncated` flag. The full native conversation remains in DSH. Tasks for the same normalized project directory are serialized only within this plugin, not against ordinary DSH sessions or other programs.

## Human control and approvals

Click a collaboration session to open its native conversation and type directly.

- **Take over** revokes external control and withdraws unconsumed external input. Current DSH work continues.
- **Release** restores external control without replaying withdrawn input.
- **Stop** cancels work without rolling back file changes already made.
- **Handoff** explicitly grants an ordinary session to one client. Already-owned collaboration sessions cannot move to another client.

Revoking resources blocks subsequent submissions and is checked again before queued work starts. Use **Stop** to stop work already running.

Approvals normally stay in DSH. A user may enable **Approve and answer in the parent agent** for an individual client. That parent must show the request to the user, wait for the answer, then call `dsh_respond_interaction`. Approvals allow only one-time approval or rejection, never a permanent grant.

**This requires trust in the parent agent.** Identity, ownership, request validity, and response format are checked, but the bridge cannot prove that `userReply` was entered by a human. Do not enable forwarding for a client that may invent user consent or approve autonomously.

The native DSH UI remains available. Its first valid answer wins. Takeover, stopping, disabling forwarding, or changing authorization invalidates old request IDs. A `submitted` result means submission, not successful execution. Disconnection never approves automatically, and uncertain approvals are not automatically retried.

## Verification and limits

Windows + DSH `0.2.1-rc.2` has been tested against the existing desktop host for task creation, continuation, result retrieval, UI, takeover/release/stop, and native approvals. Parent-chat approval and question forwarding has completed a human round trip in **Codex only**; Grok/Hermes have interface and cross-identity rejection checks for that feature, not a human round-trip acceptance test.

The previous optimized `0.1.0` build has been installed in the existing DSH Desktop app and completed a real same-session two-turn task, takeover/release/stop, parent-agent question answering, one-time approval, and rejection. Verify the GitHub plugin-page installation path separately from those feature checks; after installing, call `dsh_health` and `dsh_catalog` and inspect the native session.

Automated tests and a successful build do not establish compatibility with every client or host. The adapter depends on version-specific DSH model selection, interaction, and UI APIs. Revalidate after upgrading DSH.

A client disconnect does not stop work already accepted by DSH. Desktop exit or a crash may interrupt work; there is no automatic task recovery or replay. Credential isolation is API access control, not isolation between processes running under the same OS account. Local state includes task text and interaction audit records. See [security](../SECURITY.md).

## Update and uninstall

**For a plugin installed in the DSH Plugins page:** finish or stop active collaboration tasks, use **Update** on that plugin's details page, follow any enable/restart prompt, then call `dsh_health` and `dsh_catalog` again. Uninstall from the same page. Removing the bundle leaves the separate `~/.dsh/agent-collaboration` state directory, native DSH sessions, and file changes already made. Remove external MCP registrations and any remote adapter/tunnel separately.

`scripts/update-local.mjs` and `scripts/uninstall-local.mjs` are **only for installations previously managed by `scripts/install-local.mjs`**. Do not run them against a Plugins-page installation, and do not install a GUI bundle while the old manually managed configuration layer remains.

### Migrate a legacy installation

1. Finish or stop all collaboration tasks and **fully exit DSH**. Copy `~/.dsh/agent-collaboration` to a private backup location; it contains plain-text tokens and task records.
2. From this repository checkout, run `node scripts/uninstall-local.mjs`. It separately backs up the old profile configuration and plugin package, removes only the marked manual layer and its package, and preserves state, credentials, and DSH sessions. Keep the reported `backup` path. Do not forcibly remove configuration if this step refuses.
3. Start DSH and use **Plugins → Add plugin** as described above. Enable the bundle and fully restart DSH. Check that prior client grants and connection files remain, then call `dsh_health` and `dsh_catalog`. If an old MCP configuration points to a deleted file, update it to the installed package entry and reload the client.

For very old manual blocks without `stateDirectory`, the uninstall script refuses. Identify the real existing state directory first, then add its absolute path under `config` in the original `BEGIN/END dsh-agent-collaboration` marked block, preserving indentation:

```yaml
stateDirectory: '<actual absolute path of the existing collaboration data directory>'
```

The former default was `~/.dsh/agent-collaboration`; expand it to an absolute path in YAML. Keep the original state and credentials. Do not create empty replacement state, move data, or change `--home` to bypass the checks; then retry uninstall.

Legacy maintenance refuses active host/maintenance locks, unfinished work, and unknown entries within its managed block. Inspect those conditions rather than deleting live locks or overwriting unrelated configuration. Its `--home`, `--profile`, `--state-dir`, and `--backup` options locate the manual installation; they do not migrate state or bypass safety checks.

The internal package `dsh-agent-collaboration`, plugin ID `agent-collaboration`, and MCP tool names remain unchanged for compatibility. The project repository is [dsh-desktop-agent-bridge](https://github.com/WaldInsel/dsh-desktop-agent-bridge).

See [architecture](architecture.md), [contributing](../CONTRIBUTING.md), [changes](../CHANGELOG.md), [releasing](releasing.md), and [related projects](alternatives.md). This project builds on existing DSH bridge ideas; [Harness Relay MCP](https://github.com/tonytanglab/deepseek-harness-relay-mcp) was a public design reference. See [third-party notices](../THIRD_PARTY_NOTICES.md) for the reuse boundary.

Licensed under [MIT](../LICENSE).
