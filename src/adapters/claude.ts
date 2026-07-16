import type {
  ArtifactRecord,
  CanonicalConversationV1,
  ContentBlock,
  ConversationMessage,
  ConversationPage,
  ConversationSummary,
  JsonValue,
  NormalizeContext,
  ProviderAdapter,
  Scope,
  ToolInvocation,
  VisibleThought,
} from "../shared/types";
import { makeConversationKey } from "../shared/utils";
import {
  accountHash,
  asArray,
  asNumber,
  asOptionalString,
  asString,
  canonicalKey,
  deriveBranches,
  isRecord,
  makeScopeKey,
  normalizeRole,
  readJsonResponse,
  sanitizeAttachment,
  sanitizeProviderValue,
  sourceStatus,
  textBlock,
  toIso,
} from "./utils";
import { conversationToMarkdown } from "./markdown";

/** Compatibility parser based on Claude Exporter 1.10.17's MIT utility behavior. */
export const CLAUDE_EXPORTER_LICENSE =
  "Claude Exporter parsing compatibility adapted from agoramachina/claude-exporter (MIT License), v1.10.17.";
const CLAUDE_ADAPTER_VERSION = "claude-exporter-compatible-1.10.17";
const PAGE_SIZE = 100;
let lastOrganizationId: string | undefined;

export interface ClaudeAdapterOptions {
  fetch?: typeof fetch;
  document?: Document;
  location?: Location;
  throttleMs?: number;
  throttleJitterMs?: number;
}

interface CachedList {
  summaries: ConversationSummary[];
  fetchedAt: number;
}

function defaultFetch(): typeof fetch {
  const candidate = (globalThis as any).fetch;
  if (typeof candidate !== "function") throw new Error("Fetch is unavailable in this page");
  return candidate.bind(globalThis);
}

