#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status                       — Show broker status and all peers
 *   bun cli.ts peers                        — List all peers
 *   bun cli.ts peers-by-role <r>            — List peers filtered by role
 *   bun cli.ts send <id> <msg> [--reply-to N]   — Send a message to a peer (optionally reply)
 *   bun cli.ts broadcast <msg> [--reply-to N]   — Broadcast (optionally as a reply)
 *   bun cli.ts set-role <id> <r>            — Set a peer's role
 *   bun cli.ts set-presence <id> <p>        — Set a peer's presence string
 *   bun cli.ts history <id> [limit] [dir]   — Show recent message history for a peer
 *   bun cli.ts thread <msg-id>              — Show a full conversation thread
 *   bun cli.ts kill-broker                  — Stop the broker daemon
 */

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

type PeerRow = {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  role: string;
  presence: string;
  last_seen: string;
};

function printPeer(p: PeerRow): void {
  const presenceStr = p.presence ? ` [${p.presence}]` : "";
  console.log(`  ${p.id}  PID:${p.pid}  role:${p.role}${presenceStr}  ${p.cwd}`);
  if (p.summary) console.log(`         ${p.summary}`);
  if (p.tty) console.log(`         TTY: ${p.tty}`);
  console.log(`         Last seen: ${p.last_seen}`);
}

async function listAllPeers(): Promise<PeerRow[]> {
  return brokerFetch<PeerRow[]>("/list-peers", {
    scope: "machine",
    cwd: "/",
    git_root: null,
  });
}

const cmd = process.argv[2];

/**
 * Parse an optional `--reply-to <id>` flag from the argv tail.
 * Returns the parsed message id (positive integer) or null if absent.
 * Exits the process with usage info if the flag is present but malformed.
 */
