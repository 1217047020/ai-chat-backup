import type {
  CanonicalConversationV1,
  ConversationMessage,
  ConversationPage,
  ConversationSummary,
  ContentBlock,
  JsonValue,
  NormalizeContext,
  ProviderAdapter,
  Scope,
  ToolInvocation,
  VisibleThought,
  ArtifactRecord,
} from "../shared/types";
import { makeConversationKey, stableStringify } from "../shared/utils";
import {
  accountHash,
  asArray,
  asNumber,
  asOptionalString,
  asString,
  canonicalKey,
  deriveBranches,
  isRecord,
  makeProviderError,
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

const CHATGPT_ADAPTER_VERSION = "chatgpt-compat-2.4.7";
const PAGE_LIMIT = 100;
const workspaceIds = new Set<string>();
let lastWorkspaceId: string | undefined;
// Kept only in the MAIN-world module lifetime. It is never sent through the
// bridge, IndexedDB, Drive, or diagnostic logging.
let capturedAccessToken: string | undefined;
let capturedDeviceId: string | undefined;

export interface ChatGPTAdapterOptions {
  fetch?: typeof fetch;
  document?: Document;
  localStorage?: Storage;
  location?: Location;
  now?: () => number;
  /** Minimum inter-request delay; set to 0 only for deterministic tests. */
  throttleMs?: number;
  throttleJitterMs?: number;
}

interface ChatCursor {
  stage: "active" | "archived" | "projects";
  offset: number;
  projectIndex: number;
  projectCursor?: string;
}

interface ChatProject {
  id: string;
  title: string;
}

function defaultFetch(): typeof fetch {
  const candidate = (globalThis as any).fetch;
  if (typeof candidate !== "function") throw new Error("Fetch is unavailable in this page");
  return candidate.bind(globalThis);
}

function responseHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => { result[key.toLowerCase()] = value; });
    return result;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key.toLowerCase(), String(value)]));
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

/** Capture only workspace routing metadata; never capture Authorization values. */
export function installChatGPTWorkspaceCapture(target: Window = window): () => void {
  const marker = "__aiChatBackupChatGPTCapture";
  const existing = (target as any)[marker] as (() => void) | undefined;
  if (existing) return existing;

  const originalFetch = target.fetch;
  const Xhr = (target as any).XMLHttpRequest as typeof XMLHttpRequest | undefined;
  const originalOpen = Xhr?.prototype.open;
  const originalSetRequestHeader = Xhr?.prototype.setRequestHeader;
  const wrappedFetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      const headers = responseHeaders(init?.headers);
      const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
      const authorization = headers.authorization || request?.headers.get("Authorization") || "";
      if (/^Bearer\s+\S+/i.test(authorization)) {
        const token = authorization.replace(/^Bearer\s+/i, "");
        if (token && token.toLowerCase() !== "dummy") capturedAccessToken = token;
      }
      const account = headers["chatgpt-account-id"] || request?.headers.get("ChatGPT-Account-Id");
      if (account) {
        workspaceIds.add(account);
        lastWorkspaceId = account;
      }
      const device = headers["oai-device-id"] || request?.headers.get("oai-device-id");
      if (device) capturedDeviceId = device;
    } catch {
      // A capture hook must never interfere with the host application.
    }
    return originalFetch.call(target, input, init);
  } as typeof fetch;
  target.fetch = wrappedFetch;
  if (originalOpen && originalSetRequestHeader && Xhr) {
    const xhr = Xhr.prototype;
    xhr.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
      (this as any).__aiChatBackupUrl = String(url);
      return (originalOpen as any).call(this, method, url, ...rest);
    } as typeof xhr.open;
    xhr.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
      if (name.toLowerCase() === "authorization" && /^Bearer\s+\S+/i.test(value)) {
        const token = value.replace(/^Bearer\s+/i, "");
        if (token && token.toLowerCase() !== "dummy") capturedAccessToken = token;
      }
      if (name.toLowerCase() === "oai-device-id" && value) capturedDeviceId = value;
      if (name.toLowerCase() === "chatgpt-account-id" && value) {
        workspaceIds.add(value);
        lastWorkspaceId = value;
      }
      return (originalSetRequestHeader as any).call(this, name, value);
    } as typeof xhr.setRequestHeader;
  }
  const cleanup = () => {
    if (target.fetch === wrappedFetch) target.fetch = originalFetch;
    if (Xhr && originalOpen && Xhr.prototype.open !== originalOpen) Xhr.prototype.open = originalOpen;
    if (Xhr && originalSetRequestHeader && Xhr.prototype.setRequestHeader !== originalSetRequestHeader) Xhr.prototype.setRequestHeader = originalSetRequestHeader;
    capturedAccessToken = undefined;
    capturedDeviceId = undefined;
    delete (target as any)[marker];
  };
  (target as any)[marker] = cleanup;
  return cleanup;
}

