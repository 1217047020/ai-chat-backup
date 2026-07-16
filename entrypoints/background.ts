import { defineBackground } from 'wxt/utils/define-background';
import {
  ChromeIdentityTokenProvider,
  DriveApiError,
  DriveBackupStore,
  DriveClient,
  driveFailure,
} from '../src/drive';
import type {
  CanonicalConversationV1,
  Platform,
  RuntimeMessage,
  RuntimeResponse,
} from '../src/shared/types';
import { backupDb } from '../src/storage/db';
import { BackupStateStore } from '../src/storage/state';
import type { ScanKind } from '../src/storage/types';
import { SyncCoordinator, type ScanReport } from '../src/sync/coordinator';
import { SyncProcessor } from '../src/sync/processor';
import { RuntimeProviderAdapter } from '../src/sync/runtime-adapter';

const ALARM_NAME = 'ai-chat-backup-tick';
const PLATFORMS: readonly Platform[] = ['chatgpt', 'claude'];
const INITIAL_REQUESTED_KEY = 'backup.initialRequestedAt';
const INITIAL_COMPLETED_KEY = 'backup.initialCompletedAt';
const CONSENT_KEY = 'backup.consentGranted';
const AUTO_SYNC_KEY = 'settings.autoSync';
const LAST_SUCCESS_KEY = 'sync.lastSuccessfulAt';
const LAST_SCAN_ERROR_KEY = 'sync.lastScanError';
const INCREMENTAL_INTERVAL_MS = 6 * 60 * 60_000;
const FULL_INTERVAL_MS = 7 * 24 * 60 * 60_000;

interface RuntimeBundle {
  state: BackupStateStore;
  drive: DriveBackupStore;
  processor: SyncProcessor;
  coordinator: SyncCoordinator;
  adapters: Record<Platform, RuntimeProviderAdapter>;
}

const providerTabs = new Map<number, Platform>();
let bundle: RuntimeBundle | undefined;
let drainPromise: Promise<number> | undefined;
let scanPromise: Promise<ScanReport[]> | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scanKey(kind: ScanKind, platform: Platform): string {
  return `sync.last${kind === 'full' ? 'Full' : 'Incremental'}ScanAt:${platform}`;
}

function supportedHost(url: string | undefined, platform: Platform): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return platform === 'claude'
      ? host === 'claude.ai' || host.endsWith('.claude.ai')
      : host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com';
  } catch {
    return false;
  }
}

function senderMatches(sender: chrome.runtime.MessageSender, platform: Platform): boolean {
  const id = sender.tab?.id;
  return (typeof id === 'number' && providerTabs.get(id) === platform) || supportedHost(sender.tab?.url, platform);
}

function canonical(value: unknown): value is CanonicalConversationV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CanonicalConversationV1>;
  return candidate.schemaVersion === 1 &&
    (candidate.provider === 'chatgpt' || candidate.provider === 'claude') &&
    typeof candidate.conversationKey === 'string' &&
    typeof candidate.sourceId === 'string' &&
    typeof candidate.title === 'string' &&
    Boolean(candidate.scope);
}

function createRuntime(): RuntimeBundle {
  const state = new BackupStateStore(backupDb);
  const tokens = new ChromeIdentityTokenProvider();
  const drive = new DriveBackupStore(new DriveClient(tokens));
  const processor = new SyncProcessor(drive, backupDb, {
    onProgress: (event) => {
      if (event.kind === 'succeeded') void state.setValue(LAST_SUCCESS_KEY, Date.now());
      if (event.kind === 'failed' && event.error instanceof DriveApiError) {
        if (event.error.status === 401) void tokens.disconnect();
        if (event.error.status === 403 && !event.retryable) {
          void state.setPaused(true, 'Google Drive denied access. Please authorize again.');
        }
      }
    },
  });
  return {
    state,
    drive,
    processor,
    coordinator: new SyncCoordinator(processor, backupDb),
    adapters: {
      chatgpt: new RuntimeProviderAdapter('chatgpt'),
      claude: new RuntimeProviderAdapter('claude'),
    },
  };
}

