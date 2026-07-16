import type {
  ConversationPage,
  ConversationSummary,
  ProviderAdapter,
  Scope,
} from '../shared/types';
import { backupDb, type BackupDatabase } from '../storage/db';
import { BackupStateStore } from '../storage/state';
import type { ConversationIndexRecord, ScanKind } from '../storage/types';
import { IncrementalSync } from './incremental';
import { SyncProcessor } from './processor';

export interface ScanOptions {
  kind: ScanKind;
  scopes?: Scope[];
  signal?: AbortSignal;
  workerId?: string;
  /** Drain a few uploads after each page to keep historical backpressure low. */
  drainAfterPage?: boolean;
  maxPagesPerScope?: number;
}

export interface ScanReport {
  platform: string;
  kind: ScanKind;
  scopes: number;
  pages: number;
  summaries: number;
  fetched: number;
  queued: number;
  unchanged: number;
  completed: boolean;
  skippedForBackpressure: boolean;
  errors: Array<{ scopeId: string; sourceId?: string; message: string }>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The scan was cancelled.', 'AbortError');
}

function summaryUpdatedAt(summary: ConversationSummary): string | undefined {
  return summary.updatedAt ?? summary.createdAt;
}

function isSummaryFresh(
  summary: ConversationSummary,
  index: ConversationIndexRecord | undefined,
  watermark?: string,
): boolean {
  if (!index?.contentHash || index.syncStatus !== 'synced') return false;
  if (summary.title !== index.title) return false;
  if (
    summary.sourceStatus &&
    summary.sourceStatus !== 'unknown' &&
    summary.sourceStatus !== index.sourceStatus
  ) {
    return false;
  }
  const updatedAt = summaryUpdatedAt(summary);
  if (!updatedAt) return false;

  // A five-minute safety window catches providers that round timestamps to
  // seconds or update a conversation shortly after a list response is emitted.
  const parsed = Date.parse(updatedAt);
  const known = Date.parse(index.sourceUpdatedAt ?? '');
  const water = Date.parse(watermark ?? '');
  if (!Number.isFinite(parsed)) return false;
  if (Number.isFinite(known) && parsed > known) return false;
  if (Number.isFinite(water) && parsed > water) return false;
  const safetyWindowMs = 5 * 60_000;
  // Re-fetch recently touched conversations because list endpoints often
  // round timestamps and may lag the detail endpoint by a few minutes.
  if (parsed >= Date.now() - safetyWindowMs) return false;
  return Number.isFinite(known) && parsed <= known;
}

