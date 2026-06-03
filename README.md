# claude-orc

> **Multi-agent orchestration for Claude Code.**
> A fork of [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) that adds roles, broadcast, presence, history, message TTL, threaded replies, and Windows-native support.

```
   Boss                          Worker A                       Worker B
   (role: boss)                  (role: worker)                 (role: worker)
   ┌──────────┐   broadcast      ┌──────────┐                   ┌──────────┐
   │ Claude   │ ───────────────> │ Claude   │                   │ Claude   │
   │ "refactor│                  │ "on it"  │                   │          │
   │  the X"  │   reply (47)     │          │                   │          │
   │          │ <─────────────── │          │                   │          │
   └──────────┘                  └──────────┘                   └──────────┘
        │                                                             ▲
        └──────────── broadcast ──────────────────────────────────────┘
                          (one message → every worker)
```

When you're running several Claude Code sessions at once — one per repo, one per worktree, one as a reviewer, one as an orchestrator — **claude-orc** lets them find each other and talk. The boss can broadcast a task to every worker, the worker can reply in a thread, the reviewer can see the presence string ("typing", "busy", "reviewing") before pinging. All over a tiny local HTTP broker with SQLite, no cloud, no accounts.

## Quick start

```bash
# 1. Install Bun (if you don't have it)
curl -fsSL https://bun.sh/install | bash

# 2. Clone and install
git clone https://github.com/JonusNattapong/claude-orc-mcp.git ~/claude-orc
cd ~/claude-orc
bun install

# 3. Register the MCP server
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-orc/server.ts

# 4. Start Claude Code with the channel enabled (do this in every session)
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

Open a second terminal and run the same command. Then in either session:

> List all peers on this machine

You'll see every running instance. Then:

> Send a message to peer `[id]`: "what are you working on?"

The other Claude receives it **instantly** via Claude Code's channel protocol.

## What's new vs upstream `claude-peers`

| Feature | What it does |
|---|---|
| **Agent roles** | Tag yourself as `boss` / `worker` / `reviewer` / `any` so peers can find you by team position |
| **Broadcast** | Send a message to every peer at once, optionally filtered by role / include / exclude |
| **Presence** | A short free-form status string (`typing`, `idle`, `busy coding`) that surfaces in `list_peers` and the channel push |
| **Message history** | Queryable `inbox` / `outbox` / `all` with limit and `since` filter — catch up after downtime |
| **Message TTL** | Auto-expire unread messages after 24h (configurable, `0` = never expire) |
| **Threaded replies** | Every message can carry `reply_to`; `get_thread` walks the chain to rebuild a full conversation tree |
| **2s polling** | (was 1s) lower idle CPU while still feeling instant via channel push |
| **Windows native** | Cross-platform PID liveness, TTY via `wmic`, `kill-broker` via `netstat`+`taskkill`. No WSL needed |
| **CI** | GitHub Actions matrix: typecheck + 49 tests + bundle build on Ubuntu, Windows, macOS |

All additive — the original endpoints, tools, and DB schema are preserved (new columns added via `ALTER TABLE`).

## Multi-agent pattern: boss + workers with threads

```
   👑 Boss (role: boss)            👷 Worker A                👷 Worker B
        │                              │                          │
        │  broadcast "fix #1, #2, #3"  │                          │
        │  ─────────────────────────>  │                          │
        │  ────────────────────────────────────────────────────>  │
        │  [msg 42]                     [msg 42]                  [msg 42]
        │                              │                          │
        │                       "fixed #1" (reply_to: 42)         │
        │                       [msg 47]                          │
        │ <─────────────────────────────────                      │
        │                              │                  "fixed #2" (reply_to: 42)
        │                              │                  [msg 48]
        │ <───────────────────────────────────────────────────── │
        │                              │                          │
        │  get_thread(47)  ──>  reconciles the full chain in one call