function runtime(): RuntimeBundle {
  bundle ??= createRuntime();
  return bundle;
}

async function connected(): Promise<boolean> {
  return (await runtime().state.getDriveConnection()).connected;
}

async function consentGranted(): Promise<boolean> {
  return (await runtime().state.getValue<boolean>(CONSENT_KEY)) === true;
}

function drain(): Promise<number> {
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    if (!await connected() || await runtime().state.isPaused()) return 0;
    return runtime().processor.drain(40);
  })().finally(() => { drainPromise = undefined; });
  return drainPromise;
}

async function openPlatforms(): Promise<Platform[]> {
  const result: Platform[] = [];
  for (const platform of PLATFORMS) {
    if (await runtime().adapters[platform].hasOpenTab()) result.push(platform);
  }
  return result;
}

async function scanAvailable(kind: ScanKind, only?: readonly Platform[]): Promise<ScanReport[]> {
  if (await runtime().state.isPaused()) return [];
  if (scanPromise) {
    await scanPromise;
    return scanAvailable(kind, only);
  }
  const allow = new Set(only ?? PLATFORMS);
  const run = (async () => {
    const reports: ScanReport[] = [];
    for (const platform of PLATFORMS) {
      if (!allow.has(platform)) continue;
      const adapter = runtime().adapters[platform];
      if (!await adapter.hasOpenTab()) continue;
      try {
        reports.push(await runtime().coordinator.scanAdapter(adapter, {
          kind,
          workerId: `scan:${platform}:${kind}:${Date.now()}`,
          drainAfterPage: await connected(),
        }));
      } catch (error) {
        reports.push({
          platform,
          kind,
          scopes: 0,
          pages: 0,
          summaries: 0,
          fetched: 0,
          queued: 0,
          unchanged: 0,
          completed: false,
          skippedForBackpressure: false,
          errors: [{ scopeId: platform, message: errorMessage(error) }],
        });
      }
    }
    return reports;
  })();
  scanPromise = run;
  try { return await run; } finally { if (scanPromise === run) scanPromise = undefined; }
}

async function persistScans(kind: ScanKind, reports: readonly ScanReport[]): Promise<void> {
  const now = Date.now();
  for (const report of reports) {
    if (!report.completed || report.skippedForBackpressure) continue;
    if (report.platform === 'chatgpt' || report.platform === 'claude') {
      await runtime().state.setValue(scanKey(kind, report.platform), now);
      if (kind === 'full') await runtime().state.setValue(`backup.initialCompletedAt:${report.platform}`, now);
    }
  }
  if (kind === 'full' && reports.length > 0 && reports.every((report) => report.completed)) {
    await runtime().state.setValue(INITIAL_COMPLETED_KEY, now);
  }
}

async function scanAndPersist(kind: ScanKind, only?: readonly Platform[]): Promise<ScanReport[]> {
  const reports = await scanAvailable(kind, only);
  await persistScans(kind, reports);
  await drain();
  const errors = reports.flatMap((report) => report.errors).slice(0, 3);
  if (errors.length) await runtime().state.setValue(LAST_SCAN_ERROR_KEY, errors.map((item) => item.message).join('; '));
  return reports;
}

