import {
  createActionProposal,
  listRecentProposalsByAction,
  type ActionProposalView,
  type CreateProposalInput,
} from "../../../actions/proposals";
import type { DriveFileEntity } from "./types";
import { GOOGLE_DRIVE_PROVIDER } from "./types";

export const DRIVE_SELECTION_ACTION_ID = "drive.lastSelection";
export const DRIVE_ENTITY_ACTION_ID = "drive.entityContext";
export const DRIVE_AMBIGUITY_ACTION_ID = "drive.unresolvedAmbiguity";
const DRIVE_CONTEXT_TTL_MS = 30 * 60 * 1000;

export interface DriveContextRef {
  fileId: string;
  name: string;
  mimeType: string;
  ownerNames: string[];
  modifiedTime: string | null;
  parentIds: string[];
  webViewLink: string | null;
  driveId: string | null;
  contentAvailability: DriveFileEntity["contentAvailability"];
}

export interface DriveContextStore {
  create?: (userId: string, input: CreateProposalInput) => Promise<{ id: string }>;
  listRecent?: (userId: string, actionId: string, limit?: number) => Promise<ActionProposalView[]>;
  now?: Date;
}

export function toDriveContextRef(file: DriveFileEntity): DriveContextRef {
  return {
    fileId: file.fileId,
    name: file.name,
    mimeType: file.mimeType,
    ownerNames: file.owners.map((owner) => owner.displayName ?? owner.emailAddress).filter((value): value is string => Boolean(value)).slice(0, 5),
    modifiedTime: file.modifiedTime,
    parentIds: file.parents.slice(0, 5),
    webViewLink: file.webViewLink,
    driveId: file.driveId,
    contentAvailability: file.contentAvailability,
  };
}

function parseRef(value: unknown): DriveContextRef | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.fileId !== "string" || typeof raw.name !== "string" || typeof raw.mimeType !== "string") return null;
  const availability = raw.contentAvailability;
  if (![
    "google_doc", "plain_text", "metadata_only", "folder", "shortcut",
  ].includes(typeof availability === "string" ? availability : "")) return null;
  return {
    fileId: raw.fileId,
    name: raw.name,
    mimeType: raw.mimeType,
    ownerNames: Array.isArray(raw.ownerNames) ? raw.ownerNames.filter((item): item is string => typeof item === "string").slice(0, 5) : [],
    modifiedTime: typeof raw.modifiedTime === "string" ? raw.modifiedTime : null,
    parentIds: Array.isArray(raw.parentIds) ? raw.parentIds.filter((item): item is string => typeof item === "string").slice(0, 5) : [],
    webViewLink: typeof raw.webViewLink === "string" ? raw.webViewLink : null,
    driveId: typeof raw.driveId === "string" ? raw.driveId : null,
    contentAvailability: availability as DriveContextRef["contentAvailability"],
  };
}

let lastEstablishedAt = 0;
function nextEstablishedAt(): number {
  lastEstablishedAt = Math.max(Date.now(), lastEstablishedAt + 1);
  return lastEstablishedAt;
}

export async function recordDriveSelection(
  userId: string,
  files: DriveFileEntity[],
  store: DriveContextStore = {},
): Promise<void> {
  const refs = files.slice(0, 20).map(toDriveContextRef);
  if (refs.length === 0) return;
  await (store.create ?? createActionProposal)(userId, {
    provider: GOOGLE_DRIVE_PROVIDER,
    actionId: DRIVE_SELECTION_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: { kind: "drive_selection", refs, contextEstablishedAt: nextEstablishedAt() },
    previewText: `Showed ${refs.length} Google Drive results.`,
    ttlMs: DRIVE_CONTEXT_TTL_MS,
  });
}

export async function recordDriveEntity(
  userId: string,
  file: DriveFileEntity,
  store: DriveContextStore = {},
): Promise<void> {
  await (store.create ?? createActionProposal)(userId, {
    provider: GOOGLE_DRIVE_PROVIDER,
    actionId: DRIVE_ENTITY_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: { kind: "drive_entity", ref: toDriveContextRef(file), contextEstablishedAt: nextEstablishedAt() },
    previewText: "Google Drive entity context.",
    ttlMs: DRIVE_CONTEXT_TTL_MS,
  });
}

/** Records only a genuine clarification state; ordinary lists never create it. */
export async function recordDriveAmbiguity(
  userId: string,
  files: DriveFileEntity[],
  store: DriveContextStore = {},
): Promise<void> {
  const refs = files.slice(0, 20).map(toDriveContextRef);
  if (refs.length < 2) return;
  await (store.create ?? createActionProposal)(userId, {
    provider: GOOGLE_DRIVE_PROVIDER,
    actionId: DRIVE_AMBIGUITY_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: { kind: "drive_ambiguity", refs, contextEstablishedAt: nextEstablishedAt() },
    previewText: `Google Drive clarification with ${refs.length} candidates.`,
    ttlMs: DRIVE_CONTEXT_TTL_MS,
  });
}

