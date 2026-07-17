import type { CanonicalConversationV1, Platform } from '../shared/types';
import type { DriveFileMapping } from '../storage/types';
import { stableIdHash } from '../sync/hash';
import { DriveClient } from './client';
import type { DriveFile } from './types';

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DEFAULT_ROOT_FOLDER = 'AI Chat Backup';
const APP_MARKER = 'ai-chat-backup';

export interface DriveLayout {
  root: Pick<DriveFile, 'id'>;
  provider: Pick<DriveFile, 'id'>;
  scope: Pick<DriveFile, 'id'>;
  conversation: Pick<DriveFile, 'id'>;
  scopeHash: string;
  conversationHash: string;
  conversationFolderName: string;
  conversationCreated: boolean;
}

interface EnsuredFolder {
  file: DriveFile;
  created: boolean;
}

export function safeDriveName(value: string, fallback = 'Untitled'): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return (cleaned || fallback).slice(0, 120);
}

function providerDisplayName(provider: Platform): string {
  return provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
}

export class DriveLayoutManager {
  private readonly folderCache = new Map<string, DriveFile>();
  private readonly inflight = new Map<string, Promise<EnsuredFolder>>();

  constructor(
    private readonly client: DriveClient,
    private readonly rootName = DEFAULT_ROOT_FOLDER,
  ) {}

  private folderKey(
    appProperties: Record<string, string>,
    parentId?: string,
  ): string {
    return [
      parentId ?? 'root',
      appProperties.objectType ?? appProperties.kind ?? 'folder',
      appProperties.provider ?? appProperties.platform ?? '',
      appProperties.scope ?? appProperties.scopeHash ?? '',
      appProperties.conversation ?? appProperties.conversationHash ?? '',
    ].join('|');
  }

  private async ensureFolderUncached(
    name: string,
    appProperties: Record<string, string>,
    parentId?: string,
  ): Promise<EnsuredFolder> {
    const normalizedProperties: Record<string, string> = {
      app: APP_MARKER,
      kind: appProperties.objectType ?? 'folder',
      ...appProperties,
    };
    const identityProperties = Object.fromEntries(
      ['app', 'kind', 'provider', 'scope', 'conversation']
        .filter((key) => normalizedProperties[key] !== undefined)
        .map((key) => [key, normalizedProperties[key]]),
    );
    const existing = await this.client.findByProperties(
      identityProperties,
      parentId,
      DRIVE_FOLDER_MIME,
    );
    if (existing) {
      if (existing.name !== name) {
        return {
          file: await this.client.updateMetadata(existing.id, { name }),
          created: false,
        };
      }
      return { file: existing, created: false };
    }
    return {
      file: await this.client.createFolder({
        name,
        parents: parentId ? [parentId] : undefined,
        appProperties: normalizedProperties,
      }),
      created: true,
    };
  }

  private async ensureFolder(
    name: string,
    appProperties: Record<string, string>,
    parentId?: string,
  ): Promise<EnsuredFolder> {
    const normalizedProperties: Record<string, string> = {
      app: APP_MARKER,
      kind: appProperties.objectType ?? 'folder',
      ...appProperties,
    };
    const key = this.folderKey(normalizedProperties, parentId);
    const cached = this.folderCache.get(key);
    if (cached) {
      if (cached.name !== name) {
        const renamed = await this.client.updateMetadata(cached.id, { name });
        this.folderCache.set(key, renamed);
        return { file: renamed, created: false };
      }
      return { file: cached, created: false };
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = this.ensureFolderUncached(name, appProperties, parentId)
      .then((result) => {
        this.folderCache.set(key, result.file);
        return result;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  invalidateFolder(folderId: string): void {
    for (const [key, value] of this.folderCache) {
      if (value.id === folderId) this.folderCache.delete(key);
    }
  }

  async ensureRoot(): Promise<DriveFile> {
    const result = await this.ensureFolder(safeDriveName(this.rootName), {
      application: APP_MARKER,
      objectType: 'root',
      schemaVersion: '1',
    });
    return result.file;
  }

  async ensureConversation(
    conversation: CanonicalConversationV1,
    existing?: DriveFileMapping,
  ): Promise<DriveLayout> {
    const scopeHash = await stableIdHash(conversation.scope.scopeKey);
    const conversationHash = await stableIdHash(conversation.sourceId);
    const conversationFolderName =
      `${safeDriveName(conversation.title)}__${conversationHash}`;
    if (
      existing?.rootFolderId &&
      existing.providerFolderId &&
      existing.scopeFolderId &&
      existing.conversationFolderId &&
      existing.conversationFolderName === conversationFolderName
    ) {
      return {
        root: { id: existing.rootFolderId },
        provider: { id: existing.providerFolderId },
        scope: { id: existing.scopeFolderId },
        conversation: { id: existing.conversationFolderId },
        scopeHash,
        conversationHash,
        conversationFolderName,
        conversationCreated: false,
      };
    }
    const root = await this.ensureRoot();
    const provider = (await this.ensureFolder(
      providerDisplayName(conversation.provider),
      {
        application: APP_MARKER,
        objectType: 'provider',
        provider: conversation.provider,
        platform: conversation.provider,
        schema: '1',
      },
      root.id,
    )).file;
    const scope = (await this.ensureFolder(
      `${safeDriveName(conversation.scope.displayName, 'Personal')}__${scopeHash}`,
      {
        application: APP_MARKER,
        objectType: 'scope',
        provider: conversation.provider,
        platform: conversation.provider,
        scopeHash,
        scope: scopeHash,
        schema: '1',
      },
      provider.id,
    )).file;
    const folder = await this.ensureFolder(
      conversationFolderName,
      {
        application: APP_MARKER,
        objectType: 'conversation',
        provider: conversation.provider,
        platform: conversation.provider,
        scopeHash,
        conversationHash,
        scope: scopeHash,
        conversation: conversationHash,
        schema: '1',
      },
      scope.id,
    );
    return {
      root,
      provider,
      scope,
      conversation: folder.file,
      scopeHash,
      conversationHash,
      conversationFolderName,
      conversationCreated: folder.created,
    };
  }

  async ensureChildFolder(
    parentId: string,
    name: string,
    properties: Record<string, string>,
  ): Promise<DriveFile> {
    const result = await this.ensureFolder(safeDriveName(name), {
      application: APP_MARKER,
      ...properties,
    }, parentId);
    return result.file;
  }
}

export function backupAppProperties(
  provider: Platform,
  scopeHash: string,
  conversationHash: string,
  fileType: string,
  contentHash: string,
): Record<string, string> {
  return {
    app: APP_MARKER,
    kind: 'conversationFile',
    application: APP_MARKER,
    objectType: 'conversationFile',
    provider,
    platform: provider,
    scopeHash,
    conversationHash,
    scope: scopeHash,
    conversation: conversationHash,
    fileType,
    format: fileType,
    schemaVersion: '1',
    schema: '1',
    contentHash,
  };
}
