import {
  driveHttpRequest,
  driveJsonRequest,
  driveRequestForUser,
  DriveError,
  type DriveFetchLike,
} from "./client";
import {
  DRIVE_FOLDER_MIME,
  DRIVE_SHORTCUT_MIME,
  GOOGLE_DOC_MIME,
  GOOGLE_DRIVE_PROVIDER,
  type DriveCreationReceipt,
  type DriveFileEntity,
  type DriveListResult,
  type DriveOwner,
  type RawDriveFile,
  type RawDriveUser,
} from "./types";

const FILE_FIELDS = [
  "id", "name", "mimeType", "owners(displayName,emailAddress,permissionId)",
  "createdTime", "modifiedTime", "parents", "webViewLink", "size", "starred",
  "trashed", "driveId", "sharedWithMeTime",
  "shortcutDetails(targetId,targetMimeType,targetResourceKey)",
].join(",");

export const DRIVE_LIST_PAGE_SIZE = 50;
export const DRIVE_MAX_PAGES = 3;

export interface DriveSearchFilters {
  nameContains?: string;
  fullTextContains?: string;
  mimeTypes?: string[];
  createdAfter?: string;
  createdBefore?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
  starred?: boolean;
  ownerEmail?: string;
  sharedWithMe?: boolean;
  parentId?: string;
}

export interface ListDriveFilesOptions {
  filters?: DriveSearchFilters;
  orderBy?: "modifiedTime desc" | "createdTime desc" | "name";
  maxResults?: number;
  pageToken?: string;
  maxPages?: number;
  driveId?: string;
  fetchImpl?: DriveFetchLike;
  sleep?: (ms: number) => Promise<void>;
}

/** Escape only a literal value; callers cannot supply operators or field names. */
export function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function queryString(value: string): string {
  return `'${escapeDriveQueryLiteral(value.trim())}'`;
}

function validTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function buildDriveQuery(filters: DriveSearchFilters = {}): string {
  const terms = ["trashed = false"];
  if (filters.nameContains?.trim()) {
    terms.push(`name contains ${queryString(filters.nameContains)}`);
  }
  if (filters.fullTextContains?.trim()) {
    terms.push(`fullText contains ${queryString(filters.fullTextContains)}`);
  }
  const mimeTypes = [...new Set((filters.mimeTypes ?? []).filter(Boolean))].slice(0, 8);
  if (mimeTypes.length === 1) terms.push(`mimeType = ${queryString(mimeTypes[0]!)}`);
  if (mimeTypes.length > 1) {
    terms.push(`(${mimeTypes.map((mime) => `mimeType = ${queryString(mime)}`).join(" or ")})`);
  }
  const createdAfter = validTimestamp(filters.createdAfter);
  const createdBefore = validTimestamp(filters.createdBefore);
  const modifiedAfter = validTimestamp(filters.modifiedAfter);
  const modifiedBefore = validTimestamp(filters.modifiedBefore);
  if (createdAfter) terms.push(`createdTime >= ${queryString(createdAfter)}`);
  if (createdBefore) terms.push(`createdTime < ${queryString(createdBefore)}`);
  if (modifiedAfter) terms.push(`modifiedTime >= ${queryString(modifiedAfter)}`);
  if (modifiedBefore) terms.push(`modifiedTime < ${queryString(modifiedBefore)}`);
  if (filters.starred === true) terms.push("starred = true");
  if (filters.starred === false) terms.push("starred = false");
  if (filters.ownerEmail?.trim()) {
    terms.push(`${queryString(filters.ownerEmail.toLowerCase())} in owners`);
  }
  if (filters.sharedWithMe) terms.push("sharedWithMe");
  if (filters.parentId?.trim()) terms.push(`${queryString(filters.parentId)} in parents`);
  return terms.join(" and ");
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function owner(value: unknown): DriveOwner | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as RawDriveUser;
  const displayName = str(raw.displayName);
  const emailAddress = str(raw.emailAddress);
  const permissionId = str(raw.permissionId);
  if (!displayName && !emailAddress && !permissionId) return null;
  return { displayName, emailAddress, permissionId };
}

