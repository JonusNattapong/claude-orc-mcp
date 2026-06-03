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
 *   - /messages/history endpoint to query past messages
 *   - /set-presence + presence column for "typing" / activity status
 *   - message TTL (configurable, default 24h)
 *   - cross-platform process liveness check (works on Windows + Unix)
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  SetRoleRequest,
  SetPresenceRequest,
  ListPeersRequest,
  ListPeersByRoleRequest,
  SendMessageRequest,
  BroadcastRequest,
  BroadcastResponse,
  PollMessagesRequest,
  PollMessagesResponse,
  MessageHistoryRequest,
  MessageHistoryResponse,
  Peer,
  PeerRole,
  Message,
} from "./shared/types.ts";
import { isPeerRole } from "./shared/types.ts";
import { isProcessAlive } from "./shared/platform.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
// Default message TTL: 24 hours. Set to 0 to disable expiry.
const MESSAGE_TTL_HOURS = Math.max(0, parseFloat(process.env.CLAUDE_PEERS_MESSAGE_TTL_HOURS ?? "24"));
// Cleanup interval: every 5 minutes.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

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
    presence TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Backward-compat: ALTER the peers table if columns are missing.
{
  const cols = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(peers)")
      .all()
      .map((r) => r.name)
  );
  if (!cols.has("role")) {
    db.run("ALTER TABLE peers ADD COLUMN role TEXT NOT NULL DEFAULT 'any'");
  }
  if (!cols.has("presence")) {
    db.run("ALTER TABLE peers ADD COLUMN presence TEXT NOT NULL DEFAULT ''");
  }
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// Backward-compat: ALTER the messages table if expires_at is missing.
{
  const msgCols = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((r) => r.name)
  );
  if (!msgCols.has("expires_at")) {
    db.run("ALTER TABLE messages ADD COLUMN expires_at TEXT");
  }
}

db.run("CREATE INDEX IF NOT EXISTS idx_messages_to_undelivered ON messages(to_id, delivered, sent_at)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id, sent_at)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL");

// --- Periodic cleanup ---

