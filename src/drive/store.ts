import type { ArtifactRecord, CanonicalConversationV1 } from '../shared/types';
import { conversationToMarkdown } from '../adapters/markdown';
import type { DriveFileMapping } from '../storage/types';
import { stableIdHash } from '../sync/hash';
import { DriveClient } from './client';
import { DriveApiError } from './errors';
import {
  backupAppProperties,
  DriveLayoutManager,
  safeDriveName,
} from './layout';
import {
  attachmentsJson,
  conversationJson,
  extensionForArtifact,
} from './serialize';
import type {
  BackupConversationInput,
  DriveBackupResult,
  DriveFile,
  DriveFileMetadata,
} from './types';

interface FileSpec {
  key: string;
  name: string;
  content: string;
  contentType: string;
  fileType: string;
  fileId?: string;
  appProperties?: Record<string, string>;
}

export class DriveBackupStore {
  readonly layout: DriveLayoutManager;

  constructor(
    readonly client: DriveClient,
    rootFolderName?: string,
  ) {
    this.layout = new DriveLayoutManager(client, rootFolderName);
  }

  async connect(interactive = true): Promise<{ rootFolderId: string }> {
    await this.client.authorize(interactive);
    const root = await this.layout.ensureRoot();
    return { rootFolderId: root.id };
  }

  private async resolveExisting(
    fileId: string | undefined,
    properties: Record<string, string>,
    parentId: string,
    name?: string,
  ): Promise<DriveFile | undefined> {
    if (fileId) {
      try {
        return await this.client.getFile(fileId);
      } catch (error) {
        if (!(error instanceof DriveApiError) || error.status !== 404) throw error;
      }
    }
    return (
      (await this.client.findByProperties(properties, parentId)) ??
      (name ? this.client.findChildByName(parentId, name) : undefined)
    );
  }

  private async preserveManualEdit(
    existing: DriveFile,
    expectedChecksum: string | undefined,
    conversationFolderId: string,
    conversationHash: string,
  ): Promise<void> {
    if (
      !expectedChecksum ||
      !existing.md5Checksum ||
      existing.md5Checksum === expectedChecksum
    ) {
      return;
    }
    const manualFolder = await this.layout.ensureChildFolder(
      conversationFolderId,
      '_manual-edits',
      { objectType: 'manualEdits', conversationHash },
    );
    const archiveProperties = {
      app: 'ai-chat-backup',
      kind: 'manualEdit',
      application: 'ai-chat-backup',
      objectType: 'manualEdit',
      originalFileId: existing.id,
      observedChecksum: existing.md5Checksum,
    };
    const priorCopy = await this.client.findByProperties(
      archiveProperties,
      manualFolder.id,
    );
    if (priorCopy) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await this.client.copyFile(existing.id, {
      name: `${existing.name}.${timestamp}.manual-backup`,
      parents: [manualFolder.id],
      appProperties: archiveProperties,
    });
  }

  private async writeFile(
    spec: FileSpec,
    parentId: string,
    baseProperties: Record<string, string>,
    targetHash: string,
    expectedChecksum: string | undefined,
    conversationHash: string,
    hooks: BackupConversationInput['hooks'],
  ): Promise<{ file: DriveFile; written: boolean }> {
    const properties = { ...baseProperties, ...spec.appProperties };
    // contentHash changes on every revision and therefore must not be part of
    // the lookup key; otherwise losing the local mapping would create a second
    // Drive file instead of updating the app-created one.
    const lookupProperties = { ...properties };
    delete lookupProperties.contentHash;
    const existing = await this.resolveExisting(
      spec.fileId,
      lookupProperties,
      parentId,
      spec.name,
    );

    // This covers a worker dying after Drive accepted the upload but before the
    // IndexedDB completion transaction committed.
    if (existing?.appProperties?.contentHash === targetHash) {
      return { file: existing, written: false };
    }
    if (existing) {
      await this.preserveManualEdit(
        existing,
        expectedChecksum,
        parentId,
        conversationHash,
      );
    }

    const metadata: DriveFileMetadata = {
      name: spec.name,
      mimeType: spec.contentType,
      appProperties: properties,
      ...(existing ? {} : { parents: [parentId] }),
    };
    const file = await this.client.upload({
      fileId: existing?.id,
      metadata,
      content: spec.content,
      contentType: spec.contentType,
      fileKey: spec.key,
      resume: hooks?.resume,
      onResumeState: hooks?.onResumeState,
    });
    return { file, written: true };
  }

