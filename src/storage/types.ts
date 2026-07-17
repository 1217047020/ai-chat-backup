export type SyncJobStatus = 'pending' | 'running' | 'blocked';

export type SyncStatus =
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'error'
  | 'missing_on_source';

export interface DriveFileMapping {
  rootFolderId?: string;
  providerFolderId?: string;
  scopeFolderId?: string;
  conversationFolderId?: string;
  conversationFolderName?: string;
  jsonFileId?: string;
  markdownFileId?: string;
  attachmentsFileId?: string;
  artifactsFolderId?: string;
  artifactFileIds?: Record<string, string>;
  /** Last Drive checksum, used to preserve a user's manual edits before overwrite. */
  fileChecksums?: Record<string, string>;
}

/**
 * Long-lived state. Conversation bodies intentionally do not live here: after a
 * successful upload we retain only the hash, source metadata and Drive IDs.
 */
export interface ConversationIndexRecord {
  conversationKey: string;
  platform: string;
  scopeId: string;
  sourceConversationId: string;
  title: string;
  contentHash?: string;
  sourceUpdatedAt?: string;
  lastSeenAt: number;
  lastSyncedAt?: number;
  missingCount: number;
  firstMissingAt?: number;
  sourceStatus?: string;
  syncStatus: SyncStatus;
  lastError?: string;
  drive: DriveFileMapping;
}

export interface ResumableUploadState {
  fileKey: string;
  sessionUrl: string;
  mimeType: string;
  totalBytes: number;
  nextByte: number;
  updatedAt: number;
}

/**
 * A job owns the latest normalized snapshot for exactly one conversation.
 * Enqueueing a newer hash replaces the pending body instead of growing a log.
 */
export interface SyncJobRecord<TSnapshot = unknown> {
  id: string;
  conversationKey: string;
  platform: string;
  scopeId: string;
  sourceConversationId: string;
  targetHash: string;
  /** Attached only while a claimed job is in memory; persisted in syncJobBodies. */
  snapshot?: TSnapshot;
  snapshotBytes?: number;
  status: SyncJobStatus;
  priority: number;
  attempts: number;
  nextAttemptAt: number;
  leaseOwner?: string;
  leaseUntil?: number;
  upload?: ResumableUploadState;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface SyncJobBodyRecord<TSnapshot = unknown> {
  id: string;
  snapshot: TSnapshot;
}

export type ScanKind = 'incremental' | 'full';

export interface ScanCheckpointRecord {
  id: string;
  platform: string;
  scopeId: string;
  kind: ScanKind;
  cursor?: string;
  watermark?: string;
  /** Conversation keys seen so far in a full pass; survives worker restarts. */
  seenConversationKeys?: string[];
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface KeyValueRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: number;
}

export interface EnqueueConversationInput<TSnapshot = unknown> {
  conversationKey: string;
  platform: string;
  scopeId: string;
  sourceConversationId: string;
  title: string;
  sourceUpdatedAt?: string;
  sourceStatus?: string;
  targetHash: string;
  snapshot: TSnapshot;
  priority?: number;
  seenAt?: number;
}

export interface SyncFailure {
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  blockReason?: string;
}
