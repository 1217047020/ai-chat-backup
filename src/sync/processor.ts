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

export type ProcessOutcome = 'processed' | 'failed' | 'empty';

const WORKER_CONCURRENCY = 3;

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
  private cooldownUntil = 0;

  async processOne(): Promise<ProcessOutcome> {
    if (await this.state.isPaused()) return 'empty';
    const job = await this.queue.claimNext<CanonicalConversationV1>(this.workerId);
    if (!job) return 'empty';
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
      return 'processed';
    } catch (error) {
      const failure = driveFailure(error);
      if (failure.retryAfterMs) {
        this.cooldownUntil = Math.max(
          this.cooldownUntil,
          Date.now() + failure.retryAfterMs,
        );
      }
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
      return 'failed';
    } finally {
      clearInterval(heartbeat);
    }
  }

  async drain(
    maxJobs = this.options.maxJobs ?? 200,
    concurrency = WORKER_CONCURRENCY,
  ): Promise<number> {
    let completed = 0;
    let consecutiveFailures = 0;
    let started = 0;
    const worker = async () => {
      while (started < maxJobs && consecutiveFailures < 5) {
        if (await this.state.isPaused()) return;
        const wait = this.cooldownUntil - Date.now();
        if (wait > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(wait, 30_000)),
          );
        }
        if (started >= maxJobs || consecutiveFailures >= 5) return;
        started += 1;
        const outcome = await this.processOne();
        if (outcome === 'empty') return;
        if (outcome === 'failed') consecutiveFailures += 1;
        else {
          consecutiveFailures = 0;
          completed += 1;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, concurrency) }, () => worker()),
    );
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
