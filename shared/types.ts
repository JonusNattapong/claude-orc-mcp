// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export type PeerRole = "boss" | "worker" | "reviewer" | "any";

export const PEER_ROLES: readonly PeerRole[] = ["boss", "worker", "reviewer", "any"] as const;

export function isPeerRole(value: unknown): value is PeerRole {
  return typeof value === "string" && (PEER_ROLES as readonly string[]).includes(value);
}

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  role: PeerRole;
  presence: string; // free-form short string ("typing", "idle", "busy", "reviewing", etc.)
  display_name: string; // friendly name set by user or peer (max 32 chars)
  source: string; // "local" or "mcp" (remote federation)
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
  expires_at: string | null; // ISO timestamp or null for never-expire
  // ID of the message this is replying to (null for top-level / root messages).
  reply_to: number | null;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  role?: PeerRole;
  presence?: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
  presence?: string;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface SetRoleRequest {
  id: PeerId;
  role: PeerRole;
}

export interface SetPresenceRequest {
  id: PeerId;
  presence: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
  // Optional role filter (one of boss/worker/reviewer/any).
  role?: PeerRole;
  // Optional presence substring filter (case-insensitive).
  presence?: string;
}

export interface ListPeersByRoleRequest {
  role: PeerRole;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  // Optional TTL in seconds. If omitted, broker default applies.
  // 0 or negative means "never expire".
  ttl_seconds?: number;
  // Optional: id of the message this is replying to. The target message
  // must exist (broker validates) but it does not need to involve the
  // same peers — anyone can reply to any message.
  reply_to?: number | null;
}

export interface BroadcastRequest {
  from_id: PeerId;
  text: string;
  roles?: PeerRole[];
  include_ids?: PeerId[];
  exclude_ids?: PeerId[];
  ttl_seconds?: number;
  // Optional: same semantics as SendMessageRequest.reply_to.
  reply_to?: number | null;
}

export interface BroadcastResponse {
  ok: boolean;
  delivered_to: PeerId[];
  count: number;
  error?: string;
}

export interface PollMessagesRequest {
  id: PeerId;
  // Optional: only return messages newer than this ISO timestamp.
  since?: string;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface MessageHistoryRequest {
  id: PeerId;
  // Max number of messages to return (newest first). Default 50, capped at 500.
  limit?: number;
  // Only return messages newer than this ISO timestamp.
  since?: string;
  // "inbox" (default, only received), "outbox" (only sent), or "all" (both).
  direction?: "inbox" | "outbox" | "all";
}

export interface MessageHistoryResponse {
  messages: Message[];
  count: number;
}

export interface ThreadRequest {
  // ID of any message in the thread (root or any reply). The broker
  // walks the reply_to chain up to the root and returns the full thread.
  id: number;
}

export interface ThreadResponse {
  // The root message of the thread (the one with reply_to === null in
  // the chain). May equal `id` if the requested message is itself the root.
  root: Message;
  // Every other message in the thread, oldest first.
  // Does NOT include the root — the caller already has it.
  replies: Message[];
  // Total messages in the thread (1 + replies.length).
  count: number;
}

// --- Board types ---

export type BoardTaskStatus = "todo" | "in_progress" | "done" | "blocked";

export const BOARD_TASK_STATUSES: readonly BoardTaskStatus[] = [
  "todo",
  "in_progress",
  "done",
  "blocked",
] as const;

export function isBoardTaskStatus(value: unknown): value is BoardTaskStatus {
  return typeof value === "string" && (BOARD_TASK_STATUSES as readonly string[]).includes(value);
}

export interface Board {
  id: number;
  name: string;
  description: string;
  created_at: string;
}

export interface BoardTask {
  id: number;
  board_id: number;
  title: string;
  description: string;
  status: BoardTaskStatus;
  assigned_to: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateBoardRequest {
  name: string;
  description?: string;
}

export interface CreateBoardResponse {
  id: number;
}

export interface ListBoardsResponse {
  boards: Board[];
}

export interface CreateBoardTaskRequest {
  board_id: number;
  title: string;
  description?: string;
  assigned_to?: string;
  created_by: string;
}

export interface UpdateBoardTaskRequest {
  id: number;
  title?: string;
  description?: string;
  status?: BoardTaskStatus;
  assigned_to?: string | null;
}

export interface ListBoardTasksRequest {
  board_id: number;
  status?: BoardTaskStatus;
  assigned_to?: string;
}

export interface KanbanResponse {
  board: Board;
  todo: BoardTask[];
  in_progress: BoardTask[];
  done: BoardTask[];
  blocked: BoardTask[];
}
