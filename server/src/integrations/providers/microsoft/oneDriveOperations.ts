import { normalizePlainTextDocument } from "../googleDrive/content";
import type { DriveDocumentContent } from "../googleDrive/types";
import { logger } from "../../../utils/logger";
import {
  isSafeMicrosoftNextLink,
  microsoftGraphRequest,
  MicrosoftGraphError,
  type MicrosoftGraphRequestOptions,
} from "./graph";
import type { OneDriveContentAvailability, OneDriveIdentity, OneDriveItem, OneDriveTextContent } from "./oneDriveTypes";

const ITEM_SELECT = [
  "id", "name", "size", "createdDateTime", "lastModifiedDateTime", "createdBy", "lastModifiedBy",
  "webUrl", "parentReference", "file", "folder", "shared", "remoteItem",
].join(",");
export const ONEDRIVE_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const ONEDRIVE_TEXT_MAX_CHARACTERS = 160_000;
export const ONEDRIVE_MAX_LIST_ITEMS = 75;
export const ONEDRIVE_MAX_LIST_PAGES = 3;

export interface OneDriveDeps {
  request?: <T>(userId: string, options: MicrosoftGraphRequestOptions) => Promise<T>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function iso(value: unknown): string | null {
  const raw = string(value);
  if (!raw || !Number.isFinite(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}

function safeUrl(value: unknown): string | null {
  const raw = string(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function identity(value: unknown): OneDriveIdentity {
  const raw = object(value);
  const user = object(raw?.user) ?? object(raw?.application) ?? object(raw?.device);
  return {
    name: string(user?.displayName),
    email: string(user?.email)?.toLowerCase() ?? null,
    id: string(user?.id),
  };
}

function extension(name: string): string | null {
  const match = /\.([^.]+)$/.exec(name.toLowerCase());
  return match?.[1] ?? null;
}

export function oneDriveContentAvailability(name: string, mimeType: string | null, isFolder: boolean): OneDriveContentAvailability {
  if (isFolder) return "folder";
  const ext = extension(name);
  if (mimeType) {
    if (/^(?:text\/plain|text\/markdown|text\/csv|application\/(?:json|csv))$/i.test(mimeType)) return "text";
    // Graph's MIME type is authoritative when it identifies a binary. A file
    // named "notes.txt.docx" must never be decoded or treated as trusted text.
    return "metadata_only";
  }
  if (["txt", "md", "markdown", "csv", "json"].includes(ext ?? "")) return "text";
  return "metadata_only";
}

export function normalizeOneDriveItem(value: unknown): OneDriveItem | null {
  const outer = object(value);
  const remote = object(outer?.remoteItem);
  const raw = remote ?? outer;
  const itemId = string(raw?.id);
  const name = string(raw?.name);
  const parent = object(raw?.parentReference);
  const driveId = string(parent?.driveId) ?? string(object(outer?.parentReference)?.driveId);
  if (!itemId || !name || !driveId) return null;
  const file = object(raw?.file);
  const folder = object(raw?.folder);
  const createdBy = identity(raw?.createdBy);
  const modifiedBy = identity(raw?.lastModifiedBy);
  const isFolder = Boolean(folder);
  const mimeType = string(file?.mimeType);
  return {
    provider: "microsoft",
    service: "onedrive",
    driveId,
    itemId,
    name,
    isFolder,
    mimeType,
    extension: extension(name),
    sizeBytes: integer(raw?.size),
    createdAt: iso(raw?.createdDateTime),
    modifiedAt: iso(raw?.lastModifiedDateTime),
    createdBy,
    modifiedBy,
    owner: { name: null, email: null, id: null },
    webUrl: safeUrl(raw?.webUrl),
    parentDriveId: string(parent?.driveId),
    parentItemId: string(parent?.id),
    parentPath: string(parent?.path),
    childCount: integer(folder?.childCount),
    shared: Boolean(raw?.shared) || Boolean(remote),
    remote: Boolean(remote),
    contentAvailability: oneDriveContentAvailability(name, mimeType, isFolder),
  };
}

function collection(value: unknown): { items: unknown[]; nextLink: string | null } {
  const raw = object(value);
  if (!raw || !Array.isArray(raw.value)) throw new MicrosoftGraphError("malformed_provider_response");
  const nextLink = string(raw["@odata.nextLink"]);
  if (nextLink && !isSafeMicrosoftNextLink(nextLink)) throw new MicrosoftGraphError("malformed_provider_response");
  return { items: raw.value, nextLink };
}

async function listPages(
  userId: string,
  first: MicrosoftGraphRequestOptions,
  limit: number,
  deps: OneDriveDeps,
  operation: "root" | "recent" | "folder" | "search",
): Promise<{ items: OneDriveItem[]; hasMore: boolean }> {
  const request = deps.request ?? microsoftGraphRequest;
  const capped = Math.min(Math.max(limit, 1), ONEDRIVE_MAX_LIST_ITEMS);
  let nextLink: string | null = null;
  let pages = 0;
  const items: OneDriveItem[] = [];
  const seen = new Set<string>();
  do {
    const raw = await request<unknown>(userId, nextLink
      ? { capability: "onedrive.read", nextLink }
      : first);
    const page = collection(raw);
    for (const candidate of page.items) {
      const item = normalizeOneDriveItem(candidate);
      const key = item ? `${item.driveId}:${item.itemId}` : "";
      if (!item || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= capped) break;
    }
    nextLink = page.nextLink;
    pages += 1;
  } while (nextLink && pages < ONEDRIVE_MAX_LIST_PAGES && items.length < capped);
  logger.info("onedrive.provider listing outcome", {
    operation,
    resultCount: items.length,
    pagesFetched: pages,
    hasMore: Boolean(nextLink),
  });
  return { items, hasMore: Boolean(nextLink) };
}

export async function listOneDriveRoot(userId: string, limit = 10, deps: OneDriveDeps = {}) {
  return listPages(userId, {
    capability: "onedrive.read",
    path: "/me/drive/root/children",
    query: { "$select": ITEM_SELECT, "$orderby": "lastModifiedDateTime desc", "$top": Math.min(limit, 25) },
  }, limit, deps, "root");
}

export async function listOneDriveRecent(userId: string, limit = 10, deps: OneDriveDeps = {}) {
  return listPages(userId, {
    capability: "onedrive.read",
    path: "/me/drive/recent",
    query: { "$select": ITEM_SELECT, "$top": Math.min(limit, 25) },
  }, limit, deps, "recent");
}

export async function listOneDriveFolder(
  userId: string,
  folder: Pick<OneDriveItem, "driveId" | "itemId">,
  limit = 20,
  deps: OneDriveDeps = {},
) {
  return listPages(userId, {
    capability: "onedrive.read",
    path: `/drives/${encodeURIComponent(folder.driveId)}/items/${encodeURIComponent(folder.itemId)}/children`,
    query: { "$select": ITEM_SELECT, "$orderby": "lastModifiedDateTime desc", "$top": Math.min(limit, 25) },
  }, limit, deps, "folder");
}

export async function searchOneDriveItems(userId: string, query: string, limit = 10, deps: OneDriveDeps = {}) {
  const term = query.replace(/[\u0000-\u001f]/g, " ").replace(/'/g, "''").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!term) throw new MicrosoftGraphError("invalid_request");
  return listPages(userId, {
    capability: "onedrive.read",
    path: `/me/drive/root/search(q='${term}')`,
    query: { "$select": ITEM_SELECT, "$top": Math.min(limit, 25) },
  }, limit, deps, "search");
}

export async function getOneDriveItem(
  userId: string,
  ref: Pick<OneDriveItem, "driveId" | "itemId">,
  deps: OneDriveDeps = {},
): Promise<OneDriveItem> {
  const raw = await (deps.request ?? microsoftGraphRequest)<unknown>(userId, {
    capability: "onedrive.read",
    path: `/drives/${encodeURIComponent(ref.driveId)}/items/${encodeURIComponent(ref.itemId)}`,
    query: { "$select": ITEM_SELECT },
  });
  const item = normalizeOneDriveItem(raw);
  if (!item) throw new MicrosoftGraphError("malformed_provider_response");
  return item;
}

export async function getOneDriveDriveOwner(
  userId: string,
  driveId: string,
  deps: OneDriveDeps = {},
): Promise<OneDriveIdentity> {
  const raw = await (deps.request ?? microsoftGraphRequest)<unknown>(userId, {
    capability: "onedrive.read",
    path: `/drives/${encodeURIComponent(driveId)}`,
    query: { "$select": "id,owner" },
  });
  return identity(object(raw)?.owner);
}

export async function getOneDriveTextContent(
  userId: string,
  item: OneDriveItem,
  deps: OneDriveDeps = {},
): Promise<OneDriveTextContent> {
  if (item.contentAvailability !== "text") throw new MicrosoftGraphError("unsupported_content");
  if (item.sizeBytes !== null && item.sizeBytes > ONEDRIVE_TEXT_MAX_BYTES) throw new MicrosoftGraphError("response_too_large");
  const raw = await (deps.request ?? microsoftGraphRequest)<string>(userId, {
    capability: "onedrive.read",
    path: `/drives/${encodeURIComponent(item.driveId)}/items/${encodeURIComponent(item.itemId)}/content`,
    responseKind: "text",
    headers: { Range: `bytes=0-${ONEDRIVE_TEXT_MAX_BYTES - 1}` },
  });
  if (Buffer.byteLength(raw, "utf8") > ONEDRIVE_TEXT_MAX_BYTES) throw new MicrosoftGraphError("response_too_large");
  const text = raw.slice(0, ONEDRIVE_TEXT_MAX_CHARACTERS);
  logger.info("onedrive.content loaded", {
    mimeCategory: item.extension ?? "text",
    contentLength: text.length,
    truncated: text.length < raw.length,
  });
  return {
    item,
    text,
    originalCharacters: raw.length,
    processedCharacters: text.length,
    truncated: text.length < raw.length,
  };
}

export function oneDriveDocumentContent(content: OneDriveTextContent): DriveDocumentContent {
  const normalized = normalizePlainTextDocument({
    fileId: `${content.item.driveId}:${content.item.itemId}`,
    name: content.item.name,
    mimeType: content.item.mimeType ?? `text/${content.item.extension ?? "plain"}`,
  }, content.text);
  return {
    ...normalized,
    originalCharacters: content.originalCharacters,
    processedCharacters: content.processedCharacters,
    truncated: content.truncated,
    complete: !content.truncated,
  };
}
