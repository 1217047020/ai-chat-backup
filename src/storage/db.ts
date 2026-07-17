import Dexie, { type EntityTable } from 'dexie';

import type {
  ConversationIndexRecord,
  KeyValueRecord,
  ScanCheckpointRecord,
  SyncJobBodyRecord,
  SyncJobRecord,
} from './types';

export class BackupDatabase extends Dexie {
  conversationIndexes!: EntityTable<ConversationIndexRecord, 'conversationKey'>;
  syncJobs!: EntityTable<SyncJobRecord, 'id'>;
  syncJobBodies!: EntityTable<SyncJobBodyRecord, 'id'>;
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

    this.version(2)
      .stores({
        conversationIndexes:
          '&conversationKey, [platform+scopeId], platform, sourceConversationId, syncStatus, lastSeenAt, lastSyncedAt',
        syncJobs:
          '&id, &conversationKey, status, nextAttemptAt, leaseUntil, [status+nextAttemptAt], priority, updatedAt',
        syncJobBodies: '&id',
        scanCheckpoints: '&id, [platform+scopeId], kind, updatedAt, completedAt',
        keyValues: '&key, updatedAt',
      })
      .upgrade(async (transaction) => {
        const jobs = await transaction.table('syncJobs').toArray();
        for (const job of jobs) {
          if (job.snapshot === undefined) continue;
          const snapshotBytes = new TextEncoder().encode(
            JSON.stringify(job.snapshot),
          ).byteLength;
          await transaction.table('syncJobBodies').put({
            id: job.id,
            snapshot: job.snapshot,
          });
          delete job.snapshot;
          job.snapshotBytes = snapshotBytes;
          await transaction.table('syncJobs').put(job);
        }
      });
  }
}

export const backupDb = new BackupDatabase();