/** Capture organization routing only; request/response bodies and cookies stay in page memory. */
export function installClaudeOrganizationCapture(target: Window = window): () => void {
  const marker = "__aiChatBackupClaudeCapture";
  const existing = (target as any)[marker] as (() => void) | undefined;
  if (existing) return existing;
  const originalFetch = target.fetch;
  const Xhr = (target as any).XMLHttpRequest as typeof XMLHttpRequest | undefined;
  const originalOpen = Xhr?.prototype.open;
  const wrappedFetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const match = url.match(/\/api\/organizations\/([^/?#]+)/);
      if (match?.[1]) lastOrganizationId = decodeURIComponent(match[1]);
    } catch {
      // Never alter host behavior for an observation failure.
    }
    return originalFetch.call(target, input, init);
  } as typeof fetch;
  target.fetch = wrappedFetch;
  if (originalOpen && Xhr) {
    const xhr = Xhr.prototype;
    xhr.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
      const match = String(url).match(/\/api\/organizations\/([^/?#]+)/);
      if (match?.[1]) lastOrganizationId = decodeURIComponent(match[1]);
      return (originalOpen as any).call(this, method, url, ...rest);
    } as typeof xhr.open;
  }
  const cleanup = () => {
    if (target.fetch === wrappedFetch) target.fetch = originalFetch;
    if (Xhr && originalOpen && Xhr.prototype.open !== originalOpen) Xhr.prototype.open = originalOpen;
    delete (target as any)[marker];
  };
  (target as any)[marker] = cleanup;
  return cleanup;
}

function currentClaudeId(location: Location | undefined = typeof window !== "undefined" ? window.location : undefined): string | undefined {
  const path = location?.pathname || "";
  const matches = [...path.matchAll(/\/chat\/([a-zA-Z0-9_-]+)/g)];
  return matches.at(-1)?.[1];
}

function currentProjectId(location: Location | undefined = typeof window !== "undefined" ? window.location : undefined): string | undefined {
  const path = location?.pathname || "";
  return path.match(/\/project[s]?\/([a-zA-Z0-9_-]+)/)?.[1];
}

function organizationItems(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const nested = value.organizations ?? value.items ?? value.data;
    if (Array.isArray(nested)) return nested;
    if (isRecord(nested)) return organizationItems(nested);
  }
  return [];
}

function capabilityNames(organization: any): string[] {
  const raw = organization?.capabilities ?? organization?.features;
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return values.map((item) => asString(item).toLowerCase());
}

function projectMetadata(value: unknown): JsonValue[] {
  const record = isRecord(value) ? value : undefined;
  const items = asArray<any>(record ? record.projects ?? record.items ?? record.data : value);
  return items
    .map((item) => {
      const id = asOptionalString(item?.uuid ?? item?.id ?? item?.project_uuid ?? item?.project_id);
      if (!id) return undefined;
      const name = asString(item?.name ?? item?.title ?? item?.display_name, id);
      return { id, name } as JsonValue;
    })
    .filter((item): item is JsonValue => Boolean(item));
}

function messageText(message: any): string {
  if (typeof message?.text === "string") return message.text;
  return asArray<any>(message?.content)
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function languageIsCode(language: string): boolean {
  return /^(js|javascript|ts|typescript|python|java|c|cpp|c\+\+|ruby|php|swift|go|rust|jsx|tsx|shell|bash|sql|kotlin|scala|r|perl|lua|dart|html|css|scss|sass|less|svg)$/i.test(language);
}

function extractLegacyArtifacts(text: string, messageId: string, offset: number): ArtifactRecord[] {
  const result: ArtifactRecord[] = [];
  const regex = /<antArtifact([^>]*)>([\s\S]*?)<\/antArtifact>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const attrs = match[1] || "";
    const get = (name: string) => attrs.match(new RegExp(`${name}=["']([^"']*)["']`, "i"))?.[1];
    const type = get("type") || "text/plain";
    const language = get("language") || (type.includes("html") ? "html" : type.includes("markdown") ? "markdown" : "txt");
    const name = get("title") || `artifact-${offset + result.length + 1}`;
    result.push({ artifactId: `${messageId}:artifact:${offset + result.length}`, name, mimeType: type, language, text: match[2].trim(), sourceMessageId: messageId, hasBody: true });
  }
  return result;
}

function extractClaudeContent(message: any, messageId: string): {
  content: ContentBlock[];
  tools: ToolInvocation[];
  thoughts: VisibleThought[];
  artifacts: ArtifactRecord[];
  attachments: ReturnType<typeof sanitizeAttachment>[];
} {
  const content: ContentBlock[] = [];
  const tools: ToolInvocation[] = [];
  const thoughts: VisibleThought[] = [];
  const artifacts: ArtifactRecord[] = [];
  const attachments: ReturnType<typeof sanitizeAttachment>[] = [];
  const parts = Array.isArray(message?.content) ? message.content : message?.content ? [message.content] : [];
  for (const part of parts) {
    if (typeof part === "string") {
      const block = textBlock(part.replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/gi, ""));
      if (block) content.push(block);
      continue;
    }
    if (!isRecord(part)) continue;
    const type = asString(part.type).toLowerCase();
    if (type === "thinking" || type === "redacted_thinking") {
      const text = asString(part.thinking ?? part.text ?? part.summary);
      if (text) {
        content.push({ type: "thinking", text, visible: type !== "redacted_thinking" });
        if (type !== "redacted_thinking") thoughts.push({ messageId, text, createdAt: toIso(message?.created_at) });
      }
      continue;
    }
    if (type === "text") {
      const text = asString(part.text).replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/gi, "");
      const block = textBlock(text);
      if (block) content.push(block);
      continue;
    }
    if (type === "tool_use" || type === "server_tool_use" || type === "tool_result") {
      const name = asString(part.name ?? part.tool_name ?? type);
      const call: ToolInvocation = {
        id: asOptionalString(part.id ?? part.tool_use_id), name,
        arguments: sanitizeProviderValue(part.input ?? part.arguments),
        result: sanitizeProviderValue(part.content ?? part.result), messageId,
      };
      tools.push(call);
      content.push({ type: "tool_call", id: call.id, name, arguments: call.arguments, result: call.result });
      let display: any;
      if (isRecord(part.display_content)) display = part.display_content;
      else if (typeof part.display_content === "string") {
        try { display = JSON.parse(part.display_content); } catch { display = undefined; }
      }
      if ((name === "artifacts" || name === "create_file") && display) {
        let body = "";
        let filename = "artifact";
        let language = "txt";
        if (display.type === "code_block") {
          body = asString(display.code); filename = asString(display.filename, filename); language = asString(display.language, language);
        } else if (display.type === "json_block") {
          try {
            const parsed = JSON.parse(asString(display.json_block));
            body = asString(parsed.code); filename = asString(parsed.filename, filename); language = asString(parsed.language, language);
          } catch {
            // Invalid tool payload is retained as a tool call, not an artifact.
          }
        }
        if (body || filename !== "artifact") {
          const artifactId = `${messageId}:artifact:${artifacts.length}`;
          const artifact: ArtifactRecord = { artifactId, name: filename.split("/").pop() || filename, language, mimeType: languageIsCode(language) ? "text/plain" : undefined, text: body, sourceMessageId: messageId, hasBody: !!body };
          artifacts.push(artifact);
          content.push({ type: "artifact", artifactId, name: artifact.name, mimeType: artifact.mimeType, text: body });
        }
      }
      continue;
    }
    if (type === "image" || type === "document" || type === "file" || part.file_name || part.file_id) {
      const attachment = sanitizeAttachment(part, messageId, attachments.length);
      attachments.push(attachment);
      content.push({ type: type === "image" ? "image" : "file", name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, sourceId: attachment.sourceId });
      continue;
    }
    const unknown = sanitizeProviderValue(part);
    content.push({ type: "unknown", sourceType: type || undefined, data: unknown });
  }
  if (!parts.length) {
    const block = textBlock(messageText(message).replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/gi, ""));
    if (block) content.push(block);
  }
  const legacy = extractLegacyArtifacts(messageText(message), messageId, artifacts.length);
  artifacts.push(...legacy);
  for (const artifact of legacy) content.push({ type: "artifact", artifactId: artifact.artifactId, name: artifact.name, mimeType: artifact.mimeType, text: artifact.text });
  for (const attachment of asArray<any>(message?.attachments)) {
    const normalized = sanitizeAttachment(attachment, messageId, attachments.length);
    if (!attachments.some((candidate) => candidate.attachmentId === normalized.attachmentId)) attachments.push(normalized);
  }
  return { content, tools, thoughts, artifacts, attachments };
}

