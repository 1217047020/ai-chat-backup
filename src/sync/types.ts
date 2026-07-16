import type { Scope } from '../shared/types';

export interface SnapshotScopeLike {
  id?: string;
  scopeId?: string;
  workspaceId?: string;
  organizationId?: string;
  accountHash?: string;
  displayName?: string;
  name?: string;
  [key: string]: unknown;
}

/** Structural input accepted from either provider adapter. */
export interface ConversationSnapshotLike {
  conversationKey?: string;
  platform?: string;
  provider?: string;
  id?: string;
  conversationId?: string;
  sourceConversationId?: string;
  sourceId?: string;
  scopeId?: string;
  scope?: SnapshotScopeLike | Scope;
  title?: string;
  name?: string;
  updatedAt?: string;
  sourceUpdatedAt?: string;
  sourceStatus?: string;
  status?: string;
  contentHash?: string;
  semanticHash?: string;
}

export interface ConversationIdentity {
  conversationKey: string;
  platform: string;
  scopeId: string;
  scopeName: string;
  sourceConversationId: string;
  title: string;
  sourceUpdatedAt?: string;
  sourceStatus?: string;
}

export interface EnqueueOptions {
  identity?: Partial<ConversationIdentity>;
  priority?: number;
  seenAt?: number;
}
