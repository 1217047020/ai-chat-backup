import type {
  AttachmentMetadata,
  ContentBlock,
  ConversationBranch,
  ConversationMessage,
  JsonValue,
  Scope,
  SourceConversationStatus,
} from "../shared/types";
import { hashProjection, makeConversationKey, sha256Hex, stableStringify } from "../shared/utils";

/** Runtime-safe object guard used while parsing provider responses. */
export function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

export function asOptionalString(value: unknown): string | undefined {
  const text = asString(value).trim();
  return text || undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  return undefined;
}

/** Convert provider timestamps to stable ISO values without throwing. */
export function toIso(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  const number = asNumber(value);
  const date = number == null
    ? new Date(asString(value))
    : new Date(number < 10_000_000_000 ? number * 1000 : number);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Keep a provider response useful for diagnostics while ensuring secrets,
 * cookies and short-lived signed URLs can never enter the backup payload.
 */
export function sanitizeProviderValue(
  value: unknown,
  key = "",
  attachmentContext = false,
): JsonValue {
  const lowerKey = key.toLowerCase();
  if (
    lowerKey.includes("access_token") ||
    lowerKey === "accesstoken" ||
    lowerKey.includes("refresh_token") ||
    lowerKey === "refreshtoken" ||
    lowerKey === "authorization" ||
    lowerKey === "cookie" ||
    lowerKey === "set-cookie" ||
    lowerKey === "oai-device-id" ||
    lowerKey === "oaideviceid" ||
    lowerKey === "oai-did" ||
    lowerKey === "oaidid" ||
    lowerKey === "device_id" ||
    lowerKey === "deviceid" ||
    lowerKey === "session_token" ||
    lowerKey === "sessiontoken" ||
    lowerKey === "csrf_token" ||
    lowerKey === "csrftoken" ||
    lowerKey === "id_token" ||
    lowerKey === "idtoken"
  ) {
    return "<redacted>";
  }

  if (
    lowerKey === "extracted_content" ||
    lowerKey === "extracted_text" ||
    (attachmentContext && /^(content|data|body|bytes|base64|blob)$/i.test(lowerKey))
  ) {
    // Attachment bodies can be very large and are intentionally represented
    // by metadata only. Artifact bodies are handled separately by adapters.
    return "<omitted-attachment-content>";
  }

  if (typeof value === "string") {
    // Do not persist a signed download URL. Keep the path as a useful stable
    // diagnostic without query parameters containing signatures/tokens.
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        const hasSignature = [...url.searchParams.keys()].some((name) =>
          /sig|signature|token|expires|x-amz|download/i.test(name)
        );
        if (hasSignature) return `${url.origin}${url.pathname}`;
      } catch {
        // Keep non-URL strings unchanged.
      }
    }
    return value;
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return null;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProviderValue(item, key, attachmentContext));
  }

  const output: Record<string, JsonValue> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    const childIsAttachment = attachmentContext || /^(attachments?|files?|file_uploads?|assets?)$/i.test(childKey);
    output[childKey] = sanitizeProviderValue(childValue, childKey, childIsAttachment);
  }
  return output;
}

export function sanitizeAttachment(
  value: unknown,
  messageId?: string,
  index = 0
): AttachmentMetadata {
  const input = isRecord(value) ? value : {};
  const sourceId = asOptionalString(
    input.id ?? input.uuid ?? input.file_id ?? input.attachment_id ?? input.source_id
  );
  return {
    attachmentId: sourceId || `${messageId || "message"}:attachment:${index}`,
    sourceId,
    name: asOptionalString(input.file_name ?? input.filename ?? input.name),
    mimeType: asOptionalString(input.file_type ?? input.mime_type ?? input.content_type ?? input.type),
    sizeBytes: asNumber(input.file_size ?? input.size ?? input.size_bytes),
    messageId,
  };
}

