# Remote Bridge Topology (Cross-Machine Setup)

Use when the MCP client (agent) runs on a different machine than Chrome + the
BrowserPaw extension — e.g. Hermes in a sandbox/VM/container controlling a
desktop browser. Single-machine installs never need this page.

## Control chain

```
Agent machine (sandbox)
  │  MCP over stdio (client spawns the shim as a child process)
  ▼
mcp-chrome-stdio shim  ── POST http://127.0.0.1:<port>/mcp, Bearer <bridge-token>
  │  TCP forward (ssh -L) — the only cross-machine hop
  ▼
Native Bridge (Fastify) on the browser machine — listens on 127.0.0.1:<port>
  │  Chrome Native Messaging (local stdio pipe, no network)
  ▼
Chrome MV3 extension — drives the real tabs
```

Hard constraints that shape everything:

- The shim **refuses any target host that is not 127.0.0.1/localhost/::1**
  before sending the token. The bridge must therefore appear on the agent
  machine's *own* loopback — a forward is mandatory; pointing the shim at the
  browser machine's LAN IP can never work.
- The bridge is loopback-only by design (token + loopback is what keeps local
  web pages from controlling the browser). Do not "fix" reachability by
  binding it to 0.0.0.0.
- The bridge is **on-demand**: Chrome spawns it via the Native Messaging host
  only while that browser runs with the extension active.

## Port model

- Default bridge port is `12306`. Port resolution (bridge side):
  `CHROME_MCP_PORT` > `MCP_HTTP_PORT` > `12306`.
- Multi-instance (one Chromium per profile, one bridge each): an unpatched
  build needs a distinct port per account; the patched fork build
  sticky-scans upward from 12306 while ports are taken and records each in
  the `~/.chrome-mcp/bridges/` registry on the browser machine.
- **Ports move on restart**: if a browser restarts while other bridges hold
  their ports, its bridge may land on a higher port. Probe a range
  (e.g. 12306–12311), never assume one fixed port per browser.
- The restricted-SSH scenario (agent key with `command="true"`, no shell):
  forwards still work — `permitopen` is enforced at CONNECT time, so every
  port you forward must be in the permitted list.

## Bootstrap: `scripts/ensure-tunnel.mjs`

Idempotent forward bootstrap with a three-state probe:

```bash
node scripts/ensure-tunnel.mjs <user@host> <port...> [--key <path>] [--ssh-opt <opt>] [--dry-run]
```

Why three states, not "open/closed": when an `ssh -L` forward exists but the
remote port is closed, ssh's local listener **accepts the TCP connection and
then resets it** — a bare TCP probe reports "reachable" for a dead bridge.
The probe therefore checks `GET /ping` (unauthenticated) behind the TCP
connect:

| State          | Meaning                                                        |
| :------------- | :------------------------------------------------------------- |
| `bridge-up`    | `/ping` answers through the forward                            |
| `forward-only` | forward exists, remote port closed (browser not open / died)   |
| `no-forward`   | nothing listens locally (no tunnel yet)                        |

Behavior per port: `bridge-up` → untouched; `forward-only` → reported
(nothing to start — the local port is held by the existing tunnel);
`no-forward` → `ssh -N -f -L <port>:127.0.0.1:<port>` is started and the
probe retried until the bridge answers or the wait budget (default 8 s)
expires. Exit codes: `0` all up · `1` degraded (forward up, bridge dark —
normal when the remote browser is closed) · `2` hard failure.

The script holds **no credentials**: the ssh identity comes from `--key` or
the caller's normal ssh config/agent; `/ping` needs no bridge token.

## Auto-start: `scripts/mcp-stdio-preflight.mjs`

A transparent stdio wrapper in front of the shim:

