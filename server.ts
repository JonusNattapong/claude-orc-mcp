#!/usr/bin/env bun
/**
 * clew-orc MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:clew-orc
 *
 * With .mcp.json:
 *   { "clew-orc": { "command": "bun", "args": ["./server.ts"] } }
 *
 * New in this fork:
 *   - 2s poll interval (was 1s) to reduce idle CPU while staying responsive
 *   - broadcast_message, set_role, list_peers_by_role tools
 *   - set_presence, message_history, get_thread tools (presence + history + threading)
 *   - reply_to passed through send_message, broadcast_message, and channel push
 *   - cross-platform getTty + ensureBroker (Windows native)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  PeerRole,
  RegisterResponse,
  PollMessagesResponse,
  BroadcastResponse,
  Message,
  ThreadResponse,
  Board,
  BoardTask,
  BoardTaskStatus,
  KanbanResponse,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pick the right bun executable on the current platform.
 * On Windows, npm-installed global binaries are typically `bun.cmd` or `bun.exe`,
 * not the bare `bun` name. Prefer whichever exists on PATH; fall back to
 * common Windows names before throwing.
 */
async function resolveBunExecutable(): Promise<string> {
  const candidates =
    process.platform === "win32"
      ? ["bun", "bun.exe", "bun.cmd"]
      : ["bun"];
  for (const name of candidates) {
    const probe = Bun.spawnSync([name, "--version"], { stderr: "ignore" });
    if (probe.exitCode === 0) return name;
  }
  throw new Error(
    "Could not locate a `bun` executable on PATH. Install Bun from https://bun.sh"
  );
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const bunExe = await resolveBunExecutable();
  const proc = Bun.spawn([bunExe, BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Detach so the broker survives if this MCP server exits.
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[clew-orc] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

/**
 * Cross-platform TTY detection.
 *
 * - POSIX: query `ps -o tty= -p <ppid>`.
 * - Windows: a console process has no real TTY name; we return the parent's
 *   command name as a useful identifier (best-effort, may be null).
 * - Other / unknown: null.
 */
function getTty(): string | null {
  const ppid = process.ppid;
  if (!ppid) return null;
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawnSync(
        ["wmic", "process", "where", `ProcessId=${ppid}`, "get", "Name"],
        { stderr: "ignore" }
      );
      const text = new TextDecoder().decode(proc.stdout).trim();
      if (text) {
        // Output looks like "Name\nClaude.exe\n" — keep the first data line.
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const data = lines.find((l) => l.toLowerCase() !== "name");
        return data ?? null;
      }
    } else {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let myRole: PeerRole = "any";

// --- MCP Server ---

const mcp = new Server(
  { name: "clew-orc", version: "0.3.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the clew-orc network. Other Claude Code instances on this machine can see you and send you messages.

IMPORTANT: When you receive a <channel source="clew-orc" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo, optional role/presence filter)
- list_peers_by_role: Discover peers by role (boss/worker/reviewer/any)
- send_message: Send a message to another instance by ID (optional reply_to to thread a reply)
- broadcast_message: Send a message to every peer (optionally filter by role; optional reply_to)
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- set_role: Declare your role in the agent team (boss/worker/reviewer/any)
- set_presence: Set a short status string (typing/idle/busy/reviewing/...) visible to other peers
- message_history: Fetch past messages (inbox/outbox/all) for catch-up after downtime
- get_thread: Fetch a full conversation thread by the id of any message in it
- check_messages: Manually check for new messages (the polling loop already pushes them automatically)

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, role, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "list_peers_by_role",
    description:
      "List other Claude Code instances filtered by their declared role (boss, worker, reviewer, or any).",
    inputSchema: {
      type: "object" as const,
      properties: {
        role: {
          type: "string" as const,
          enum: ["boss", "worker", "reviewer", "any"],
          description: "Role to filter by.",
        },
      },
      required: ["role"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification. Pass reply_to with the id of an earlier message to thread your message as a reply to it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
        reply_to: {
          type: "number" as const,
          description: "Optional message id this message is replying to. Use get_thread to discover message ids.",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "broadcast_message",
    description:
      "Send a message to every Claude Code instance (optionally filtered by role). Useful when a 'boss' agent needs to announce work to all 'worker' agents at once. Pass reply_to to thread this broadcast as a reply to a prior message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string" as const,
          description: "The message to broadcast.",
        },
        roles: {
          type: "array" as const,
          items: {
            type: "string" as const,
            enum: ["boss", "worker", "reviewer", "any"],
          },
          description:
            "Optional role filter. If omitted, every peer (except the sender) receives the message.",
        },
        include_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Optional explicit list of peer IDs to target.",
        },
        exclude_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Optional peer IDs to skip.",
        },
        reply_to: {
          type: "number" as const,
          description: "Optional message id this broadcast is replying to.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "set_role",
    description:
      "Declare your role in the agent team so other peers can find you with list_peers_by_role. Common roles: boss (orchestrates), worker (does tasks), reviewer (checks work), any (default).",
    inputSchema: {
      type: "object" as const,
      properties: {
        role: {
          type: "string" as const,
          enum: ["boss", "worker", "reviewer", "any"],
          description: "Your role in the agent team.",
        },
      },
      required: ["role"],
    },
  },
  {
    name: "set_presence",
    description:
      "Set a short presence string (max 64 chars) like 'typing', 'idle', 'busy', 'reviewing'. Other peers can filter by it. Stripped of control characters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        presence: {
          type: "string" as const,
          description: "Short status string. Empty string clears it.",
        },
      },
      required: ["presence"],
    },
  },
  {
    name: "message_history",
    description:
      "Fetch recent message history (inbox by default). Useful for catching up on what other peers sent while this instance was offline.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number" as const,
          description: "Max messages to return (1-500). Default 50.",
        },
        since: {
          type: "string" as const,
          description: "Only return messages newer than this ISO timestamp.",
        },
        direction: {
          type: "string" as const,
          enum: ["inbox", "outbox", "all"],
          description: "Which messages to return. Default: inbox.",
        },
      },
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications (every 2 seconds), but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_thread",
    description:
      "Fetch a full conversation thread given the id of any message in it (the root or any reply). Returns the root message and all replies in chronological order. Use this to reconstruct a multi-turn conversation after coming back online, or to look up context for an inbound message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number" as const,
          description: "Id of any message in the thread (root or reply).",
        },
      },
      required: ["id"],
    },
  },

  // --- Identity tools ---

  {
    name: "set_my_name",
    description: "Set your own display name visible to other peers. Use this when the user tells you their preferred name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Your display name (max 32 chars)" },
      },
      required: ["name"],
    },
  },
  {
    name: "set_peer_name",
    description: "Set a display name for another peer. Useful for a 'boss' to label workers, or to give a friendly name to a peer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: { type: "string" as const, description: "The peer ID to name" },
        name: { type: "string" as const, description: "Display name (max 32 chars)" },
      },
      required: ["peer_id", "name"],
    },
  },
  {
    name: "get_my_info",
    description: "Get your own peer info: ID, display name, role, presence, summary, cwd. Useful for knowing who you are in the peer network.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // --- Board tools ---

  {
    name: "create_board",
    description: "Create a shared task board. Boards persist across sessions and are visible to all peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Board name (e.g. 'Sprint 1', 'Bugs')" },
        description: { type: "string" as const, description: "Optional board description" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_boards",
    description: "List all shared task boards.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "create_board_task",
    description: "Add a task to a shared board. Tasks persist and are visible to all peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "number" as const, description: "Board ID to add the task to" },
        title: { type: "string" as const, description: "Task title" },
        description: { type: "string" as const, description: "Optional task description" },
        assigned_to: { type: "string" as const, description: "Optional peer ID to assign this task to" },
      },
      required: ["board_id", "title"],
    },
  },
  {
    name: "update_board_task",
    description: "Update a task's status, title, description, or assignment.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number" as const, description: "Task ID to update" },
        title: { type: "string" as const, description: "New title" },
        description: { type: "string" as const, description: "New description" },
        status: {
          type: "string" as const,
          enum: ["todo", "in_progress", "done", "blocked"] as const,
          description: "New status",
        },
        assigned_to: { type: "string" as const, description: "Assign to peer ID, or empty string to unassign" },
      },
    },
  },
  {
    name: "list_board_tasks",
    description: "List tasks on a board, optionally filtered by status or assignee.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "number" as const, description: "Board ID" },
        status: {
          type: "string" as const,
          enum: ["todo", "in_progress", "done", "blocked"] as const,
          description: "Filter by status",
        },
        assigned_to: { type: "string" as const, description: "Filter by assigned peer ID" },
      },
      required: ["board_id"],
    },
  },
  {
    name: "board_kanban",
    description:
      "View a board as a kanban — all tasks grouped by status (todo/in_progress/done/blocked). Use this to get the full picture of what's happening on a board.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "number" as const, description: "Board ID" },
      },
      required: ["board_id"],
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