  async backupConversation(
    input: BackupConversationInput,
  ): Promise<DriveBackupResult> {
    const { conversation, contentHash } = input;
    const layout = await this.layout.ensureConversation(conversation);
    const existing = input.existing ?? {};
    const mapping: DriveFileMapping = {
      ...existing,
      rootFolderId: layout.root.id,
      providerFolderId: layout.provider.id,
      scopeFolderId: layout.scope.id,
      conversationFolderId: layout.conversation.id,
      artifactFileIds: { ...(existing.artifactFileIds ?? {}) },
      fileChecksums: { ...(existing.fileChecksums ?? {}) },
    };
    let filesWritten = 0;

    const common = (fileType: string) =>
      backupAppProperties(
        conversation.provider,
        layout.scopeHash,
        layout.conversationHash,
        fileType,
        contentHash,
      );

    const primarySpecs: FileSpec[] = [
      {
        key: 'conversation.json',
        name: 'conversation.json',
        content: conversationJson(conversation, contentHash),
        contentType: 'application/json',
        fileType: 'json',
        fileId: existing.jsonFileId,
      },
      {
        key: 'conversation.md',
        name: 'conversation.md',
        // Keep the Drive representation identical to the adapter's tested
        // renderer (including branch, tool and attachment formatting).
        content: conversationToMarkdown(conversation),
        contentType: 'text/markdown',
        fileType: 'markdown',
        fileId: existing.markdownFileId,
      },
      {
        key: 'attachments.json',
        name: 'attachments.json',
        content: attachmentsJson(conversation),
        contentType: 'application/json',
        fileType: 'attachments',
        fileId: existing.attachmentsFileId,
      },
    ];

    for (const spec of primarySpecs) {
      const result = await this.writeFile(
        spec,
        layout.conversation.id,
        common(spec.fileType),
        contentHash,
        mapping.fileChecksums?.[spec.key],
        layout.conversationHash,
        input.hooks,
      );
      filesWritten += Number(result.written);
      if (spec.fileType === 'json') mapping.jsonFileId = result.file.id;
      if (spec.fileType === 'markdown') mapping.markdownFileId = result.file.id;
      if (spec.fileType === 'attachments') mapping.attachmentsFileId = result.file.id;
      if (result.file.md5Checksum) {
        mapping.fileChecksums![spec.key] = result.file.md5Checksum;
      }
    }

    const bodyArtifacts = conversation.artifacts.filter(
      (artifact): artifact is ArtifactRecord & { text: string } =>
        artifact.hasBody && typeof artifact.text === 'string',
    );
    if (bodyArtifacts.length > 0) {
      const artifactsFolder = await this.layout.ensureChildFolder(
        layout.conversation.id,
        'artifacts',
        {
          objectType: 'artifacts',
          conversationHash: layout.conversationHash,
        },
      );
      mapping.artifactsFolderId = artifactsFolder.id;

      for (const artifact of bodyArtifacts) {
        const artifactHash = await stableIdHash(artifact.artifactId);
        const extension = extensionForArtifact(artifact.mimeType, artifact.language);
        const baseName = safeDriveName(
          artifact.name.replace(/\.[a-z0-9]{1,8}$/i, ''),
          'artifact',
        );
        const key = `artifact:${artifact.artifactId}`;
        const spec: FileSpec = {
          key,
          name: `${baseName}__${artifactHash}.${extension}`,
          content: artifact.text,
          contentType: artifact.mimeType ?? 'text/plain',
          fileType: 'artifact',
          fileId: existing.artifactFileIds?.[artifact.artifactId],
          appProperties: { artifactHash },
        };
        const result = await this.writeFile(
          spec,
          artifactsFolder.id,
          common('artifact'),
          contentHash,
          mapping.fileChecksums?.[key],
          layout.conversationHash,
          input.hooks,
        );
        filesWritten += Number(result.written);
        mapping.artifactFileIds![artifact.artifactId] = result.file.id;
        if (result.file.md5Checksum) {
          mapping.fileChecksums![key] = result.file.md5Checksum;
        }
      }
    }

    return { mapping, filesWritten };
  }
}