function inferModel(raw: any): string | undefined {
  if (asOptionalString(raw?.model)) return asOptionalString(raw.model);
  const created = new Date(raw?.created_at || 0).getTime();
  if (created >= Date.parse("2026-02-17")) return "claude-sonnet-4-6";
  if (created >= Date.parse("2025-09-29")) return "claude-sonnet-4-5-20250929";
  if (created >= Date.parse("2025-05-22")) return "claude-sonnet-4-20250514";
  if (created >= Date.parse("2025-02-24")) return "claude-3-7-sonnet-20250219";
  if (created >= Date.parse("2024-10-22")) return "claude-3-5-sonnet-20241022";
  if (created >= Date.parse("2024-06-20")) return "claude-3-5-sonnet-20240620";
  return "claude-3-sonnet-20240229";
}

function canonicalizeClaude(rawInput: JsonValue, context: NormalizeContext): CanonicalConversationV1 {
  const raw = isRecord(rawInput) && isRecord((rawInput as any).conversation) ? (rawInput as any).conversation : (rawInput as any);
  const sourceId = context.sourceId || asString(raw?.uuid ?? raw?.id);
  const messages: ConversationMessage[] = [];
  const tools: ToolInvocation[] = [];
  const thoughts: VisibleThought[] = [];
  const artifacts: ArtifactRecord[] = [];
  const attachments: ReturnType<typeof sanitizeAttachment>[] = [];
  for (const [index, value] of asArray<any>(raw?.chat_messages ?? raw?.messages).entries()) {
    const id = asString(value?.uuid ?? value?.id, `message:${index}`);
    const normalized = extractClaudeContent(value, id);
    messages.push({
      id,
      role: normalizeRole(value?.sender ?? value?.role),
      parentId: asOptionalString(value?.parent_message_uuid ?? value?.parent_id),
      createdAt: toIso(value?.created_at), updatedAt: toIso(value?.updated_at),
      model: asOptionalString(value?.model), content: normalized.content,
      metadata: sanitizeProviderValue(isRecord(value?.metadata) ? value.metadata : {}) as Record<string, JsonValue>,
    });
    tools.push(...normalized.tools); thoughts.push(...normalized.thoughts); artifacts.push(...normalized.artifacts); attachments.push(...normalized.attachments);
  }
  const activeLeaf = asOptionalString(raw?.current_leaf_message_uuid ?? raw?.current_node);
  const branchInfo = deriveBranches(messages, activeLeaf);
  const model = inferModel(raw) || messages.map((message) => message.model).find(Boolean);
  const archived = raw?.archived === true || raw?.archived === "true" || raw?.is_archived === true || raw?.is_archived === "true";
  const projectId = asOptionalString(raw?.project_uuid ?? raw?.project_id);
  const project = projectId
    ? asArray<any>(context.scope.metadata?.projects).find((item) => isRecord(item) && item.id === projectId)
    : undefined;
  const canonical: CanonicalConversationV1 = {
    schemaVersion: 1,
    conversationKey: canonicalKey(context.scope, sourceId),
    provider: "claude",
    scope: context.scope,
    sourceId,
    title: asString(raw?.name ?? raw?.title, "Untitled Conversation") || "Untitled Conversation",
    createdAt: toIso(raw?.created_at), updatedAt: toIso(raw?.updated_at),
    messages, branches: branchInfo.branches, currentBranchId: branchInfo.currentBranchId,
    model, tools, visibleThoughts: thoughts, artifacts, attachments,
    sourceStatus: sourceStatus(archived), adapterVersion: context.adapterVersion,
    capturedAt: new Date().toISOString(), raw: sanitizeProviderValue(rawInput),
    metadata: {
      sourceUrl: `https://claude.ai/chat/${sourceId}`,
      ...(projectId ? { projectId } : {}),
      ...(project && asOptionalString(project.name) ? { projectName: asString(project.name) } : {}),
      ...(context.scope.organizationId ? { organizationId: context.scope.organizationId } : {}),
      license: CLAUDE_EXPORTER_LICENSE,
    },
  };
  return canonical;
}