function maxTimestamp(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

/**
 * Provider-agnostic scanner. It deliberately repeats a page after a crash
 * rather than advancing its checkpoint before details have been normalized;
 * queue de-duplication makes that replay safe.
 */
export class SyncCoordinator {
  readonly state: BackupStateStore;
  readonly incremental: IncrementalSync;

  constructor(
    private readonly processor: SyncProcessor,
    private readonly db: BackupDatabase = backupDb,
  ) {
    this.state = new BackupStateStore(db);
    this.incremental = new IncrementalSync(db);
  }

  async scanAdapter(
    adapter: ProviderAdapter,
    options: ScanOptions,
  ): Promise<ScanReport> {
    const report: ScanReport = {
      platform: adapter.platform,
      kind: options.kind,
      scopes: 0,
      pages: 0,
      summaries: 0,
      fetched: 0,
    queued: 0,
    unchanged: 0,
    completed: false,
      skippedForBackpressure: false,
      errors: [],
    };
    const scopes = options.scopes ?? (await adapter.detectScopes());
    report.scopes = scopes.length;
    const workerId = options.workerId ?? `scan:${adapter.platform}:${crypto.randomUUID()}`;
    let allScopesComplete = true;

    for (const scope of scopes) {
      throwIfAborted(options.signal);
      const checkpoint = await this.state.getCheckpoint(
        adapter.platform,
        scope.scopeKey,
        options.kind,
      );
      // A completed checkpoint starts a new pass; an incomplete checkpoint is
      // resumed exactly where the previous worker stopped.
      let cursor = checkpoint?.completedAt ? undefined : checkpoint?.cursor;
      let watermark = checkpoint?.completedAt ? undefined : checkpoint?.watermark;
      const startedAt = checkpoint?.completedAt ? Date.now() : checkpoint?.startedAt ?? Date.now();
      const seen = new Set<string>(
        checkpoint?.completedAt ? [] : checkpoint?.seenConversationKeys ?? [],
      );
      let complete = false;
      let pagesForScope = 0;
      let listFailed = false;

      while (!complete) {
        throwIfAborted(options.signal);
        if (await this.processor.state.isPaused()) break;
        if (
          options.maxPagesPerScope !== undefined &&
          pagesForScope >= options.maxPagesPerScope
        ) {
          break;
        }
        if (await this.incremental.isBackpressured()) {
          report.skippedForBackpressure = true;
          break;
        }

        const requestedCursor = cursor;
        let page: ConversationPage;
        try {
          page = await adapter.listConversations(scope, cursor);
        } catch (error) {
          listFailed = true;
          report.errors.push({
            scopeId: scope.scopeKey,
            message: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        report.pages += 1;
        pagesForScope += 1;
        report.summaries += page.items.length;

        let stoppedForBackpressure = false;
        let stoppedForPause = false;
        for (const summary of page.items) {
          throwIfAborted(options.signal);
          if (await this.processor.state.isPaused()) {
            stoppedForPause = true;
            break;
          }
          if (await this.incremental.isBackpressured()) {
            stoppedForBackpressure = true;
            report.skippedForBackpressure = true;
            break;
          }
          seen.add(summary.conversationKey);
          const previousWatermark = watermark;
          const index = await this.db.conversationIndexes.get(summary.conversationKey);
          if (isSummaryFresh(summary, index, previousWatermark)) {
            watermark = maxTimestamp(watermark, summaryUpdatedAt(summary));
            await this.db.conversationIndexes.update(summary.conversationKey, {
              lastSeenAt: Date.now(),
              sourceUpdatedAt: summaryUpdatedAt(summary) ?? index?.sourceUpdatedAt,
              sourceStatus: summary.sourceStatus ?? (summary.archived ? 'archived' : index?.sourceStatus),
              missingCount: 0,
              firstMissingAt: undefined,
            });
            report.unchanged += 1;
            continue;
          }

          watermark = maxTimestamp(watermark, summaryUpdatedAt(summary));

          try {
            const snapshot = await adapter.fetchConversation(scope, summary.sourceId);
            // A summary can be marked archived before the detail endpoint adds
            // the same flag; preserve the stronger list-level source status.
            const normalized =
              summary.sourceStatus && snapshot.sourceStatus !== summary.sourceStatus
                ? { ...snapshot, sourceStatus: summary.sourceStatus }
                : snapshot;
            const result = await this.incremental.enqueue(normalized, {
              identity: {
                conversationKey: summary.conversationKey,
                platform: adapter.platform,
                scopeId: scope.scopeKey,
                scopeName: scope.displayName,
                sourceConversationId: summary.sourceId,
                title: summary.title,
                sourceUpdatedAt: summaryUpdatedAt(summary),
                sourceStatus: summary.sourceStatus,
              },
              priority: options.kind === 'full' ? 10 : 30,
            });
            report.fetched += 1;
            if (result.result === 'enqueued') report.queued += 1;
            else report.unchanged += 1;
          } catch (error) {
            report.errors.push({
              scopeId: scope.scopeKey,
              sourceId: summary.sourceId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (stoppedForBackpressure || stoppedForPause) {
          // Keep the current cursor so the partially processed page is replayed
          // after the upload queue drains; enqueueLatest makes that replay safe.
          cursor = requestedCursor;
          complete = false;
          await this.state.saveCheckpoint({
            platform: adapter.platform,
            scopeId: scope.scopeKey,
            kind: options.kind,
            cursor,
            watermark,
            seenConversationKeys: [...seen],
            startedAt,
          });
          break;
        }

        cursor = page.nextCursor ?? undefined;
        if (page.nextCursor && page.nextCursor === requestedCursor) {
          report.errors.push({
            scopeId: scope.scopeKey,
            message: 'Provider returned a repeating pagination cursor.',
          });
          break;
        }
        complete = page.complete === true || !page.nextCursor;
        await this.state.saveCheckpoint({
          platform: adapter.platform,
          scopeId: scope.scopeKey,
          kind: options.kind,
          cursor,
          watermark,
          seenConversationKeys: [...seen],
          startedAt,
          completedAt: complete ? Date.now() : undefined,
        });

        if (options.drainAfterPage !== false) {
          await this.processor.drain(10);
        }
      }

      if (complete) {
        await this.state.finishCheckpoint(
          adapter.platform,
          scope.scopeKey,
          options.kind,
          watermark,
        );
        if (options.kind === 'full' && !listFailed && !report.skippedForBackpressure) {
          await this.processor.queue.recordFullScanPresence(
            adapter.platform,
            scope.scopeKey,
            seen,
          );
        }
      }
      if (!complete) allScopesComplete = false;
      if (report.skippedForBackpressure) break;
      if (await this.processor.state.isPaused()) break;
    }

    report.completed = allScopesComplete && !report.skippedForBackpressure && !(await this.processor.state.isPaused());
    return report;
  }

  async scanAll(
    adapters: readonly ProviderAdapter[],
    options: Omit<ScanOptions, 'scopes'>,
  ): Promise<ScanReport[]> {
    const reports: ScanReport[] = [];
    for (const adapter of adapters) {
      throwIfAborted(options.signal);
      reports.push(await this.scanAdapter(adapter, options));
      if (reports.at(-1)?.skippedForBackpressure) break;
    }
    return reports;
  }
}
