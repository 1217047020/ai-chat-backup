import type { ProviderAdapter, Scope } from "../shared/types";
import { ChatGPTAdapter, installChatGPTWorkspaceCapture } from "../adapters/chatgpt";
import { ClaudeAdapter, installClaudeOrganizationCapture } from "../adapters/claude";
import {
  BRIDGE_CHANNEL,
  BRIDGE_SOURCE,
  type BridgeRequest,
  type BridgeResponse,
  isBridgeRequest,
  sanitizeBridgeRequest,
} from "./protocol";

const INSTALL_MARKER = "__aiChatBackupPageBridgeInstalled";

function platformForPage(): "chatgpt" | "claude" {
  return /(^|\.)claude\.ai$/i.test(window.location.hostname) ? "claude" : "chatgpt";
}

function post(response: BridgeResponse): void {
  window.postMessage(response, window.location.origin);
}

function errorPayload(error: unknown): BridgeResponse["error"] {
  const value = error as { message?: unknown; status?: unknown; retryAfterMs?: unknown };
  return {
    message: typeof value?.message === "string" ? value.message : "Provider request failed",
    ...(typeof value?.status === "number" ? { status: value.status } : {}),
    ...(typeof value?.retryAfterMs === "number" ? { retryAfterMs: value.retryAfterMs } : {}),
  };
}

/**
 * Install the narrow MAIN-world bridge. It accepts only fixed provider
 * operations and never accepts a URL, method, or arbitrary headers from the
 * isolated world/page. Provider credentials therefore remain in this page
 * context and are never serialized into a bridge response.
 */
export function installPageCollectionBridge(): () => void {
  const existing = (window as any)[INSTALL_MARKER] as (() => void) | undefined;
  if (existing) return existing;
  const platform = platformForPage();
  const adapter: ProviderAdapter = platform === "claude" ? new ClaudeAdapter() : new ChatGPTAdapter();
  const cleanups: Array<() => void> = [];
  cleanups.push(platform === "claude" ? installClaudeOrganizationCapture(window) : installChatGPTWorkspaceCapture(window));

  const onMessage = async (event: MessageEvent) => {
    if (event.source !== window || (event.origin && event.origin !== window.location.origin)) return;
    if (!isBridgeRequest(event.data)) return;
    const request = sanitizeBridgeRequest(event.data as BridgeRequest);
    if (request.platform !== platform) return;
    const base: Pick<BridgeResponse, "channel" | "source" | "requestId"> = { channel: BRIDGE_CHANNEL, source: BRIDGE_SOURCE, requestId: request.requestId };
    try {
      switch (request.operation) {
        case "ping":
          post({ ...base, ok: true, result: { kind: "pong", platform } });
          return;
        case "detect_scopes":
          post({ ...base, ok: true, result: { kind: "scopes", scopes: await adapter.detectScopes() } });
          return;
        case "list_conversations": {
          if (!request.scope || request.scope.platform !== platform) throw new Error("A matching provider scope is required");
          const page = await adapter.listConversations(request.scope, request.cursor);
          post({ ...base, ok: true, result: { kind: "conversations", page } });
          return;
        }
        case "fetch_conversation": {
          if (!request.scope || request.scope.platform !== platform || !request.sourceId) throw new Error("A scope and source ID are required");
          const conversation = await adapter.fetchConversation(request.scope, request.sourceId);
          post({ ...base, ok: true, result: { kind: "conversation", conversation } });
          return;
        }
        case "fetch_current": {
          const fetchCurrent = (adapter as any).fetchCurrentConversation as (() => Promise<unknown>) | undefined;
          const conversation = fetchCurrent ? await fetchCurrent.call(adapter) : undefined;
          post(conversation ? { ...base, ok: true, result: { kind: "conversation", conversation: conversation as any } } : { ...base, ok: true, result: { kind: "empty" } });
          return;
        }
        default:
          throw new Error("Unsupported provider bridge operation");
      }
    } catch (error) {
      post({ ...base, ok: false, error: errorPayload(error) });
    }
  };
  window.addEventListener("message", onMessage);
  cleanups.push(() => window.removeEventListener("message", onMessage));
  cleanups.push(adapter.observeCurrentConversation((conversation) => {
    window.postMessage({ channel: BRIDGE_CHANNEL, source: BRIDGE_SOURCE, event: "conversation_updated", platform, conversation }, window.location.origin);
  }));

  const cleanup = () => {
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch { /* best effort during page teardown */ }
    }
    delete (window as any)[INSTALL_MARKER];
  };
  (window as any)[INSTALL_MARKER] = cleanup;
  return cleanup;
}

export default installPageCollectionBridge;