function parseCursor(cursor?: string | null): ChatCursor {
  if (!cursor) return { stage: "active", offset: 0, projectIndex: 0 };
  try {
    const value = JSON.parse(cursor) as Partial<ChatCursor>;
    if (value.stage === "active" || value.stage === "archived" || value.stage === "projects") {
      return {
        stage: value.stage,
        offset: Math.max(0, Number(value.offset) || 0),
        projectIndex: Math.max(0, Number(value.projectIndex) || 0),
        projectCursor: typeof value.projectCursor === "string" ? value.projectCursor : undefined,
      };
    }
  } catch {
    const offset = Number(cursor);
    if (Number.isFinite(offset)) return { stage: "active", offset, projectIndex: 0 };
  }
  return { stage: "active", offset: 0, projectIndex: 0 };
}

function encodeCursor(value: ChatCursor): string {
  return JSON.stringify(value);
}

function titleOf(value: any): string {
  return asString(value?.title ?? value?.name ?? value?.display_name, "Untitled Conversation").trim() || "Untitled Conversation";
}

function projectList(value: unknown): ChatProject[] {
  const items = isRecord(value) ? asArray<any>(value.items ?? value.data ?? value.projects) : asArray<any>(value);
  return items
    .map((item) => {
      const gizmo = isRecord(item?.gizmo) ? item.gizmo : item;
      const display = isRecord(gizmo?.display) ? gizmo.display : gizmo;
      const id = asOptionalString(gizmo?.id ?? item?.id ?? item?.gizmo_id);
      const title = asOptionalString(display?.name ?? item?.name ?? item?.title);
      return id ? { id, title: title || id } : undefined;
    })
    .filter(Boolean) as ChatProject[];
}

function currentChatId(location: Location | undefined = typeof window !== "undefined" ? window.location : undefined): string | undefined {
  const path = location?.pathname || "";
  // ChatGPT uses /c/<id> for personal, team and project conversations.
  const match = path.match(/\/c\/([a-zA-Z0-9_-]+)/);
  return match?.[1];
}

function collectAccountHints(document?: Document, storage?: Storage): Array<{ id: string; name?: string; kind?: Scope["kind"] }> {
  const found = new Map<string, { id: string; name?: string; kind?: Scope["kind"] }>();
  const add = (id: unknown, name?: unknown, kind?: Scope["kind"]) => {
    const value = asOptionalString(id);
    if (!value || value.length < 6) return;
    const previous = found.get(value);
    found.set(value, { id: value, name: asOptionalString(name) || previous?.name, kind: kind || previous?.kind });
  };
  const visit = (value: unknown, depth = 0) => {
    if (depth > 5 || value == null) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    const account = isRecord(value.account) ? value.account : value;
    const id = account.id ?? account.account_id ?? account.workspace_id ?? account.workspaceId;
    if (id) {
      const kindText = asString(account.kind ?? account.type ?? account.account_type).toLowerCase();
      const kind: Scope["kind"] = /personal|individual|free|plus|pro/.test(kindText)
        ? "personal"
        : /team/.test(kindText)
          ? "team"
          : /business/.test(kindText)
            ? "business"
            : "workspace";
      add(id, account.name ?? account.display_name ?? account.title, kind);
    }
    for (const [key, child] of Object.entries(value)) {
      if (/account|workspace|team|organization/i.test(key)) visit(child, depth + 1);
    }
  };
  try {
    const next = document?.getElementById("__NEXT_DATA__")?.textContent;
    if (next) visit(JSON.parse(next));
  } catch {
    // Ignore malformed framework data.
  }
  try {
    for (let index = 0; index < (storage?.length || 0); index++) {
      const key = storage?.key(index);
      if (!key || !/account|workspace|team/i.test(key)) continue;
      const value = storage?.getItem(key);
      if (!value) continue;
      const matches = value.match(/(?:ws-)?[a-f0-9]{8}-[a-f0-9-]{27,}/gi) || [];
      for (const match of matches) add(match.replace(/^"|"$/g, ""));
      try { visit(JSON.parse(value)); } catch { /* plain text */ }
    }
  } catch {
    // Access to localStorage may be denied in a privacy sandbox.
  }
  for (const id of workspaceIds) add(id, undefined, "workspace");
  return [...found.values()];
}