export function parseDriveOrdinal(text: string | undefined): number | null {
  const value = (text ?? "").trim().toLowerCase();
  const words: Record<string, number> = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  };
  for (const [word, position] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\b`).test(value)) return position;
  }
  const numeric = /\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(value) ?? /^#?(\d{1,2})\.?$/.exec(value);
  if (numeric) return Math.min(Number(numeric[1]), 20);
  // "last modified" is a metadata predicate, not a request for the last
  // item in the prior list. Only treat last as an ordinal when it names an
  // item (or appears at the end of the reference).
  if (/\blast(?:\s+(?:one|file|document))?\s*[.!?]?$/.test(value)) return -1;
  return null;
}

async function liveRows(userId: string, actionId: string, store: DriveContextStore): Promise<ActionProposalView[]> {
  // Context rows are append-only read markers. Ask for a generous bounded
  // window before applying logical contextEstablishedAt ordering; a backend
  // with tied createdAt values (or oldest-first ordering) must not hide the
  // latest active entity behind the first ten historical follow-ups.
  const rows = await (store.listRecent ?? listRecentProposalsByAction)(userId, actionId, 1000);
  const now = (store.now ?? new Date()).getTime();
  return rows.filter((row) => Date.parse(row.expiresAt) > now);
}

function establishedAt(row: ActionProposalView): number {
  const value = row.input?.contextEstablishedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : Date.parse(row.createdAt);
}

async function selectionState(
  userId: string,
  store: DriveContextStore,
): Promise<{ refs: DriveContextRef[]; at: number } | null> {
  const rows = await liveRows(userId, DRIVE_SELECTION_ACTION_ID, store);
  for (const row of rows.sort((a, b) => establishedAt(b) - establishedAt(a))) {
    if (row.input?.kind !== "drive_selection" || !Array.isArray(row.input.refs)) continue;
    const refs = row.input.refs.map(parseRef);
    if (refs.every(Boolean)) return { refs: refs as DriveContextRef[], at: establishedAt(row) };
  }
  return null;
}

async function entityState(
  userId: string,
  store: DriveContextStore,
): Promise<{ ref: DriveContextRef; at: number } | null> {
  const rows = await liveRows(userId, DRIVE_ENTITY_ACTION_ID, store);
  for (const row of rows.sort((a, b) => establishedAt(b) - establishedAt(a))) {
    if (row.input?.kind !== "drive_entity") continue;
    const ref = parseRef(row.input.ref);
    if (ref) return { ref, at: establishedAt(row) };
  }
  return null;
}

async function ambiguityState(
  userId: string,
  store: DriveContextStore,
): Promise<{ refs: DriveContextRef[]; at: number } | null> {
  const rows = await liveRows(userId, DRIVE_AMBIGUITY_ACTION_ID, store);
  for (const row of rows.sort((a, b) => establishedAt(b) - establishedAt(a))) {
    if (row.input?.kind !== "drive_ambiguity" || !Array.isArray(row.input.refs)) continue;
    const refs = row.input.refs.map(parseRef);
    if (refs.length > 1 && refs.every(Boolean)) return { refs: refs as DriveContextRef[], at: establishedAt(row) };
  }
  return null;
}

export async function loadDriveSelection(
  userId: string,
  store: DriveContextStore = {},
): Promise<DriveContextRef[]> {
  return (await selectionState(userId, store))?.refs ?? [];
}

export async function loadDriveEntity(
  userId: string,
  store: DriveContextStore = {},
): Promise<DriveContextRef | null> {
  return (await entityState(userId, store))?.ref ?? null;
}

export async function resolveDriveReference(
  userId: string,
  text: string | undefined,
  explicitPosition?: number | null,
  store: DriveContextStore = {},
): Promise<DriveContextRef | null> {
  const position = explicitPosition ?? parseDriveOrdinal(text);
  if (position !== null) {
    const selection = await loadDriveSelection(userId, store);
    const index = position === -1 ? selection.length - 1 : position - 1;
    return selection[index] ?? null;
  }
  const [entity, selection, ambiguity] = await Promise.all([
    entityState(userId, store),
    selectionState(userId, store),
    ambiguityState(userId, store),
  ]);
  // Selection results and unresolved ambiguity are different state. Only an
  // explicit clarification request may suspend an older active entity, and a
  // later explicit selection/entity resolution deterministically clears it.
  if (ambiguity && (!entity || ambiguity.at > entity.at)) return null;
  // An explicitly grounded entity is the durable current target. A list is
  // only a fallback for unresolved references; it must never regain priority
  // merely because its provider row was written later or ordered differently.
  if (entity) return entity.ref;
  if (!selection) return null;
  return selection.refs[0] ?? null;
}
