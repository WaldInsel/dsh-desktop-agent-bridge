# Optional remote MCP

**Local connections need no domain, server, tunnel or cloud account.**
The local stdio connection is the default. This adapter adds a **single-client**,
authenticated Streamable HTTP endpoint for clients that cannot launch a local
process. It listens only on `127.0.0.1`. It does not expose DSH's native gateway or
the collaboration administration actions.

The original Grok path was verified through HTTPS and an SSH reverse tunnel.
This repository ships generic configuration, not a server deployment or an
automatic reconnect service. Remote clients need an HTTPS URL they can reach.
There are two deployment choices:

- A hosted tunnel can provide its own HTTPS hostname, without buying a domain or
  maintaining a VPS. This is a deployment option, **not yet integrated or tested
  by this project**; check its authentication, Host forwarding, Origin handling,
  timeout and privacy behavior before relying on it.
- A self-managed HTTPS reverse proxy and SSH tunnel, documented below, needs a
  domain, TLS certificate, server and restricted SSH account. This matches the
  previously verified Grok deployment.

Keep the desktop, adapter and chosen tunnel running. A cloud agent cannot reach
your desktop's `127.0.0.1` address directly.

## 1. Create a separate DSH client

In **Agent collaboration → Settings**, create `grokbot` (or another ID) and grant
only the intended workspaces, presets and models. Use that client's local
connection file. Each remote listener is fixed to one client; do not share an
identity between unrelated callers.

## 2. Initialize credentials once

Use the installed bundle's adapter, or a built source checkout. The default
Desktop installation path is shown below; confirm the file exists first. Store
credentials outside the repository:

```powershell
$bridge = Join-Path $env:USERPROFILE '.dsh/profiles/desktop/node_modules/dsh-agent-collaboration/dist/remote-mcp.mjs'
if (!(Test-Path -LiteralPath $bridge)) { throw 'Check the installed plugin path first.' }
node $bridge --init --config "$env:USERPROFILE/.dsh/agent-collaboration/remote-grok.json" --public-host bridge.example.com
```

Replace the example domain with your own lowercase hostname. No protocol, port
or path is accepted. Initialization creates a random independent bearer token
and refuses to overwrite an existing file. Startup never silently creates or
replaces credentials.

Keep the file private. POSIX creation requests mode `0600`; Windows inherits the
directory's ACL. These files are not a security boundary against another process
running as the same OS user.

## 3. Start the adapter

```powershell
$bridge = Join-Path $env:USERPROFILE '.dsh/profiles/desktop/node_modules/dsh-agent-collaboration/dist/remote-mcp.mjs'
node $bridge --connection "$env:USERPROFILE/.dsh/agent-collaboration/client-grokbot.json" --config "$env:USERPROFILE/.dsh/agent-collaboration/remote-grok.json" --client grokbot --port 18769
```

The default client is `grokbot` and the default port is `18769`; custom clients
must be explicitly selected. The server rejects connection files whose identity
changes. `Ctrl+C` stops the adapter and does not cancel accepted DSH tasks.

## 4. Forward through HTTPS (self-managed example)

Example reverse tunnel, run on the desktop:

```sh
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 127.0.0.1:18769:127.0.0.1:18769 bridge-user@your-server
```

The server-side forwarding port must remain loopback-only. Put the following
location inside a correctly configured TLS server block for your domain:

```nginx
location = /dsh-collaboration/mcp {
    client_max_body_size 128k;
    proxy_pass http://127.0.0.1:18769;
    proxy_http_version 1.1;
    proxy_set_header Host 127.0.0.1:18769;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 45s;
}
```

Preserve incoming `Origin` headers: the adapter deliberately rejects browser
origins. Do not strip them to bypass that check. Do not log Authorization headers.
TLS ends at your reverse proxy, so the server operator can see requests and results.
No VPS configuration is applied by the project scripts.

## 5. Configure the parent client

- URL: `https://bridge.example.com/dsh-collaboration/mcp`
- Transport: Streamable HTTP, stateless POST
- Header: `Authorization: Bearer <value from your remote config>`

Use the client's secure credential field; never put the token in a chat, URL,
issue or repository. The remote token is distinct from the desktop connection
token. Browser clients requiring CORS, stateful sessions or GET/SSE subscriptions
are not supported.

Verify `dsh_health`, `dsh_catalog` and a small task through the actual parent
client. Tool discovery alone does not prove a complete task. Parent approval
forwarding remains separately disabled until the user enables it in DSH.

## Stop and recovery

Stop the tunnel and adapter with `Ctrl+C`. Remove only your proxy location when
decommissioning; keep DSH task history. A disconnected parent does not stop DSH
work, while a closed or crashed desktop cannot continue it.

After a network outage, restart the failed tunnel/adapter and read the existing
`runId`. Do not create a new request ID merely because a connection failed.
Credential rotation requires stopping the adapter, safely replacing its private
configuration, updating the parent client's secure credential, and restarting.