function formatPeer(p: Peer): string {
  const parts = [
    `ID: ${p.id}`,
    `PID: ${p.pid}`,
    `Role: ${p.role}`,
    `CWD: ${p.cwd}`,
  ];
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  if (p.presence) parts.push(`Presence: ${p.presence}`);
  parts.push(`Last seen: ${p.last_seen}`);
  return parts.join("\n  ");
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map(formatPeer);
        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "list_peers_by_role": {
      const { role } = args as { role: PeerRole };
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers-by-role", {
          role,
          exclude_id: myId,
        });
        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No peers found with role "${role}".`,
              },
            ],
          };
        }
        const lines = peers.map(formatPeer);
        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) with role "${role}":\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers by role: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message, reply_to } = args as {
        to_id: string;
        message: string;
        reply_to?: number | null;
      };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
          reply_to: reply_to ?? null,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: reply_to != null
                ? `Reply (to msg ${reply_to}) sent to peer ${to_id}`
                : `Message sent to peer ${to_id}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "broadcast_message": {
      const { message, roles, include_ids, exclude_ids, reply_to } = args as {
        message: string;
        roles?: PeerRole[];
        include_ids?: string[];
        exclude_ids?: string[];
        reply_to?: number | null;
      };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<BroadcastResponse>("/broadcast", {
          from_id: myId,
          text: message,
          roles,
          include_ids,
          exclude_ids,
          reply_to: reply_to ?? null,
        });
        if (!result.ok) {
          return {
            content: [
              { type: "text" as const, text: `Broadcast failed: ${result.error ?? "unknown error"}` },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: reply_to != null
                ? `Broadcast reply (to msg ${reply_to}) delivered to ${result.count} peer(s): ${result.delivered_to.join(", ") || "(none)"}`
                : `Broadcast delivered to ${result.count} peer(s): ${result.delivered_to.join(", ") || "(none)"}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error broadcasting: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_role": {
      const { role } = args as { role: PeerRole };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/set-role", {
          id: myId,
          role,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to set role: ${result.error}` }],
            isError: true,
          };
        }
        myRole = role;
        return {
          content: [{ type: "text" as const, text: `Role updated: "${role}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting role: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_presence": {
      const { presence } = args as { presence: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/set-presence", {
          id: myId,
          presence,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to set presence: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Presence updated: "${presence}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting presence: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "message_history": {
      const { limit, since, direction } = args as {
        limit?: number;
        since?: string;
        direction?: "inbox" | "outbox" | "all";
      };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ messages: Array<{ from_id: string; to_id: string; text: string; sent_at: string }>; count: number }>(
          "/messages/history",
          { id: myId, limit, since, direction }
        );
        if (result.messages.length === 0) {
          return {
            content: [
              { type: "text" as const, text: `No messages in ${direction ?? "inbox"} history.` },
            ],
          };
        }
        const lines = result.messages.map(
          (m) => `${m.sent_at}  ${m.from_id} -> ${m.to_id}\n${m.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.count} message(s) (${direction ?? "inbox"}):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching history: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "get_thread": {
      const { id } = args as { id: number };
      try {
        const result = await brokerFetch<
          | { root: Message; replies: Message[]; count: number }
          | { error: string }
        >("/messages/thread", { id });
        if ("error" in result) {
          return {
            content: [{ type: "text" as const, text: `Thread not found: ${result.error}` }],
            isError: true,
          };
        }
        const renderMsg = (m: Message, prefix: string) =>
          `${prefix}[${m.id}] ${m.sent_at}  ${m.from_id} -> ${m.to_id}` +
          (m.reply_to != null ? `  (in reply to ${m.reply_to})` : "") +
          `\n${m.text}`;
        const lines = [
          renderMsg(result.root, ""),
          ...result.replies.map((m) => renderMsg(m, "  ")),
        ];
        return {
          content: [
            {
              type: "text" as const,
              text: `Thread (${result.count} message${result.count === 1 ? "" : "s"}):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching thread: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    // --- Board tool handlers ---

    case "create_board": {
      const { name, description } = args as { name: string; description?: string };
      try {
        const result = await brokerFetch<{ id: number }>("/board/create", { name, description });
        return {
          content: [{ type: "text" as const, text: `Board created: "${name}" (ID: ${result.id})` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "list_boards": {
      try {
        const result = await brokerFetch<{ boards: Board[] }>("/board/list");
        if (result.boards.length === 0) {
          return { content: [{ type: "text" as const, text: "No boards yet." }] };
        }
        const lines = result.boards.map(
          (b) => `  [${b.id}] ${b.name}${b.description ? ` \u2014 ${b.description}` : ""}  (${b.created_at.slice(0, 10)})`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Boards (${result.boards.length}):\n${lines.join("\n")}\n\nUse board_kanban <board_id> to see tasks.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "create_board_task": {
      const { board_id, title, description, assigned_to } = args as {
        board_id: number;
        title: string;
        description?: string;
        assigned_to?: string;
      };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ id: number }>("/board/task/create", {
          board_id,
          title,
          description,
          assigned_to,
          created_by: myId,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: assigned_to
                ? `Task #${result.id} created on board ${board_id}: "${title}" (assigned to ${assigned_to})`
                : `Task #${result.id} created on board ${board_id}: "${title}"`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "update_board_task": {
      const { id, title, description, status, assigned_to } = args as {
        id: number;
        title?: string;
        description?: string;
        status?: BoardTaskStatus;
        assigned_to?: string;
      };
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/board/task/update", {
          id,
          title,
          description,
          status,
          assigned_to: assigned_to === "" ? null : assigned_to,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed: ${result.error}` }],
            isError: true,
          };
        }
        const parts: string[] = [`Task #${id} updated`];
        if (status) parts.push(`status: ${status}`);
        if (assigned_to !== undefined) parts.push(assigned_to ? `assigned to ${assigned_to}` : "unassigned");
        return { content: [{ type: "text" as const, text: parts.join(" \u2014 ") }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "list_board_tasks": {
      const { board_id, status, assigned_to } = args as {
        board_id: number;
        status?: BoardTaskStatus;
        assigned_to?: string;
      };
      try {
        const result = await brokerFetch<{ tasks: BoardTask[] }>("/board/task/list", {
          board_id,
          status,
          assigned_to,
        });
        if (result.tasks.length === 0) {
          return { content: [{ type: "text" as const, text: "No tasks found." }] };
        }
        const lines = result.tasks.map(
          (t) =>
            `  [${t.id}] [${t.status}] ${t.title}${t.assigned_to ? ` (\u2192 ${t.assigned_to})` : ""}${t.description ? `\n       ${t.description}` : ""}`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Tasks (${result.tasks.length}):\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "board_kanban": {
      const { board_id } = args as { board_id: number };
      try {
        const result = await brokerFetch<KanbanResponse | { error: string }>("/board/task/kanban", { board_id });
        if ("error" in result) {
          return {
            content: [{ type: "text" as const, text: result.error }],
            isError: true,
          };
        }
        const renderTasks = (tasks: BoardTask[], status: string) => {
          if (tasks.length === 0) return `  [${status}] \u2014 (empty)`;
          return tasks
            .map((t) => `  [${status}] #${t.id} ${t.title}${t.assigned_to ? ` (${t.assigned_to})` : ""}`)
            .join("\n");
        };
        const sections = [
          `Board: ${result.board.name}`,
          result.board.description ? `Description: ${result.board.description}` : "",
          "",
          renderTasks(result.todo, "todo"),
          renderTasks(result.in_progress, "in_progress"),
          renderTasks(result.done, "done"),
          renderTasks(result.blocked, "blocked"),
        ];
        return {
          content: [{ type: "text" as const, text: sections.filter(Boolean).join("\n") }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "set_my_name": {
      const { name } = args as { name: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string; name?: string }>("/set-name", { id: myId, name });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Name set to "${result.name}"` }] };
      } catch (e) { return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }; }
    }

    case "set_peer_name": {
      const { peer_id, name } = args as { peer_id: string; name: string };
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string; name?: string }>("/set-name", { id: peer_id, name });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Peer ${peer_id} name set to "${result.name}"` }] };
      } catch (e) { return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }; }
    }

    case "get_my_info": {
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        const info = await brokerFetch<Peer & { display_name?: string } | { error: string }>("/peer-info", { id: myId });
        if ("error" in info) return { content: [{ type: "text" as const, text: info.error }], isError: true };
        const p = info as Peer & { display_name?: string };
        const lines = [
          `ID: ${p.id}`,
          `Name: ${p.display_name || "(not set)"}`,
          `Role: ${p.role}`,
          `Presence: ${p.presence || "-"}`,
          `Summary: ${p.summary || "-"}`,
          `CWD: ${p.cwd}`,
          `PID: ${p.pid}`,
          `Last seen: ${p.last_seen}`,
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) { return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }; }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

let pollInFlight = false;

async function pollAndPushMessages() {
  if (!myId || pollInFlight) return;

  pollInFlight = true;
  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    for (const msg of result.messages) {
      // Look up the sender's info for context
      let fromSummary = "";
      let fromCwd = "";
      let fromRole = "";
      let fromPresence = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
          fromRole = sender.role;
          fromPresence = sender.presence;
        }
      } catch {
        // Non-critical, proceed without sender info
      }

      // Push as channel notification — this is what makes it immediate
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.from_id,
            from_role: fromRole,
            from_presence: fromPresence,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            sent_at: msg.sent_at,
            // If this message is a reply, surface that to the receiving
            // Claude so it can call get_thread to fetch context.
            reply_to: msg.reply_to ?? null,
          },
        },
      });

      log(`Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    // Broker might be down temporarily, don't crash
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    pollInFlight = false;
  }
}

// --- Startup ---

async function main() {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Generate initial summary via gpt-5.4-nano (non-blocking, best-effort)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 4. Register with broker
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    role: myRole,
  });
  myId = reg.id;
  log(`Registered as peer ${myId} (role: ${myRole})`);

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch {
          // Non-critical
        }
      }
    });
  }

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start polling for inbound messages (every 2 seconds)
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7. Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
