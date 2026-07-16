import type {
  ConversationIdentity,
  ConversationSnapshotLike,
} from './types';

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

export function conversationIdentity(
  snapshot: ConversationSnapshotLike,
  override: Partial<ConversationIdentity> = {},
): ConversationIdentity {
  const scope = snapshot.scope ?? {};
  const scopeRecord = scope as Record<string, unknown>;
  const platform = (
    override.platform ?? firstString(snapshot.platform, snapshot.provider)
  )?.toLowerCase();
  const scopeId =
    override.scopeId ??
    firstString(
      snapshot.scopeId,
      scopeRecord.id,
      scopeRecord.scopeKey,
      scopeRecord.scopeId,
      scopeRecord.workspaceId,
      scopeRecord.organizationId,
      scopeRecord.accountHash,
      scopeRecord.accountIdHash,
    );
  const sourceConversationId =
    override.sourceConversationId ??
    firstString(
      snapshot.sourceConversationId,
      snapshot.sourceId,
      snapshot.conversationId,
      snapshot.id,
    );

  if (!platform) throw new Error('Conversation snapshot is missing a platform.');
  if (!scopeId) throw new Error('Conversation snapshot is missing a scope ID.');
  if (!sourceConversationId) {
    throw new Error('Conversation snapshot is missing a source conversation ID.');
  }

  const title =
    override.title ?? firstString(snapshot.title, snapshot.name) ?? 'Untitled';
  const scopeName =
    override.scopeName ??
    firstString(scopeRecord.displayName, scopeRecord.name) ??
    'Personal';
  const conversationKey =
    override.conversationKey ??
    firstString(snapshot.conversationKey) ??
    `${platform}:${scopeId}:${sourceConversationId}`;

  return {
    conversationKey,
    platform,
    scopeId,
    scopeName,
    sourceConversationId,
    title,
    sourceUpdatedAt:
      override.sourceUpdatedAt ??
      firstString(snapshot.sourceUpdatedAt, snapshot.updatedAt),
    sourceStatus:
      override.sourceStatus ?? firstString(snapshot.sourceStatus, snapshot.status),
  };
}