```

In a boss session:

> Set my role to "boss".
> Broadcast: "fix bug #1, #2, #3" with roles=["worker"].
> (later) Get thread 47 to see the full context.

In a worker session:

> Set my role to "worker".
> Send message to `<boss>` with reply_to=42: "fixed #1, but #2 needs more context".

The boss gets the reply with `reply_to: 42` in the channel payload, calls `get_thread(47)`, and sees the original ask plus all the worker replies in order — no more guessing which message answered which task.

## Tools (MCP)

| Tool | Purpose |
|---|---|
| `list_peers` | Discover peers (`machine` / `directory` / `repo` scope, optional `role`/`presence` filter) |
| `list_peers_by_role` | Find peers by declared role |
| `send_message` | Send to one peer (optional `ttl_seconds`, `reply_to`) |
| `broadcast_message` | Send to every peer (optional roles / include / exclude, `reply_to`) |
| `set_summary` | Describe what you're working on |
| `set_role` | Declare your team role |
| `set_presence` | Set a short status string |
| `message_history` | Past messages (inbox/outbox/all, with limit) |
| `get_thread` | Reconstruct a full conversation thread |
| `check_messages` | Manual poll (normally the channel push handles it) |

## CLI

```bash
bun cli.ts status                              # broker status + all peers
bun cli.ts peers                               # list all peers
bun cli.ts peers-by-role worker                # find workers
bun cli.ts send <id> <msg> [--reply-to N]      # send (optionally as a reply)
bun cli.ts broadcast <msg> [--roles r,r] [--reply-to N]
bun cli.ts set-role <id> worker
bun cli.ts set-presence <id> "reviewing"
bun cli.ts history <id> [limit] [inbox|outbox|all]
bun cli.ts thread <msg-id>                     # full conversation tree
bun cli.ts kill-broker
```

## How it works

```
                     ┌──────────────────────────┐
                     │   broker daemon          │
                     │   127.0.0.1:7899         │
                     │   Bun.serve + SQLite     │
                     └────┬──────────────┬──────┘
                          │              │
                     HTTP POST      HTTP POST
                          │              │
                    ┌─────┴───┐     ┌────┴────┐
                    │ server  │     │ server  │   ← one MCP stdio per Claude session
                    │  .ts    │     │  .ts    │
                    └────┬────┘     └────┬────┘
                         │              │
                       Claude A      Claude B
                       (channel)     (channel)
```

- The broker **auto-launches** on the first session. It exits when no peers are left.
- Each session registers its PID + cwd + git root + tty + summary, then **polls every 2s** for new messages.
- Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol so Claude sees them **immediately** without waiting for the next user turn.
- The broker reaps dead PIDs cross-platform (handles `EPERM` on Windows).
- Everything is **localhost-only** — no network exposure.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CLAUDE_PEERS_PORT` | `7899` | Broker port |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite database file |
| `CLAUDE_PEERS_MESSAGE_TTL_HOURS` | `24` | Unread message expiry (`0` disables) |
| `OPENAI_API_KEY` | — | Enables auto-summary via `gpt-5.4-nano` on startup |

## Windows

Tested on Windows 11 native (not WSL). The original `claude-peers` used `lsof` and `ps -o tty=` which don't exist on Windows; this fork:

- Replaces `process.kill(pid, 0)` with a cross-platform `isProcessAlive()` helper in `shared/platform.ts` (handles `EPERM`).
- Detects TTY via `wmic`, falls back gracefully.
- `kill-broker` uses `netstat -ano` + `taskkill /F /PID`.
- Resolves `bun.exe` / `bun.cmd` / `bun` on PATH.

## Development

```bash
bun test                              # 49 tests across 6 files
bun test tests/threading.test.ts      # just the threading suite
bunx tsc --noEmit                     # typecheck
bun broker.ts                         # run broker standalone
bun run build                         # build dist/{broker,server,cli}.js
bun run prepublishOnly                # typecheck + test + build (CI parity)
```

CI runs on every push and PR across `ubuntu-latest`, `windows-latest`, and `macos-latest` (Bun 1.3.x, frozen lockfile), and uploads the bundled `dist/` artifacts.

## Backward compatibility

- Same port (7899) and same DB file format.
- New columns (`role`, `presence`, `messages.expires_at`, `messages.reply_to`) are added via `ALTER TABLE` on existing databases; defaults keep old clients working.
- Original endpoints (`/register`, `/heartbeat`, `/set-summary`, `/list-peers`, `/send-message`, `/poll-messages`, `/unregister`) and tools (`list_peers`, `send_message`, `set_summary`, `check_messages`) are unchanged.
- New endpoints and tools are purely additive and advertised in the MCP `tools` list.

## Requirements

- [Bun](https://bun.sh) 1.3+
- Claude Code v2.1.80+
- A `claude.ai` login (channels require it — API-key auth won't work)
- Windows, macOS, or Linux

## License

MIT — same as upstream.
