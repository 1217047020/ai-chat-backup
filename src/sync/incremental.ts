import { backupDb, type BackupDatabase } from '../storage/db';
import { SyncQueue } from '../storage/queue';
import type { EnqueueConversationInput } from '../storage/types';
import { semanticHash } from './hash';
import { conversationIdentity } from './identity';
import type {
  ConversationSnapshotLike,
  EnqueueOptions,
} from './types';

export class IncrementalSync {
  static readonly MAX_PENDING_BYTES = 100 * 1024 * 1024;

  readonly queue: SyncQueue;

  constructor(private readonly db: BackupDatabase = backupDb) {
    this.queue = new SyncQueue(db);
  }

  async enqueue<TSnapshot extends ConversationSnapshotLike>(
    snapshot: TSnapshot,
    options: EnqueueOptions = {},
  ): Promise<{ result: 'enqueued' | 'unchanged'; hash: string; key: string }> {
    const identity = conversationIdentity(snapshot, options.identity);
    const hash = await semanticHash(snapshot);
    const input: EnqueueConversationInput<TSnapshot> = {
      conversationKey: identity.conversationKey,
      platform: identity.platform,
      scopeId: identity.scopeId,
      sourceConversationId: identity.sourceConversationId,
      title: identity.title,
      sourceUpdatedAt: identity.sourceUpdatedAt,
      sourceStatus: identity.sourceStatus,
      targetHash: hash,
      snapshot,
      priority: options.priority,
      seenAt: options.seenAt,
    };
    const result = await this.queue.enqueueLatest(input);
    return { result, hash, key: identity.conversationKey };
  }

  async pendingBytes(): Promise<number> {
    const jobs = await this.db.syncJobs.toArray();
    return jobs.reduce((total, job) => total + (job.snapshotBytes ?? 0), 0);
  }

  async isBackpressured(): Promise<boolean> {
    return (await this.pendingBytes()) >= IncrementalSync.MAX_PENDING_BYTES;
  }
}