function contentText(value: any): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) return asString(value.text ?? value.content ?? value.value);
  return "";
}

function normalizeChatContent(message: any, messageId: string): {
  content: ContentBlock[];
  tools: ToolInvocation[];
  thoughts: VisibleThought[];
  artifacts: ArtifactRecord[];
  attachments: ReturnType<typeof sanitizeAttachment>[];
} {
  const blocks: ContentBlock[] = [];
  const tools: ToolInvocation[] = [];
  const thoughts: VisibleThought[] = [];
  const artifacts: ArtifactRecord[] = [];
  const attachments: ReturnType<typeof sanitizeAttachment>[] = [];
  const rawContent = message?.content;
  const parts: any[] = isRecord(rawContent) && Array.isArray(rawContent.parts)
    ? rawContent.parts
    : Array.isArray(rawContent) ? rawContent : rawContent ? [rawContent] : [];

  const addText = (text: unknown) => {
    const block = textBlock(text);
    if (block) blocks.push(block);
  };
  for (const part of parts) {
    if (typeof part === "string") { addText(part); continue; }
    if (!isRecord(part)) continue;
    const type = asString(part.content_type ?? part.type).toLowerCase();
    if (/thought|reasoning/.test(type)) {
      const text = contentText(part);
      if (text) {
        blocks.push({ type: "thinking", text, visible: true });
        thoughts.push({ messageId, text, createdAt: toIso(message?.create_time) });
      }
      continue;
    }
    if (/^(code|canvas|artifact|code_block)$/.test(type)) {
      const body = contentText(part) || asString(part.code);
      const name = asString(part.filename ?? part.name ?? "artifact");
      if (body || name !== "artifact") {
        const artifactId = `${messageId}:artifact:${artifacts.length}`;
        const artifact: ArtifactRecord = {
          artifactId,
          name,
          language: asOptionalString(part.language),
          mimeType: asOptionalString(part.mime_type ?? part.mimeType),
          text: body,
          sourceMessageId: messageId,
          hasBody: !!body,
        };
        artifacts.push(artifact);
        blocks.push({ type: "artifact", artifactId, name, mimeType: artifact.mimeType, text: body });
      }
      continue;
    }
    if (/tool|execution|computer/.test(type) || part.recipient || part.tool_name || (part.name && !/image|file|attachment/.test(type))) {
      const name = asString(part.name ?? part.recipient ?? part.tool_name, type || "tool");
      const args = part.arguments ?? part.input ?? part.parameters;
      const result = part.output ?? part.result ?? part.execution_output;
      const call: ToolInvocation = { id: asOptionalString(part.id ?? part.call_id), name, arguments: sanitizeProviderValue(args), result: sanitizeProviderValue(result), messageId };
      tools.push(call);
      blocks.push({ type: "tool_call", id: call.id, name, arguments: call.arguments, result: call.result });
      if (/code|canvas|artifact|file/.test(type) && (contentText(part) || part.code)) {
        const body = contentText(part) || asString(part.code);
        const nameValue = asString(part.filename ?? part.name ?? "artifact");
        const artifactId = `${messageId}:artifact:${artifacts.length}`;
        artifacts.push({ artifactId, name: nameValue, language: asOptionalString(part.language), mimeType: asOptionalString(part.mime_type), text: body, sourceMessageId: messageId, hasBody: !!body });
        blocks.push({ type: "artifact", artifactId, name: nameValue, mimeType: asOptionalString(part.mime_type), text: body });
      }
      continue;
    }
    const asset = part.asset_pointer ?? part.assetPointer ?? part.file_id;
    if (asset || /image|file|attachment/.test(type)) {
      const attachment = sanitizeAttachment({ ...part, source_id: part.source_id ?? asset, id: part.id ?? (typeof asset === "string" ? asset : undefined) }, messageId, attachments.length);
      attachments.push(attachment);
      blocks.push({ type: /image/.test(type) ? "image" : "file", name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, sourceId: attachment.sourceId });
      continue;
    }
    addText(contentText(part));
  }
  if (!parts.length) addText(message?.text);

  for (const attachment of asArray<any>(message?.metadata?.attachments ?? message?.attachments)) {
    const normalized = sanitizeAttachment(attachment, messageId, attachments.length);
    if (!attachments.some((item) => item.attachmentId === normalized.attachmentId)) attachments.push(normalized);
  }
  return { content: blocks, tools, thoughts, artifacts, attachments };
}

