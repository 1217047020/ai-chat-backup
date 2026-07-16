/** Shared, serialisable domain types used by adapters, sync, and Drive. */

export type Platform = "chatgpt" | "claude";

export type ScopeKind =
  | "personal"
  | "team"
  | "business"
  | "organization"
  | "workspace"
  | "unknown";

export interface Scope {
  /** Stable, provider-local identifier. */
  scopeKey: string;
  platform: Platform;
  /** A one-way identifier used to separate accounts without storing emails. */
  accountIdHash: string;
  /** Provider workspace/team/organization identifier, when available. */
  workspaceId?: string;
  organizationId?: string;
  /** Human-readable name used only for Drive paths and the UI. */
  displayName: string;
  kind: ScopeKind;
  metadata?: Record<string, JsonValue>;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "developer"
  | "unknown";

export type ContentBlock =
  | { type: "text"; text: string; markdown?: string }
  | { type: "thinking"; text: string; visible: boolean }
  | {
      type: "tool_call";
      id?: string;
      name: string;
      arguments?: JsonValue;
      result?: JsonValue;
    }
  | { type: "artifact"; artifactId: string; name?: string; mimeType?: string; text?: string }
  | {
      type: "image" | "file";
      name?: string;
      mimeType?: string;
      sizeBytes?: number;
      sourceId?: string;
    }
  | { type: "unknown"; sourceType?: string; data: JsonValue };

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  /** Parent message id preserves the source tree and alternate branches. */
  parentId?: string;
  childIds?: string[];
  createdAt?: string;
  updatedAt?: string;
  model?: string;
  content: ContentBlock[];
  metadata?: Record<string, JsonValue>;
}

export interface ConversationBranch {
  id: string;
  rootMessageId?: string;
  messageIds: string[];
  title?: string;
  isActive?: boolean;
}

export interface ToolInvocation {
  id?: string;
  name: string;
  arguments?: JsonValue;
  result?: JsonValue;
  messageId?: string;
}

export interface VisibleThought {
  messageId?: string;
  text: string;
  createdAt?: string;
}

export interface ArtifactRecord {
  artifactId: string;
  name: string;
  mimeType?: string;
  language?: string;
  text?: string;
  sourceMessageId?: string;
  /** True when the artifact body was captured and will be written to Drive. */
  hasBody: boolean;
}

export interface AttachmentMetadata {
  attachmentId?: string;
  sourceId?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  messageId?: string;
}

export type SourceConversationStatus =
  | "active"
  | "archived"
  | "missing_on_source"
  | "unknown";

