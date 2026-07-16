import type {
  CanonicalConversationV1,
  ConversationPage,
  ProviderAdapter,
  Scope,
} from "../shared/types";
import {
  BRIDGE_CHANNEL,
  BRIDGE_SOURCE,
  type BridgePush,
  type BridgeRequest,
  type BridgeResponse,
  isBridgePush,
  isBridgeResponse,
} from "./protocol";

interface PendingRequest {
  resolve: (value: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: number;
}

let requestCounter = 0;

/** Isolated-world client; no provider token or cookie is ever read here. */
export class PageBridgeClient {
  private readonly platform: "chatgpt" | "claude";
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(conversation: CanonicalConversationV1) => void>();
  private installed = false;
  private readonly onMessage = (event: MessageEvent) => {
    if (event.source !== window || (event.origin && event.origin !== window.location.origin)) return;
    if (isBridgePush(event.data)) {
      const push = event.data as BridgePush;
      if (push.platform === this.platform) for (const listener of this.listeners) listener(push.conversation);
      return;
    }
    if (!isBridgeResponse(event.data)) return;
    const response = event.data as BridgeResponse;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    window.clearTimeout(pending.timer);
    pending.resolve(response);
  };

  constructor(platform: "chatgpt" | "claude", timeoutMs = 30_000) {
    this.platform = platform;
    this.timeoutMs = timeoutMs;
  }

  start(): void {
    if (this.installed) return;
    this.installed = true;
    window.addEventListener("message", this.onMessage);
  }

  stop(): void {
    if (!this.installed) return;
    this.installed = false;
    window.removeEventListener("message", this.onMessage);
    for (const [id, pending] of this.pending) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("Page bridge stopped"));
      this.pending.delete(id);
    }
    this.listeners.clear();
  }

  onConversation(listener: (conversation: CanonicalConversationV1) => void): () => void {
    this.start();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async request(operation: BridgeRequest["operation"], payload: Partial<BridgeRequest> = {}): Promise<BridgeResponse> {
    this.start();
    const requestId = `${Date.now().toString(36)}-${(++requestCounter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const request: BridgeRequest = {
      channel: BRIDGE_CHANNEL,
      source: BRIDGE_SOURCE,
      requestId,
      operation,
      platform: this.platform,
      ...(payload.scope ? { scope: payload.scope } : {}),
      ...(payload.sourceId ? { sourceId: payload.sourceId } : {}),
      ...(payload.cursor !== undefined ? { cursor: payload.cursor } : {}),
    };
    const response = await new Promise<BridgeResponse>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Page bridge timeout (${operation})`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      window.postMessage(request, window.location.origin);
    });
    if (!response.ok) {
      const error = new Error(response.error?.message || "Provider request failed") as Error & { status?: number; retryAfterMs?: number };
      error.status = response.error?.status;
      error.retryAfterMs = response.error?.retryAfterMs;
      throw error;
    }
    return response;
  }

  async detectScopes(): Promise<Scope[]> {
    const response = await this.request("detect_scopes");
    return response.result?.kind === "scopes" ? response.result.scopes : [];
  }

  async listConversations(scope: Scope, cursor?: string | null): Promise<ConversationPage> {
    const response = await this.request("list_conversations", { scope, cursor });
    if (response.result?.kind !== "conversations") throw new Error("Invalid conversation page from bridge");
    return response.result.page;
  }

  async fetchConversation(scope: Scope, sourceId: string): Promise<CanonicalConversationV1> {
    const response = await this.request("fetch_conversation", { scope, sourceId });
    if (response.result?.kind !== "conversation") throw new Error("Conversation was not found");
    return response.result.conversation;
  }

  async fetchCurrentConversation(): Promise<CanonicalConversationV1 | undefined> {
    const response = await this.request("fetch_current");
    return response.result?.kind === "conversation" ? response.result.conversation : undefined;
  }
}