function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    if (!isProcessAlive(peer.pid)) {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

function cleanExpiredMessages() {
  if (MESSAGE_TTL_HOURS <= 0) return; // TTL disabled
  const cutoff = new Date(Date.now() - MESSAGE_TTL_HOURS * 3600 * 1000).toISOString();
  // Only delete delivered messages older than the cutoff, or any undelivered
  // message past its expiry. This preserves undelivered recent messages.
  db.run("DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?", [cutoff]);
  db.run("DELETE FROM messages WHERE delivered = 1 AND sent_at < ?", [cutoff]);
}

cleanStalePeers();
cleanExpiredMessages();
setInterval(() => {
  cleanStalePeers();
  cleanExpiredMessages();
}, CLEANUP_INTERVAL_MS);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, role, presence, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

const updatePresence = db.prepare(`
  UPDATE peers SET presence = ? WHERE id = ?
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
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered, expires_at)
  VALUES (?, ?, ?, ?, 0, ?)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages
  WHERE to_id = ? AND delivered = 0
    AND (expires_at IS NULL OR expires_at > ?)
  ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

const selectHistoryInbox = db.prepare(`
  SELECT * FROM messages
  WHERE to_id = ? AND (expires_at IS NULL OR expires_at > ?)
    AND (? IS NULL OR sent_at > ?)
  ORDER BY sent_at DESC
  LIMIT ?
`);

const selectHistoryOutbox = db.prepare(`
  SELECT * FROM messages
  WHERE from_id = ? AND (expires_at IS NULL OR expires_at > ?)
    AND (? IS NULL OR sent_at > ?)
  ORDER BY sent_at DESC
  LIMIT ?
`);

const selectHistoryAll = db.prepare(`
  SELECT * FROM messages
  WHERE (from_id = ? OR to_id = ?)
    AND (expires_at IS NULL OR expires_at > ?)
    AND (? IS NULL OR sent_at > ?)
  ORDER BY sent_at DESC
  LIMIT ?
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

function coercePresence(value: unknown): string {
  if (typeof value !== "string") return "";
  // Strip control chars first, then cap length, so the cap applies to the
  // cleaned value (otherwise the cap is reached before stripping and the
  // caller can bloat the visible string with control bytes near the front).
  return value.replace(/[\x00-\x1f]/g, "").slice(0, 64);
}

function computeExpiry(ttlSeconds: number | undefined): string | null {
  if (ttlSeconds === undefined) {
    return MESSAGE_TTL_HOURS > 0
      ? new Date(Date.now() + MESSAGE_TTL_HOURS * 3600 * 1000).toISOString()
      : null;
  }
  if (ttlSeconds <= 0) return null;
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
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
    presence: String(row.presence ?? ""),
    registered_at: String(row.registered_at),
    last_seen: String(row.last_seen),
  };
}

function filterAndReap<T extends { id: string; pid: number }>(
  peers: T[]
): T[] {
  return peers.filter((p) => {
    if (isProcessAlive(p.pid)) return true;
    deletePeer.run(p.id);
    return false;
  });
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  const role = coerceRole(body.role);
  const presence = coercePresence(body.presence);

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, role, presence, now, now);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  if (body.presence !== undefined) {
    db.run("UPDATE peers SET last_seen = ?, presence = ? WHERE id = ?", [
      new Date().toISOString(),
      coercePresence(body.presence),
      body.id,
    ]);
  } else {
    updateLastSeen.run(new Date().toISOString(), body.id);
  }
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

function handleSetPresence(body: SetPresenceRequest): { ok: boolean; error?: string } {
  const target = selectPeerById.get(body.id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.id} not found` };
  }
  updatePresence.run(coercePresence(body.presence), body.id);
  return { ok: true };
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let rows: Record<string, unknown>[];

  if (body.role && isPeerRole(body.role)) {
    rows = selectPeersByRole.all(body.role) as Record<string, unknown>[];
  } else {
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
          rows = selectPeersByDirectory.all(body.cwd) as Record<string, unknown>[];
        }
        break;
      default:
        rows = selectAllPeers.all() as Record<string, unknown>[];
    }
  }

  let peers = rows.map(rowToPeer);

  // Optional filters
  if (body.role && isPeerRole(body.role)) {
    peers = peers.filter((p) => p.role === body.role);
  }
  if (body.presence) {
    const needle = body.presence.toLowerCase();
    peers = peers.filter((p) => p.presence.toLowerCase().includes(needle));
  }
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  return filterAndReap(peers);
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
  return filterAndReap(peers);
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  const target = selectPeerById.get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  const expiresAt = computeExpiry(body.ttl_seconds);
  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString(), expiresAt);
  return { ok: true };
}

function handleBroadcast(body: BroadcastRequest): BroadcastResponse {
  // Allow "cli" as a special sender for the bundled CLI (matches /send-message).
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
  const expiresAt = computeExpiry(body.ttl_seconds);
  const delivered: string[] = [];
  for (const target of candidates) {
    insertMessage.run(body.from_id, target.id, body.text, sentAt, expiresAt);
    delivered.push(target.id);
  }

  return { ok: true, count: delivered.length, delivered_to: delivered };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const now = new Date().toISOString();
  let messages: Message[];

  if (body.since) {
    // Custom filter: undelivered + to_id + not expired + sent_at > since
    const rows = db
      .query<
        Message,
        [string, string, string]
      >(
        `SELECT * FROM messages
         WHERE to_id = ? AND delivered = 0
           AND (expires_at IS NULL OR expires_at > ?)
           AND sent_at > ?
         ORDER BY sent_at ASC`
      )
      .all(body.id, now, body.since);
    messages = rows;
  } else {
    messages = selectUndelivered.all(body.id, now) as Message[];
  }

  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleMessageHistory(body: MessageHistoryRequest): MessageHistoryResponse {
  const limit = Math.max(1, Math.min(500, body.limit ?? 50));
  const now = new Date().toISOString();
  const since = body.since ?? null;
  const direction = body.direction ?? "inbox";

  let rows: Message[];
  if (direction === "inbox") {
    rows = selectHistoryInbox.all(body.id, now, since, since, limit) as Message[];
  } else if (direction === "outbox") {
    rows = selectHistoryOutbox.all(body.id, now, since, since, limit) as Message[];
  } else {
    rows = selectHistoryAll.all(body.id, body.id, now, since, since, limit) as Message[];
  }

  return { messages: rows, count: rows.length };
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
        return Response.json({
          status: "ok",
          peers: (selectAllPeers.all() as Peer[]).length,
          message_ttl_hours: MESSAGE_TTL_HOURS,
        });
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
        case "/set-presence":
          return Response.json(handleSetPresence(body as SetPresenceRequest));
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
        case "/messages/history":
          return Response.json(handleMessageHistory(body as MessageHistoryRequest));
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

console.error(
  `[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH}, ttl_hours: ${MESSAGE_TTL_HOURS})`
);
