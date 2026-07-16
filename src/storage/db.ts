import Dexie, { type EntityTable } from 'dexie';

import type {
  ConversationIndexRecord,
  KeyValueRecord,
  ScanCheckpointRecord,
  SyncJobRecord,
} from './types';

export class BackupDatabase extends Dexie {
  conversationIndexes!: EntityTable<ConversationIndexRecord, 'conversationKey'>;
  syncJobs!: EntityTable<SyncJobRecord, 'id'>;
  scanCheckpoints!: EntityTable<ScanCheckpointRecord, 'id'>;
  keyValues!: EntityTable<KeyValueRecord, 'key'>;

  constructor(name = 'ai-chat-backup') {
    super(name);

    this.version(1).stores({
      conversationIndexes:
        '&conversationKey, [platform+scopeId], sourceConversationId, syncStatus, lastSeenAt, lastSyncedAt',
      syncJobs:
        '&id, &conversationKey, status, nextAttemptAt, leaseUntil, [status+nextAttemptAt], priority, updatedAt',
      scanCheckpoints: '&id, [platform+scopeId], kind, updatedAt, completedAt',
      keyValues: '&key, updatedAt',
    });
  }
}

export const backupDb = new BackupDatabase();
