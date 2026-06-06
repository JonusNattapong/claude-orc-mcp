/**
 * Tests for message TTL, history endpoint, and presence.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const acks: Array<{ proc: Bun.Subprocess; tmpDir: string; port: number }> = [];
let nextPort = 8500 + Math.floor(Math.random() * 100);

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

async function startBroker(env: Record<string, string> = {}): Promise<{ port: number; tmpDir: string }> {
  const port = nextPort++;
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-ttl-"));
  const dbPath = join(tmpDir, "peers.db");
  const proc = Bun.spawn(
    ["bun", "broker.ts"],
    {
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(port),
        CLAUDE_PEERS_DB: dbPath,
        ...env,
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

function spawnIdleChild(): Bun.Subprocess {
  return Bun.spawn(
    process.platform === "win32"
      ? ["ping", "-n", "60", "127.0.0.1"]
      : ["sleep", "60"],
    { stdout: "ignore", stderr: "ignore" }
  );
}

describe("presence", () => {
  test("register accepts initial presence and /list-peers returns it", async () => {
    const { port } = await startBroker();
    const child = spawnIdleChild();
    try {
      const reg = await brokerFetch<{ id: string }>(port, "/register", {
        pid: child.pid, cwd: "/tmp/p", git_root: null, tty: null, summary: "",
        presence: "typing",
      });
      const peers = await brokerFetch<Array<{ id: string; presence: string }>>(
        port, "/list-peers", { scope: "machine", cwd: "/", git_root: null }
      );
      const me = peers.find((p) => p.id === reg.id);
      expect(me?.presence).toBe("typing");
    } finally {
      try { child.kill(); } catch {}
    }
  });

  test("/set-presence updates the value", async () => {
    const { port } = await startBroker();
    const child = spawnIdleChild();
    try {
      const reg = await brokerFetch<{ id: string }>(port, "/register", {
        pid: child.pid, cwd: "/tmp/p", git_root: null, tty: null, summary: "",
      });
      const res = await brokerFetch<{ ok: boolean }>(port, "/set-presence", {
        id: reg.id, presence: "reviewing",
      });
      expect(res.ok).toBe(true);

      const peers = await brokerFetch<Array<{ id: string; presence: string }>>(
        port, "/list-peers", { scope: "machine", cwd: "/", git_root: null }
      );
      expect(peers.find((p) => p.id === reg.id)?.presence).toBe("reviewing");
    } finally {
      try { child.kill(); } catch {}
    }
  });

  test("presence filter on /list-peers is case-insensitive substring", async () => {
    const { port } = await startBroker();
    const c1 = spawnIdleChild();
    const c2 = spawnIdleChild();
    try {
      const r1 = await brokerFetch<{ id: string }>(port, "/register", {
        pid: c1.pid, cwd: "/tmp/p", git_root: null, tty: null, summary: "", presence: "Reviewing PR",
      });
      const r2 = await brokerFetch<{ id: string }>(port, "/register", {
        pid: c2.pid, cwd: "/tmp/p", git_root: null, tty: null, summary: "", presence: "idle",
      });
      const filtered = await brokerFetch<Array<{ id: string }>>(
        port, "/list-peers", { scope: "machine", cwd: "/", git_root: null, presence: "review" }
      );
      const ids = filtered.map((p) => p.id);
      expect(ids).toContain(r1.id);
      expect(ids).not.toContain(r2.id);
    } finally {
      try { c1.kill(); } catch {}
      try { c2.kill(); } catch {}
    }
  });

  test("presence is sanitized (control chars stripped, length capped)", async () => {
    const { port } = await startBroker();
    const child = spawnIdleChild();
    try {
      const reg = await brokerFetch<{ id: string }>(port, "/register", {
        pid: child.pid, cwd: "/tmp/p", git_root: null, tty: null, summary: "",
        presence: "abc\x07\x1fdef" + "x".repeat(200),
      });
      const peers = await brokerFetch<Array<{ id: string; presence: string }>>(
        port, "/list-peers", { scope: "machine", cwd: "/", git_root: null }
      );
      const me = peers.find((p) => p.id === reg.id);
      // Should strip control chars and cap to 64
      expect(me?.presence).toBe("abcdef" + "x".repeat(58));
      expect(me?.presence.length).toBeLessThanOrEqual(64);
    } finally {
      try { child.kill(); } catch {}
    }
  });
});

describe("message history", () => {
  test("inbox returns messages received by the peer, newest first", async () => {
    const { port } = await startBroker();
    const sender = spawnIdleChild();
    const receiver = spawnIdleChild();
    try {
      const a = await brokerFetch<{ id: string }>(port, "/register", {
        pid: sender.pid, cwd: "/tmp/h", git_root: null, tty: null, summary: "",
      });
      const b = await brokerFetch<{ id: string }>(port, "/register", {
        pid: receiver.pid, cwd: "/tmp/h", git_root: null, tty: null, summary: "",
      });

      for (let i = 0; i < 3; i++) {
        await brokerFetch(port, "/send-message", {
          from_id: a.id, to_id: b.id, text: `m${i}`,
        });
      }

      const inbox = await brokerFetch<{ messages: Array<{ text: string }>; count: number }>(
        port, "/messages/history", { id: b.id, direction: "inbox" }
      );
      expect(inbox.count).toBe(3);
      expect(inbox.messages.map((m) => m.text)).toEqual(["m2", "m1", "m0"]);

      // Outbox of the sender also has 3
      const outbox = await brokerFetch<{ messages: Array<{ text: string }>; count: number }>(
        port, "/messages/history", { id: a.id, direction: "outbox" }
      );
      expect(outbox.count).toBe(3);
      expect(outbox.messages.map((m) => m.text)).toEqual(["m2", "m1", "m0"]);

      // 'all' for the receiver should still be 3 (inbox == all for this peer)
      const all = await brokerFetch<{ messages: unknown[]; count: number }>(
        port, "/messages/history", { id: b.id, direction: "all" }
      );
      expect(all.count).toBe(3);
    } finally {
      try { sender.kill(); } catch {}
      try { receiver.kill(); } catch {}
    }
  });

  test("limit caps the result count", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild();
    const b = spawnIdleChild();
    try {
      const ra = await brokerFetch<{ id: string }>(port, "/register", {
        pid: a.pid, cwd: "/tmp/h", git_root: null, tty: null, summary: "",
      });
      const rb = await brokerFetch<{ id: string }>(port, "/register", {
        pid: b.pid, cwd: "/tmp/h", git_root: null, tty: null, summary: "",
      });
      for (let i = 0; i < 5; i++) {
        await brokerFetch(port, "/send-message", { from_id: ra.id, to_id: rb.id, text: `m${i}` });
      }
      const inbox = await brokerFetch<{ count: number }>(
        port, "/messages/history", { id: rb.id, limit: 2 }
      );
      expect(inbox.count).toBe(2);
    } finally {
      try { a.kill(); } catch {}
      try { b.kill(); } catch {}
    }
  });

  test("since filter returns only messages newer than the cutoff", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild();
    const b = spawnIdleChild();
    try {
      const ra = await brokerFetch<{ id: string }>(port, "/register", {
        pid: a.pid, cwd: "/tmp/h", git_root: null, tty: null, summary: "",
      });
      const rb = await brokerFetch<{ id: string }>(port, "/register", {
        pid: b.pid, cwd: "/tmp/h", git_root: null, tty: null, summary: "",
      });

      await brokerFetch(port, "/send-message", { from_id: ra.id, to_id: rb.id, text: "first" });
      await new Promise((r) => setTimeout(r, 50));
      const cutoff = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 50));
      await brokerFetch(port, "/send-message", { from_id: ra.id, to_id: rb.id, text: "second" });
      await brokerFetch(port, "/send-message", { from_id: ra.id, to_id: rb.id, text: "third" });

      const recent = await brokerFetch<{ messages: Array<{ text: string }>; count: number }>(
        port, "/messages/history", { id: rb.id, since: cutoff }
      );
      expect(recent.count).toBe(2);
      expect(recent.messages.map((m) => m.text).sort()).toEqual(["second", "third"]);
    } finally {
      try { a.kill(); } catch {}
      try { b.kill(); } catch {}
    }
  });
});

describe("message TTL", () => {
  test("messages with ttl_seconds <= 0 get expires_at = null (never expire)", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild();
    const b = spawnIdleChild();
    try {
      const ra = await brokerFetch<{ id: string }>(port, "/register", {
        pid: a.pid, cwd: "/tmp/t", git_root: null, tty: null, summary: "",
      });
      const rb = await brokerFetch<{ id: string }>(port, "/register", {
        pid: b.pid, cwd: "/tmp/t", git_root: null, tty: null, summary: "",
      });
      await brokerFetch(port, "/send-message", {
        from_id: ra.id, to_id: rb.id, text: "forever", ttl_seconds: 0,
      });
      const inbox = await brokerFetch<{ messages: Array<{ expires_at: string | null }> }>(
        port, "/messages/history", { id: rb.id, direction: "inbox" }
      );
      expect(inbox.messages[0]!.expires_at).toBeNull();
    } finally {
      try { a.kill(); } catch {}
      try { b.kill(); } catch {}
    }
  });

  test("messages with ttl_seconds set get a future expires_at", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild();
    const b = spawnIdleChild();
    try {
      const ra = await brokerFetch<{ id: string }>(port, "/register", {
        pid: a.pid, cwd: "/tmp/t", git_root: null, tty: null, summary: "",
      });
      const rb = await brokerFetch<{ id: string }>(port, "/register", {
        pid: b.pid, cwd: "/tmp/t", git_root: null, tty: null, summary: "",
      });
      await brokerFetch(port, "/send-message", {
        from_id: ra.id, to_id: rb.id, text: "soon", ttl_seconds: 3600,
      });
      const inbox = await brokerFetch<{ messages: Array<{ expires_at: string | null; sent_at: string }> }>(
        port, "/messages/history", { id: rb.id, direction: "inbox" }
      );
      const m = inbox.messages[0]!;
      expect(m.expires_at).not.toBeNull();
      expect(new Date(m.expires_at!).getTime()).toBeGreaterThan(new Date(m.sent_at).getTime());
    } finally {
      try { a.kill(); } catch {}
      try { b.kill(); } catch {}
    }
  });

  test("expired messages are not returned by /poll-messages", async () => {
    const { port, tmpDir } = await startBroker();
    const a = spawnIdleChild();
    const b = spawnIdleChild();
    try {
      const ra = await brokerFetch<{ id: string }>(port, "/register", {
        pid: a.pid, cwd: "/tmp/t", git_root: null, tty: null, summary: "",
      });
      const rb = await brokerFetch<{ id: string }>(port, "/register", {
        pid: b.pid, cwd: "/tmp/t", git_root: null, tty: null, summary: "",
      });
      // Insert a message, then backdate its expires_at directly in the DB
      await brokerFetch(port, "/send-message", {
        from_id: ra.id, to_id: rb.id, text: "expired", ttl_seconds: 1,
      });
      const dbPath = join(tmpDir, "peers.db");
      const db = new Database(dbPath);
      db.run("UPDATE messages SET expires_at = ? WHERE from_id = ?", [
        new Date(Date.now() - 60_000).toISOString(),
        ra.id,
      ]);
      db.close();

      const poll = await brokerFetch<{ messages: unknown[] }>(
        port, "/poll-messages", { id: rb.id }
      );
      expect(poll.messages.length).toBe(0);

      // And history shouldn't return it either
      const hist = await brokerFetch<{ messages: unknown[] }>(
        port, "/messages/history", { id: rb.id }
      );
      expect(hist.messages.length).toBe(0);
    } finally {
      try { a.kill(); } catch {}
      try { b.kill(); } catch {}
    }
  });
});

describe("schema migration: legacy DBs without new columns", () => {
  test("broker adds presence and expires_at columns without losing data", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-mig-"));
    const dbPath = join(tmpDir, "peers.db");

    // Pre-seed a legacy DB
    const seed = new Database(dbPath);
    seed.run(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY, pid INTEGER NOT NULL, cwd TEXT NOT NULL,
        git_root TEXT, tty TEXT, summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL, last_seen TEXT NOT NULL
      )
    `);
    seed.run(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL,
        to_id TEXT NOT NULL, text TEXT NOT NULL, sent_at TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      )
    `);
    seed.prepare(
      `INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("legacyP", process.pid, "/tmp/legacy", null, null, "old", "2024-01-01T00:00:00Z", new Date().toISOString());
    seed.close();

    for (const suffix of ["-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (existsSync(p)) {
        try { rmSync(p); } catch {}
      }
    }

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
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }

    const db = new Database(dbPath, { readonly: true });
    const peerCols = db.query<{ name: string }, []>("PRAGMA table_info(peers)").all().map((r) => r.name);
    const msgCols = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((r) => r.name);
    db.close();
    expect(peerCols).toContain("role");
    expect(peerCols).toContain("presence");
    expect(msgCols).toContain("expires_at");

    // The legacy peer should survive (its pid is alive) with default presence=""
    const peers = await brokerFetch<Array<{ id: string; presence: string; role: string }>>(
      port, "/list-peers", { scope: "machine", cwd: "/", git_root: null }
    );
    const me = peers.find((p) => p.id === "legacyP");
    expect(me).toBeDefined();
    expect(me!.presence).toBe("");
    expect(me!.role).toBe("any");
  });
});
