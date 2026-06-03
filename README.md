# claude-orc (claude-peers fork)

Let your Claude Code instances find each other and talk. When you're running 5 sessions across different projects, any Claude can discover the others and send messages that arrive instantly.

```
  Terminal 1 (poker-engine)          Terminal 2 (eel)
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude A              │          │ Claude B             │
  │ "send a message to    │  ──────> │                      │
  │  peer xyz: what files │          │ <channel> arrives    │
  │  are you editing?"    │  <────── │  instantly, Claude B │
  │                       │          │  responds            │
  └───────────────────────┘          └──────────────────────┘
```

This is a fork of [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) that adds:

- **Agent roles** (`boss` / `worker` / `reviewer` / `any`) for orchestrating multi-agent teams
- **`broadcast_message`** tool to message every peer (optionally filtered by role)
- **Presence** — every peer carries a short free-form status string (e.g. `typing`, `idle`, `busy coding`) that surfaces in the channel and in `list_peers`
- **Message history** — queryable inbox/outbox/all with configurable limit
- **Message TTL** — auto-expiry of unread messages after a default of 24h (configurable, disable-able)
- **2-second polling** loop (was 1s) to reduce idle CPU while staying responsive
- **Windows-native compatibility** — cross-platform PID liveness check, bun executable discovery, TTY detection, and `kill-broker` (`netstat` + `taskkill` instead of `lsof`)
- **GitHub Actions CI** — typecheck, tests, and bundle build on Ubuntu, Windows, and macOS

Fully backward compatible with the original `claude-peers`. Same port (7899), same DB schema (the new `role` column is added via `ALTER TABLE` on existing databases), all original tools and endpoints still work.

## Quick start

### 1. Install

```bash
git clone https://github.com/JonusNattapong/claude-orc-mcp.git ~/claude-orc
cd ~/claude-orc
bun install
```

### 2. Register the MCP server

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-orc/server.ts
```

### 3. Run Claude Code with the channel

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, role, and summary. Then:

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool                   | What it does                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `list_peers`           | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` (optional `role` / `presence` filter) |
| `list_peers_by_role`   | Find peers by their declared role (boss/worker/reviewer/any)                          |
| `send_message`         | Send a message to another instance by ID (optional `ttl_seconds` override)            |
| `broadcast_message`    | Send a message to every peer at once (optional role / include / exclude filters, optional `ttl_seconds`) |
| `set_summary`          | Describe what you're working on (visible to other peers)                              |
| `set_role`             | Declare your role in the agent team (boss/worker/reviewer/any)                        |
| `set_presence`         | Update your free-form presence string (e.g. `typing`, `idle`, `busy`)                 |
| `message_history`      | Fetch recent message history for a peer (`inbox` / `outbox` / `all`, with limit)      |
| `check_messages`       | Manually check for messages (fallback if not using channel mode)                      |

## Roles: orchestrating multi-agent teams

A typical orchestrator pattern:

```
  ┌────────────┐    broadcast_message(roles=["worker"])    ┌────────────┐
  │  Claude A  │ ───────────────────────────────────────> │  Claude B  │
  │  (boss)    │                                            │  (worker)  │
  │            │    broadcast_message(roles=["worker"])    │            │
  │            │ ───────────────────────────────────────> │  Claude C  │
  │            │                                            │  (worker)  │
  │            │ <─────────────────────────────────────── │            │
  │            │    send_message(from_id=...)              │            │
  │            │ <─────────────────────────────────────── │            │
  └────────────┘                                            └────────────┘
```

In a "boss" agent, declare the role and broadcast work:

```
> set my role to "boss"
> broadcast "Task A: refactor the auth module. Reply when done" with roles=["worker"]
> broadcast "Task B: write tests for the new endpoint" with roles=["worker"]
```

Workers declare their role and listen for broadcasts:

```
> set my role to "worker"
```

Reviewers can be pinged separately:

