#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 *
 * Backward compatible with original claude-peers. New in this fork:
 *   - agent roles (boss/worker/reviewer/any)
 *   - /broadcast endpoint to message every peer at once
 *   - cross-platform process liveness check (works on Windows + Unix)
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  SetRoleRequest,
  ListPeersRequest,
  ListPeersByRoleRequest,
  SendMessageRequest,
  BroadcastRequest,
  BroadcastResponse,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  PeerRole,
  Message,
} from "./shared/types.ts";
import { isPeerRole } from "./shared/types.ts";
import { isProcessAlive } from "./shared/platform.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'any',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Backward-compat: if the table existed before `role` was added, ALTER it.
const peerColumns = db
  .query<{ name: string }, []>("PRAGMA table_info(peers)")
  .all()
  .map((row) => row.name);
if (!peerColumns.includes("role")) {
  db.run("ALTER TABLE peers ADD COLUMN role TEXT NOT NULL DEFAULT 'any'");
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    if (!isProcessAlive(peer.pid)) {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, role, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const updateRole = db.prepare(`
  UPDATE peers SET role = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeerById = db.prepare(`
  SELECT * FROM peers WHERE id = ?
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const selectPeersByRole = db.prepare(`
  SELECT * FROM peers WHERE role = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Helpers ---

function coerceRole(value: unknown, fallback: PeerRole = "any"): PeerRole {
  return isPeerRole(value) ? value : fallback;
}

function rowToPeer(row: Record<string, unknown>): Peer {
  return {
    id: String(row.id),
    pid: Number(row.pid),
    cwd: String(row.cwd),
    git_root: row.git_root == null ? null : String(row.git_root),
    tty: row.tty == null ? null : String(row.tty),
    summary: String(row.summary ?? ""),
    role: coerceRole(row.role),
    registered_at: String(row.registered_at),
    last_seen: String(row.last_seen),
  };
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  const role = coerceRole(body.role);

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, role, now, now);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleSetRole(body: SetRoleRequest): { ok: boolean; error?: string } {
  if (!isPeerRole(body.role)) {
    return { ok: false, error: `Invalid role: ${String(body.role)}` };
  }
  const target = selectPeerById.get(body.id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.id} not found` };
  }
  updateRole.run(body.role, body.id);
  return { ok: true };
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let rows: Record<string, unknown>[];

  switch (body.scope) {
    case "machine":
      rows = selectAllPeers.all() as Record<string, unknown>[];
      break;
    case "directory":
      rows = selectPeersByDirectory.all(body.cwd) as Record<string, unknown>[];
      break;
    case "repo":
      if (body.git_root) {
        rows = selectPeersByGitRoot.all(body.git_root) as Record<string, unknown>[];
      } else {
        // No git root, fall back to directory
        rows = selectPeersByDirectory.all(body.cwd) as Record<string, unknown>[];
      }
      break;
    default:
      rows = selectAllPeers.all() as Record<string, unknown>[];
  }

  // Exclude the requesting peer
  let peers = rows.map(rowToPeer);
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    if (isProcessAlive(p.pid)) return true;
    deletePeer.run(p.id);
    return false;
  });
}

function handleListPeersByRole(body: ListPeersByRoleRequest): Peer[] {
  if (!isPeerRole(body.role)) {
    return [];
  }
  const rows = selectPeersByRole.all(body.role) as Record<string, unknown>[];
  let peers = rows.map(rowToPeer);
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }
  return peers.filter((p) => {
    if (isProcessAlive(p.pid)) return true;
    deletePeer.run(p.id);
    return false;
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Verify target exists
  const target = selectPeerById.get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handleBroadcast(body: BroadcastRequest): BroadcastResponse {
  // Verify sender exists, but allow the special "cli" identifier so the
  // bundled CLI can broadcast without first registering a peer (mirrors
  // the original /send-message behavior, which does not validate sender).
  if (body.from_id !== "cli") {
    const sender = selectPeerById.get(body.from_id) as { id: string } | null;
    if (!sender) {
      return {
        ok: false,
        count: 0,
        delivered_to: [],
        error: `Sender peer ${body.from_id} not found`,
      };
    }
  }

  // Validate role filter (if any) and short-circuit on bad input.
  let roles: PeerRole[] | null = null;
  if (body.roles && body.roles.length > 0) {
    const validated: PeerRole[] = [];
    for (const r of body.roles) {
      if (!isPeerRole(r)) {
        return {
          ok: false,
          count: 0,
          delivered_to: [],
          error: `Invalid role in filter: ${String(r)}`,
        };
      }
      validated.push(r);
    }
    roles = validated;
  }

  // Build target set. Start from all live peers, then apply filters.
  const includeSet = body.include_ids && body.include_ids.length > 0
    ? new Set(body.include_ids)
    : null;
  const excludeSet = new Set<string>([body.from_id, ...(body.exclude_ids ?? [])]);

  const allRows = selectAllPeers.all() as Record<string, unknown>[];
  const candidates = allRows
    .map(rowToPeer)
    .filter((p) => !excludeSet.has(p.id))
    .filter((p) => isProcessAlive(p.pid))
    .filter((p) => (includeSet ? includeSet.has(p.id) : true))
    .filter((p) => (roles ? roles.includes(p.role) : true));

  const sentAt = new Date().toISOString();
  const delivered: string[] = [];
  for (const target of candidates) {
    insertMessage.run(body.from_id, target.id, body.text, sentAt);
    delivered.push(target.id);
  }

  return { ok: true, count: delivered.length, delivered_to: delivered };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/set-role":
          return Response.json(handleSetRole(body as SetRoleRequest));
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/list-peers-by-role":
          return Response.json(handleListPeersByRole(body as ListPeersByRoleRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/broadcast":
          return Response.json(handleBroadcast(body as BroadcastRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
