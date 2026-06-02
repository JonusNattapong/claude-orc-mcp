/**
 * Broker integration tests.
 *
 * Spins up the real `bun broker.ts` on an isolated port and exercises the
 * HTTP API end-to-end. Tests run serially because the broker is a singleton
 * per port; each test gets a fresh DB on a fresh port.
 *
 * Note: the broker reaps peers whose PIDs are not alive. Each test that
 * needs live peers spawns its own child processes and tears them down.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT_BASE = 7800 + Math.floor(Math.random() * 150);
let nextPort = PORT_BASE;
const acks: Array<{ port: number; tmpDir: string; proc: Bun.Subprocess }> = [];

interface BrokerProcess {
  port: number;
  tmpDir: string;
  proc: Bun.Subprocess;
}

async function startBroker(): Promise<BrokerProcess> {
  const port = nextPort++;
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-test-"));
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
  const entry = { port, tmpDir, proc };
  acks.push(entry);
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return entry;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Broker did not come up on port ${port}`);
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
    const text = await res.text();
    throw new Error(`${path} -> ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

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

function spawnIdleChild(label: string): Bun.Subprocess {
  return Bun.spawn(
    process.platform === "win32"
      ? ["ping", "-n", "60", "127.0.0.1"]
      : ["sleep", "60"],
    { stdout: "ignore", stderr: "ignore" }
  );
}

describe("broker HTTP API", () => {
  test("health endpoint returns ok", async () => {
    const { port } = await startBroker();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string; peers: number };
    expect(body.status).toBe("ok");
    expect(body.peers).toBe(0);
  });

  test("register returns an 8-char peer id and persists in list-peers", async () => {
    const { port } = await startBroker();
    const child = spawnIdleChild("register");
    try {
      const reg = await brokerFetch<{ id: string }>(port, "/register", {
        pid: child.pid,
        cwd: "/tmp/project-a",
        git_root: null,
        tty: null,
        summary: "first",
      });
      expect(reg.id).toMatch(/^[a-z0-9]{8}$/);

      const peers = await brokerFetch<Array<{ id: string; role: string }>>(
        port,
        "/list-peers",
        { scope: "machine", cwd: "/", git_root: null }
      );
      expect(peers.length).toBe(1);
      expect(peers[0]!.id).toBe(reg.id);
      expect(peers[0]!.role).toBe("any");
    } finally {
      try { child.kill(); } catch {}
    }
  });

  test("set-role and list-peers-by-role", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild("a");
    const b = spawnIdleChild("b");
    try {
      const regA = await brokerFetch<{ id: string }>(port, "/register", {
        pid: a.pid, cwd: "/tmp/a", git_root: null, tty: null, summary: "alpha", role: "any",
      });
      const regB = await brokerFetch<{ id: string }>(port, "/register", {
        pid: b.pid, cwd: "/tmp/b", git_root: null, tty: null, summary: "beta", role: "any",
      });

      await brokerFetch(port, "/set-role", { id: regA.id, role: "boss" });
      await brokerFetch(port, "/set-role", { id: regB.id, role: "worker" });

      const bosses = await brokerFetch<Array<{ id: string; role: string }>>(
        port, "/list-peers-by-role", { role: "boss" }
      );
      expect(bosses.map((p) => p.id)).toEqual([regA.id]);

      const workers = await brokerFetch<Array<{ id: string; role: string }>>(
        port, "/list-peers-by-role", { role: "worker" }
      );
      expect(workers.map((p) => p.id)).toEqual([regB.id]);
    } finally {
      try { a.kill(); } catch {}
      try { b.kill(); } catch {}
    }
  });

  test("set-role rejects invalid role names", async () => {
    const { port } = await startBroker();
    const child = spawnIdleChild("invalid");
    try {
      const reg = await brokerFetch<{ id: string }>(port, "/register", {
        pid: child.pid, cwd: "/tmp/invalid", git_root: null, tty: null, summary: "",
      });
      const res = await brokerFetch<{ ok: boolean; error?: string }>(
        port, "/set-role", { id: reg.id, role: "overlord" }
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Invalid role");
    } finally {
      try { child.kill(); } catch {}
    }
  });

  test("send-message and poll-messages round-trip", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild("sender");
    const b = spawnIdleChild("receiver");
    try {
      const regA = await brokerFetch<{ id: string }>(port, "/register", {
        pid: a.pid, cwd: "/tmp/round", git_root: null, tty: null, summary: "sender",
      });
      const regB = await brokerFetch<{ id: string }>(port, "/register", {
        pid: b.pid, cwd: "/tmp/round", git_root: null, tty: null, summary: "receiver",
      });

      await brokerFetch(port, "/send-message", {
        from_id: regA.id, to_id: regB.id, text: "hello there",
      });

      const poll = await brokerFetch<{ messages: Array<{ text: string; from_id: string }> }>(
        port, "/poll-messages", { id: regB.id }
      );
      expect(poll.messages.length).toBe(1);
      expect(poll.messages[0]!.text).toBe("hello there");
      expect(poll.messages[0]!.from_id).toBe(regA.id);

      const again = await brokerFetch<{ messages: unknown[] }>(
        port, "/poll-messages", { id: regB.id }
      );
      expect(again.messages.length).toBe(0);
    } finally {
      try { a.kill(); } catch {}
      try { b.kill(); } catch {}
    }
  });

  test("send-message to unknown peer fails", async () => {
    const { port } = await startBroker();
    const child = spawnIdleChild("unknown-msg");
    try {
      const reg = await brokerFetch<{ id: string }>(port, "/register", {
        pid: child.pid, cwd: "/tmp/uk", git_root: null, tty: null, summary: "",
      });
      const res = await brokerFetch<{ ok: boolean; error?: string }>(
        port, "/send-message", { from_id: reg.id, to_id: "nonexistent", text: "ping" }
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("not found");
    } finally {
      try { child.kill(); } catch {}
    }
  });

  test("broadcast reaches all live peers, excluding the sender", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild("bc-a");
    const b = spawnIdleChild("bc-b");
    const c = spawnIdleChild("bc-c");
    try {
      const regA = await brokerFetch<{ id: string }>(port, "/register", {
        pid: a.pid, cwd: "/tmp/bc", git_root: null, tty: null, summary: "broadcaster",
      });
      const regB = await brokerFetch<{ id: string }>(port, "/register", {
        pid: b.pid, cwd: "/tmp/bc", git_root: null, tty: null, summary: "receiver 1",
      });
      const regC = await brokerFetch<{ id: string }>(port, "/register", {
        pid: c.pid, cwd: "/tmp/bc", git_root: null, tty: null, summary: "receiver 2",
      });

      const result = await brokerFetch<{ ok: boolean; count: number; delivered_to: string[] }>(
        port, "/broadcast", { from_id: regA.id, text: "team update" }
      );
      expect(result.ok).toBe(true);
      expect(result.count).toBe(2);
      expect(new Set(result.delivered_to)).toEqual(new Set([regB.id, regC.id]));

      const bPoll = await brokerFetch<{ messages: Array<{ text: string }> }>(
        port, "/poll-messages", { id: regB.id }
      );
      expect(bPoll.messages[0]!.text).toBe("team update");
    } finally {
      try { a.kill(); } catch {}
      try { b.kill(); } catch {}
      try { c.kill(); } catch {}
    }
  });

  test("broadcast filters by role", async () => {
    const { port } = await startBroker();
    const boss = spawnIdleChild("boss");
    const w1 = spawnIdleChild("w1");
    const w2 = spawnIdleChild("w2");
    const reviewer = spawnIdleChild("reviewer");
    try {
      const regBoss = await brokerFetch<{ id: string }>(port, "/register", {
        pid: boss.pid, cwd: "/tmp/role-bc", git_root: null, tty: null, summary: "boss", role: "boss",
      });
      const regW1 = await brokerFetch<{ id: string }>(port, "/register", {
        pid: w1.pid, cwd: "/tmp/role-bc", git_root: null, tty: null, summary: "worker 1", role: "worker",
      });
      const regW2 = await brokerFetch<{ id: string }>(port, "/register", {
        pid: w2.pid, cwd: "/tmp/role-bc", git_root: null, tty: null, summary: "worker 2", role: "worker",
      });
      const regReviewer = await brokerFetch<{ id: string }>(port, "/register", {
        pid: reviewer.pid, cwd: "/tmp/role-bc", git_root: null, tty: null, summary: "reviewer", role: "reviewer",
      });

      const result = await brokerFetch<{ ok: boolean; count: number; delivered_to: string[] }>(
        port, "/broadcast",
        { from_id: regBoss.id, text: "go team", roles: ["worker"] }
      );
      expect(result.ok).toBe(true);
      expect(result.count).toBe(2);
      expect(new Set(result.delivered_to)).toEqual(new Set([regW1.id, regW2.id]));

      const reviewerPoll = await brokerFetch<{ messages: unknown[] }>(
        port, "/poll-messages", { id: regReviewer.id }
      );
      expect(reviewerPoll.messages.length).toBe(0);

      const bossPoll = await brokerFetch<{ messages: unknown[] }>(
        port, "/poll-messages", { id: regBoss.id }
      );
      expect(bossPoll.messages.length).toBe(0);
    } finally {
      try { boss.kill(); } catch {}
      try { w1.kill(); } catch {}
      try { w2.kill(); } catch {}
      try { reviewer.kill(); } catch {}
    }
  });

  test("broadcast from unknown sender is rejected", async () => {
    const { port } = await startBroker();
    const res = await brokerFetch<{ ok: boolean; error?: string }>(
      port, "/broadcast", { from_id: "phantom", text: "hello?" }
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Sender peer");
  });

  test("broadcast with bad role filter is rejected", async () => {
    const { port } = await startBroker();
    const child = spawnIdleChild("bad-role");
    try {
      const reg = await brokerFetch<{ id: string }>(port, "/register", {
        pid: child.pid, cwd: "/tmp/bad-role", git_root: null, tty: null, summary: "",
      });
      const res = await brokerFetch<{ ok: boolean; error?: string }>(
        port, "/broadcast", { from_id: reg.id, text: "x", roles: ["god-mode"] }
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Invalid role");
    } finally {
      try { child.kill(); } catch {}
    }
  });

  test("broadcast with include_ids restricts to listed peers", async () => {
    const { port } = await startBroker();
    const a = spawnIdleChild("include-a");
    const b = spawnIdleChild("include-b");
    const c = spawnIdleChild("include-c");
    try {
      const regA = await brokerFetch<{ id: string }>(port, "/register", {
        pid: a.pid, cwd: "/tmp/include", git_root: null, tty: null, summary: "",
      });
      const regB = await brokerFetch<{ id: string }>(port, "/register", {
        pid: b.pid, cwd: "/tmp/include", git_root: null, tty: null, summary: "",
      });
      const regC = await brokerFetch<{ id: string }>(port, "/register", {
        pid: c.pid, cwd: "/tmp/include", git_root: null, tty: null, summary: "",
      });
      const res = await brokerFetch<{ ok: boolean; count: number; delivered_to: string[] }>(
        port, "/broadcast", { from_id: regA.id, text: "ping", include_ids: [regB.id] }
      );
      expect(res.ok).toBe(true);
      expect(res.count).toBe(1);
      expect(res.delivered_to).toEqual([regB.id]);

      const cPoll = await brokerFetch<{ messages: unknown[] }>(
        port, "/poll-messages", { id: regC.id }
      );
      expect(cPoll.messages.length).toBe(0);
    } finally {
      try { a.kill(); } catch {}
      try { b.kill(); } catch {}
      try { c.kill(); } catch {}
    }
  });

  test("heartbeat updates last_seen", async () => {
    const { port } = await startBroker();
    const child = spawnIdleChild("hb");
    try {
      const reg = await brokerFetch<{ id: string }>(port, "/register", {
        pid: child.pid, cwd: "/tmp/hb", git_root: null, tty: null, summary: "",
      });
      const before = await brokerFetch<Array<{ id: string; last_seen: string }>>(
        port, "/list-peers", { scope: "machine", cwd: "/", git_root: null }
      );
      expect(before.length).toBe(1);
      await new Promise((r) => setTimeout(r, 50));
      await brokerFetch(port, "/heartbeat", { id: reg.id });
      const after = await brokerFetch<Array<{ id: string; last_seen: string }>>(
        port, "/list-peers", { scope: "machine", cwd: "/", git_root: null }
      );
      expect(after.length).toBe(1);
      expect(after[0]!.last_seen >= before[0]!.last_seen).toBe(true);
    } finally {
      try { child.kill(); } catch {}
    }
  });

  test("unregister removes the peer", async () => {
    const { port } = await startBroker();
    const child = spawnIdleChild("unreg");
    try {
      const reg = await brokerFetch<{ id: string }>(port, "/register", {
        pid: child.pid, cwd: "/tmp/unreg", git_root: null, tty: null, summary: "",
      });
      await brokerFetch(port, "/unregister", { id: reg.id });
      const peers = await brokerFetch<Array<{ id: string }>>(
        port, "/list-peers", { scope: "machine", cwd: "/", git_root: null }
      );
      expect(peers.length).toBe(0);
    } finally {
      try { child.kill(); } catch {}
    }
  });
});

describe("broker backward compat", () => {
  test("register payload without role defaults to 'any'", async () => {
    const { port } = await startBroker();
    const child = spawnIdleChild("legacy");
    try {
      const reg = await brokerFetch<{ id: string }>(port, "/register", {
        pid: child.pid, cwd: "/tmp/legacy", git_root: null, tty: null, summary: "no role in body",
      });
      const peers = await brokerFetch<Array<{ id: string; role: string }>>(
        port, "/list-peers", { scope: "machine", cwd: "/", git_root: null }
      );
      expect(peers.length).toBe(1);
      expect(peers[0]!.id).toBe(reg.id);
      expect(peers[0]!.role).toBe("any");
    } finally {
      try { child.kill(); } catch {}
    }
  });

  test("original endpoints still respond (200) for the legacy client surface", async () => {
    const { port } = await startBroker();
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthRes.status).toBe(200);
    const hbRes = await fetch(`http://127.0.0.1:${port}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ghost" }),
    });
    expect(hbRes.status).toBe(200);
  });
});
