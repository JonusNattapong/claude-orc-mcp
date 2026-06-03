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
}

export interface BroadcastRequest {
  from_id: PeerId;
  text: string;
  roles?: PeerRole[];
  include_ids?: PeerId[];
  exclude_ids?: PeerId[];
  ttl_seconds?: number;
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