function parseReplyToFlag(): number | null {
  const flagIdx = process.argv.indexOf("--reply-to");
  if (flagIdx < 0) return null;
  const raw = process.argv[flagIdx + 1];
  if (!raw) {
    console.error("Error: --reply-to requires a message id");
    process.exit(1);
  }
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`Error: --reply-to must be a positive integer, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

/**
 * Like `parseReplyToFlag`, but also returns the argv tail with the
 * `--reply-to <id>` pair removed, so the caller can fold the rest into
 * the message body without the flag leaking in.
 */
function takeReplyTo(): { replyTo: number | null; rest: string[] } {
  const flagIdx = process.argv.indexOf("--reply-to");
  if (flagIdx < 0) return { replyTo: null, rest: process.argv };
  // Validate the flag's value first (exits on bad input).
  const replyTo = parseReplyToFlag();
  // Now strip the flag and its value out of argv.
  const rest = process.argv.filter((_, i) => i !== flagIdx && i !== flagIdx + 1);
  return { replyTo, rest };
}

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number; message_ttl_hours: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered, ttl=${health.message_ttl_hours}h)`);
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await listAllPeers();
        console.log("\nPeers:");
        for (const p of peers) printPeer(p);
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      const peers = await listAllPeers();
      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) printPeer(p);
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers-by-role": {
    const role = process.argv[3];
    if (!role) {
      console.error("Usage: bun cli.ts peers-by-role <boss|worker|reviewer|any>");
      process.exit(1);
    }
    try {
      const peers = await brokerFetch<PeerRow[]>("/list-peers-by-role", { role });
      if (peers.length === 0) {
        console.log(`No peers with role "${role}".`);
      } else {
        console.log(`Peers with role "${role}":`);
        for (const p of peers) printPeer(p);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    if (!toId) {
      console.error("Usage: bun cli.ts send <peer-id> <message> [--reply-to <msg-id>]");
      process.exit(1);
    }
    // Strip --reply-to so the rest becomes the message text.
    const { replyTo, rest } = takeReplyTo();
    const msg = rest.slice(4).join(" ");
    if (!msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message> [--reply-to <msg-id>]");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
        reply_to: replyTo,
      });
      if (result.ok) {
        if (replyTo != null) {
          console.log(`Reply (to msg ${replyTo}) sent to ${toId}`);
        } else {
          console.log(`Message sent to ${toId}`);
        }
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "broadcast": {
    // Strip --reply-to so the rest becomes the message text.
    const { replyTo, rest } = takeReplyTo();
    const msg = rest.slice(3).join(" ");
    if (!msg) {
      console.error("Usage: bun cli.ts broadcast <message> [--roles boss,worker] [--reply-to <msg-id>]");
      process.exit(1);
    }
    let roles: string[] | undefined;
    const flagIdx = process.argv.indexOf("--roles");
    if (flagIdx > 0) {
      const raw = process.argv[flagIdx + 1];
      if (raw) roles = raw.split(",").map((r) => r.trim()).filter(Boolean);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; count: number; delivered_to: string[]; error?: string }>(
        "/broadcast",
        { from_id: "cli", text: msg, roles, reply_to: replyTo }
      );
      if (result.ok) {
        const suffix = replyTo != null ? ` (as reply to msg ${replyTo})` : "";
        console.log(`Broadcast${suffix} delivered to ${result.count} peer(s): ${result.delivered_to.join(", ") || "(none)"}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "set-role": {
    const id = process.argv[3];
    const role = process.argv[4];
    if (!id || !role) {
      console.error("Usage: bun cli.ts set-role <peer-id> <boss|worker|reviewer|any>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/set-role", { id, role });
      if (result.ok) console.log(`Role of ${id} set to "${role}"`);
      else console.error(`Failed: ${result.error}`);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "set-presence": {
    const id = process.argv[3];
    const presence = process.argv.slice(4).join(" ");
    if (!id) {
      console.error('Usage: bun cli.ts set-presence <peer-id> "<presence string>"');
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/set-presence", {
        id,
        presence,
      });
      if (result.ok) console.log(`Presence of ${id} set to "${presence}"`);
      else console.error(`Failed: ${result.error}`);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "history": {
    const id = process.argv[3];
    const limit = process.argv[4] ? parseInt(process.argv[4], 10) : 20;
    if (!id) {
      console.error("Usage: bun cli.ts history <peer-id> [limit] [inbox|outbox|all]");
      process.exit(1);
    }
    const direction = (process.argv[5] ?? "inbox") as "inbox" | "outbox" | "all";
    try {
      const result = await brokerFetch<{ messages: Array<{ id: number; from_id: string; to_id: string; text: string; sent_at: string; expires_at: string | null; reply_to: number | null }>; count: number }>(
        "/messages/history",
        { id, limit, direction }
      );
      if (result.messages.length === 0) {
        console.log(`No messages in ${direction} for ${id}.`);
      } else {
        console.log(`${result.count} message(s) in ${direction} for ${id}:`);
        for (const m of result.messages) {
          const exp = m.expires_at ? ` (expires ${m.expires_at})` : "";
          const reply = m.reply_to != null ? `  (reply to ${m.reply_to})` : "";
          console.log(`  [${m.id}] ${m.sent_at}  ${m.from_id} -> ${m.to_id}${exp}${reply}`);
          console.log(`    ${m.text}`);
        }
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "thread": {
    const idStr = process.argv[3];
    if (!idStr) {
      console.error("Usage: bun cli.ts thread <msg-id>");
      process.exit(1);
    }
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) {
      console.error(`Error: msg-id must be a positive integer, got "${idStr}"`);
      process.exit(1);
    }
    try {
      const result = await brokerFetch<
        | { root: { id: number; from_id: string; to_id: string; text: string; sent_at: string; reply_to: number | null }; replies: Array<{ id: number; from_id: string; to_id: string; text: string; sent_at: string; reply_to: number | null }>; count: number }
        | { error: string }
      >("/messages/thread", { id });
      if ("error" in result) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      const render = (m: { id: number; from_id: string; to_id: string; text: string; sent_at: string; reply_to: number | null }, prefix: string) => {
        const reply = m.reply_to != null ? `  (reply to ${m.reply_to})` : "";
        console.log(`${prefix}[${m.id}] ${m.sent_at}  ${m.from_id} -> ${m.to_id}${reply}`);
        console.log(`${prefix}  ${m.text}`);
      };
      console.log(`Thread (${result.count} message${result.count === 1 ? "" : "s"}):`);
      render(result.root, "");
      for (const m of result.replies) render(m, "  ");
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);

      if (process.platform === "win32") {
        const proc = Bun.spawnSync(["netstat", "-ano"], { stderr: "ignore" });
        const text = new TextDecoder().decode(proc.stdout);
        const pidCol = new Map<string, true>();
        for (const line of text.split(/\r?\n/)) {
          if (!line.includes("LISTENING")) continue;
          if (!line.includes(`:${BROKER_PORT}`)) continue;
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid)) pidCol.set(pid, true);
        }
        for (const pid of pidCol.keys()) {
          Bun.spawnSync(["taskkill", "/F", "/PID", pid], { stderr: "ignore" });
        }
        if (pidCol.size === 0) console.log("No matching process found via netstat.");
      } else {
        const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
        const pids = new TextDecoder()
          .decode(proc.stdout)
          .trim()
          .split("\n")
          .filter((p) => p);
        for (const pid of pids) {
          process.kill(parseInt(pid), "SIGTERM");
        }
        if (pids.length === 0) console.log("No matching process found via lsof.");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status                                Show broker status and all peers
  bun cli.ts peers                                 List all peers
  bun cli.ts peers-by-role <role>                  List peers filtered by role (boss/worker/reviewer/any)
  bun cli.ts send <id> <msg> [--reply-to <id>]     Send a message (optionally as a reply)
  bun cli.ts broadcast <msg> [--reply-to <id>]     Broadcast (optionally as a reply)
  bun cli.ts set-role <id> <role>                  Set a peer's role
  bun cli.ts set-presence <id> <p>                 Set a peer's presence string
  bun cli.ts history <id> [limit] [dir]            Show recent message history (inbox|outbox|all; default 20, inbox)
  bun cli.ts thread <msg-id>                       Show a full conversation thread
  bun cli.ts kill-broker                           Stop the broker (uses lsof on Unix, netstat+taskkill on Windows)`);
}
