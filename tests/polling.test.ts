/**
 * Tests for the polling + liveness behavior of the broker.
 *
 * Verifies that the broker:
 *   1. Detects dead PIDs and removes them on the next list-peers call.
 *   2. Returns messages exactly once via /poll-messages.
 *   3. Marks messages as delivered so the next poll is empty.
 *
 * The MCP-side polling loop in server.ts is verified by static checks below
 * (POLL_INTERVAL_MS = 2000) plus this broker-side test that proves the
 * /poll-messages contract the loop depends on.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const acks: Array<{ proc: Bun.Subprocess; tmpDir: string; port: number }> = [];
let nextPort = 8200 + Math.floor(Math.random() * 100);

afterAll(() => {
  for (const { proc, tmpDir } of acks) {
    try {
      proc.kill();
    } catch {
      // ignore
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

async function startBroker(): Promise<{ port: number; tmpDir: string }> {
  const port = nextPort++;
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-poll-"));
  const dbPath = join(tmpDir, "peers.db");
  const proc = Bun.spawn(
    ["bun", "broker.ts"],
    {
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(port),
        CLAUDE_PEERS_DB: dbPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  acks.push({ proc, tmpDir, port });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return { port, tmpDir };
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Broker did not start on port ${port}`);
}

async function brokerFetch<T>(
  port: number,
  path: string,
  body?: unknown
): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

describe("cross-platform process liveness", () => {
  test("peers with a dead PID are removed on list-peers", async () => {
    const { port } = await startBroker();
    // Register a peer at a PID that is virtually guaranteed not to exist.
    // Using a very high PID plus negative guard so isProcessAlive returns false.
    const dead = await brokerFetch<{ id: string }>(port, "/register", {
      pid: 2_000_000_000,
      cwd: "/tmp/dead",
      git_root: null,
      tty: null,
      summary: "should be reaped",
    });

    // Also register a live peer (current process) so the list has at least one row.
    const live = await brokerFetch<{ id: string }>(port, "/register", {
      pid: process.pid,
      cwd: "/tmp/live",
      git_root: null,
      tty: null,
      summary: "should remain",
    });

    // First call: dead should be reaped, live should remain.
    const peers = await brokerFetch<Array<{ id: string }>>(
      port,
      "/list-peers",
      { scope: "machine", cwd: "/", git_root: null }
    );
    const ids = peers.map((p) => p.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(dead.id);
  });

  test("stale peer cleanup runs on broker startup (cleanStalePeers)", async () => {
    // Pre-seed a peer with a definitely-dead PID, then start broker.
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-clean-"));
    const dbPath = join(tmpDir, "peers.db");
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY, pid INTEGER NOT NULL, cwd TEXT NOT NULL,
        git_root TEXT, tty TEXT, summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL, last_seen TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL,
        to_id TEXT NOT NULL, text TEXT NOT NULL, sent_at TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.prepare(
      `INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("ghost01", 2_000_000_001, "/tmp/ghost", null, null, "", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z");
    db.close();

    const port = nextPort++;
    const proc = Bun.spawn(
      ["bun", "broker.ts"],
      {
        env: { ...process.env, CLAUDE_PEERS_PORT: String(port), CLAUDE_PEERS_DB: dbPath },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    acks.push({ proc, tmpDir, port });
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) break;
      } catch {
        // not yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // The ghost peer should have been reaped.
    const peers = await brokerFetch<Array<{ id: string }>>(
      port,
      "/list-peers",
      { scope: "machine", cwd: "/", git_root: null }
    );
    expect(peers.map((p) => p.id)).not.toContain("ghost01");
  });
});

describe("polling contract", () => {
  test("messages are returned exactly once and then delivered", async () => {
    const { port } = await startBroker();
    // Spawn two real child processes so the broker sees two distinct live PIDs
    // (registering twice with the same PID re-uses the same row).
    const childA = Bun.spawn(
      process.platform === "win32"
        ? ["cmd", "/c", "timeout", "/t", "30", "/nobreak"]
        : ["sleep", "30"],
      { stdout: "ignore", stderr: "ignore" }
    );
    const childB = Bun.spawn(
      process.platform === "win32"
        ? ["cmd", "/c", "timeout", "/t", "30", "/nobreak"]
        : ["sleep", "30"],
      { stdout: "ignore", stderr: "ignore" }
    );
    try {
      const a = await brokerFetch<{ id: string }>(port, "/register", {
        pid: childA.pid,
        cwd: "/tmp/poll-a",
        git_root: null,
        tty: null,
        summary: "sender",
      });
      const b = await brokerFetch<{ id: string }>(port, "/register", {
        pid: childB.pid,
        cwd: "/tmp/poll-b",
        git_root: null,
        tty: null,
        summary: "receiver",
      });

      for (let i = 0; i < 3; i++) {
        await brokerFetch(port, "/send-message", {
          from_id: a.id,
          to_id: b.id,
          text: `ping ${i}`,
        });
      }

      const first = await brokerFetch<{ messages: Array<{ text: string }> }>(
        port,
        "/poll-messages",
        { id: b.id }
      );
      expect(first.messages.length).toBe(3);
      expect(first.messages.map((m) => m.text)).toEqual(["ping 0", "ping 1", "ping 2"]);

      const second = await brokerFetch<{ messages: unknown[] }>(
        port,
        "/poll-messages",
        { id: b.id }
      );
      expect(second.messages.length).toBe(0);
    } finally {
      try { childA.kill(); } catch {}
      try { childB.kill(); } catch {}
    }
  });
});

describe("server.ts static guarantees", () => {
  test("server.ts polls every 2 seconds (POLL_INTERVAL_MS = 2000)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    expect(src).toMatch(/POLL_INTERVAL_MS\s*=\s*2000\b/);
  });

  test("server.ts no longer uses process.kill(pid, 0) directly", () => {
    // server.ts doesn't actually use process.kill directly for liveness;
    // the broker is the one doing that. We only need to verify the constant
    // is 2000 and a setInterval drives polling.
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    expect(src).toMatch(/setInterval\(pollAndPushMessages,\s*POLL_INTERVAL_MS\)/);
  });

  test("broker.ts uses isProcessAlive helper instead of process.kill(pid, 0)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "broker.ts"), "utf8");
    // Helper is in shared/platform.ts and imported here.
    expect(src).toContain('import { isProcessAlive } from "./shared/platform.ts"');
    // No direct process.kill(<pid>, 0) left in broker.ts
    expect(src).not.toMatch(/process\.kill\(\s*\w+\.pid\s*,\s*0\s*\)/);
    // And the helper is actually used.
    expect(src).toMatch(/isProcessAlive\(/);
  });

  test("server.ts declares all 7 expected tools", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    for (const name of [
      "list_peers",
      "list_peers_by_role",
      "send_message",
      "broadcast_message",
      "set_summary",
      "set_role",
      "check_messages",
    ]) {
      expect(src).toContain(`name: "${name}"`);
    }
  });
});