export interface CanonicalConversationV1 {
  schemaVersion: 1;
  conversationKey: string;
  provider: Platform;
  scope: Scope;
  sourceId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  messages: ConversationMessage[];
  branches: ConversationBranch[];
  currentBranchId?: string;
  model?: string;
  tools: ToolInvocation[];
  visibleThoughts: VisibleThought[];
  artifacts: ArtifactRecord[];
  attachments: AttachmentMetadata[];
  sourceStatus: SourceConversationStatus;
  adapterVersion: string;
  /** Capture time is informational and must not participate in content hashes. */
  capturedAt: string;
  /** Sanitised provider response, if retaining it is useful for diagnostics. */
  raw?: JsonValue;
  /** SHA-256 of the hash projection, populated by the sync layer. */
  semanticHash?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ConversationSummary {
  sourceId: string;
  conversationKey: string;
  scopeKey: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  projectId?: string;
  sourceStatus?: SourceConversationStatus;
  metadata?: Record<string, JsonValue>;
}

export interface ConversationPage {
  items: ConversationSummary[];
  nextCursor?: string | null;
  /** True when the provider reports that all pages have been consumed. */
  complete?: boolean;
}

export interface NormalizeContext {
  provider: Platform;
  scope: Scope;
  sourceId: string;
  adapterVersion: string;
}

export interface ProviderAdapter {
  readonly platform: Platform;
  readonly adapterVersion: string;
  detectScopes(): Promise<Scope[]>;
  listConversations(scope: Scope, cursor?: string | null): Promise<ConversationPage>;
  fetchConversation(scope: Scope, sourceId: string): Promise<CanonicalConversationV1>;
  normalize(raw: JsonValue, context: NormalizeContext): CanonicalConversationV1;
  observeCurrentConversation(
    callback: (conversation: CanonicalConversationV1) => void
  ): () => void;
}

export type SyncStatus =
  | "pending"
  | "in_progress"
  | "synced"
  | "paused"
  | "failed"
  | "missing_on_source";

export interface DriveFileIds {
  folderId?: string;
  conversationJsonId?: string;
  conversationMarkdownId?: string;
  attachmentsJsonId?: string;
  artifactsFolderId?: string;
  artifactFileIds?: Record<string, string>;
}

export interface ConversationIndex {
  id?: number;
  conversationKey: string;
  provider: Platform;
  scopeKey: string;
  sourceId: string;
  title: string;
  updatedAt?: string;
  contentHash?: string;
  targetHash?: string;
  driveFolderId?: string;
  driveFileIds?: DriveFileIds;
  status: SyncStatus;
  sourceStatus: SourceConversationStatus;
  lastSeenAt?: string;
  lastSyncedAt?: string;
  missingSince?: string;
  missingChecks?: number;
  adapterVersion?: string;
  metadata?: Record<string, JsonValue>;
}

export type SyncJobStatus = "queued" | "running" | "succeeded" | "retry" | "failed" | "cancelled";

export interface SyncJob {
  id: string;
  conversationKey: string;
  targetHash: string;
  /** Optional until the worker loads the pending snapshot from local storage. */
  payload?: CanonicalConversationV1;
  attempts: number;
  leaseUntil?: number;
  nextAttemptAt: number;
  status: SyncJobStatus;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  priority?: "realtime" | "incremental" | "full_scan";
}

export interface ScanCheckpoint {
  id: string;
  platform: Platform;
  scopeKey: string;
  cursor?: string | null;
  phase: "scopes" | "conversations" | "details" | "complete";
  startedAt: number;
  updatedAt: number;
  lastFullScanAt?: number;
}

export interface DriveConnectionState {
  connected: boolean;
  rootFolderId?: string;
  rootFolderName: string;
  accountHint?: string;
  lastConnectedAt?: number;
  lastError?: string;
}

export interface AppSettings {
  driveRootFolderName: string;
  autoSync: boolean;
  realtimeDebounceMs: number;
  incrementalScanHours: number;
  fullScanDays: number;
  consentVersion: number;
}

export interface SyncStatusSnapshot {
  drive: DriveConnectionState;
  queued: number;
  inProgress: number;
  failed: number;
  lastSuccessfulSyncAt?: number;
  paused: boolean;
  pausedReason?: string;
  consentGranted?: boolean;
  byPlatform: Record<Platform, { scopes: number; conversations: number }>;
}

export type RuntimeMessage =
  | { type: "content_ready"; platform: Platform; url: string }
  | {
      type: "conversation_captured";
      platform: Platform;
      conversation: CanonicalConversationV1;
      trigger?: "observer" | "scan" | "manual" | "realtime";
    }
  | {
      type: "start_collection";
      platform?: Platform;
      full: boolean;
      cursors?: Record<string, string | null | undefined>;
    }
  | {
      type: "collect_current";
      platform?: Platform;
    }
  | {
      type: "scan_progress";
      platform: Platform;
      scopeKey: string;
      kind: "full" | "incremental";
      cursor?: string | null;
    }
  | {
      type: "scan_complete";
      platform: Platform;
      scopeKey: string;
      kind: "full" | "incremental";
      seenConversationKeys: string[];
    }
  | { type: "get_status" }
  | { type: "connect_drive" }
  | { type: "start_initial_backup" }
  | { type: "pause_sync" }
  | { type: "resume_sync" }
  | { type: "sync_now"; conversationKey?: string }
  | { type: "retry_failed" };

export type RuntimeResponse =
  | { ok: true; status?: SyncStatusSnapshot }
  | { ok: false; error: string; retryable?: boolean };
