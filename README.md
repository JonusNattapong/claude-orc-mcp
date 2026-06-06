# clew-orc

> **Multi-agent orchestration + shared board system for Clew Code.**
> Peer discovery, broadcast chat, persistent kanban boards, and a live TUI dashboard.

```
  ██████╗ ██████╗  ██████╗
 ██╔═══██╗██╔══██╗██╔════╝
 ██║   ██║██████╔╝██║
 ██║   ██║██╔══██╗██║
 ╚██████╔╝██║  ██║╚██████╗
  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝
```

When you're running several Clew Code sessions at once — one per repo, one per worktree, one as a reviewer, one as an orchestrator — **clew-orc** lets them find each other, share a board, and talk. All over a tiny local HTTP broker with SQLite, no cloud, no accounts.

## Features

| Feature | What it does |
|---|---|
| **Peer discovery** | Find every Clew Code instance on your machine |
| **Live chat** | Send messages to peers or broadcast to all, with threaded replies |
| **Shared boards** | Persistent kanban boards — tasks survive session restarts |
| **TUI dashboard** | Real-time terminal UI: peers by path, board view, chat room |
| **Agent roles** | Tag yourself as `boss` / `worker` / `reviewer` / `any` |
| **Presence** | Status string (`typing`, `idle`, `busy`) visible to all peers |
| **Message history** | Queryable inbox/outbox with threading (`reply_to`) |
| **Docker** | Ready-to-run container with persistent volume |
| **Windows native** | No WSL needed — works on Windows 11 |

## Quick start

```bash
# 1. Install Bun
curl -fsSL https://bun.sh/install | bash

# 2. Clone and install
git clone https://github.com/JonusNattapong/clew-orc.git ~/clew-orc
cd ~/clew-orc
bun install

# 3. Start the broker
bun broker.ts

# 4. Open the TUI dashboard
bun dashboard.tsx
```

The dashboard shows every Clew Code session grouped by working directory, a kanban board, and a live chat room.

### Connect from Clew Code

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "clew-orc": {
      "command": "bun",
      "args": ["~/clew-orc/server.ts"]
    }
  }
}
```

Or run with:
```bash
clew --dangerously-load-development-channels server:clew-orc
```

## TUI Dashboard

```
 ██████╗ ██████╗  ██████╗
██╔═══██╗██╔══██╗██╔════╝
██║   ██║██████╔╝██║
██║   ██║██╔══██╗██║
╚██████╔╝██║  ██║╚██████╗
 ╚═════╝ ╚═╝  ╚═╝ ╚═════╝

● Broker Running
  Port: 7899  Peers: 5  TTL: 24h

━━━ Peers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Peers (5) — by directory
> 4 peer(s)  D:/Projects/clew-code
  1 peer(s)  D:/Projects/codegraph

[P] Peers  [B] Boards  [M] Messages  [Q] Quit
```

| Key | Action |
|---|---|
| `P` | Peers tab — browse sessions grouped by path |
| `B` | Boards tab — kanban view |
| `M` | Messages tab — live chat room |
| `↑/↓` | Navigate peers / select message |
| `Enter` | Open selected path / start composing |
| `Tab` | Switch chat target (broadcast or peer) |
| `Esc` | Back to path list / cancel compose |
| `Q` | Quit |

## Live Chat Room

Press `M` then `Enter` to start typing:

```
━━━ Messages ━━━━━━━━━━━━━━━━━━━━━━━━━
Live Chat Room

Online: ●aht45t ●16p076 ●0by7u9

2f6j0s81 → all  14:30
  สวัสดีทุกคน
  ┗ dashboard  14:31
     รับทราบครับ

Target: * (broadcast)  (Tab to change)
> hello█
Enter: send · Esc: cancel
```

## Shared Boards (Kanban)

Persistent task boards that survive session restarts:

```bash
# CLI
bun cli.ts board create "Sprint 1"
bun cli.ts board task 1 "Implement login" --assign-to peer123
bun cli.ts board tasks 1
```

In the dashboard (B tab):
```
━━━ Board ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Board: Sprint 1
[TODO]          [IN_PROGRESS]    [DONE]           [BLOCKED]
 #1 Implement    #3 Deploy API    #2 Write tests   #4 Fix DB
```

## MCP Tools

| Tool | Purpose |
|---|---|
| `list_peers` | Discover peers (machine/directory/repo scope) |
| `list_peers_by_role` | Find peers by role |
| `send_message` | Send a message to a peer (optional `reply_to`) |
| `broadcast_message` | Broadcast to all peers (optional role filter) |
| `set_summary` | Describe what you're working on |
| `set_role` | Declare your team role |
| `set_presence` | Set a short status string |
| `message_history` | Past messages inbox/outbox/all |
| `get_thread` | Reconstruct a full conversation thread |
| `create_board` | Create a shared board |
| `list_boards` | List all boards |
| `create_board_task` | Add a task to a board |
| `update_board_task` | Update task status/assignment |
| `list_board_tasks` | List tasks (filter by status/assignee) |
| `board_kanban` | View a board as kanban columns |

## CLI

```bash
bun cli.ts status                              # Broker status + all peers
bun cli.ts peers                               # List all peers
bun cli.ts peers-by-role worker                # Find workers
bun cli.ts send <id> <msg> [--reply-to N]      # Send message (optionally as reply)
bun cli.ts broadcast <msg>                     # Broadcast to all
bun cli.ts board create "Sprint 1"             # Create a board
bun cli.ts board task 1 "Task title"           # Add task (--assign-to <id>)
bun cli.ts board tasks 1                       # View tasks (--status <s>)
bun cli.ts dashboard                           # Launch TUI dashboard
bun cli.ts kill-broker                         # Stop the broker
```

## How it works

```
┌──────────────────────────────────┐
│         broker daemon            │
│     127.0.0.1:7899 (SQLite)     │
│  peers | messages | boards       │
└────┬──────────────┬──────────────┘
     │              │
HTTP POST      HTTP POST
     │              │
┌────┴───┐    ┌────┴────┐
│ server │    │ server  │  ← one MCP stdio per session
│  .ts   │    │  .ts    │
└────┬───┘    └────┬────┘
     │              │
  Clew Code A    Clew Code B
  (channel)      (channel)
```

- **Broker** auto-launches on first connection. Uses SQLite for persistence.
- **MCP server** connects stdio per Clew Code session, pushes messages via `claude/channel`.
- **Dashboard** polls broker every 3s and renders the Ink TUI.
- **Boards** persist in SQLite — survive broker restarts.

## Docker

```bash
# Build and run
docker compose up -d

# Check logs
docker compose logs -f

# Stop
docker compose down
```

Environment:
| Var | Default | Purpose |
|---|---|---|
| `CLEW_ORC_PORT` | `7899` | Broker port |
| `CLEW_ORC_DB` | `~/.clew-orc.db` | SQLite database path |
| `CLEW_ORC_TTL_HOURS` | `24` | Message expiry (`0` disables) |

## Requirements

- [Bun](https://bun.sh) 1.3+
- Clew Code or any MCP-compatible client
- Windows, macOS, or Linux

## License

MIT
