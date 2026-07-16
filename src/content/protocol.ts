import type {
  CanonicalConversationV1,
  ConversationPage,
  JsonValue,
  Scope,
} from "../shared/types";

export const BRIDGE_CHANNEL = "AI_CHAT_BACKUP_PAGE_BRIDGE_V1" as const;
export const BRIDGE_SOURCE = "ai-chat-backup" as const;

export type BridgeOperation =
  | "ping"
  | "detect_scopes"
  | "list_conversations"
  | "fetch_conversation"
  | "fetch_current";

export interface BridgeRequest {
  channel: typeof BRIDGE_CHANNEL;
  source: typeof BRIDGE_SOURCE;
  requestId: string;
  operation: BridgeOperation;
  platform: "chatgpt" | "claude";
  scope?: Scope;
  sourceId?: string;
  cursor?: string | null;
}

export interface BridgeResponse {
  channel: typeof BRIDGE_CHANNEL;
  source: typeof BRIDGE_SOURCE;
  requestId: string;
  ok: boolean;
  result?:
    | { kind: "pong"; platform: string }
    | { kind: "scopes"; scopes: Scope[] }
    | { kind: "conversations"; page: ConversationPage }
    | { kind: "conversation"; conversation: CanonicalConversationV1 }
    | { kind: "empty" };
  error?: { message: string; status?: number; retryAfterMs?: number };
}

export interface BridgePush {
  channel: typeof BRIDGE_CHANNEL;
  source: typeof BRIDGE_SOURCE;
  event: "conversation_updated";
  platform: "chatgpt" | "claude";
  conversation: CanonicalConversationV1;
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.channel === BRIDGE_CHANNEL && candidate.source === BRIDGE_SOURCE && typeof candidate.requestId === "string" && typeof candidate.operation === "string" && (candidate.platform === "chatgpt" || candidate.platform === "claude");
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.channel === BRIDGE_CHANNEL && candidate.source === BRIDGE_SOURCE && typeof candidate.requestId === "string" && typeof candidate.ok === "boolean";
}

export function isBridgePush(value: unknown): value is BridgePush {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.channel === BRIDGE_CHANNEL && candidate.source === BRIDGE_SOURCE && candidate.event === "conversation_updated" && (candidate.platform === "chatgpt" || candidate.platform === "claude") && !!candidate.conversation;
}

/** Remove any accidental extra fields before a request enters the page bridge. */
export function sanitizeBridgeRequest(value: BridgeRequest): BridgeRequest {
  return {
    channel: BRIDGE_CHANNEL,
    source: BRIDGE_SOURCE,
    requestId: value.requestId.slice(0, 80),
    operation: value.operation,
    platform: value.platform,
    ...(value.scope ? { scope: value.scope } : {}),
    ...(value.sourceId ? { sourceId: value.sourceId.slice(0, 300) } : {}),
    ...(value.cursor ? { cursor: value.cursor.slice(0, 2_000) } : {}),
  };
}