async function status(): Promise<RuntimeResponse> {
  const current = runtime();
  const counts = await current.processor.queue.counts();
  const indexes = await current.processor.queue.listIndexes();
  const scopes: Record<Platform, Set<string>> = { chatgpt: new Set(), claude: new Set() };
  const byPlatform: Record<Platform, { scopes: number; conversations: number }> = {
    chatgpt: { scopes: 0, conversations: 0 }, claude: { scopes: 0, conversations: 0 },
  };
  for (const index of indexes) {
    if (index.platform !== 'chatgpt' && index.platform !== 'claude') continue;
    scopes[index.platform].add(index.scopeId);
    byPlatform[index.platform].conversations += 1;
  }
  byPlatform.chatgpt.scopes = scopes.chatgpt.size;
  byPlatform.claude.scopes = scopes.claude.size;
  return {
    ok: true,
    status: {
      drive: await current.state.getDriveConnection(),
      queued: counts.pending,
      inProgress: counts.running,
      failed: counts.blocked,
      lastSuccessfulSyncAt: await current.state.getValue<number>(LAST_SUCCESS_KEY),
      paused: await current.state.isPaused(),
      pausedReason: await current.state.blockedReason(),
      consentGranted: await consentGranted(),
      byPlatform,
    },
  };
}

async function connectDrive(): Promise<RuntimeResponse> {
  try {
    const result = await runtime().drive.connect(true);
    await runtime().state.setDriveConnection({
      connected: true,
      rootFolderId: result.rootFolderId,
      rootFolderName: 'AI Chat Backup',
      lastConnectedAt: Date.now(),
      lastError: undefined,
    });
    await runtime().state.setPaused(false);
    void drain();
    return status();
  } catch (error) {
    const failure = driveFailure(error);
    await runtime().state.setDriveConnection({ connected: false, lastError: failure.message });
    return { ok: false, error: failure.message, retryable: failure.retryable };
  }
}

async function startInitial(): Promise<RuntimeResponse> {
  if (!await connected()) return { ok: false, error: 'Connect Google Drive first.', retryable: false };
  const platforms = await openPlatforms();
  if (!platforms.length) return { ok: false, error: 'Open a ChatGPT or Claude tab before starting the first backup.', retryable: true };
  await runtime().state.setValue(INITIAL_REQUESTED_KEY, Date.now());
  await runtime().state.setValue(CONSENT_KEY, true);
  void scanAndPersist('full', platforms).catch((error) => runtime().state.setValue(LAST_SCAN_ERROR_KEY, errorMessage(error)));
  return status();
}

async function scheduledFor(platform: Platform): Promise<void> {
  if (!await connected() || await runtime().state.isPaused()) return;
  if (!await runtime().state.getValue<number>(INITIAL_REQUESTED_KEY)) return;
  const now = Date.now();
  const fullAt = await runtime().state.getValue<number>(scanKey('full', platform));
  const incrementalAt = await runtime().state.getValue<number>(scanKey('incremental', platform));
  if (!fullAt || now - fullAt >= FULL_INTERVAL_MS) await scanAndPersist('full', [platform]);
  else if (!incrementalAt || now - incrementalAt >= INCREMENTAL_INTERVAL_MS) await scanAndPersist('incremental', [platform]);
}

async function scheduledScans(): Promise<void> {
  for (const platform of await openPlatforms()) await scheduledFor(platform);
  await drain();
}

async function fetchCurrent(platform: Platform): Promise<CanonicalConversationV1 | undefined> {
  const adapter = runtime().adapters[platform] as RuntimeProviderAdapter & {
    fetchCurrentConversation?: () => Promise<CanonicalConversationV1 | undefined>;
  };
  try { return await adapter.fetchCurrentConversation?.(); } catch { return undefined; }
}

async function enqueueConversation(
  conversation: CanonicalConversationV1,
  trigger: 'observer' | 'scan' | 'manual' | 'realtime' = 'observer',
): Promise<RuntimeResponse> {
  if (!await consentGranted()) return { ok: false, error: 'Confirm and start the first backup before uploading.', retryable: false };
  await runtime().coordinator.incremental.enqueue(conversation, {
    priority: trigger === 'manual' ? 100 : trigger === 'observer' || trigger === 'realtime' ? 80 : 30,
    identity: {
      conversationKey: conversation.conversationKey,
      platform: conversation.provider,
      scopeId: conversation.scope.scopeKey,
      scopeName: conversation.scope.displayName,
      sourceConversationId: conversation.sourceId,
      title: conversation.title,
      sourceUpdatedAt: conversation.updatedAt,
      sourceStatus: conversation.sourceStatus,
    },
  });
  if ((await runtime().state.getValue<boolean>(AUTO_SYNC_KEY) ?? true) && await connected() && !await runtime().state.isPaused()) void drain();
  return status();
}

