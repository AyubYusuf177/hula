export type OneDriveContentAvailability = "text" | "folder" | "metadata_only";

export interface OneDriveIdentity {
  name: string | null;
  email: string | null;
  id: string | null;
}

export interface OneDriveItem {
  provider: "microsoft";
  service: "onedrive";
  driveId: string;
  itemId: string;
  name: string;
  isFolder: boolean;
  mimeType: string | null;
  extension: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
  modifiedAt: string | null;
  createdBy: OneDriveIdentity;
  modifiedBy: OneDriveIdentity;
  owner: OneDriveIdentity;
  webUrl: string | null;
  parentDriveId: string | null;
  parentItemId: string | null;
  parentPath: string | null;
  childCount: number | null;
  shared: boolean;
  remote: boolean;
  contentAvailability: OneDriveContentAvailability;
}

export interface OneDriveTextContent {
  item: OneDriveItem;
  text: string;
  originalCharacters: number;
  processedCharacters: number;
  truncated: boolean;
}
