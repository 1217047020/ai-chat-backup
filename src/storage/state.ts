import type { BackupDatabase } from './db';
import { backupDb } from './db';
import type { ScanCheckpointRecord, ScanKind } from './types';

export interface DriveConnectionRecord {
  connected: boolean;
  rootFolderId?: string;
  rootFolderName: string;
  accountHint?: string;
  lastConnectedAt?: number;
  lastError?: string;
}

const PAUSED_KEY = 'sync.paused';
const BLOCKED_REASON_KEY = 'sync.blockedReason';
const DRIVE_CONNECTION_KEY = 'drive.connection';

export class BackupStateStore {
  constructor(private readonly db: BackupDatabase = backupDb) {}

  async isPaused(): Promise<boolean> {
    return (await this.db.keyValues.get(PAUSED_KEY))?.value === true;
  }

  async setPaused(paused: boolean, reason?: string): Promise<void> {
    const now = Date.now();
    await this.db.transaction('rw', this.db.keyValues, async () => {
      await this.db.keyValues.put({ key: PAUSED_KEY, value: paused, updatedAt: now });
      if (reason) {
        await this.db.keyValues.put({
          key: BLOCKED_REASON_KEY,
          value: reason,
          updatedAt: now,
        });
      } else if (!paused) {
        await this.db.keyValues.delete(BLOCKED_REASON_KEY);
      }
    });
  }

  async blockedReason(): Promise<string | undefined> {
    const value = (await this.db.keyValues.get(BLOCKED_REASON_KEY))?.value;
    return typeof value === 'string' ? value : undefined;
  }

  async getDriveConnection(): Promise<DriveConnectionRecord> {
    const value = await this.getValue<DriveConnectionRecord>(DRIVE_CONNECTION_KEY);
    return (
      value ?? {
        connected: false,
        rootFolderName: 'AI Chat Backup',
      }
    );
  }

  async setDriveConnection(
    value: Partial<DriveConnectionRecord> & Pick<DriveConnectionRecord, 'connected'>,
  ): Promise<DriveConnectionRecord> {
    const current = await this.getDriveConnection();
    const next: DriveConnectionRecord = {
      ...current,
      ...value,
      rootFolderName: value.rootFolderName ?? current.rootFolderName,
    };
    await this.setValue(DRIVE_CONNECTION_KEY, next);
    return next;
  }

  async getValue<T>(key: string): Promise<T | undefined> {
    return (await this.db.keyValues.get(key))?.value as T | undefined;
  }

  async setValue<T>(key: string, value: T): Promise<void> {
    await this.db.keyValues.put({ key, value, updatedAt: Date.now() });
  }

  static checkpointId(platform: string, scopeId: string, kind: ScanKind): string {
    return `${platform}:${scopeId}:${kind}`;
  }

  async getCheckpoint(
    platform: string,
    scopeId: string,
    kind: ScanKind,
  ): Promise<ScanCheckpointRecord | undefined> {
    return this.db.scanCheckpoints.get(
      BackupStateStore.checkpointId(platform, scopeId, kind),
    );
  }

  async saveCheckpoint(
    checkpoint: Omit<ScanCheckpointRecord, 'id' | 'updatedAt'>,
  ): Promise<ScanCheckpointRecord> {
    const stored: ScanCheckpointRecord = {
      ...checkpoint,
      id: BackupStateStore.checkpointId(
        checkpoint.platform,
        checkpoint.scopeId,
        checkpoint.kind,
      ),
      updatedAt: Date.now(),
    };
    await this.db.scanCheckpoints.put(stored);
    return stored;
  }

  async finishCheckpoint(
    platform: string,
    scopeId: string,
    kind: ScanKind,
    watermark?: string,
  ): Promise<void> {
    const id = BackupStateStore.checkpointId(platform, scopeId, kind);
    const current = await this.db.scanCheckpoints.get(id);
    const now = Date.now();
    await this.db.scanCheckpoints.put({
      id,
      platform,
      scopeId,
      kind,
      startedAt: current?.startedAt ?? now,
      updatedAt: now,
      completedAt: now,
      watermark: watermark ?? current?.watermark,
      seenConversationKeys: current?.seenConversationKeys,
    });
  }
}
