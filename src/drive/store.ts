import type { ArtifactRecord, CanonicalConversationV1 } from '../shared/types';
import { conversationToMarkdown } from '../adapters/markdown';
import type { DriveFileMapping } from '../storage/types';
import { stableIdHash } from '../sync/hash';
import { DriveClient, RESUMABLE_THRESHOLD_BYTES } from './client';
import { DriveApiError } from './errors';
import {
  backupAppProperties,
  DriveLayoutManager,
  safeDriveName,
} from './layout';
import type { DriveLayout } from './layout';
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

type FileWriteResult = {
  spec: FileSpec;
  result: { file: DriveFile; written: boolean };
};

function isLarge(spec: FileSpec): boolean {
  return new Blob([spec.content]).size > RESUMABLE_THRESHOLD_BYTES;
}

async function allSettledOrThrow<T>(promises: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected) throw rejected.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
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
    skipLookup = false,
  ): Promise<{ file: DriveFile; written: boolean }> {
    const properties = { ...baseProperties, ...spec.appProperties };
    // contentHash changes on every revision and therefore must not be part of
    // the lookup key; otherwise losing the local mapping would create a second
    // Drive file instead of updating the app-created one.
    const lookupProperties = { ...properties };
    delete lookupProperties.contentHash;
    const existing = skipLookup && !spec.fileId
      ? undefined
      : await this.resolveExisting(
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
    const existing = input.existing ?? {};
    const writeAll = async (layout: DriveLayout): Promise<DriveBackupResult> => {
      const mapping: DriveFileMapping = {
        ...existing,
        rootFolderId: layout.root.id,
        providerFolderId: layout.provider.id,
        scopeFolderId: layout.scope.id,
        conversationFolderId: layout.conversation.id,
        conversationFolderName: layout.conversationFolderName,
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
      const specs = primarySpecs.filter(
        (spec) =>
          spec.fileType !== 'attachments' ||
          conversation.attachments.length > 0 ||
          Boolean(existing.attachmentsFileId),
      );

      const writePrimary = async (spec: FileSpec): Promise<FileWriteResult> => ({
        spec,
        result: await this.writeFile(
          spec,
          layout.conversation.id,
          common(spec.fileType),
          contentHash,
          mapping.fileChecksums?.[spec.key],
          layout.conversationHash,
          input.hooks,
          layout.conversationCreated,
        ),
      });
      const primaryResults = await allSettledOrThrow(
        specs.filter((spec) => !isLarge(spec)).map(writePrimary),
      );
      for (const spec of specs.filter(isLarge)) {
        primaryResults.push(await writePrimary(spec));
      }
      for (const { spec, result } of primaryResults) {
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

        const artifactSpecs = await Promise.all(
          bodyArtifacts.map(async (artifact) => {
            const artifactHash = await stableIdHash(artifact.artifactId);
            const extension = extensionForArtifact(
              artifact.mimeType,
              artifact.language,
            );
            const baseName = safeDriveName(
              artifact.name.replace(/\.[a-z0-9]{1,8}$/i, ''),
              'artifact',
            );
            const key = `artifact:${artifact.artifactId}`;
            return {
              artifactId: artifact.artifactId,
              spec: {
                key,
                name: `${baseName}__${artifactHash}.${extension}`,
                content: artifact.text,
                contentType: artifact.mimeType ?? 'text/plain',
                fileType: 'artifact',
                fileId: existing.artifactFileIds?.[artifact.artifactId],
                appProperties: { artifactHash },
              } satisfies FileSpec,
            };
          }),
        );
        const writeArtifact = async (
          item: (typeof artifactSpecs)[number],
        ): Promise<FileWriteResult & { artifactId: string }> => ({
          artifactId: item.artifactId,
          spec: item.spec,
          result: await this.writeFile(
            item.spec,
            artifactsFolder.id,
            common('artifact'),
            contentHash,
            mapping.fileChecksums?.[item.spec.key],
            layout.conversationHash,
            input.hooks,
            layout.conversationCreated,
          ),
        });
        const smallArtifacts = artifactSpecs.filter(({ spec }) => !isLarge(spec));
        const largeArtifacts = artifactSpecs.filter(({ spec }) => isLarge(spec));
        const artifactResults: Array<
          FileWriteResult & { artifactId: string }
        > = [];
        for (let i = 0; i < smallArtifacts.length; i += 3) {
          artifactResults.push(
            ...(await allSettledOrThrow(
              smallArtifacts.slice(i, i + 3).map(writeArtifact),
            )),
          );
        }
        for (const item of largeArtifacts) {
          artifactResults.push(await writeArtifact(item));
        }
        for (const { artifactId, spec, result } of artifactResults) {
          filesWritten += Number(result.written);
          mapping.artifactFileIds![artifactId] = result.file.id;
          if (result.file.md5Checksum) {
            mapping.fileChecksums![spec.key] = result.file.md5Checksum;
          }
        }
      }

      return { mapping, filesWritten };
    };

    let resolvedLayout = await this.layout.ensureConversation(
      conversation,
      input.existing,
    );
    try {
      return await writeAll(resolvedLayout);
    } catch (error) {
      if (!(error instanceof DriveApiError) || error.status !== 404) throw error;
      for (const folder of [
        resolvedLayout.root,
        resolvedLayout.provider,
        resolvedLayout.scope,
        resolvedLayout.conversation,
      ]) {
        this.layout.invalidateFolder(folder.id);
      }
      resolvedLayout = await this.layout.ensureConversation(conversation);
      return writeAll(resolvedLayout);
    }
  }
}
