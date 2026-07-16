import { DriveApiError } from './errors';
import type {
  DriveFile,
  DriveFileList,
  DriveFileMetadata,
  DriveUploadInput,
  TokenProvider,
} from './types';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS =
  'id,name,mimeType,parents,appProperties,modifiedTime,size,md5Checksum';
export const RESUMABLE_THRESHOLD_BYTES = 5 * 1024 * 1024;
const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;

function asBlob(content: string | Uint8Array | Blob, contentType: string): Blob {
  if (content instanceof Blob) return content;
  if (typeof content === 'string') return new Blob([content], { type: contentType });
  // Copy to an ArrayBuffer-backed view to satisfy strict BlobPart typings.
  return new Blob([content.slice().buffer], { type: contentType });
}

export function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function appPropertiesQuery(properties: Record<string, string>): string {
  return Object.entries(properties)
    .map(
      ([key, value]) =>
        `appProperties has { key='${escapeDriveQuery(key)}' and value='${escapeDriveQuery(value)}' }`,
    )
    .join(' and ');
}

function rangeNextByte(header: string | null): number {
  if (!header) return 0;
  const match = /bytes=\d+-(\d+)/i.exec(header);
  return match ? Number(match[1]) + 1 : 0;
}

export class DriveClient {
  constructor(private readonly tokens: TokenProvider) {}

  async authorize(interactive = true): Promise<void> {
    await this.tokens.getAccessToken(interactive);
  }

  private async fetchAuthorized(
    url: string,
    init: RequestInit,
    acceptedStatuses: ReadonlySet<number> = new Set(),
    mayRetryAuth = true,
  ): Promise<Response> {
    const token = await this.tokens.getAccessToken(false);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(url, { ...init, headers });

    if (response.status === 401 && mayRetryAuth) {
      await this.tokens.invalidateAccessToken(token);
      return this.fetchAuthorized(url, init, acceptedStatuses, false);
    }
    if (!response.ok && !acceptedStatuses.has(response.status)) {
      throw await DriveApiError.fromResponse(response);
    }
    return response;
  }

