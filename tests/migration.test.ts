/**
 * Schema migration test.
 *
 * Simulates an existing claude-peers DB that predates the `role` column and
 * verifies the broker adds the column on startup without losing data.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const acks: Array<{ proc: Bun.Subprocess; tmpDir: string; port: number }> = [];
let nextPort = 8000 + Math.floor(Math.random() * 100);

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

interface LegacyPeer {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string;
  last_seen: string;
}

async function startBrokerWithPreExistingDb(
  preSeed: (dbPath: string) => void
): Promise<{ port: number; dbPath: string; tmpDir: string }> {
  const port = nextPort++;
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-migrate-"));
  const dbPath = join(tmpDir, "peers.db");

  // Seed a legacy DB *before* the broker starts.
  preSeed(dbPath);

  // Sanity: WAL files may have been created; remove so the broker creates them.
  for (const suffix of ["-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch {
        // ignore
      }
    }
  }

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
      if (res.ok) return { port, dbPath, tmpDir };
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

describe("schema migration: legacy DB without `role` column", () => {
  test("broker adds the role column and existing rows get 'any'", async () => {
    const { port, dbPath } = await startBrokerWithPreExistingDb((dbPath) => {
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
          delivered INTEGER NOT NULL DEFAULT 0
        )
      `);
      const insert = db.prepare(`
        INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // Use process.pid so the row survives the broker's startup cleanup.
      insert.run("legacy01", process.pid, "/tmp/legacy-seed", null, null, "old peer", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z");
      db.close();
    });

    // After startup, the broker should have ALTERed the table to add `role`.
    const db = new Database(dbPath, { readonly: true });
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(peers)")
      .all()
      .map((r) => r.name);
    db.close();
    expect(columns).toContain("role");

    // The legacy row should now show up with role 'any' (default).
    const peers = await brokerFetch<Array<{ id: string; role: string; summary: string }>>(
      port,
      "/list-peers",
      { scope: "machine", cwd: "/", git_root: null }
    );
    const legacy = peers.find((p) => p.id === "legacy01");
    expect(legacy).toBeDefined();
    expect(legacy!.role).toBe("any");
    expect(legacy!.summary).toBe("old peer");
  });
});