export function normalizeRole(value: unknown): ConversationMessage["role"] {
  const role = asString(value).toLowerCase();
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "claude" || role === "bot") return "assistant";
  if (role === "system") return "system";
  if (role === "developer") return "developer";
  if (role === "tool" || role === "tool_use" || role === "tool_result") return "tool";
  return "unknown";
}

export function textBlock(text: unknown): ContentBlock | undefined {
  const value = asString(text).trim();
  return value ? { type: "text", text: value } : undefined;
}

/** Build all leaf-to-root paths so alternate provider branches remain backed up. */
export function deriveBranches(
  messages: ConversationMessage[],
  activeLeafId?: string
): { branches: ConversationBranch[]; currentBranchId?: string } {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const children = new Map<string, string[]>();
  for (const message of messages) {
    if (message.parentId && byId.has(message.parentId)) {
      const siblings = children.get(message.parentId) || [];
      siblings.push(message.id);
      children.set(message.parentId, siblings);
    }
  }
  for (const message of messages) message.childIds = children.get(message.id) || [];

  const leaves = messages
    .filter((message) => (message.childIds || []).length === 0)
    .map((message) => message.id);
  if (activeLeafId && byId.has(activeLeafId) && !leaves.includes(activeLeafId)) {
    leaves.push(activeLeafId);
  }

  const branches: ConversationBranch[] = [];
  for (const leaf of leaves) {
    const path: string[] = [];
    const seen = new Set<string>();
    let id: string | undefined = leaf;
    while (id && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      path.unshift(id);
      id = byId.get(id)?.parentId;
    }
    if (!path.length) continue;
    const branchId = `branch:${leaf}`;
    branches.push({
      id: branchId,
      rootMessageId: path[0],
      messageIds: path,
      isActive: leaf === activeLeafId || (!activeLeafId && branches.length === 0),
    });
  }

  const current = branches.find((branch) => branch.isActive) || branches[0];
  if (current) current.isActive = true;
  return { branches, currentBranchId: current?.id };
}

export function getBranchMessages(
  messages: ConversationMessage[],
  branches: ConversationBranch[],
  currentBranchId?: string
): ConversationMessage[] {
  const branch = branches.find((candidate) => candidate.id === currentBranchId) || branches.find((candidate) => candidate.isActive) || branches[0];
  if (!branch) return messages;
  const byId = new Map(messages.map((message) => [message.id, message]));
  return branch.messageIds.map((id) => byId.get(id)).filter(Boolean) as ConversationMessage[];
}

export function makeScopeKey(_platform: Scope["platform"], id: string): string {
  // Scope keys are provider-local; the platform is added exactly once by
  // makeConversationKey(). Keeping the key bare avoids `chatgpt:chatgpt:...`
  // identities and matches the shared Scope contract.
  return id || "personal";
}

export async function accountHash(value: string): Promise<string> {
  const hash = await sha256Hex(value || "unknown-account");
  return hash.slice(0, 24);
}

export function canonicalKey(scope: Scope, sourceId: string): string {
  return makeConversationKey(scope.platform, scope.scopeKey, sourceId);
}

/** Hash projection used by tests and callers that need a stable target hash. */
export async function semanticHash(value: Record<string, unknown>): Promise<string> {
  return sha256Hex(stableStringify(hashProjection(value)));
}

export function sourceStatus(archived: unknown, missing = false): SourceConversationStatus {
  if (missing) return "missing_on_source";
  if (archived === true || archived === "true") return "archived";
  return "active";
}

export function safeFilename(value: string, fallback = "untitled"): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (cleaned || fallback).slice(0, 120);
}

export interface ProviderFetchError extends Error {
  status?: number;
  retryAfterMs?: number;
}

export function makeProviderError(response: Response, provider: string): ProviderFetchError {
  const error = new Error(`${provider} request failed (${response.status})`) as ProviderFetchError;
  error.status = response.status;
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    error.retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  return error;
}

export async function readJsonResponse(response: Response, provider: string): Promise<JsonValue> {
  if (!response.ok) throw makeProviderError(response, provider);
  return (await response.json()) as JsonValue;
}