async function handleMessage(
  message: RuntimeMessage | Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): Promise<RuntimeResponse> {
  switch (message.type) {
    case 'content_ready': {
      const platform = message.platform as Platform;
      if (sender.tab?.id != null) providerTabs.set(sender.tab.id, platform);
      if (await runtime().state.getValue<number>(INITIAL_REQUESTED_KEY) &&
          !await runtime().state.getValue<number>(`backup.initialCompletedAt:${platform}`)) {
        void scanAndPersist('full', [platform]).catch((error) => runtime().state.setValue(LAST_SCAN_ERROR_KEY, errorMessage(error)));
      } else {
        void scheduledFor(platform).catch((error) => runtime().state.setValue(LAST_SCAN_ERROR_KEY, errorMessage(error)));
      }
      return { ok: true };
    }
    case 'conversation_captured': {
      const value = (message as { conversation?: unknown }).conversation;
      const platform = (message as { platform?: Platform }).platform ?? (canonical(value) ? value.provider : undefined);
      if (!platform || !canonical(value) || value.provider !== platform || !senderMatches(sender, platform)) {
        return { ok: false, error: 'Invalid conversation from an unsupported page.', retryable: false };
      }
      const trigger = ((message as { trigger?: string }).trigger ?? 'observer') as 'observer' | 'scan' | 'manual' | 'realtime';
      return enqueueConversation(value, trigger);
    }
    case 'connect_drive': return connectDrive();
    case 'start_initial_backup': return startInitial();
    case 'pause_sync':
      await runtime().state.setPaused(true, 'Sync paused by the user.');
      return status();
    case 'resume_sync':
      await runtime().state.setPaused(false);
      void drain();
      return status();
    case 'retry_failed':
      await runtime().state.setPaused(false);
      await runtime().processor.queue.retryBlocked();
      void drain();
      return status();
    case 'sync_now': {
      if (!await consentGranted()) return { ok: false, error: 'Confirm and start the first backup before uploading.', retryable: false };
      const key = (message as { conversationKey?: string }).conversationKey;
      if (key) {
        const index = await backupDb.conversationIndexes.get(key);
        if (index?.platform === 'chatgpt' || index?.platform === 'claude') {
          const current = await fetchCurrent(index.platform);
          if (current) await enqueueConversation(current, 'manual');
        }
        await runtime().processor.queue.makeDue(key, 1000);
      } else {
        for (const platform of await openPlatforms()) {
          const current = await fetchCurrent(platform);
          if (current) await enqueueConversation(current, 'manual');
        }
      }
      void drain();
      return status();
    }
    case 'get_status': return status();
    default: return { ok: false, error: 'Unsupported background message.', retryable: false };
  }
}

export default defineBackground(() => {
  const scheduleAlarm = () => void chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 15 });
  scheduleAlarm();
  chrome.runtime.onInstalled.addListener(() => {
    scheduleAlarm();
    void runtime().state.setValue(AUTO_SYNC_KEY, true);
    void runtime().state.getValue<boolean>(CONSENT_KEY).then((value) => {
      if (value === undefined) return runtime().state.setValue(CONSENT_KEY, false);
      return undefined;
    });
    void chrome.storage.local.set({ 'ai-chat-backup:installedAt': new Date().toISOString() });
  });
  chrome.runtime.onStartup.addListener(scheduleAlarm);
  chrome.tabs.onRemoved.addListener((tabId) => providerTabs.delete(tabId));
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void scheduledScans().catch((error) => runtime().state.setValue(LAST_SCAN_ERROR_KEY, errorMessage(error)));
  });
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    void handleMessage(message as RuntimeMessage, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error), retryable: true }));
    return true;
  });
});

