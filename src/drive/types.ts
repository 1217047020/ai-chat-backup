import type { CanonicalConversationV1 } from '../shared/types';
import type {
  DriveFileMapping,
  ResumableUploadState,
} from '../storage/types';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
}

export interface DriveFileList {
  files: DriveFile[];
  nextPageToken?: string;
}

export interface DriveFileMetadata {
  name: string;
  mimeType?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
}

export interface DriveUploadInput {
  fileId?: string;
  metadata: DriveFileMetadata;
  content: string | Uint8Array | Blob;
  contentType: string;
  fileKey: string;
  resume?: ResumableUploadState;
  onResumeState?: (state?: ResumableUploadState) => Promise<void> | void;
}

export interface DriveBackupHooks {
  resume?: ResumableUploadState;
  onResumeState?: (state?: ResumableUploadState) => Promise<void> | void;
}

export interface DriveBackupResult {
  mapping: DriveFileMapping;
  filesWritten: number;
}

export interface BackupConversationInput {
  conversation: CanonicalConversationV1;
  contentHash: string;
  existing?: DriveFileMapping;
  hooks?: DriveBackupHooks;
}

export interface TokenProvider {
  getAccessToken(interactive?: boolean): Promise<string>;
  invalidateAccessToken(token: string): Promise<void>;
}