  async listFiles(query: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: query,
        spaces: 'drive',
        pageSize: '1000',
        fields: `nextPageToken,files(${FILE_FIELDS})`,
      });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.fetchAuthorized(
        `${DRIVE_API}/files?${params.toString()}`,
        { method: 'GET' },
      );
      const page = (await response.json()) as DriveFileList;
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const response = await this.fetchAuthorized(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
      { method: 'GET' },
    );
    return response.json() as Promise<DriveFile>;
  }

  async findByProperties(
    properties: Record<string, string>,
    parentId?: string,
    mimeType?: string,
  ): Promise<DriveFile | undefined> {
    const parts = ['trashed = false', appPropertiesQuery(properties)];
    if (parentId) parts.push(`'${escapeDriveQuery(parentId)}' in parents`);
    if (mimeType) parts.push(`mimeType = '${escapeDriveQuery(mimeType)}'`);
    const files = await this.listFiles(parts.join(' and '));
    files.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
    return files[0];
  }

  async findChildByName(
    parentId: string,
    name: string,
    mimeType?: string,
  ): Promise<DriveFile | undefined> {
    const parts = [
      'trashed = false',
      `'${escapeDriveQuery(parentId)}' in parents`,
      `name = '${escapeDriveQuery(name)}'`,
    ];
    if (mimeType) parts.push(`mimeType = '${escapeDriveQuery(mimeType)}'`);
    const files = await this.listFiles(parts.join(' and '));
    files.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
    return files[0];
  }

  async createFolder(metadata: DriveFileMetadata): Promise<DriveFile> {
    const response = await this.fetchAuthorized(
      `${DRIVE_API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
          ...metadata,
          mimeType: 'application/vnd.google-apps.folder',
        }),
      },
    );
    return response.json() as Promise<DriveFile>;
  }

  async updateMetadata(
    fileId: string,
    metadata: Partial<DriveFileMetadata>,
  ): Promise<DriveFile> {
    const response = await this.fetchAuthorized(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(metadata),
      },
    );
    return response.json() as Promise<DriveFile>;
  }

  async copyFile(
    fileId: string,
    metadata: DriveFileMetadata,
  ): Promise<DriveFile> {
    const response = await this.fetchAuthorized(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}/copy?fields=${encodeURIComponent(FILE_FIELDS)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(metadata),
      },
    );
    return response.json() as Promise<DriveFile>;
  }

  async upload(input: DriveUploadInput): Promise<DriveFile> {
    const blob = asBlob(input.content, input.contentType);
    if (blob.size <= RESUMABLE_THRESHOLD_BYTES) {
      const file = await this.multipartUpload(input, blob);
      await input.onResumeState?.(undefined);
      return file;
    }
    return this.resumableUpload(input, blob);
  }

  private async multipartUpload(
    input: DriveUploadInput,
    blob: Blob,
  ): Promise<DriveFile> {
    const boundary = `ai_chat_backup_${crypto.randomUUID()}`;
    const body = new Blob(
      [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        JSON.stringify(input.metadata),
        `\r\n--${boundary}\r\nContent-Type: ${input.contentType}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--`,
      ],
      { type: `multipart/related; boundary=${boundary}` },
    );
    const suffix = input.fileId ? `/${encodeURIComponent(input.fileId)}` : '';
    const response = await this.fetchAuthorized(
      `${DRIVE_UPLOAD_API}/files${suffix}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`,
      {
        method: input.fileId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    return response.json() as Promise<DriveFile>;
  }

  private async createResumableSession(
    input: DriveUploadInput,
    blob: Blob,
  ): Promise<string> {
    const suffix = input.fileId ? `/${encodeURIComponent(input.fileId)}` : '';
    const response = await this.fetchAuthorized(
      `${DRIVE_UPLOAD_API}/files${suffix}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`,
      {
        method: input.fileId ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': input.contentType,
          'X-Upload-Content-Length': String(blob.size),
        },
        body: JSON.stringify(input.metadata),
      },
    );
    const location = response.headers.get('location');
    if (!location) throw new Error('Google Drive did not return a resumable session URL.');
    return location;
  }

  private async resumableUpload(
    input: DriveUploadInput,
    blob: Blob,
  ): Promise<DriveFile> {
    const saved = input.resume;
    let sessionUrl =
      saved?.fileKey === input.fileKey &&
      saved.totalBytes === blob.size &&
      saved.mimeType === input.contentType
        ? saved.sessionUrl
        : undefined;
    let nextByte = sessionUrl ? (saved?.nextByte ?? 0) : 0;
    let restarted = false;

    while (true) {
      if (!sessionUrl) {
        sessionUrl = await this.createResumableSession(input, blob);
        nextByte = 0;
        await input.onResumeState?.({
          fileKey: input.fileKey,
          sessionUrl,
          mimeType: input.contentType,
          totalBytes: blob.size,
          nextByte,
          updatedAt: Date.now(),
        });
      } else if (nextByte > 0) {
        try {
          const probe = await this.fetchAuthorized(
            sessionUrl,
            {
              method: 'PUT',
              headers: { 'Content-Range': `bytes */${blob.size}` },
            },
            new Set([308]),
          );
          if (probe.ok) {
            await input.onResumeState?.(undefined);
            return probe.json() as Promise<DriveFile>;
          }
          nextByte = rangeNextByte(probe.headers.get('range'));
        } catch (error) {
          if (
            !restarted &&
            error instanceof DriveApiError &&
            (error.status === 404 || error.status === 410)
          ) {
            restarted = true;
            sessionUrl = undefined;
            nextByte = 0;
            await input.onResumeState?.(undefined);
            continue;
          }
          throw error;
        }
      }

      const endExclusive = Math.min(nextByte + RESUMABLE_CHUNK_BYTES, blob.size);
      const chunk = blob.slice(nextByte, endExclusive, input.contentType);
      try {
        const response = await this.fetchAuthorized(
          sessionUrl,
          {
            method: 'PUT',
            headers: {
              'Content-Type': input.contentType,
              'Content-Range': `bytes ${nextByte}-${endExclusive - 1}/${blob.size}`,
            },
            body: chunk,
          },
          new Set([308]),
        );
        if (response.ok) {
          await input.onResumeState?.(undefined);
          return response.json() as Promise<DriveFile>;
        }
        nextByte = rangeNextByte(response.headers.get('range')) || endExclusive;
        await input.onResumeState?.({
          fileKey: input.fileKey,
          sessionUrl,
          mimeType: input.contentType,
          totalBytes: blob.size,
          nextByte,
          updatedAt: Date.now(),
        });
      } catch (error) {
        if (
          !restarted &&
          error instanceof DriveApiError &&
          (error.status === 404 || error.status === 410)
        ) {
          restarted = true;
          sessionUrl = undefined;
          nextByte = 0;
          await input.onResumeState?.(undefined);
          continue;
        }
        throw error;
      }
    }
  }
}
