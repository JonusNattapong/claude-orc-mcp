#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status              — Show broker status and all peers
 *   bun cli.ts peers               — List all peers
 *   bun cli.ts peers-by-role <r>   — List peers filtered by role
 *   bun cli.ts send <id> <msg>     — Send a message to a peer
 *   bun cli.ts broadcast <msg>     — Broadcast a message to every peer
 *   bun cli.ts set-role <id> <r>   — Set a peer's role
 *   bun cli.ts kill-broker         — Stop the broker daemon
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
  last_seen: string;
};

function printPeer(p: PeerRow): void {
  console.log(`  ${p.id}  PID:${p.pid}  role:${p.role}  ${p.cwd}`);
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

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
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
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "broadcast": {
    const msg = process.argv.slice(3).join(" ");
    if (!msg) {
      console.error("Usage: bun cli.ts broadcast <message> [--roles boss,worker]");
      process.exit(1);
    }
    // Optional trailing flag: --roles a,b
    let roles: string[] | undefined;
    const flagIdx = process.argv.indexOf("--roles");
    if (flagIdx > 0) {
      const raw = process.argv[flagIdx + 1];
      if (raw) roles = raw.split(",").map((r) => r.trim()).filter(Boolean);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; count: number; delivered_to: string[]; error?: string }>(
        "/broadcast",
        { from_id: "cli", text: msg, roles }
      );
      if (result.ok) {
        console.log(`Broadcast delivered to ${result.count} peer(s): ${result.delivered_to.join(", ") || "(none)"}`);
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
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/set-role", {
        id,
        role,
      });
      if (result.ok) {
        console.log(`Role of ${id} set to "${role}"`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);

      // Cross-platform port owner lookup.
      if (process.platform === "win32") {
        // netstat -ano | findstr :PORT  ->  "TCP    0.0.0.0:7899    ...    LISTENING    <pid>"
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
  bun cli.ts status                   Show broker status and all peers
  bun cli.ts peers                    List all peers
  bun cli.ts peers-by-role <role>     List peers filtered by role (boss/worker/reviewer/any)
  bun cli.ts send <id> <msg>          Send a message to a peer
  bun cli.ts broadcast <msg>          Broadcast a message to every peer
  bun cli.ts set-role <id> <role>     Set a peer's role
  bun cli.ts kill-broker              Stop the broker daemon`);
}
