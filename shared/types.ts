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
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  role?: PeerRole;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface SetRoleRequest {
  id: PeerId;
  role: PeerRole;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface ListPeersByRoleRequest {
  role: PeerRole;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface BroadcastRequest {
  from_id: PeerId;
  text: string;
  // When set, only peers whose role matches any of these receive the message.
  // If omitted, all peers (other than `from_id`) are targeted.
  roles?: PeerRole[];
  // Optional include/exclude lists for finer control
  include_ids?: PeerId[];
  exclude_ids?: PeerId[];
}

export interface BroadcastResponse {
  ok: boolean;
  delivered_to: PeerId[];
  count: number;
  error?: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}
