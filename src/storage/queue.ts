import type { BackupDatabase } from './db';
import { backupDb } from './db';
import type {
  DriveFileMapping,
  EnqueueConversationInput,
  ResumableUploadState,
  SyncFailure,
  SyncJobRecord,
} from './types';

const DEFAULT_LEASE_MS = 2 * 60_000;
const DEFAULT_BASE_RETRY_MS = 5_000;
const DEFAULT_MAX_RETRY_MS = 6 * 60 * 60_000;

function jobId(conversationKey: string): string {
  return conversationKey;
}

function boundedRetryDelay(attempt: number): number {
  const exponential = Math.min(
    DEFAULT_MAX_RETRY_MS,
    DEFAULT_BASE_RETRY_MS * 2 ** Math.min(attempt, 12),
  );
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

export class SyncQueue {
  constructor(private readonly db: BackupDatabase = backupDb) {}

  /**
   * Upserts a single latest job per conversation. If the exact hash is already
   * synced or queued, no duplicate body is persisted.
   */
  async enqueueLatest<TSnapshot>(
    input: EnqueueConversationInput<TSnapshot>,
  ): Promise<'enqueued' | 'unchanged'> {
    const now = input.seenAt ?? Date.now();
    return this.db.transaction(
      'rw',
      this.db.conversationIndexes,
      this.db.syncJobs,
      async () => {
        const currentIndex = await this.db.conversationIndexes.get(
          input.conversationKey,
        );
        const currentJob = await this.db.syncJobs.get(jobId(input.conversationKey));

        await this.db.conversationIndexes.put({
          conversationKey: input.conversationKey,
          platform: input.platform,
          scopeId: input.scopeId,
          sourceConversationId: input.sourceConversationId,
          title: input.title,
          contentHash: currentIndex?.contentHash,
          sourceUpdatedAt: input.sourceUpdatedAt,
          sourceStatus: input.sourceStatus,
          lastSeenAt: now,
          lastSyncedAt: currentIndex?.lastSyncedAt,
          missingCount: 0,
          syncStatus:
            currentIndex?.contentHash === input.targetHash ? 'synced' : 'pending',
          drive: currentIndex?.drive ?? {},
          lastError: undefined,
        });

        if (
          currentIndex?.contentHash === input.targetHash ||
          currentJob?.targetHash === input.targetHash
        ) {
          return 'unchanged';
        }

        const job: SyncJobRecord<TSnapshot> = {
          id: jobId(input.conversationKey),
          conversationKey: input.conversationKey,
          platform: input.platform,
          scopeId: input.scopeId,
          sourceConversationId: input.sourceConversationId,
          targetHash: input.targetHash,
          snapshot: input.snapshot,
          status: 'pending',
          priority: input.priority ?? 0,
          attempts: 0,
          nextAttemptAt: now,
          createdAt: currentJob?.createdAt ?? now,
          updatedAt: now,
        };
        await this.db.syncJobs.put(job as SyncJobRecord);
        return 'enqueued';
      },
    );
  }

  /** Atomically claims a due job and recovers work whose worker lease expired. */
  async claimNext<TSnapshot = unknown>(
    workerId: string,
    options: { now?: number; leaseMs?: number } = {},
  ): Promise<SyncJobRecord<TSnapshot> | undefined> {
    const now = options.now ?? Date.now();
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

    return this.db.transaction('rw', this.db.syncJobs, async () => {
      const candidates = await this.db.syncJobs
        .where('nextAttemptAt')
        .belowOrEqual(now)
        .filter(
          (job) =>
            job.status === 'pending' ||
            (job.status === 'running' && (job.leaseUntil ?? 0) <= now),
        )
        .toArray();

      candidates.sort(
        (a, b) =>
          b.priority - a.priority ||
          a.nextAttemptAt - b.nextAttemptAt ||
          a.createdAt - b.createdAt,
      );
      const selected = candidates[0];
      if (!selected) return undefined;

      const claimed: SyncJobRecord = {
        ...selected,
        status: 'running',
        leaseOwner: workerId,
        leaseUntil: now + leaseMs,
        updatedAt: now,
      };
      await this.db.syncJobs.put(claimed);
      return claimed as SyncJobRecord<TSnapshot>;
    });
  }

  async renewLease(
    jobIdToRenew: string,
    workerId: string,
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<boolean> {
    return this.db.transaction('rw', this.db.syncJobs, async () => {
      const job = await this.db.syncJobs.get(jobIdToRenew);
      if (!job || job.status !== 'running' || job.leaseOwner !== workerId) {
        return false;
      }
      const now = Date.now();
      await this.db.syncJobs.update(job.id, {
        leaseUntil: now + leaseMs,
        updatedAt: now,
      });
      return true;
    });
  }

  async saveUploadState(
    jobIdToUpdate: string,
    workerId: string,
    upload?: ResumableUploadState,
  ): Promise<void> {
    await this.db.transaction('rw', this.db.syncJobs, async () => {
      const job = await this.db.syncJobs.get(jobIdToUpdate);
      if (!job || job.status !== 'running' || job.leaseOwner !== workerId) {
        throw new Error('The sync job lease is no longer owned by this worker.');
      }
      await this.db.syncJobs.update(job.id, { upload, updatedAt: Date.now() });
    });
  }

  /**
   * Commits Drive IDs and the synchronized content hash, then deletes the job
   * body in the same transaction.
   */
  async complete(
    jobIdToComplete: string,
    workerId: string,
    drive: DriveFileMapping,
  ): Promise<void> {
    await this.db.transaction(
      'rw',
      this.db.syncJobs,
      this.db.conversationIndexes,
      async () => {
        const job = await this.db.syncJobs.get(jobIdToComplete);
        if (!job || job.status !== 'running' || job.leaseOwner !== workerId) {
          throw new Error('The sync job lease is no longer owned by this worker.');
        }

        const index = await this.db.conversationIndexes.get(job.conversationKey);
        if (!index) throw new Error('Conversation index disappeared during upload.');

        await this.db.conversationIndexes.put({
          ...index,
          contentHash: job.targetHash,
          lastSyncedAt: Date.now(),
          syncStatus: 'synced',
          lastError: undefined,
          drive,
        });
        await this.db.syncJobs.delete(job.id);
      },
    );
  }

  async fail(
    jobIdToFail: string,
    workerId: string,
    failure: SyncFailure,
  ): Promise<void> {
    const now = Date.now();
    await this.db.transaction(
      'rw',
      this.db.syncJobs,
      this.db.conversationIndexes,
      async () => {
        const job = await this.db.syncJobs.get(jobIdToFail);
        if (!job || job.leaseOwner !== workerId) return;

        const attempts = job.attempts + 1;
        await this.db.syncJobs.put({
          ...job,
          status: failure.retryable ? 'pending' : 'blocked',
          attempts,
          nextAttemptAt:
            now + (failure.retryAfterMs ?? boundedRetryDelay(attempts)),
          leaseOwner: undefined,
          leaseUntil: undefined,
          updatedAt: now,
          lastError: failure.message,
        });
        await this.db.conversationIndexes.update(job.conversationKey, {
          syncStatus: 'error',
          lastError: failure.message,
        });
      },
    );
  }

  async retryBlocked(conversationKey?: string): Promise<number> {
    const now = Date.now();
    return this.db.transaction('rw', this.db.syncJobs, async () => {
      const jobs = conversationKey
        ? [await this.db.syncJobs.get(jobId(conversationKey))].filter(
            (job): job is SyncJobRecord => Boolean(job),
          )
        : await this.db.syncJobs.where('status').equals('blocked').toArray();
      let changed = 0;
      for (const job of jobs) {
        if (job.status !== 'blocked') continue;
        await this.db.syncJobs.update(job.id, {
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now,
          updatedAt: now,
          lastError: undefined,
        });
        changed += 1;
      }
      return changed;
    });
  }

  async makeDue(conversationKey: string, priority = 100): Promise<boolean> {
    const job = await this.db.syncJobs.get(jobId(conversationKey));
    if (!job) return false;
    await this.db.syncJobs.update(job.id, {
      nextAttemptAt: Date.now(),
      priority,
      status: job.status === 'blocked' ? 'pending' : job.status,
      updatedAt: Date.now(),
      lastError: undefined,
    });
    return true;
  }

  async counts(): Promise<{ pending: number; running: number; blocked: number }> {
    const [pending, running, blocked] = await Promise.all([
      this.db.syncJobs.where('status').equals('pending').count(),
      this.db.syncJobs.where('status').equals('running').count(),
      this.db.syncJobs.where('status').equals('blocked').count(),
    ]);
    return { pending, running, blocked };
  }

  async listIndexes(platform?: string) {
    if (!platform) return this.db.conversationIndexes.toArray();
    return this.db.conversationIndexes
      .filter((record) => record.platform === platform)
      .toArray();
  }

  /**
   * Called after a complete source scan. A missing conversation needs two scans
   * at least 24 hours apart before it is marked missing_on_source.
   */
  async recordFullScanPresence(
    platform: string,
    scopeId: string,
    seenConversationKeys: ReadonlySet<string>,
    now = Date.now(),
  ): Promise<void> {
    const minimumGap = 24 * 60 * 60_000;
    await this.db.transaction('rw', this.db.conversationIndexes, async () => {
      const records = await this.db.conversationIndexes
        .where('[platform+scopeId]')
        .equals([platform, scopeId])
        .toArray();

      for (const record of records) {
        if (seenConversationKeys.has(record.conversationKey)) {
          await this.db.conversationIndexes.update(record.conversationKey, {
            missingCount: 0,
            firstMissingAt: undefined,
            lastSeenAt: now,
          });
          continue;
        }

        const firstMissingAt = record.firstMissingAt ?? now;
        const separatedByOneDay = now - firstMissingAt >= minimumGap;
        const missingCount = separatedByOneDay
          ? Math.max(record.missingCount + 1, 2)
          : Math.max(record.missingCount, 1);
        await this.db.conversationIndexes.update(record.conversationKey, {
          firstMissingAt,
          missingCount,
          sourceStatus:
            missingCount >= 2 ? 'missing_on_source' : record.sourceStatus,
          syncStatus:
            missingCount >= 2 ? 'missing_on_source' : record.syncStatus,
        });
      }
    });
  }

  async clearAllForTests(): Promise<void> {
    await this.db.transaction(
      'rw',
      this.db.conversationIndexes,
      this.db.syncJobs,
      this.db.scanCheckpoints,
      this.db.keyValues,
      async () => {
        await Promise.all([
          this.db.conversationIndexes.clear(),
          this.db.syncJobs.clear(),
          this.db.scanCheckpoints.clear(),
          this.db.keyValues.clear(),
        ]);
      },
    );
  }
}
