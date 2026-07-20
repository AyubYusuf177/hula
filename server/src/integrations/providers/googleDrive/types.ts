export const GOOGLE_DRIVE_PROVIDER = "google_drive" as const;

export const DRIVE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly" as const;
export const DRIVE_FILE_SCOPE =
  "https://www.googleapis.com/auth/drive.file" as const;

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder" as const;
export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document" as const;
export const DRIVE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut" as const;

export type DriveCapability =
  | "drive.files.read"
  | "drive.content.read"
  | "drive.files.create";

export interface DriveOwner {
  displayName: string | null;
  emailAddress: string | null;
  permissionId: string | null;
}

export type DriveContentAvailability =
  | "google_doc"
  | "plain_text"
  | "metadata_only"
  | "folder"
  | "shortcut";

/** A strict, app-safe projection of one Drive file. */
export interface DriveFileEntity {
  provider: typeof GOOGLE_DRIVE_PROVIDER;
  fileId: string;
  name: string;
  mimeType: string;
  owners: DriveOwner[];
  createdTime: string | null;
  modifiedTime: string | null;
  parents: string[];
  webViewLink: string | null;
  sizeBytes: number | null;
  starred: boolean;
  trashed: boolean;
  driveId: string | null;
  sharedDrive: boolean;
  sharedWithMeTime: string | null;
  contentAvailability: DriveContentAvailability;
  shortcut: {
    targetId: string;
    targetMimeType: string | null;
    resourceKey: string | null;
  } | null;
}

export interface RawDriveUser {
  displayName?: unknown;
  emailAddress?: unknown;
  permissionId?: unknown;
  me?: unknown;
}

export interface RawDriveFile {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  owners?: unknown;
  createdTime?: unknown;
  modifiedTime?: unknown;
  parents?: unknown;
  webViewLink?: unknown;
  size?: unknown;
  starred?: unknown;
  trashed?: unknown;
  driveId?: unknown;
  sharedWithMeTime?: unknown;
  shortcutDetails?: unknown;
}

export interface DriveListResult {
  files: DriveFileEntity[];
  nextPageToken: string | null;
  incompleteSearch: boolean;
  pagesFetched: number;
}

export type DriveContentSectionKind =
  | "heading"
  | "paragraph"
  | "list_item"
  | "table"
  | "tab";

export interface DriveContentSection {
  kind: DriveContentSectionKind;
  text: string;
  level?: number;
  tabTitle?: string;
  links?: string[];
}

export interface DriveDocumentContent {
  fileId: string;
  title: string;
  mimeType: string;
  sections: DriveContentSection[];
  text: string;
  originalCharacters: number;
  processedCharacters: number;
  truncated: boolean;
  complete: boolean;
}

export interface DriveCreationReceipt {
  fileId: string;
  name: string;
  mimeType: string;
  webViewLink: string | null;
  idempotencyKey: string;
  contentApplied?: boolean;
  partial?: boolean;
}
