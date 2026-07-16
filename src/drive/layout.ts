import type { CanonicalConversationV1, Platform } from '../shared/types';
import { stableIdHash } from '../sync/hash';
import { DriveClient } from './client';
import type { DriveFile } from './types';

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DEFAULT_ROOT_FOLDER = 'AI Chat Backup';
const APP_MARKER = 'ai-chat-backup';

export interface DriveLayout {
  root: DriveFile;
  provider: DriveFile;
  scope: DriveFile;
  conversation: DriveFile;
  scopeHash: string;
  conversationHash: string;
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
  constructor(
    private readonly client: DriveClient,
    private readonly rootName = DEFAULT_ROOT_FOLDER,
  ) {}

  private async ensureFolder(
    name: string,
    appProperties: Record<string, string>,
    parentId?: string,
  ): Promise<DriveFile> {
    const normalizedProperties: Record<string, string> = {
      app: APP_MARKER,
      kind: appProperties.objectType ?? 'folder',
      ...appProperties,
    };
    const existing =
      (await this.client.findByProperties(
      normalizedProperties,
      parentId,
      DRIVE_FOLDER_MIME,
      )) ??
      (await this.client.findByProperties(
        Object.fromEntries(
          ['app', 'kind', 'provider', 'scope', 'conversation']
            .filter((key) => normalizedProperties[key] !== undefined)
            .map((key) => [key, normalizedProperties[key]]),
        ),
        parentId,
        DRIVE_FOLDER_MIME,
      ));
    if (existing) {
      if (existing.name !== name) {
        return this.client.updateMetadata(existing.id, { name });
      }
      return existing;
    }
    return this.client.createFolder({
      name,
      parents: parentId ? [parentId] : undefined,
      appProperties: normalizedProperties,
    });
  }

  async ensureRoot(): Promise<DriveFile> {
    return this.ensureFolder(safeDriveName(this.rootName), {
      application: APP_MARKER,
      objectType: 'root',
      schemaVersion: '1',
    });
  }

  async ensureConversation(
    conversation: CanonicalConversationV1,
  ): Promise<DriveLayout> {
    const root = await this.ensureRoot();
    const provider = await this.ensureFolder(
      providerDisplayName(conversation.provider),
      {
        application: APP_MARKER,
        objectType: 'provider',
        provider: conversation.provider,
        platform: conversation.provider,
        schema: '1',
      },
      root.id,
    );
    const scopeHash = await stableIdHash(conversation.scope.scopeKey);
    const scope = await this.ensureFolder(
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
    );
    const conversationHash = await stableIdHash(conversation.sourceId);
    const folder = await this.ensureFolder(
      `${safeDriveName(conversation.title)}__${conversationHash}`,
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
      conversation: folder,
      scopeHash,
      conversationHash,
    };
  }

  async ensureChildFolder(
    parentId: string,
    name: string,
    properties: Record<string, string>,
  ): Promise<DriveFile> {
    return this.ensureFolder(safeDriveName(name), {
      application: APP_MARKER,
      ...properties,
    }, parentId);
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