```json
"mcpServers": {
  "browserpaw": {
    "command": "node",
    "args": [
      "<ABSOLUTE_PATH_TO_BROWSERPAW>/scripts/mcp-stdio-preflight.mjs",
      "<ABSOLUTE_PATH_TO_BROWSERPAW>/app/native-server/dist/mcp/mcp-server-stdio.js"
    ],
    "env": {
      "BROWSERPAW_TUNNEL_TARGET": "user@browser-machine",
      "BROWSERPAW_TUNNEL_PORTS": "12306,12307,12308,12309,12310,12311",
      "BROWSERPAW_TUNNEL_KEY": "~/.ssh/id_ed25519"
    }
  }
}
```

Without `BROWSERPAW_TUNNEL_TARGET` set it is a pure passthrough (single-
machine installs unaffected). With it set, it runs the ensure-tunnel logic
before spawning the shim and logs progress to **stderr** (the MCP stdio
channel on stdout stays clean). "Bridge dark" is only a warning here — the
bridge is on-demand, so the shim starts regardless and calls succeed as soon
as the remote browser comes up.

## Unattended operation: supervisor loop

For environments where no agent is present to repair a dead tunnel, run the
bootstrap on a timer (the `ssh -f` children detach, so the loop only ever
re-creates missing forwards):

```bash
while :; do
  node /path/to/browserpaw/scripts/ensure-tunnel.mjs user@host 12306 12307 12308 12309 12310 12311 >> tunnel-supervisor.log 2>&1
  sleep 30
done
```

If the host reaps long-running background processes (observed in sandboxed
agent environments: SIGTERM delivered to a persistent loop), prefer a
**scheduler-based watchdog** over the raw loop: a script job that runs the
bootstrap every few minutes and prints *nothing* unless it hard-fails
(exit 2 — ssh refused / forward could not be established). Exit 1 (tunnels
up, remote bridge dark) must stay silent — the bridge is on-demand, so a
closed browser is a normal state. In Hermes, a cron job with `no_agent` and
a wrapper script implements exactly this watchdog pattern: empty stdout
sends nothing, so the job is silent while healthy and speaks up only on
transport failure. A small state file gives you alert throttling (at most
one alert per hour while the failure persists) and a one-line recovery
notice on the transition back to healthy. The bootstrap is idempotent, so
a 5-minute cadence costs nothing and only sets detection latency.

## Token

The bridge generates `~/.chrome-mcp/bridge-token` on the browser machine.
The shim reads it from the **MCP server process's** `$HOME/.chrome-mcp/`
(which can differ from the interactive shell's `$HOME`). Copy the file there
on the agent machine (`chmod 600`); mismatch → 401. Never print it into chat
or logs. Liveness checks never need it (`/ping` is unauthenticated).

## Pitfalls

- **False-positive probes**: TCP-open ≠ bridge-up (see three-state probe).
- `ssh -f` exits 0 before the forward is confirmed — always probe after.
- `pkill -f` patterns that appear in your own shell command line kill your
  own shell (the terminal wrapper's argv contains the literal pattern);
  anchor to the real process (`^ssh …`) and break the digits with a character
  class (`1230[6]`).
- **Misrouting on unpatched builds**: if two profiles' bridges share a port,
  the second bind fails and its extension silently attaches to the first
  bridge — every command relays to the wrong browser. The patched fork build
  scans free ports and verifies `/ping` identity before attaching, so a
  foreign bridge fails loudly.
- A single `ECONNREFUSED` proves only that *something* in the chain is down —
  check tunnel, token, shim, and bridge in order, not just the first guess.
- Killing the bridge process is safe (Chrome respawns it within seconds);
  killing the extension or its host registration is not — verify the
  extension is actually loaded before chasing tunnels.
- A background `while :; do … sleep; done` supervisor is **not durable**:
  host process managers can SIGTERM it (observed: both a 2.4-day-old loop
  and a freshly started one). The `ssh -f` children outlive the loop, so a
  reaped supervisor degrades gracefully — but use a scheduler (system cron
  or an agent-platform cron job) instead of a raw loop for anything that
  must outlive sessions.
