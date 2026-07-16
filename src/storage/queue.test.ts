import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupDatabase } from './db';
import { SyncQueue } from './queue';
import { BackupStateStore } from './state';

let db: BackupDatabase;
let queue: SyncQueue;

beforeEach(() => {
  db = new BackupDatabase(`ai-chat-backup-test-${Date.now()}-${Math.random()}`);
  queue = new SyncQueue(db);
});

afterEach(async () => {
  await db.delete();
});

function input(hash: string, snapshot: unknown = { title: 'Snapshot' }) {
  return {
    conversationKey: 'chatgpt:personal:conversation-1',
    platform: 'chatgpt',
    scopeId: 'personal',
    sourceConversationId: 'conversation-1',
    title: 'Conversation',
    sourceUpdatedAt: '2026-07-16T00:00:00.000Z',
    sourceStatus: 'active',
    targetHash: hash,
    snapshot,
  };
}

describe('durable sync queue', () => {
  it('keeps only the newest pending snapshot for a conversation', async () => {
    expect(await queue.enqueueLatest(input('hash-1'))).toBe('enqueued');
    expect(await queue.enqueueLatest(input('hash-1'))).toBe('unchanged');
    expect(await db.syncJobs.count()).toBe(1);

    expect(await queue.enqueueLatest(input('hash-2', { title: 'New snapshot' }))).toBe('enqueued');
    const job = await db.syncJobs.get('chatgpt:personal:conversation-1');
    expect(job?.targetHash).toBe('hash-2');
    expect(job?.snapshot).toEqual({ title: 'New snapshot' });
    expect(await db.syncJobs.count()).toBe(1);
  });

  it('marks a missing source only after two checks at least 24 hours apart', async () => {
    await queue.enqueueLatest(input('hash-1'));
    const start = Date.parse('2026-07-16T00:00:00.000Z');

    await queue.recordFullScanPresence('chatgpt', 'personal', new Set(), start);
    let index = await db.conversationIndexes.get('chatgpt:personal:conversation-1');
    expect(index?.missingCount).toBe(1);
    expect(index?.sourceStatus).toBe('active');

    await queue.recordFullScanPresence('chatgpt', 'personal', new Set(), start + 23 * 60 * 60_000);
    index = await db.conversationIndexes.get('chatgpt:personal:conversation-1');
    expect(index?.missingCount).toBe(1);

    await queue.recordFullScanPresence('chatgpt', 'personal', new Set(), start + 24 * 60 * 60_000);
    index = await db.conversationIndexes.get('chatgpt:personal:conversation-1');
    expect(index?.missingCount).toBe(2);
    expect(index?.sourceStatus).toBe('missing_on_source');
    expect(index?.syncStatus).toBe('missing_on_source');
  });

  it('persists full-scan cursors and seen keys across worker restarts', async () => {
    const state = new BackupStateStore(db);
    await state.saveCheckpoint({
      platform: 'claude',
      scopeId: 'organization-1',
      kind: 'full',
      cursor: 'page-2',
      watermark: '2026-07-16T00:00:00.000Z',
      seenConversationKeys: ['claude:organization-1:first'],
      startedAt: Date.now(),
    });

    const restored = await new BackupStateStore(db).getCheckpoint('claude', 'organization-1', 'full');
    expect(restored?.cursor).toBe('page-2');
    expect(restored?.seenConversationKeys).toEqual(['claude:organization-1:first']);
  });
});

