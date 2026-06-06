#!/usr/bin/env bun
import React, { useEffect, useMemo, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";

const BROKER_PORT = parseInt(process.env.CLEW_ORC_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_MS = 3000;

type Peer = { id: string; pid: number; cwd: string; git_root: string | null; summary: string; role: string; presence: string; source: string; last_seen: string };
type Board = { id: number; name: string; description: string; created_at: string };
type BoardTask = { id: number; title: string; status: string; assigned_to: string | null; description: string };
type Kanban = { board: Board; todo: BoardTask[]; in_progress: BoardTask[]; done: BoardTask[]; blocked: BoardTask[] };

async function brokerFetch<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    const opts: RequestInit = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
    const res = await fetch(`${BROKER_URL}${path}`, { ...opts, signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

type Tab = "peers" | "boards" | "messages";

// ─── Broker Status ──────────────────────────────────────────────────────────

function BrokerStatus() {
  const [health, setHealth] = useState<{ status: string; peers: number; message_ttl_hours: number } | null>(null);
  useEffect(() => { const t = setInterval(async () => setHealth(await brokerFetch("/health")), POLL_MS); return () => clearInterval(t); }, []);
  const alive = health?.status === "ok";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{alive ? <Text color="green">{"● "}</Text> : <Text color="red">{"○ "}</Text>}{`Broker ${alive ? "Running" : "Offline"}`}</Text>
      {alive && <Text dimColor>  Port: {BROKER_PORT}  Peers: {health?.peers ?? 0}  TTL: {health?.message_ttl_hours}h</Text>}
    </Box>
  );
}

// ─── Peer List ────────────────────────────────────────────────────────────────

function PeerList({ peers, selectedPath, pathIndex, groups: _g }: { peers: Peer[]; selectedPath: string | null; pathIndex: number; groups: { cwd: string; count: number; peers: Peer[] }[] }) {
  if (peers.length === 0) return <Text dimColor>No peers connected.</Text>;

  if (!selectedPath) {
    return (
      <Box flexDirection="column">
        <Text bold>Peers ({peers.length}) — by directory</Text>
        <Box flexDirection="column" marginTop={1}>
          {_g.map((g, i) => (
            <Text key={g.cwd} color={i === pathIndex ? "cyan" : undefined}>
              {i === pathIndex ? "> " : "  "}{`${g.count} peer(s)`}  <Text dimColor>{g.cwd}</Text>{g.peers.some(p => p.source === "mcp") ? <Text color="yellow">{" [MCP]"}</Text> : null}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  const group = _g.find((g) => g.cwd === selectedPath);
  if (!group) return null;
  const isAlive = (lastSeen: string) => (Date.now() - new Date(lastSeen).getTime()) < 30000;

  return (
    <Box flexDirection="column">
      <Text bold color="yellow">Path: </Text>
      <Text bold>{selectedPath}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">{"     ID        ROLE     PRESENCE   STATUS     LAST SEEN"}</Text>
        <Text dimColor>{"  ───────────────────────────────────────────────────────"}</Text>
        {group.peers.slice(0, 25).map((p) => (
          <Box key={p.id} flexDirection="column">
            <Text>
              <Text>{isAlive(p.last_seen) ? "  ●" : "  ○"}</Text>
              <Text>{` ${p.id.slice(0, 10)}`}</Text>
              {p.source === "mcp" ? <Text color="yellow">{" MCP "}</Text> : <Text>{"    "}</Text>}
              <Text dimColor>{` ${p.role.padEnd(8)}`}</Text>
              <Text dimColor>{` ${(p.presence || "-").padEnd(9)}`}</Text>
              <Text color={isAlive(p.last_seen) ? "green" : "red"}>{isAlive(p.last_seen) ? "alive".padEnd(9) : "offline".padEnd(9)}</Text>
              <Text dimColor>{timeAgo(p.last_seen)}</Text>
            </Text>
            {p.summary && <Text dimColor>{`   ${p.summary.slice(0, 55)}`}</Text>}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ─── TabBar ─────────────────────────────────────────────────────────────────

function TabBar({ active }: { active: Tab }) {
  return <Text dimColor>{`[P] Peers  [B] Boards  [M] Messages  [Q] Quit`}</Text>;
}

// ─── Board Kanban ────────────────────────────────────────────────────────────

function BoardKanban() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedBoard, setSelectedBoard] = useState<number | null>(null);
  const [kanban, setKanban] = useState<Kanban | null>(null);
  useEffect(() => { const t = setInterval(async () => { const b = await brokerFetch<{ boards: Board[] }>("/board/list", {}); if (b) setBoards(b.boards); }, POLL_MS * 2); return () => clearInterval(t); }, []);
  useEffect(() => { if (!selectedBoard && boards.length > 0) setSelectedBoard(boards[0].id); }, [boards, selectedBoard]);
  useEffect(() => { if (!selectedBoard) return; const t = setInterval(async () => { const k = await brokerFetch<Kanban>("/board/task/kanban", { board_id: selectedBoard }); if (k && "board" in k) setKanban(k as Kanban); }, POLL_MS); return () => clearInterval(t); }, [selectedBoard]);
  if (boards.length === 0) return <Text dimColor>No boards yet.</Text>;

  const col = (tasks: BoardTask[], title: string, color: string) => (
    <Box flexDirection="column" marginRight={1} minWidth={18}>
      <Text bold color={color}>{`[${title.toUpperCase()}]`}</Text>
      {tasks.length === 0 ? <Text dimColor>  (empty)</Text> : tasks.slice(0, 8).map((t) => (
        <Text key={t.id}><Text color={color}>{` #${t.id}`}</Text><Text>{` ${t.title.slice(0, 14)}${t.assigned_to ? ` ${t.assigned_to.slice(0, 6)}` : ""}`}</Text></Text>
      ))}
      {tasks.length > 8 && <Text dimColor>{`  +${tasks.length - 8} more`}</Text>}
    </Box>
  );

  const board = boards.find((b) => b.id === selectedBoard);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="yellow">{`Board: ${board?.name ?? selectedBoard}`}</Text>
      <Box marginTop={1} flexDirection="row">{kanban ? <>{col(kanban.todo, "todo", "blue")}{col(kanban.in_progress, "in_progress", "yellow")}{col(kanban.done, "done", "green")}{col(kanban.blocked, "blocked", "red")}</> : <Text dimColor>Loading...</Text>}</Box>
    </Box>
  );
}

// ─── Messages / Chat Room ─────────────────────────────────────────────────────
// NOTE: This component does NOT use useInput. All input is handled by App.
// It receives composing state and messages as props.

function MessagesView({
  allPeers, msgs, composing, composeInput, composeTarget,
}: {
  allPeers: Peer[];
  msgs: Array<{ id: number; from_id: string; to_id: string; text: string; sent_at: string }>;
  composing: boolean;
  composeInput: string;
  composeTarget: string;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Live Chat Room</Text>

      {/* Online indicator */}
      <Box marginTop={1} flexDirection="row">
        <Text dimColor>Online: </Text>
        {allPeers.length === 0 ? <Text dimColor>none</Text> : allPeers.slice(0, 10).map((p) => {
          const alive = (Date.now() - new Date(p.last_seen).getTime()) < 30000;
          return <Text key={p.id} marginRight={1}><Text color={alive ? "green" : "red"}>{alive ? "●" : "○"}</Text><Text dimColor>{`${p.id.slice(0, 6)} `}</Text></Text>;
        })}
      </Box>

      {/* Messages */}
      <Box flexDirection="column" marginTop={1}>
        {msgs.length === 0 ? (
          <Text dimColor>No messages yet.</Text>
        ) : (
          msgs.slice().reverse().slice(0, 20).map((m) => (
            <Box key={m.id} flexDirection="column" marginTop={1}>
              <Text>
                <Text color={m.from_id === "dashboard" ? "green" : "cyan"}>{m.from_id}</Text>
                <Text dimColor>{` \u2192 `}</Text>
                <Text color={m.to_id === "*" ? "yellow" : "magenta"}>{m.to_id === "*" ? "all" : m.to_id}</Text>
                <Text dimColor>{`  ${m.sent_at.slice(11, 19)}`}</Text>
              </Text>
              <Text>{m.text.slice(0, 80)}</Text>
            </Box>
          ))
        )}
      </Box>

      {/* Compose input */}
      {composing ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Target: {composeTarget}  (Tab to change)</Text>
          <Text bold color="green">{`> ${composeInput}${((Date.now() / 500) % 2) ? "\u2588" : " "}`}</Text>
          <Text dimColor>Enter: send \u00b7 Esc: cancel</Text>
        </Box>
      ) : (
        <Box marginTop={1}><Text dimColor>Press Enter to compose</Text></Box>
      )}
    </Box>
  );
}

// ─── Main App ──────────────────────────────────────────────────────────────

function App() {
  const { exit } = useApp();
  const [tab, setTab] = useState<Tab>("peers");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pathIndex, setPathIndex] = useState(0);

  // Chat state (handled here, not in MessagesView, to avoid useInput conflicts)
  const [msgs, setMsgs] = useState<Array<{ id: number; from_id: string; to_id: string; text: string; sent_at: string }>>([]);
  const [composing, setComposing] = useState(false);
  const [composeInput, setComposeInput] = useState("");
  const [composeTarget, setComposeTarget] = useState("* (broadcast)");
  const [composeTargetIdx, setComposeTargetIdx] = useState(0);

  // Poll peers
  useEffect(() => { const t = setInterval(async () => { const p = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null }); if (p) setPeers(p); }, POLL_MS); return () => clearInterval(t); }, []);

  // Poll messages (only on messages tab, pause while composing)
  useEffect(() => {
    if (composing) return;
    const t = setInterval(async () => {
      const p = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
      if (p && p.length > 0) {
        const hist = await brokerFetch<{ messages: Array<{ id: number; from_id: string; to_id: string; text: string; sent_at: string }> }>("/messages/history", { id: p[0].id, limit: 30, direction: "all" });
        if (hist) setMsgs(hist.messages);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [composing]);

  const groups = useMemo(() => {
    const map: Record<string, Peer[]> = {};
    for (const p of peers) {
      const key = p.cwd.replace(/\\/g, "/"); // normalize Windows paths
      (map[key] ??= []).push({ ...p, cwd: key });
    }
    return Object.entries(map).map(([cwd, ps]) => ({ cwd, count: ps.length, peers: ps }));
  }, [peers]);

  const chatTargets = ["* (broadcast)", ...peers.filter(p => p.id !== peers[0]?.id).map(p => `${p.id}`)];

  // ALL keyboard input handled here
  useInput((_input, key) => {
    // ── Chat composing mode ──
    if (composing) {
      if (key.escape) { setComposing(false); setComposeInput(""); return; }
      if (key.return && composeInput.trim()) {
        const target = composeTarget === "* (broadcast)" ? "*" : composeTarget.split(" ")[0];
        if (target === "*") {
          brokerFetch("/broadcast", { from_id: "dashboard", text: composeInput.trim() });
        } else {
          brokerFetch("/send-message", { from_id: "dashboard", to_id: target, text: composeInput.trim() });
        }
        setComposeInput("");
        setComposing(false);
        return;
      }
      if (key.backspace || key.delete) { setComposeInput((s) => s.slice(0, -1)); return; }
      if (key.tab) {
        const next = (composeTargetIdx + 1) % chatTargets.length;
        setComposeTargetIdx(next);
        setComposeTarget(chatTargets[next]);
        return;
      }
      if (_input.length === 1 && _input >= " ") { setComposeInput((s) => s + _input); return; }
      return; // block all other keys while composing
    }

    // ── Peers tab navigation ──
    if (tab === "peers") {
      if (!selectedPath) {
        if (key.upArrow) setPathIndex((i) => Math.max(0, i - 1));
        if (key.downArrow) setPathIndex((i) => Math.min(groups.length - 1, i + 1));
        if (key.return && groups.length > 0) setSelectedPath(groups[pathIndex].cwd);
      } else { if (key.escape) setSelectedPath(null); }
    }

    // ── Tab switching ──
    if (_input === "p" || _input === "P") { setTab("peers"); setSelectedPath(null); }
    if (_input === "b" || _input === "B") setTab("boards");
    if (_input === "m" || _input === "M") { setTab("messages"); setComposing(false); }

    // ── Enter chat compose ──
    if (tab === "messages" && key.return) { setComposing(true); setComposeInput(""); setComposeTarget("* (broadcast)"); setComposeTargetIdx(0); }

    // ── Quit ──
    if (_input === "q" || _input === "Q") exit();
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="green">{`
  ██████╗ ██████╗  ██████╗
 ██╔═══██╗██╔══██╗██╔════╝
 ██║   ██║██████╔╝██║
 ██║   ██║██╔══██╗██║
 ╚██████╔╝██║  ██║╚██████╗
  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝
`}</Text>
      <BrokerStatus />

      <Box marginTop={1}><Text bold>━━━ Peers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text></Box>
      <PeerList peers={peers} selectedPath={selectedPath} pathIndex={pathIndex} groups={groups} />

      {tab === "boards" && <Box marginTop={1}><Text bold>━━━ Board ━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text></Box>}
      {tab === "boards" && <BoardKanban />}

      {tab === "messages" && <Box marginTop={1}><Text bold>━━━ Messages ━━━━━━━━━━━━━━━━━━━━━━━━━</Text></Box>}
      {tab === "messages" && (
        <MessagesView
          allPeers={peers}
          msgs={msgs}
          composing={composing}
          composeInput={composeInput}
          composeTarget={composeTarget}
        />
      )}

      <TabBar active={tab} />
      <Text dimColor>Auto-refresh every {POLL_MS / 1000}s</Text>
    </Box>
  );
}

render(<App />);
if (!process.stdin.isTTY) setTimeout(() => process.exit(0), 2000);
