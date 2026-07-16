import { DriveBackupStore } from '../drive/store';
import { driveFailure } from '../drive/errors';
import { SyncQueue } from '../storage/queue';
import { backupDb, type BackupDatabase } from '../storage/db';
import { BackupStateStore } from '../storage/state';
import type { CanonicalConversationV1 } from '../shared/types';

export interface SyncProcessorOptions {
  workerId?: string;
  maxJobs?: number;
  onProgress?: (event: {
    kind: 'started' | 'succeeded' | 'failed';
    conversationKey: string;
    error?: unknown;
    retryable?: boolean;
  }) => void;
}

/**
 * Durable queue consumer. The queue owns the snapshot body and the processor
 * owns only the short-lived Drive client; a service-worker restart therefore
 * cannot lose a captured conversation.
 */
export class SyncProcessor {
  readonly queue: SyncQueue;
  readonly workerId: string;
  readonly state: BackupStateStore;

  constructor(
    private readonly drive: DriveBackupStore,
    private readonly db: BackupDatabase = backupDb,
    options: SyncProcessorOptions = {},
  ) {
    this.queue = new SyncQueue(db);
    this.state = new BackupStateStore(db);
    this.workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
    this.options = options;
  }

  private readonly options: SyncProcessorOptions;

  async processOne(): Promise<boolean> {
    if (await this.state.isPaused()) return false;
    const job = await this.queue.claimNext<CanonicalConversationV1>(this.workerId);
    if (!job) return false;
    this.options.onProgress?.({ kind: 'started', conversationKey: job.conversationKey });
    const heartbeat = setInterval(() => {
      void this.queue.renewLease(job.id, this.workerId);
    }, 30_000);
    try {
      if (!job.snapshot) throw new Error('Sync job has no captured snapshot.');
      const index = await this.db.conversationIndexes.get(job.conversationKey);
      const result = await this.drive.backupConversation({
        conversation: job.snapshot,
        contentHash: job.targetHash,
        existing: index?.drive,
        hooks: {
          resume: job.upload,
          onResumeState: (upload) => this.queue.saveUploadState(job.id, this.workerId, upload),
        },
      });
      await this.queue.complete(job.id, this.workerId, result.mapping);
      this.options.onProgress?.({ kind: 'succeeded', conversationKey: job.conversationKey });
      return true;
    } catch (error) {
      const failure = driveFailure(error);
      await this.queue.fail(job.id, this.workerId, failure);
      if (failure.blockReason) {
        await this.state.setPaused(true, failure.blockReason);
      }
      this.options.onProgress?.({
        kind: 'failed',
        conversationKey: job.conversationKey,
        error,
        retryable: failure.retryable,
      });
      return false;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async drain(maxJobs = this.options.maxJobs ?? 10): Promise<number> {
    let completed = 0;
    for (let i = 0; i < maxJobs; i += 1) {
      const processed = await this.processOne();
      if (!processed) break;
      completed += 1;
    }
    return completed;
  }
}

export function createSyncProcessor(
  drive: DriveBackupStore,
  db: BackupDatabase = backupDb,
  options?: SyncProcessorOptions,
): SyncProcessor {
  return new SyncProcessor(drive, db, options);
}
