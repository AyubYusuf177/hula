import {
  createActionProposal,
  listRecentProposalsByAction,
  type ActionProposalView,
  type CreateProposalInput,
} from "../../../actions/proposals";
import type { OneDriveItem } from "./oneDriveTypes";

export const ONEDRIVE_SELECTION_ACTION_ID = "microsoft.onedrive.lastSelection" as const;
export const ONEDRIVE_ENTITY_ACTION_ID = "microsoft.onedrive.entityContext" as const;
export const ONEDRIVE_SELECTION_TTL_MS = 30 * 60 * 1_000;
export const ONEDRIVE_ENTITY_TTL_MS = 2 * 60 * 60 * 1_000;

export interface OneDriveItemRef {
  provider: "microsoft";
  service: "onedrive";
  driveId: string;
  itemId: string;
  name: string;
  isFolder: boolean;
  mimeType: string | null;
  modifiedAt: string | null;
  webUrl: string | null;
  contentAvailability: OneDriveItem["contentAvailability"];
}

export interface OneDriveContextStore {
  create?: (userId: string, input: CreateProposalInput) => Promise<{ id: string }>;
  listRecent?: (userId: string, actionId: string, limit?: number) => Promise<ActionProposalView[]>;
  now?: Date;
}

export function toOneDriveItemRef(item: OneDriveItem): OneDriveItemRef {
  return {
    provider: "microsoft",
    service: "onedrive",
    driveId: item.driveId,
    itemId: item.itemId,
    name: item.name,
    isFolder: item.isFolder,
    mimeType: item.mimeType,
    modifiedAt: item.modifiedAt,
    webUrl: item.webUrl,
    contentAvailability: item.contentAvailability,
  };
}

function parseRef(value: unknown): OneDriveItemRef | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.provider !== "microsoft" || raw.service !== "onedrive" || typeof raw.driveId !== "string" || typeof raw.itemId !== "string" || typeof raw.name !== "string") return null;
  const availability = raw.contentAvailability;
  return {
    provider: "microsoft",
    service: "onedrive",
    driveId: raw.driveId,
    itemId: raw.itemId,
    name: raw.name,
    isFolder: raw.isFolder === true,
    mimeType: typeof raw.mimeType === "string" ? raw.mimeType : null,
    modifiedAt: typeof raw.modifiedAt === "string" ? raw.modifiedAt : null,
    webUrl: typeof raw.webUrl === "string" ? raw.webUrl : null,
    contentAvailability: availability === "text" || availability === "folder" ? availability : "metadata_only",
  };
}

function live(row: ActionProposalView, now: Date): boolean {
  return Date.parse(row.expiresAt) > now.getTime();
}

export async function recordOneDriveSelection(
  userId: string,
  items: OneDriveItem[],
  store: OneDriveContextStore = {},
): Promise<void> {
  await (store.create ?? createActionProposal)(userId, {
    provider: "microsoft",
    actionId: ONEDRIVE_SELECTION_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: {
      kind: "onedrive_selection",
      items: items.slice(0, 20).map(toOneDriveItemRef),
      contextEstablishedAt: (store.now ?? new Date()).getTime(),
    },
    previewText: `Showed ${Math.min(items.length, 20)} OneDrive items.`,
    ttlMs: ONEDRIVE_SELECTION_TTL_MS,
  });
}

export async function recordOneDriveEntity(
  userId: string,
  item: OneDriveItem,
  store: OneDriveContextStore = {},
): Promise<void> {
  await (store.create ?? createActionProposal)(userId, {
    provider: "microsoft",
    actionId: ONEDRIVE_ENTITY_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: {
      kind: "onedrive_entity",
      ref: toOneDriveItemRef(item),
      contextEstablishedAt: (store.now ?? new Date()).getTime(),
    },
    previewText: "Selected a OneDrive item.",
    ttlMs: ONEDRIVE_ENTITY_TTL_MS,
  });
}

export async function loadOneDriveSelection(
  userId: string,
  store: OneDriveContextStore = {},
): Promise<OneDriveItemRef[]> {
  const rows = await (store.listRecent ?? listRecentProposalsByAction)(userId, ONEDRIVE_SELECTION_ACTION_ID, 100);
  const now = store.now ?? new Date();
  for (const row of rows) {
    if (!live(row, now) || row.input?.kind !== "onedrive_selection" || !Array.isArray(row.input.items)) continue;
    const refs = row.input.items.flatMap((item) => parseRef(item) ?? []);
    if (refs.length) return refs;
  }
  return [];
}

export async function loadOneDriveEntity(
  userId: string,
  store: OneDriveContextStore = {},
): Promise<OneDriveItemRef | null> {
  const rows = await (store.listRecent ?? listRecentProposalsByAction)(userId, ONEDRIVE_ENTITY_ACTION_ID, 100);
  const now = store.now ?? new Date();
  for (const row of rows) {
    if (!live(row, now) || row.input?.kind !== "onedrive_entity") continue;
    const ref = parseRef(row.input.ref);
    if (ref) return ref;
  }
  return null;
}

const WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

export function parseOneDriveOrdinal(text: string): number | null {
  const lower = text.toLowerCase();
  const word = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/.exec(lower);
  if (word) return WORDS[word[1]!] ?? null;
  const numeric = /^(?:#|number\s+)?(\d{1,2})(?:st|nd|rd|th)?\.?$/i.exec(text.trim());
  if (!numeric) return null;
  const value = Number(numeric[1]);
  return value >= 1 && value <= 20 ? value : null;
}

export async function resolveOneDriveReference(
  userId: string,
  text: string,
  ordinal: number | null | undefined,
  store: OneDriveContextStore = {},
): Promise<OneDriveItemRef | null> {
  const position = ordinal ?? parseOneDriveOrdinal(text);
  if (position) return (await loadOneDriveSelection(userId, store))[position - 1] ?? null;
  return loadOneDriveEntity(userId, store);
}