function canonicalizeChat(rawInput: JsonValue, context: NormalizeContext): CanonicalConversationV1 {
  const raw = isRecord(rawInput) && isRecord((rawInput as any).conversation) ? (rawInput as any).conversation : (rawInput as any);
  const mapping = isRecord(raw?.mapping) ? raw.mapping : {};
  const messages: ConversationMessage[] = [];
  const tools: ToolInvocation[] = [];
  const thoughts: VisibleThought[] = [];
  const artifacts: ArtifactRecord[] = [];
  const attachments: ReturnType<typeof sanitizeAttachment>[] = [];
  const ids = new Set<string>();

  for (const [mappingId, nodeValue] of Object.entries(mapping)) {
    const node = isRecord(nodeValue) ? nodeValue : {};
    const message = isRecord(node.message) ? node.message : undefined;
    if (!message && !node.id) continue;
    const id = asString(message?.id ?? node.id ?? mappingId, mappingId);
    if (ids.has(id)) continue;
    ids.add(id);
    const normalized = normalizeChatContent(message || node, id);
    messages.push({
      id,
      role: normalizeRole(message?.author?.role ?? message?.role ?? node.role),
      parentId: asOptionalString(node.parent ?? message?.parent_message_id),
      createdAt: toIso(message?.create_time ?? node.create_time),
      updatedAt: toIso(message?.update_time ?? node.update_time),
      model: asOptionalString(message?.metadata?.model_slug ?? message?.metadata?.model ?? message?.model),
      content: normalized.content,
      metadata: sanitizeProviderValue(isRecord(message?.metadata) ? {
        model_slug: message.metadata.model_slug,
        finish_details: message.metadata.finish_details,
        status: message.metadata.status,
      } : {}) as Record<string, JsonValue>,
    });
    tools.push(...normalized.tools);
    thoughts.push(...normalized.thoughts);
    artifacts.push(...normalized.artifacts);
    attachments.push(...normalized.attachments);
  }
  // Some exports return a flat `messages` array instead of mapping.
  if (!messages.length) {
    for (const [index, value] of asArray<any>(raw?.messages).entries()) {
      const id = asString(value?.id, `message:${index}`);
      const normalized = normalizeChatContent(value, id);
      messages.push({ id, role: normalizeRole(value?.author?.role ?? value?.role), parentId: asOptionalString(value?.parent_id ?? value?.parent_message_uuid), createdAt: toIso(value?.created_at ?? value?.create_time), updatedAt: toIso(value?.updated_at ?? value?.update_time), model: asOptionalString(value?.model), content: normalized.content });
      tools.push(...normalized.tools); thoughts.push(...normalized.thoughts); artifacts.push(...normalized.artifacts); attachments.push(...normalized.attachments);
    }
  }

  const activeLeaf = asOptionalString(raw?.current_node ?? raw?.current_leaf_message_uuid);
  const branchInfo = deriveBranches(messages, activeLeaf);
  const models = [...new Set(
    messages.map((message) => message.model).filter((value): value is string => Boolean(value)),
  )];
  const sourceId = context.sourceId || asString(raw?.conversation_id ?? raw?.id);
  const model = asOptionalString(raw?.model ?? raw?.default_model_slug) || models[0];
  const status = sourceStatus(raw?.is_archived);
  const projectId = asOptionalString(raw?.gizmo_id ?? raw?.project_id);
  const project = projectId
    ? projectList(context.scope.metadata?.projects).find((item) => item.id === projectId)
    : undefined;
  const sanitizedRaw = sanitizeProviderValue(rawInput);
  const canonical: CanonicalConversationV1 = {
    schemaVersion: 1,
    conversationKey: canonicalKey(context.scope, sourceId),
    provider: "chatgpt",
    scope: context.scope,
    sourceId,
    title: titleOf(raw),
    createdAt: toIso(raw?.create_time ?? raw?.created_at),
    updatedAt: toIso(raw?.update_time ?? raw?.updated_at),
    messages,
    branches: branchInfo.branches,
    currentBranchId: branchInfo.currentBranchId,
    model,
    tools,
    visibleThoughts: thoughts,
    artifacts,
    attachments,
    sourceStatus: status,
    adapterVersion: context.adapterVersion,
    capturedAt: new Date().toISOString(),
    raw: sanitizedRaw,
    metadata: {
      sourceUrl: `https://chatgpt.com/c/${sourceId}`,
      ...(projectId ? { projectId } : {}),
      ...(project ? { projectName: project.title } : {}),
      models: models as unknown as JsonValue,
    },
  };
  return canonical;
}