export function contentAvailability(mimeType: string) {
  if (mimeType === GOOGLE_DOC_MIME) return "google_doc" as const;
  if (mimeType === DRIVE_FOLDER_MIME) return "folder" as const;
  if (mimeType === DRIVE_SHORTCUT_MIME) return "shortcut" as const;
  if (
    mimeType === "text/plain" ||
    mimeType === "text/markdown" ||
    mimeType === "text/x-markdown"
  ) return "plain_text" as const;
  return "metadata_only" as const;
}

export function normalizeDriveFile(raw: RawDriveFile): DriveFileEntity | null {
  const fileId = str(raw.id);
  const name = str(raw.name);
  const mimeType = str(raw.mimeType);
  if (!fileId || !name || !mimeType) return null;
  const shortcutRaw = raw.shortcutDetails && typeof raw.shortcutDetails === "object"
    ? raw.shortcutDetails as Record<string, unknown>
    : null;
  const targetId = str(shortcutRaw?.targetId);
  const driveId = str(raw.driveId);
  const sizeValue = str(raw.size);
  const sizeNumber = sizeValue ? Number(sizeValue) : Number.NaN;
  return {
    provider: GOOGLE_DRIVE_PROVIDER,
    fileId,
    name,
    mimeType,
    owners: Array.isArray(raw.owners)
      ? raw.owners.map(owner).filter((item): item is DriveOwner => Boolean(item))
      : [],
    createdTime: str(raw.createdTime),
    modifiedTime: str(raw.modifiedTime),
    parents: Array.isArray(raw.parents)
      ? raw.parents.filter((value): value is string => typeof value === "string")
      : [],
    webViewLink: str(raw.webViewLink),
    sizeBytes: Number.isSafeInteger(sizeNumber) && sizeNumber >= 0 ? sizeNumber : null,
    starred: raw.starred === true,
    trashed: raw.trashed === true,
    driveId,
    sharedDrive: Boolean(driveId),
    sharedWithMeTime: str(raw.sharedWithMeTime),
    contentAvailability: contentAvailability(mimeType),
    shortcut: targetId
      ? {
          targetId,
          targetMimeType: str(shortcutRaw?.targetMimeType),
          resourceKey: str(shortcutRaw?.targetResourceKey),
        }
      : null,
  };
}

export async function fetchDriveIdentity(
  accessToken: string,
  fetchImpl?: DriveFetchLike,
): Promise<{ permissionId: string; email: string | null; displayName: string | null }> {
  const response = await driveJsonRequest<{ user?: RawDriveUser }>({
    accessToken,
    path: "/about",
    query: { fields: "user(displayName,emailAddress,permissionId,me)" },
    fetchImpl,
  });
  const permissionId = str(response.user?.permissionId);
  if (!permissionId || response.user?.me !== true) {
    throw new DriveError("malformed_provider_response", "Drive identity was missing");
  }
  return {
    permissionId,
    email: str(response.user?.emailAddress),
    displayName: str(response.user?.displayName),
  };
}

export async function listDriveFiles(
  userId: string,
  options: ListDriveFilesOptions = {},
): Promise<DriveListResult> {
  return driveRequestForUser({
    userId,
    sleep: options.sleep,
    run: (accessToken) => listDriveFilesWithToken(accessToken, options),
  });
}