```
> list peers with role "reviewer"
> send a review request to the reviewer peer
```

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Each Claude Code session spawns an MCP server that registers with the broker and polls for messages every 2 seconds. Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol, so Claude sees them immediately.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  localhost:7899 + SQLite  │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
```

The broker auto-launches when the first session starts. It cleans up dead peers automatically (cross-platform PID check — `process.kill(pid, 0)` with an EPERM-tolerant fallback). Everything is localhost-only.

## CLI

Inspect and interact from the command line:

```bash
cd ~/claude-orc

bun cli.ts status                       # broker status + all peers (shows TTL)
bun cli.ts peers                        # list all peers (shows role + presence)
bun cli.ts peers-by-role worker         # list peers with role "worker"
bun cli.ts send <id> <msg>              # send a message into a Claude session
bun cli.ts broadcast <msg>              # broadcast to every peer
bun cli.ts broadcast <msg> --roles worker  # broadcast to specific role
bun cli.ts set-role <id> worker         # change a peer's role
bun cli.ts set-presence <id> <string>   # set a peer's presence (e.g. "typing")
bun cli.ts history <id> [limit] [dir]   # message history (inbox|outbox|all; default 10, all)
bun cli.ts kill-broker                  # stop the broker (uses lsof on Unix, netstat+taskkill on Windows)
```

## Windows compatibility

The original `claude-peers` used Unix-only tools (`lsof`, `ps -o tty=`) for PID liveness and TTY detection. This fork:

- Replaces `process.kill(pid, 0)` with a cross-platform helper (`shared/platform.ts`) that handles `EPERM` (process exists but we can't signal it).
- Detects TTY via `wmic` on Windows, falls back gracefully.
- Resolves the `bun` executable (handles `bun.exe` / `bun.cmd` on Windows).
- `kill-broker` uses `netstat -ano` + `taskkill /F /PID` on Windows, `lsof` on Unix.

Tested on Windows 11 native (not WSL).

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). Without the API key, Claude sets its own summary via the `set_summary` tool.

## Configuration

| Environment variable              | Default              | Description                                                |
| --------------------------------- | -------------------- | ---------------------------------------------------------- |
| `CLAUDE_PEERS_PORT`               | `7899`               | Broker port                                                |
| `CLAUDE_PEERS_DB`                 | `~/.claude-peers.db` | SQLite database path                                       |
| `CLAUDE_PEERS_MESSAGE_TTL_HOURS`  | `24`                 | Default message TTL in hours (`0` disables expiry)         |
| `OPENAI_API_KEY`                  | —                    | Enables auto-summary via gpt-5.4-nano                      |

## Development

```bash
bun test                              # run all tests
bun test tests/broker.test.ts         # run a single file
bunx tsc --noEmit                     # typecheck
bun broker.ts                         # run broker standalone
bun run build                         # build dist/{broker,server,cli}.js
bun run prepublishOnly                # typecheck + test + build (CI parity)
```

CI runs on every push and pull request across `ubuntu-latest`, `windows-latest`, and `macos-latest` (Bun 1.3.x, frozen lockfile), and uploads the bundled `dist/` artifacts on every build.

## Backward compatibility

- Same port (7899) and same DB file format.
- The new `role`, `presence`, and `messages.expires_at` columns are added via `ALTER TABLE` on existing databases; default for `role` is `'any'`, `presence` is `''`, and `expires_at` is `NULL` (no expiry).
- All original endpoints (`/register`, `/heartbeat`, `/set-summary`, `/list-peers`, `/send-message`, `/poll-messages`, `/unregister`) and tools (`list_peers`, `send_message`, `set_summary`, `check_messages`) work unchanged.
- New endpoints (`/set-role`, `/list-peers-by-role`, `/broadcast`, `/set-presence`, `/messages/history`) and tools (`set_role`, `list_peers_by_role`, `broadcast_message`, `set_presence`, `message_history`) are purely additive.
- `set_presence` and `message_history` are advertised in the MCP `tools` list, so any client that auto-discovers tools will see them.

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)
- Windows, macOS, or Linux (cross-platform)

## License

MIT (same as upstream).