export class ChatGPTAdapter implements ProviderAdapter {
  readonly platform = "chatgpt" as const;
  readonly adapterVersion = CHATGPT_ADAPTER_VERSION;
  private readonly fetcher: typeof fetch;
  private readonly document?: Document;
  private readonly storage?: Storage;
  private readonly location?: Location;
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly throttleJitterMs: number;
  private lastRequestAt = 0;
  private accessToken?: string;

  constructor(options: ChatGPTAdapterOptions = {}) {
    this.fetcher = options.fetch || defaultFetch();
    this.document = options.document ?? (typeof document !== "undefined" ? document : undefined);
    this.storage = options.localStorage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    this.location = options.location ?? (typeof window !== "undefined" ? window.location : undefined);
    this.now = options.now || (() => Date.now());
    this.throttleMs = Math.max(0, options.throttleMs ?? (options.fetch ? 0 : 350));
    this.throttleJitterMs = Math.max(0, options.throttleJitterMs ?? 200);
  }

  private async waitForThrottle(path: string): Promise<void> {
    if (path.startsWith("/api/auth/session") || this.throttleMs <= 0) return;
    const wait = Math.max(0, this.lastRequestAt + this.throttleMs - this.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = this.now() + Math.floor(Math.random() * (this.throttleJitterMs + 1));
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    if (capturedAccessToken) return capturedAccessToken;
    const response = await this.fetcher("/api/auth/session?unstable_client=true", { credentials: "include" });
    const session = await readJsonResponse(response, "ChatGPT");
    const sessionRecord: any = isRecord(session) ? session : {};
    const token = asOptionalString(sessionRecord.accessToken ?? sessionRecord.access_token ?? sessionRecord.session?.accessToken ?? sessionRecord.session?.access_token);
    if (!token) throw new Error("ChatGPT session is not authenticated");
    this.accessToken = token;
    return token;
  }

  private async headers(scope?: Scope): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const cookie = this.document?.cookie ?? (typeof document !== "undefined" ? document.cookie : "");
    const match = cookie.match(/(?:^|;\s*)oai-did=([^;]+)/);
    if (match?.[1]) {
      try { headers["oai-device-id"] = decodeURIComponent(match[1]); } catch { headers["oai-device-id"] = match[1]; }
    }
    if (!headers["oai-device-id"] && capturedDeviceId) headers["oai-device-id"] = capturedDeviceId;
    const workspaceId = scope?.workspaceId;
    if (workspaceId) headers["ChatGPT-Account-Id"] = workspaceId;
    return headers;
  }

  private async request(path: string, scope?: Scope): Promise<JsonValue> {
    // Session discovery is intentionally unauthenticated (cookie session) and
    // must not receive an Authorization header. It also avoids a duplicate
    // session request when detectScopes() is called for the first time.
    if (path.startsWith("/api/auth/session")) {
      const response = await this.fetcher(path, { credentials: "include", headers: { Accept: "application/json" } });
      const value = await readJsonResponse(response, "ChatGPT");
      const token = isRecord(value)
        ? asOptionalString((value as any).accessToken ?? (value as any).access_token ?? (value as any).session?.accessToken ?? (value as any).session?.access_token)
        : undefined;
      if (token) this.accessToken = token;
      return value;
    }
    await this.waitForThrottle(path);
    const response = await this.fetcher(path, { credentials: "include", headers: await this.headers(scope) });
    if (response.status === 401) {
      this.accessToken = undefined;
      capturedAccessToken = undefined;
      capturedDeviceId = undefined;
    }
    return readJsonResponse(response, "ChatGPT");
  }