/** Injectable provider core used by production and deterministic tests. */
export async function listDriveFilesWithToken(
  accessToken: string,
  options: ListDriveFilesOptions = {},
): Promise<DriveListResult> {
  const maxResults = Math.min(Math.max(options.maxResults ?? 10, 1), 100);
  const maxPages = Math.min(Math.max(options.maxPages ?? DRIVE_MAX_PAGES, 1), 5);
  const files: DriveFileEntity[] = [];
  let pageToken = options.pageToken;
  let incompleteSearch = false;
  let pagesFetched = 0;
  do {
    const response = await driveJsonRequest<{
      files?: RawDriveFile[];
      nextPageToken?: unknown;
      incompleteSearch?: unknown;
    }>({
      accessToken,
      path: "/files",
      query: {
        q: buildDriveQuery(options.filters),
        orderBy: options.orderBy ?? "modifiedTime desc",
        pageSize: String(Math.min(DRIVE_LIST_PAGE_SIZE, maxResults - files.length)),
        pageToken,
        spaces: "drive",
        corpora: options.driveId ? "drive" : "user",
        driveId: options.driveId,
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
      },
      fetchImpl: options.fetchImpl,
    });
    pagesFetched += 1;
    for (const raw of response.files ?? []) {
      const normalized = normalizeDriveFile(raw);
      if (normalized) files.push(normalized);
      if (files.length >= maxResults) break;
    }
    incompleteSearch ||= response.incompleteSearch === true;
    pageToken = str(response.nextPageToken) ?? undefined;
  } while (pageToken && files.length < maxResults && pagesFetched < maxPages);
  return {
    files,
    nextPageToken: pageToken ?? null,
    incompleteSearch,
    pagesFetched,
  };
}

export async function getDriveFile(
  userId: string,
  fileId: string,
  fetchImpl?: DriveFetchLike,
): Promise<DriveFileEntity> {
  return driveRequestForUser({
    userId,
    run: async (accessToken) => {
      const response = await driveJsonRequest<RawDriveFile>({
        accessToken,
        path: `/files/${encodeURIComponent(fileId)}`,
        query: { fields: FILE_FIELDS, supportsAllDrives: "true" },
        fetchImpl,
      });
      const file = normalizeDriveFile(response);
      if (!file) throw new DriveError("malformed_provider_response");
      return file;
    },
  });
}

export async function resolveDriveShortcut(
  userId: string,
  shortcut: DriveFileEntity,
  fetchImpl?: DriveFetchLike,
): Promise<DriveFileEntity> {
  if (!shortcut.shortcut) return shortcut;
  return getDriveFile(userId, shortcut.shortcut.targetId, fetchImpl);
}

export async function resolveDriveParents(
  userId: string,
  file: DriveFileEntity,
  fetchImpl?: DriveFetchLike,
): Promise<DriveFileEntity[]> {
  return Promise.all(file.parents.slice(0, 5).map((id) => getDriveFile(userId, id, fetchImpl)));
}

async function findByIdempotencyKey(
  userId: string,
  key: string,
  mimeType: string,
  fetchImpl?: DriveFetchLike,
): Promise<DriveFileEntity | null> {
  // `listDriveFiles` deliberately exposes only whitelisted search filters. This
  // provider-internal lookup supplies its own fixed query shape below.
  return driveRequestForUser({
    userId,
    run: async (accessToken) => {
      const response = await driveJsonRequest<{ files?: RawDriveFile[] }>({
        accessToken,
        path: "/files",
        query: {
          q: `trashed = false and mimeType = ${queryString(mimeType)} and appProperties has { key='hulaRequestId' and value=${queryString(key)} }`,
          pageSize: "2",
          spaces: "drive",
          includeItemsFromAllDrives: "true",
          supportsAllDrives: "true",
          fields: `files(${FILE_FIELDS})`,
        },
        fetchImpl,
      });
      const found = (response.files ?? []).map(normalizeDriveFile).filter(Boolean) as DriveFileEntity[];
      return found[0] ?? null;
    },
  });
}

