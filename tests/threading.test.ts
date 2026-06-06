/**
 * Tests for message threading: reply_to, /messages/thread, and the
 * recursive CTE that walks the chain up to the root and collects all
 * descendants in a single query.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const acks: Array<{ proc: Bun.Subprocess; tmpDir: string; port: number }> = [];
let nextPort = 8600 + Math.floor(Math.random() * 100);

afterAll(() => {
  for (const { proc, tmpDir } of acks) {
    try { proc.kill(); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

async function startBroker(): Promise<{ port: number; tmpDir: string }> {
  const port = nextPort++;
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-thr-"));
  const dbPath = join(tmpDir, "peers.db");
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
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return { port, tmpDir };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Broker did not start on port ${port}`);
}

async function brokerFetch<T>(port: number, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...opts, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

function spawnIdleChild(): Bun.Subprocess {
  return Bun.spawn(
    process.platform === "win32" ? ["ping", "-n", "60", "127.0.0.1"] : ["sleep", "60"],
    { stdout: "ignore", stderr: "ignore" }
  );
}

type ThreadMessage = {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
  delivered: number;
  expires_at: string | null;
  reply_to: number | null;
};

async function registerPeer(port: number, child: Bun.Subprocess, label: string) {
  const reg = await brokerFetch<{ id: string }>(port, "/register", {
    pid: child.pid,
    cwd: `/tmp/${label}`,
    git_root: null,
    tty: null,
    summary: label,
  });
  return reg.id;
}

describe("message threading", () => {
  test("top-level messages have reply_to = null", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild();
    const b = spawnIdleChild();
    try {
      const idA = await registerPeer(port, a, "A");
      const idB = await registerPeer(port, b, "B");
      const send = await brokerFetch<{ ok: boolean }>(port, "/send-message", {
        from_id: idA, to_id: idB, text: "hello",
      });
      expect(send.ok).toBe(true);

      const history = await brokerFetch<{ messages: ThreadMessage[]; count: number }>(
        port, "/messages/history", { id: idB, direction: "inbox", limit: 10 }
      );
      expect(history.count).toBe(1);
      expect(history.messages[0]!.reply_to).toBeNull();
      expect(history.messages[0]!.text).toBe("hello");
    } finally {
      a.kill(); b.kill();
    }
  });

  test("send-message with reply_to persists the parent id", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild();
    const b = spawnIdleChild();
    try {
      const idA = await registerPeer(port, a, "A");
      const idB = await registerPeer(port, b, "B");

      // root
      const r1 = await brokerFetch<{ ok: boolean }>(port, "/send-message", {
        from_id: idA, to_id: idB, text: "first",
      });
      expect(r1.ok).toBe(true);

      // Look up the root id via history
      const hist = await brokerFetch<{ messages: ThreadMessage[] }>(port, "/messages/history", {
        id: idB, direction: "inbox", limit: 5,
      });
      const rootId = hist.messages[0]!.id;

      // reply
      const r2 = await brokerFetch<{ ok: boolean }>(port, "/send-message", {
        from_id: idB, to_id: idA, text: "second", reply_to: rootId,
      });
      expect(r2.ok).toBe(true);

      // Verify both messages and the reply_to link
      const out = await brokerFetch<{ messages: ThreadMessage[] }>(port, "/messages/history", {
        id: idA, direction: "inbox", limit: 5,
      });
      expect(out.messages.length).toBe(1);
      expect(out.messages[0]!.reply_to).toBe(rootId);
    } finally {
      a.kill(); b.kill();
    }
  });

  test("send-message rejects reply_to pointing at non-existent message", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild();
    const b = spawnIdleChild();
    try {
      const idA = await registerPeer(port, a, "A");
      const idB = await registerPeer(port, b, "B");
      const r = await brokerFetch<{ ok: boolean; error: string }>(port, "/send-message", {
        from_id: idA, to_id: idB, text: "reply to ghost", reply_to: 99999,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/99999/);
    } finally {
      a.kill(); b.kill();
    }
  });

  test("send-message rejects non-positive / non-integer reply_to", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild();
    const b = spawnIdleChild();
    try {
      const idA = await registerPeer(port, a, "A");
      const idB = await registerPeer(port, b, "B");
      // Note: NaN and Infinity serialize as `null` in JSON, so the broker
      // sees null reply_to and treats it as "no reply". We test only the
      // values that survive JSON round-tripping here.
      for (const bad of [0, -1, 1.5, 9999]) {
        if (bad === 9999) continue; // separate test for "non-existent"
        const r = await brokerFetch<{ ok: boolean; error?: string }>(port, "/send-message", {
          from_id: idA, to_id: idB, text: "x", reply_to: bad,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/positive integer/);
      }
    } finally {
      a.kill(); b.kill();
    }
  });

  test("broadcast with reply_to tags every delivery", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild();
    const b = spawnIdleChild();
    const c = spawnIdleChild();
    try {
      const idA = await registerPeer(port, a, "A");
      const idB = await registerPeer(port, b, "B");
      const idC = await registerPeer(port, c, "C");

      // First, A sends a normal message that becomes the "root"
      const r0 = await brokerFetch<{ ok: boolean }>(port, "/send-message", {
        from_id: idA, to_id: idB, text: "question",
      });
      expect(r0.ok).toBe(true);
      const hist = await brokerFetch<{ messages: ThreadMessage[] }>(port, "/messages/history", {
        id: idB, direction: "inbox", limit: 5,
      });
      const rootId = hist.messages[0]!.id;

      // Now A broadcasts a reply that goes to both B and C
      const rb = await brokerFetch<{ ok: boolean; count: number; delivered_to: string[] }>(port, "/broadcast", {
        from_id: idA, text: "answer", reply_to: rootId,
      });
      expect(rb.ok).toBe(true);
      expect(rb.count).toBe(2); // excludes sender

      // Each recipient's inbox should have a reply with reply_to = rootId
      for (const recipient of [idB, idC]) {
        const h = await brokerFetch<{ messages: ThreadMessage[] }>(port, "/messages/history", {
          id: recipient, direction: "inbox", limit: 5,
        });
        const reply = h.messages.find((m) => m.text === "answer");
        expect(reply).toBeDefined();
        expect(reply!.reply_to).toBe(rootId);
      }
    } finally {
      a.kill(); b.kill(); c.kill();
    }
  });

  test("/messages/thread returns the full chain (root + all replies)", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild();
    const b = spawnIdleChild();
    try {
      const idA = await registerPeer(port, a, "A");
      const idB = await registerPeer(port, b, "B");

      // root
      const r1 = await brokerFetch<{ ok: boolean }>(port, "/send-message", {
        from_id: idA, to_id: idB, text: "r0",
      });
      expect(r1.ok).toBe(true);

      // Get the root id
      const h0 = await brokerFetch<{ messages: ThreadMessage[] }>(port, "/messages/history", {
        id: idB, direction: "inbox", limit: 1,
      });
      const rootId = h0.messages[0]!.id;

      // reply 1, then reply 2 to reply 1 (nested)
      const r2 = await brokerFetch<{ ok: boolean }>(port, "/send-message", {
        from_id: idB, to_id: idA, text: "r1", reply_to: rootId,
      });
      expect(r2.ok).toBe(true);
      const h1 = await brokerFetch<{ messages: ThreadMessage[] }>(port, "/messages/history", {
        id: idA, direction: "inbox", limit: 1,
      });
      const reply1Id = h1.messages[0]!.id;
      const r3 = await brokerFetch<{ ok: boolean }>(port, "/send-message", {
        from_id: idA, to_id: idB, text: "r2", reply_to: reply1Id,
      });
      expect(r3.ok).toBe(true);

      // Fetch the thread from the reply id (not the root) — should still work
      const h2 = await brokerFetch<{ messages: ThreadMessage[] }>(port, "/messages/history", {
        id: idB, direction: "inbox", limit: 1,
      });
      const reply2Id = h2.messages[0]!.id;
      const thread = await brokerFetch<
        | { root: ThreadMessage; replies: ThreadMessage[]; count: number }
        | { error: string }
      >(port, "/messages/thread", { id: reply2Id });

      if ("error" in thread) throw new Error(thread.error);
      expect(thread.count).toBe(3);
      expect(thread.root.id).toBe(rootId);
      expect(thread.root.reply_to).toBeNull();
      expect(thread.root.text).toBe("r0");
      expect(thread.replies.map((m) => m.text)).toEqual(["r1", "r2"]);
      expect(thread.replies[0]!.reply_to).toBe(rootId);
      expect(thread.replies[1]!.reply_to).toBe(reply1Id);
    } finally {
      a.kill(); b.kill();
    }
  });

  test("/messages/thread resolves to a single root when the requested id IS the root", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild();
    const b = spawnIdleChild();
    try {
      const idA = await registerPeer(port, a, "A");
      const idB = await registerPeer(port, b, "B");
      await brokerFetch(port, "/send-message", { from_id: idA, to_id: idB, text: "root" });
      const h = await brokerFetch<{ messages: ThreadMessage[] }>(port, "/messages/history", {
        id: idB, direction: "inbox", limit: 1,
      });
      const rootId = h.messages[0]!.id;
      const thread = await brokerFetch<
        | { root: ThreadMessage; replies: ThreadMessage[]; count: number }
        | { error: string }
      >(port, "/messages/thread", { id: rootId });
      if ("error" in thread) throw new Error(thread.error);
      expect(thread.root.id).toBe(rootId);
      expect(thread.replies).toEqual([]);
      expect(thread.count).toBe(1);
    } finally {
      a.kill(); b.kill();
    }
  });

  test("/messages/thread returns an error for unknown id", async () => {
    const { port } = await startBroker();
    try {
      const r = await brokerFetch<{ error: string }>(port, "/messages/thread", { id: 424242 });
      expect(r.error).toMatch(/not found/);
    } finally {
      // no children spawned
    }
  });

  test("/messages/thread rejects non-positive id", async () => {
    const { port } = await startBroker();
    for (const bad of [0, -1, 1.5]) {
      const r = await brokerFetch<{ error: string }>(port, "/messages/thread", { id: bad });
      expect(r.error).toMatch(/positive integer/);
    }
  });
});

describe("schema migration: legacy DBs without reply_to column", () => {
  test("broker adds the reply_to column without losing data", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-legacy-thr-"));
    const dbPath = join(tmpDir, "peers.db");

    // Seed a minimal legacy DB: peers table (without role/presence) and
    // messages table (without expires_at/reply_to).
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        git_root TEXT,
        tty TEXT,
        summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE messages (
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
    db.prepare(
      `INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("legacyP", process.pid, "/tmp/legacy", null, null, "old", "2024-01-01T00:00:00Z", new Date().toISOString());
    db.close();

    for (const suffix of ["-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (existsSync(p)) { try { rmSync(p); } catch {} }
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
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        if (res.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }

    const db2 = new Database(dbPath, { readonly: true });
    const msgCols = db2.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((r) => r.name);
    db2.close();
    expect(msgCols).toContain("reply_to");

    // The legacy peer should survive (its pid is alive)
    const peers = await brokerFetch<Array<{ id: string }>>(port, "/list-peers", {
      scope: "machine", cwd: "/", git_root: null,
    });
    expect(peers.find((p) => p.id === "legacyP")).toBeDefined();
  });
});