  private async projects(scope?: Scope): Promise<ChatProject[]> {
    try {
      const value = await this.request("/backend-api/gizmos/snorlax/sidebar", scope);
      return projectList(value);
    } catch {
      return [];
    }
  }

  async detectScopes(): Promise<Scope[]> {
    let session: any = {};
    try { session = await this.request("/api/auth/session?unstable_client=true"); } catch { /* unauthenticated page */ }
    const accountSeed = asString(session?.user?.id ?? session?.user?.user_id ?? session?.id ?? "chatgpt-account");
    const hash = await accountHash(`chatgpt:${accountSeed}`);
    const hints = collectAccountHints(this.document, this.storage);
    const personalScope: Scope = {
      scopeKey: makeScopeKey("chatgpt", "personal"),
      platform: "chatgpt",
      accountIdHash: hash,
      displayName: "Personal",
      kind: "personal",
    };
    const scopes: Scope[] = [personalScope];
    // Projects are also exposed for personal accounts. Keep their metadata on
    // the personal scope so the project pagination stage is not skipped.
    try {
      const projects = await this.projects(personalScope);
      if (projects.length) personalScope.metadata = { projects: projects as unknown as JsonValue };
    } catch {
      // Project listing is optional; the normal conversation lists still work.
    }
    const seen = new Set<string>();
    for (const hint of hints) {
      if (hint.kind === "personal") continue;
      if (seen.has(hint.id)) continue;
      seen.add(hint.id);
      const scope: Scope = {
        scopeKey: makeScopeKey("chatgpt", hint.id), platform: "chatgpt", accountIdHash: hash,
        workspaceId: hint.id, displayName: hint.name || `Workspace ${hint.id.slice(-8)}`, kind: hint.kind || "workspace",
      };
      const projects = await this.projects(scope);
      if (projects.length) scope.metadata = { projects: projects as unknown as JsonValue };
      scopes.push(scope);
    }
    // A captured workspace may not be present in framework state yet.
    if (lastWorkspaceId && !seen.has(lastWorkspaceId)) {
      const scope: Scope = { scopeKey: makeScopeKey("chatgpt", lastWorkspaceId), platform: "chatgpt", accountIdHash: hash, workspaceId: lastWorkspaceId, displayName: `Workspace ${lastWorkspaceId.slice(-8)}`, kind: "workspace" };
      const projects = await this.projects(scope);
      if (projects.length) scope.metadata = { projects: projects as unknown as JsonValue };
      scopes.push(scope);
    }
    return scopes;
  }

  private projectsFromScope(scope: Scope): ChatProject[] {
    const value = scope.metadata?.projects;
    return projectList(value);
  }

  async listConversations(scope: Scope, cursor?: string | null): Promise<ConversationPage> {
    const state = parseCursor(cursor);
    if (state.stage === "active" || state.stage === "archived") {
      const params = new URLSearchParams({ offset: String(state.offset), limit: String(PAGE_LIMIT), order: "updated" });
      if (state.stage === "archived") params.set("is_archived", "true");
      const data = await this.request(`/backend-api/conversations?${params.toString()}`, scope);
      const record: any = isRecord(data) ? data : {};
      const items = asArray<any>(record.items ?? data).map((item) => this.summary(scope, item, state.stage === "archived"));
      if (items.length >= PAGE_LIMIT) {
        return { items, nextCursor: encodeCursor({ ...state, offset: state.offset + items.length }), complete: false };
      }
      const next: ChatCursor = state.stage === "active" ? { stage: "archived", offset: 0, projectIndex: 0 } : { stage: "projects", offset: 0, projectIndex: 0 };
      return { items, nextCursor: encodeCursor(next), complete: false };
    }

    let projects = this.projectsFromScope(scope);
    if (!projects.length && state.projectIndex === 0) projects = await this.projects(scope);
    if (state.projectIndex >= projects.length) return { items: [], nextCursor: null, complete: true };
    const project = projects[state.projectIndex];
    const query = state.projectCursor ? `?cursor=${encodeURIComponent(state.projectCursor)}` : "?cursor=0";
    const data = await this.request(`/backend-api/gizmos/${encodeURIComponent(project.id)}/conversations${query}`, scope);
    const record: any = isRecord(data) ? data : {};
    const items = asArray<any>(record.items ?? data).map((item) => this.summary(scope, item, !!item?.is_archived, project.id));
    const nextProjectCursor = asOptionalString(record.cursor ?? record.next_cursor);
    if (nextProjectCursor && nextProjectCursor !== state.projectCursor) {
      return { items, nextCursor: encodeCursor({ ...state, projectCursor: nextProjectCursor }), complete: false };
    }
    return { items, nextCursor: encodeCursor({ stage: "projects", offset: 0, projectIndex: state.projectIndex + 1 }), complete: false };
  }