function parseCursor(cursor?: string | null): number {
  if (!cursor) return 0;
  try { return Math.max(0, Number(JSON.parse(cursor).offset) || 0); } catch { return Math.max(0, Number(cursor) || 0); }
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly platform = "claude" as const;
  readonly adapterVersion = CLAUDE_ADAPTER_VERSION;
  private readonly fetcher: typeof fetch;
  private readonly document?: Document;
  private readonly location?: Location;
  private readonly lists = new Map<string, CachedList>();
  private readonly throttleMs: number;
  private readonly throttleJitterMs: number;
  private lastRequestAt = 0;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.fetcher = options.fetch || defaultFetch();
    this.document = options.document ?? (typeof document !== "undefined" ? document : undefined);
    this.location = options.location ?? (typeof window !== "undefined" ? window.location : undefined);
    this.throttleMs = Math.max(0, options.throttleMs ?? (options.fetch ? 0 : 350));
    this.throttleJitterMs = Math.max(0, options.throttleJitterMs ?? 200);
  }

  private async waitForThrottle(): Promise<void> {
    if (this.throttleMs <= 0) return;
    const wait = Math.max(0, this.lastRequestAt + this.throttleMs - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now() + Math.floor(Math.random() * (this.throttleJitterMs + 1));
  }

  private async request(path: string): Promise<JsonValue> {
    await this.waitForThrottle();
    const response = await this.fetcher(path, { credentials: "include", headers: { Accept: "application/json" } });
    return readJsonResponse(response, "Claude");
  }

  async detectScopes(): Promise<Scope[]> {
    const data = await this.request("/api/organizations");
    const organizations = organizationItems(data);
    const hasChatOrganization = organizations.some((organization) => capabilityNames(organization).some((item) => /chat|conversation/.test(item)));
    const scopes: Scope[] = [];
    const seenOrganizations = new Set<string>();
    for (const organization of organizations) {
      const id = asOptionalString(organization?.uuid ?? organization?.id ?? organization?.organization_id);
      if (!id) continue;
      if (seenOrganizations.has(id)) continue;
      seenOrganizations.add(id);
      const capabilities = capabilityNames(organization);
      // Claude returns API-only organizations alongside chat organizations;
      // only spaces advertising chat capability can contain conversations.
      if (hasChatOrganization && capabilities.length && !capabilities.some((item) => /chat|conversation/.test(item))) continue;
      const name = asString(organization?.name ?? organization?.display_name ?? organization?.title, `Organization ${id.slice(-8)}`);
      const kindText = asString(organization?.type ?? organization?.plan ?? "").toLowerCase();
      const kind: Scope["kind"] = /team/.test(kindText) ? "team" : /business/.test(kindText) ? "business" : "organization";
      const accountSeed = asString(organization?.account_id ?? organization?.user_id ?? organization?.owner_id ?? id);
      const scope: Scope = { scopeKey: makeScopeKey("claude", id), platform: "claude", accountIdHash: await accountHash(`claude:${accountSeed}`), organizationId: id, displayName: name, kind };
      try {
        const projects = await this.request(`/api/organizations/${encodeURIComponent(id)}/projects`);
        const metadata = projectMetadata(projects);
        if (metadata.length) scope.metadata = { projects: metadata };
      } catch {
        // Projects are optional and can be unavailable to personal accounts.
      }
      scopes.push(scope);
    }
    if (lastOrganizationId && !scopes.some((scope) => scope.organizationId === lastOrganizationId)) {
      scopes.push({ scopeKey: makeScopeKey("claude", lastOrganizationId), platform: "claude", accountIdHash: await accountHash(`claude:${lastOrganizationId}`), organizationId: lastOrganizationId, displayName: `Organization ${lastOrganizationId.slice(-8)}`, kind: "organization" });
    }
    return scopes;
  }

  async listConversations(scope: Scope, cursor?: string | null): Promise<ConversationPage> {
    if (!scope.organizationId) return { items: [], nextCursor: null, complete: true };
    const offset = parseCursor(cursor);
    let cached = this.lists.get(scope.scopeKey);
    if (!cached || Date.now() - cached.fetchedAt > 5 * 60 * 1000) {
      const data = await this.request(`/api/organizations/${encodeURIComponent(scope.organizationId)}/chat_conversations`);
      const record: any = isRecord(data) ? data : {};
      const items = asArray<any>(isRecord(data) ? record.items ?? record.data ?? record.conversations : data);
      cached = { summaries: items.map((item) => this.summary(scope, item)), fetchedAt: Date.now() };
      this.lists.set(scope.scopeKey, cached);
    }
    const items = cached.summaries.slice(offset, offset + PAGE_SIZE);
    const next = offset + items.length < cached.summaries.length ? JSON.stringify({ offset: offset + items.length }) : null;
    return { items, nextCursor: next, complete: !next };
  }

  private summary(scope: Scope, item: any): ConversationSummary {
    const sourceId = asString(item?.uuid ?? item?.id ?? item?.conversation_id);
    const archived = item?.archived === true || item?.archived === "true" || item?.is_archived === true || item?.is_archived === "true";
    return {
      sourceId, conversationKey: makeConversationKey("claude", scope.scopeKey, sourceId), scopeKey: scope.scopeKey,
      title: asString(item?.name ?? item?.title, "Untitled Conversation") || "Untitled Conversation",
      createdAt: toIso(item?.created_at), updatedAt: toIso(item?.updated_at), archived,
      projectId: asOptionalString(item?.project_uuid ?? item?.project_id), sourceStatus: sourceStatus(archived),
      metadata: { raw: sanitizeProviderValue(item) },
    };
  }

  async fetchConversation(scope: Scope, sourceId: string): Promise<CanonicalConversationV1> {
    if (!scope.organizationId) throw new Error("Claude organization is required");
    const path = `/api/organizations/${encodeURIComponent(scope.organizationId)}/chat_conversations/${encodeURIComponent(sourceId)}?tree=True&rendering_mode=messages&render_all_tools=true`;
    const raw = await this.request(path);
    return this.normalize(raw, { provider: "claude", scope, sourceId, adapterVersion: this.adapterVersion });
  }

  normalize(raw: JsonValue, context: NormalizeContext): CanonicalConversationV1 {
    return canonicalizeClaude(raw, context);
  }

  observeCurrentConversation(callback: (conversation: CanonicalConversationV1) => void): () => void {
    const target = this.document?.defaultView || (typeof window !== "undefined" ? window : undefined);
    if (!target || !this.document) return () => undefined;
    let disposed = false;
    let timer: number | undefined;
    let lastId: string | undefined;
    const schedule = (delay = 15_000) => {
      if (timer != null) target.clearTimeout(timer);
      timer = target.setTimeout(async () => {
        timer = undefined;
        if (disposed || this.document?.visibilityState === "hidden") return;
        if (this.document?.querySelector('[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="停止"]')) { schedule(5_000); return; }
        if (this.document?.querySelector('button[aria-label*="停止"], button[data-testid*="stop"]')) {
          schedule(5_000);
          return;
        }
        const id = currentClaudeId(this.location || target.location);
        if (!id) return;
        const scopes = await this.detectScopes().catch(() => []);
        const ordered = scopes.sort((a, b) => Number(b.organizationId === lastOrganizationId) - Number(a.organizationId === lastOrganizationId));
        for (const scope of ordered) {
          try {
            const conversation = await this.fetchConversation(scope, id);
            if (!disposed) { lastId = id; callback(conversation); }
            break;
          } catch {
            // Try the next accessible organization; do not expose body data.
          }
        }
      }, delay);
    };
    const observer = new MutationObserver(() => schedule(currentClaudeId(this.location || target.location) !== lastId ? 250 : 15_000));
    observer.observe(this.document.body || this.document.documentElement, { childList: true, subtree: true, characterData: true });
    const onRoute = () => schedule(250);
    target.addEventListener("popstate", onRoute); target.addEventListener("hashchange", onRoute);
    const onVisibility = () => schedule(target.document.visibilityState === "hidden" ? 1_000 : 250);
    target.document.addEventListener("visibilitychange", onVisibility);
    schedule(250);
    return () => { disposed = true; observer.disconnect(); if (timer != null) target.clearTimeout(timer); target.removeEventListener("popstate", onRoute); target.removeEventListener("hashchange", onRoute); target.document.removeEventListener("visibilitychange", onVisibility); };
  }

  async fetchCurrentConversation(): Promise<CanonicalConversationV1 | undefined> {
    const sourceId = currentClaudeId(this.location);
    if (!sourceId) return undefined;
    const scopes = await this.detectScopes();
    for (const scope of scopes.sort((a, b) => Number(b.organizationId === lastOrganizationId) - Number(a.organizationId === lastOrganizationId))) {
      try { return await this.fetchConversation(scope, sourceId); } catch { /* try next org */ }
    }
    return undefined;
  }

  static markdown(conversation: CanonicalConversationV1): string { return conversationToMarkdown(conversation); }
}

export { currentClaudeId, currentProjectId, canonicalizeClaude };
