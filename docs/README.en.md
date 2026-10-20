# DSH Desktop Agent Bridge

[中文](../README.md)

Delegate work from Codex, Hermes, Grok Bot, or another MCP client to an **already running DeepSeek Harness desktop application**. Watch native conversations, add instructions, approve operations, take control, or stop work in the same DSH window.

This is an independent third-party plugin, not affiliated with DeepSeek AI. Version `0.1.0` is a preview. **Windows with DSH `0.2.1-rc.2`** is the verified host combination; other systems and DSH versions are unverified.

**Local stdio connections require no domain, server, or public service.** A cloud parent agent that cannot reach a local process needs a reachable HTTPS endpoint. A managed tunnel or self-hosted HTTPS can provide it; buying a domain or VPS is not required. Managed tunnels are an optional deployment suggestion, not an integrated or tested one-click feature. Default installation configures only the local plugin; it installs no new service, creates no account, and initiates no paid service.

## Features

- An **Agent collaboration** area below the workspace list, grouping multiple sessions by external client.
- Per-client credentials, session ownership, and user-selected workspaces, existing capability presets, and models.
- Session-specific model and supported reasoning-effort selection.
- Native DSH conversations, tools, permissions, and human interaction; no second headless or web DSH process.
- User takeover, release, stop, and explicit handoff of ordinary sessions.
- Optional forwarding of approvals and questions to the parent agent's chat, **disabled by default for each client**.

Capability presets reuse existing DSH compositions, including their skills and MCP tools. The bridge does not install arbitrary skills or MCP servers, change global model defaults, or expose a permission-escalation API.

## Install

Requirements: Node.js 22+, a working DSH desktop installation, and an MCP-capable client. Finish or stop collaboration tasks, then **exit DSH** before installing, updating, or uninstalling.

From the repository:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
node scripts/install-local.mjs
```

The installer backs up its targets, copies the built plugin into the desktop profile, and adds a marked configuration block. It does not replace the DSH application. By default it creates no workspace and grants no resource access.

Use `node scripts/install-local.mjs --help` for custom paths: `--home`, `--profile`, `--state-dir`, and `--backup`. The optional install-only `--initial-workspace <existing-directory>` registers a workspace and initial Codex permissions; omit it to configure access in the UI.

Defaults are `~/.dsh/profiles/desktop` for the profile and `~/.dsh/agent-collaboration` for state. Backups are created in a new directory under `~/.dsh/backups/dsh-agent-collaboration/`, with the original configuration, previous plugin package if present, and `manifest.json`. Update and uninstall reuse the state path from the managed configuration block; `--state-dir` cannot migrate state or bypass active-task checks.

A successful result with `restartRequired: true` confirms file maintenance only, not DSH startup or client connectivity. Perform the checks below after starting DSH.

Start DSH, open **Agent collaboration → Settings**, create one identity per client, select its permitted resources, and save. Empty permission lists grant nothing. Use that client's `client-<id>.json` path shown in settings.

Example local stdio MCP configuration:

```json
{
  "mcpServers": {
    "dsh_collaboration": {
      "command": "node",
      "args": [
        "<installed-plugin-directory>/dist/mcp.mjs",
        "--connection",
        "<collaboration-state-directory>/client-codex.json"
      ]
    }
  }
}
```

Replace placeholders with absolute paths and adapt the configuration format to your client; Hermes uses `mcp_servers`. Never share one client's connection file with another client. The file contains a credential: reference its path rather than pasting its contents into a chat or repository.

Reload MCP or open a new client conversation and actually call `dsh_health` and `dsh_catalog`. Cloud clients need a separately authenticated HTTP adapter and a reachable HTTPS channel; see [remote setup](remote.md). That deployment is optional and is not required for local use.

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

Those desktop acceptance results came from the local version before open-source preparation. The prepared code has passed automated regression, build, and MCP checks, but has not replaced the existing installation or repeated the full human desktop acceptance flow.

Automated tests and a successful build do not establish compatibility with every client or host. The adapter depends on version-specific DSH model selection, interaction, and UI APIs. Revalidate after upgrading DSH.

A client disconnect does not stop work already accepted by DSH. Desktop exit or a crash may interrupt work; there is no automatic task recovery or replay. Credential isolation is API access control, not isolation between processes running under the same OS account. Local state includes task text and interaction audit records. See [security](../SECURITY.md).

## Update, uninstall, and contribute

Exit DSH after resolving unfinished work. Rebuild the source before updating:

```bash
node scripts/update-local.mjs
```

**Legacy private installations:** update and uninstall reject a managed configuration block that lacks `stateDirectory`. Finish pending work and exit DSH first. Add the following under `config` inside the existing `BEGIN dsh-agent-collaboration` / `END dsh-agent-collaboration` block, preserving its indentation:

```yaml
stateDirectory: '<actual absolute path of the existing collaboration data directory>'
```

The former default is `~/.dsh/agent-collaboration`; expand it to its actual absolute path in YAML. Keep the existing state and credentials in place. Do not create empty replacement state, move data, or change `--home` to bypass the checks. Then run maintenance.

To uninstall:

```bash
node scripts/uninstall-local.mjs
```

Both commands support the same path and backup options. Uninstall retains DSH sessions, collaboration state, and connection credentials. Remove client MCP registrations and stop remote adapters/tunnels separately. Uninstalling does not undo previously accepted work.

Host locks, concurrent maintenance locks, or unfinished tasks block maintenance. If a crash leaves a stale lock, confirm that its process has exited before handling it manually; do not delete an active lock just to proceed.

Additional plugins, instructions, or unknown fields inside the managed block also cause refusal, preventing accidental configuration removal. Failed maintenance attempts recovery; if concurrent edits are detected, it preserves those edits and backups for manual recovery.

The internal package `dsh-agent-collaboration`, plugin ID `agent-collaboration`, and MCP tool names remain unchanged for compatibility. The project repository is [dsh-desktop-agent-bridge](https://github.com/WaldInsel/dsh-desktop-agent-bridge).

See [architecture](architecture.md), [contributing](../CONTRIBUTING.md), [changes](../CHANGELOG.md), [releasing](releasing.md), and [related projects](alternatives.md). This project builds on existing DSH bridge ideas; [Harness Relay MCP](https://github.com/tonytanglab/deepseek-harness-relay-mcp) was a public design reference. See [third-party notices](../THIRD_PARTY_NOTICES.md) for the reuse boundary.

Licensed under [MIT](../LICENSE).