  private summary(scope: Scope, item: any, archived = false, projectId?: string): ConversationSummary {
    const sourceId = asString(item?.id ?? item?.conversation_id ?? item?.uuid);
    const archivedValue = archived || item?.is_archived === true || item?.is_archived === "true";
    return {
      sourceId,
      conversationKey: makeConversationKey("chatgpt", scope.scopeKey, sourceId),
      scopeKey: scope.scopeKey,
      title: titleOf(item),
      createdAt: toIso(item?.create_time ?? item?.created_at),
      updatedAt: toIso(item?.update_time ?? item?.updated_at),
      archived: archivedValue,
      projectId: projectId || asOptionalString(item?.gizmo_id ?? item?.project_id),
      sourceStatus: sourceStatus(archivedValue),
      metadata: { raw: sanitizeProviderValue(item) },
    };
  }

  async fetchConversation(scope: Scope, sourceId: string): Promise<CanonicalConversationV1> {
    const raw = await this.request(`/backend-api/conversation/${encodeURIComponent(sourceId)}`, scope);
    return this.normalize(raw, { provider: "chatgpt", scope, sourceId, adapterVersion: this.adapterVersion });
  }

  normalize(raw: JsonValue, context: NormalizeContext): CanonicalConversationV1 {
    return canonicalizeChat(raw, context);
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
        if (this.document?.querySelector('[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="停止"]')) {
          schedule(5_000);
          return;
        }
        // Chinese-localized stop buttons should be treated the same as the
        // English selector while a response is still being generated.
        if (this.document?.querySelector('button[aria-label*="停止"], button[data-testid*="stop"]')) {
          schedule(5_000);
          return;
        }
        const id = currentChatId(this.location || target.location);
        if (!id) return;
        try {
          const scopes = await this.detectScopes();
          const ordered = scopes.sort((a, b) => Number(b.workspaceId === lastWorkspaceId) - Number(a.workspaceId === lastWorkspaceId));
          for (const selected of ordered) {
            try {
              const conversation = await this.fetchConversation(selected, id);
              if (!disposed) { lastId = id; callback(conversation); }
              break;
            } catch {
              // A stale workspace header can survive an SPA account switch;
              // try the remaining accessible scopes before giving up.
            }
          }
        } catch {
          // Background retry policy owns errors; do not leak response bodies to logs.
        }
      }, delay);
    };
    const observer = new MutationObserver(() => {
      const id = currentChatId(this.location || target.location);
      if (id !== lastId) schedule(250);
      else schedule(15_000);
    });
    observer.observe(this.document.body || this.document.documentElement, { childList: true, subtree: true, characterData: true });
    const onPop = () => schedule(250);
    target.addEventListener("popstate", onPop);
    target.addEventListener("hashchange", onPop);
    const onVisibility = () => { schedule(target.document.visibilityState === "hidden" ? 1_000 : 250); };
    target.document.addEventListener("visibilitychange", onVisibility);
    schedule(250);
    return () => {
      disposed = true;
      observer.disconnect();
      if (timer != null) target.clearTimeout(timer);
      target.removeEventListener("popstate", onPop);
      target.removeEventListener("hashchange", onPop);
      target.document.removeEventListener("visibilitychange", onVisibility);
    };
  }

  /** Useful for popup/bridge callers that want the currently open conversation. */
  async fetchCurrentConversation(): Promise<CanonicalConversationV1 | undefined> {
    const sourceId = currentChatId(this.location);
    if (!sourceId) return undefined;
    const scopes = await this.detectScopes();
    const ordered = scopes.sort((a, b) => Number(b.workspaceId === lastWorkspaceId) - Number(a.workspaceId === lastWorkspaceId));
    for (const scope of ordered) {
      try { return await this.fetchConversation(scope, sourceId); } catch { /* try next scope */ }
    }
    return undefined;
  }

  static markdown(conversation: CanonicalConversationV1): string {
    return conversationToMarkdown(conversation);
  }
}

export { currentChatId, canonicalizeChat };