async function createDriveFile(input: {
  userId: string;
  name: string;
  mimeType: string;
  idempotencyKey: string;
  fetchImpl?: DriveFetchLike;
}): Promise<{ file: DriveFileEntity; existing: boolean }> {
  const existing = await findByIdempotencyKey(
    input.userId,
    input.idempotencyKey,
    input.mimeType,
    input.fetchImpl,
  );
  if (existing) return { file: existing, existing: true };
  return driveRequestForUser({
    userId: input.userId,
    mutation: true,
    run: async (accessToken) => {
      const response = await driveJsonRequest<RawDriveFile>({
        accessToken,
        method: "POST",
        path: "/files",
        query: { fields: FILE_FIELDS, supportsAllDrives: "true" },
        body: {
          name: input.name,
          mimeType: input.mimeType,
          appProperties: { hulaRequestId: input.idempotencyKey },
        },
        fetchImpl: input.fetchImpl,
      });
      const file = normalizeDriveFile(response);
      if (!file || file.mimeType !== input.mimeType) {
        throw new DriveError("malformed_provider_response");
      }
      return { file, existing: false };
    },
  });
}

export async function createDriveFolder(input: {
  userId: string;
  name: string;
  idempotencyKey: string;
  fetchImpl?: DriveFetchLike;
}): Promise<DriveCreationReceipt> {
  const { file } = await createDriveFile({ ...input, mimeType: DRIVE_FOLDER_MIME });
  return {
    fileId: file.fileId,
    name: file.name,
    mimeType: file.mimeType,
    webViewLink: file.webViewLink,
    idempotencyKey: input.idempotencyKey,
  };
}

function docsText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  let result = "";
  const textRun = record.textRun;
  if (textRun && typeof textRun === "object") {
    result += str((textRun as Record<string, unknown>).content) ?? "";
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) result += child.map(docsText).join("");
    else if (child && typeof child === "object" && child !== textRun) result += docsText(child);
  }
  return result;
}

export async function createGoogleDoc(input: {
  userId: string;
  name: string;
  content: string;
  idempotencyKey: string;
  fetchImpl?: DriveFetchLike;
}): Promise<DriveCreationReceipt> {
  const { file, existing } = await createDriveFile({
    ...input,
    mimeType: GOOGLE_DOC_MIME,
  });
  if (!input.content) {
    return { ...fileReceipt(file, input.idempotencyKey), contentApplied: true };
  }
  try {
    const current = await driveRequestForUser({
      userId: input.userId,
      run: (accessToken) => driveJsonRequest<Record<string, unknown>>({
        accessToken,
        api: "docs",
        path: `/documents/${encodeURIComponent(file.fileId)}`,
        query: { includeTabsContent: "true" },
        fetchImpl: input.fetchImpl,
      }),
    });
    if (existing && docsText(current).includes(input.content)) {
      return { ...fileReceipt(file, input.idempotencyKey), contentApplied: true };
    }
    await driveRequestForUser({
      userId: input.userId,
      mutation: true,
      run: (accessToken) => driveJsonRequest<Record<string, unknown>>({
        accessToken,
        api: "docs",
        method: "POST",
        path: `/documents/${encodeURIComponent(file.fileId)}:batchUpdate`,
        body: { requests: [{ insertText: { location: { index: 1 }, text: input.content } }] },
        fetchImpl: input.fetchImpl,
      }),
    });
    return { ...fileReceipt(file, input.idempotencyKey), contentApplied: true };
  } catch {
    // The file creation is authoritative, but the multi-step content write is not.
    return {
      ...fileReceipt(file, input.idempotencyKey),
      contentApplied: false,
      partial: true,
    };
  }
}

function fileReceipt(file: DriveFileEntity, idempotencyKey: string): DriveCreationReceipt {
  return {
    fileId: file.fileId,
    name: file.name,
    mimeType: file.mimeType,
    webViewLink: file.webViewLink,
    idempotencyKey,
  };
}

export async function downloadDriveText(input: {
  userId: string;
  fileId: string;
  fetchImpl?: DriveFetchLike;
  maxBytes: number;
}): Promise<string> {
  return driveRequestForUser({
    userId: input.userId,
    run: (accessToken) => driveHttpRequest({
      accessToken,
      path: `/files/${encodeURIComponent(input.fileId)}`,
      query: { alt: "media", supportsAllDrives: "true" },
      fetchImpl: input.fetchImpl,
      maxBytes: input.maxBytes,
    }),
  });
}
