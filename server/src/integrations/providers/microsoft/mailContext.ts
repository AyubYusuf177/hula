import {
  createActionProposal,
  listRecentProposalsByAction,
  type ActionProposalView,
  type CreateProposalInput,
} from "../../../actions/proposals";
import type { OutlookAddress, OutlookAttachment, OutlookMessage } from "./mailTypes";

export const OUTLOOK_SELECTION_ACTION_ID = "microsoft.mail.lastSelection" as const;
export const OUTLOOK_ENTITY_ACTION_ID = "microsoft.mail.entityContext" as const;
export const OUTLOOK_DRAFT_ACTION_ID = "microsoft.mail.lastDraft" as const;
export const OUTLOOK_SELECTION_TTL_MS = 30 * 60 * 1000;
export const OUTLOOK_ENTITY_TTL_MS = 2 * 60 * 60 * 1000;

export interface OutlookMessageRef {
  provider: "microsoft";
  service: "outlook_mail";
  itemKind: "message" | "draft";
  id: string;
  conversationId: string | null;
  parentFolderId: string | null;
  senderAddress: string | null;
  senderName: string | null;
  subject: string;
  receivedAt: string | null;
  isRead: boolean;
}

export interface OutlookSelectionData {
  kind: "outlook_selection";
  contextEstablishedAt: number;
  items: OutlookMessageRef[];
}

export interface OutlookEntityData {
  kind: "outlook_entity";
  contextEstablishedAt: number;
  ref: OutlookMessageRef;
  grounded: OutlookMessage;
}

export interface OutlookEntityInvalidationData {
  kind: "outlook_entity_invalidated";
  contextEstablishedAt: number;
  draftId: string;
}

export interface OutlookGroundedEntity {
  ref: OutlookMessageRef;
  message: OutlookMessage | null;
}

export interface OutlookContextStore {
  create?: (userId: string, input: CreateProposalInput) => Promise<unknown>;
  listRecent?: (userId: string, actionId: string, limit?: number) => Promise<ActionProposalView[]>;
  now?: Date;
}

export function toOutlookMessageRef(message: OutlookMessage): OutlookMessageRef {
  const sender = message.sender ?? message.from;
  return {
    provider: "microsoft",
    service: "outlook_mail",
    itemKind: message.isDraft ? "draft" : "message",
    id: message.id,
    conversationId: message.conversationId,
    parentFolderId: message.parentFolderId,
    senderAddress: sender?.address ?? null,
    senderName: sender?.name ?? null,
    subject: message.subject,
    receivedAt: message.receivedAt,
    isRead: message.isRead,
  };
}

function boundedText(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

function snapshotAddress(value: OutlookAddress): OutlookAddress {
  return {
    address: value.address.slice(0, 320),
    name: boundedText(value.name, 300),
  };
}

/** Persist only the normalized, bounded evidence Hula already showed or analysed. */
function groundedSnapshot(message: OutlookMessage): OutlookMessage {
  return {
    ...message,
    id: message.id.slice(0, 1_000),
    conversationId: boundedText(message.conversationId, 1_000),
    internetMessageId: boundedText(message.internetMessageId, 1_000),
    parentFolderId: boundedText(message.parentFolderId, 1_000),
    subject: message.subject.slice(0, 998),
    from: message.from ? snapshotAddress(message.from) : null,
    sender: message.sender ? snapshotAddress(message.sender) : null,
    replyTo: message.replyTo.slice(0, 50).map(snapshotAddress),
    to: message.to.slice(0, 50).map(snapshotAddress),
    cc: message.cc.slice(0, 50).map(snapshotAddress),
    bcc: message.bcc.slice(0, 50).map(snapshotAddress),
    preview: message.preview.slice(0, 500),
    body: boundedText(message.body, 12_000),
    attachments: message.attachments.slice(0, 50).map((item) => ({
      ...item,
      id: item.id.slice(0, 1_000),
      name: item.name.slice(0, 500),
      contentType: boundedText(item.contentType, 300),
    })),
  };
}

function parseAddress(value: unknown): OutlookAddress | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.address !== "string" || !raw.address) return null;
  return {
    address: raw.address.slice(0, 320),
    name: typeof raw.name === "string" ? raw.name.slice(0, 300) : null,
  };
}

function parseAddresses(value: unknown): OutlookAddress[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.slice(0, 50).map(parseAddress);
  return parsed.every(Boolean) ? parsed as OutlookAddress[] : null;
}

function parseAttachment(value: unknown): OutlookAttachment | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string") return null;
  const kind = raw.kind;
  if (kind !== "file" && kind !== "item" && kind !== "reference" && kind !== "unknown") return null;
  return {
    id: raw.id.slice(0, 1_000),
    name: raw.name.slice(0, 500),
    contentType: typeof raw.contentType === "string" ? raw.contentType.slice(0, 300) : null,
    size: typeof raw.size === "number" && Number.isFinite(raw.size) ? Math.max(0, Math.trunc(raw.size)) : 0,
    isInline: raw.isInline === true,
    kind,
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Validate persisted JSON before it becomes model evidence. Old ref-only rows return null. */
export function parseGroundedOutlookMessage(value: unknown, ref: OutlookMessageRef): OutlookMessage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.id !== ref.id || typeof raw.subject !== "string") return null;
  const from = raw.from === null ? null : parseAddress(raw.from);
  const sender = raw.sender === null ? null : parseAddress(raw.sender);
  const replyTo = parseAddresses(raw.replyTo);
  const to = parseAddresses(raw.to);
  const cc = parseAddresses(raw.cc);
  const bcc = parseAddresses(raw.bcc);
  if ((raw.from !== null && !from) || (raw.sender !== null && !sender) || !replyTo || !to || !cc || !bcc) return null;
  if (!Array.isArray(raw.attachments)) return null;
  const attachments = raw.attachments.slice(0, 50).map(parseAttachment);
  if (!attachments.every(Boolean)) return null;
  const importance = raw.importance;
  const bodyType = raw.bodyType;
  if (importance !== "low" && importance !== "normal" && importance !== "high") return null;
  if (bodyType !== null && bodyType !== "text" && bodyType !== "html") return null;
  return {
    id: ref.id,
    conversationId: nullableString(raw.conversationId),
    internetMessageId: nullableString(raw.internetMessageId),
    parentFolderId: nullableString(raw.parentFolderId),
    subject: raw.subject.slice(0, 998),
    from,
    sender,
    replyTo,
    to,
    cc,
    bcc,
    receivedAt: nullableString(raw.receivedAt),
    sentAt: nullableString(raw.sentAt),
    createdAt: nullableString(raw.createdAt),
    modifiedAt: nullableString(raw.modifiedAt),
    isRead: raw.isRead === true,
    isDraft: raw.isDraft === true,
    importance,
    hasAttachments: raw.hasAttachments === true,
    preview: typeof raw.preview === "string" ? raw.preview.slice(0, 500) : "",
    body: raw.body === null ? null : typeof raw.body === "string" ? raw.body.slice(0, 12_000) : null,
    bodyType,
    attachments: attachments as OutlookAttachment[],
  };
}

function parseRef(value: unknown): OutlookMessageRef | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.provider !== "microsoft" || raw.service !== "outlook_mail") return null;
  if (typeof raw.id !== "string" || !raw.id || typeof raw.subject !== "string") return null;
  return {
    provider: "microsoft",
    service: "outlook_mail",
    itemKind: raw.itemKind === "draft" ? "draft" : "message",
    id: raw.id,
    conversationId: typeof raw.conversationId === "string" ? raw.conversationId : null,
    parentFolderId: typeof raw.parentFolderId === "string" ? raw.parentFolderId : null,
    senderAddress: typeof raw.senderAddress === "string" ? raw.senderAddress : null,
    senderName: typeof raw.senderName === "string" ? raw.senderName : null,
    subject: raw.subject,
    receivedAt: typeof raw.receivedAt === "string" ? raw.receivedAt : null,
    isRead: raw.isRead === true,
  };
}

function live(row: ActionProposalView, now: Date): boolean {
  return Date.parse(row.expiresAt) > now.getTime();
}

export async function recordOutlookSelection(
  userId: string,
  messages: OutlookMessage[],
  store: OutlookContextStore = {},
): Promise<void> {
  if (!messages.length) return;
  await (store.create ?? createActionProposal)(userId, {
    provider: "microsoft",
    actionId: OUTLOOK_SELECTION_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: {
      kind: "outlook_selection",
      contextEstablishedAt: (store.now ?? new Date()).getTime(),
      items: messages.slice(0, 20).map(toOutlookMessageRef),
    },
    previewText: "Outlook message selection context.",
    ttlMs: OUTLOOK_SELECTION_TTL_MS,
  });
}

export async function recordOutlookEntity(
  userId: string,
  message: OutlookMessage,
  store: OutlookContextStore = {},
): Promise<void> {
  await (store.create ?? createActionProposal)(userId, {
    provider: "microsoft",
    actionId: message.isDraft ? OUTLOOK_DRAFT_ACTION_ID : OUTLOOK_ENTITY_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: {
      kind: "outlook_entity",
      contextEstablishedAt: (store.now ?? new Date()).getTime(),
      ref: toOutlookMessageRef(message),
      grounded: groundedSnapshot(message),
    },
    previewText: "Outlook message context.",
    ttlMs: OUTLOOK_ENTITY_TTL_MS,
  });
}

/** End the active lifetime of an unsent draft after a verified send/delete. */
export async function invalidateOutlookDraftEntity(
  userId: string,
  draftId: string,
  store: OutlookContextStore = {},
): Promise<void> {
  await (store.create ?? createActionProposal)(userId, {
    provider: "microsoft",
    actionId: OUTLOOK_DRAFT_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: {
      kind: "outlook_entity_invalidated",
      contextEstablishedAt: (store.now ?? new Date()).getTime(),
      draftId: draftId.slice(0, 1_000),
    },
    previewText: "Outlook draft context ended.",
    ttlMs: OUTLOOK_ENTITY_TTL_MS,
  });
}

export async function loadOutlookSelection(
  userId: string,
  store: OutlookContextStore = {},
): Promise<OutlookMessageRef[]> {
  const rows = await (store.listRecent ?? listRecentProposalsByAction)(userId, OUTLOOK_SELECTION_ACTION_ID, 10);
  const now = store.now ?? new Date();
  for (const row of rows) {
    if (!live(row, now) || row.input?.kind !== "outlook_selection" || !Array.isArray(row.input.items)) continue;
    const refs = row.input.items.flatMap((item) => parseRef(item) ?? []);
    if (refs.length) return refs;
  }
  return [];
}

export async function loadOutlookEntity(
  userId: string,
  itemKind: "message" | "draft" | "either" = "either",
  store: OutlookContextStore = {},
): Promise<OutlookMessageRef | null> {
  return (await loadGroundedOutlookEntity(userId, itemKind, store))?.ref ?? null;
}

/** Load active entity identity plus any sufficient evidence persisted with it. */
export async function loadGroundedOutlookEntity(
  userId: string,
  itemKind: "message" | "draft" | "either" = "either",
  store: OutlookContextStore = {},
  messageId?: string,
): Promise<OutlookGroundedEntity | null> {
  const actionIds = itemKind === "message"
    ? [OUTLOOK_ENTITY_ACTION_ID]
    : itemKind === "draft"
      ? [OUTLOOK_DRAFT_ACTION_ID]
      : [OUTLOOK_ENTITY_ACTION_ID, OUTLOOK_DRAFT_ACTION_ID];
  const now = store.now ?? new Date();
  const found: { ref: OutlookMessageRef; message: OutlookMessage | null; at: number }[] = [];
  for (const actionId of actionIds) {
    const rows = await (store.listRecent ?? listRecentProposalsByAction)(userId, actionId, 10);
    for (const row of rows) {
      if (!live(row, now)) continue;
      if (actionId === OUTLOOK_DRAFT_ACTION_ID && row.input?.kind === "outlook_entity_invalidated") break;
      if (row.input?.kind !== "outlook_entity") continue;
      const ref = parseRef(row.input.ref);
      if (ref && (!messageId || ref.id === messageId)) {
        found.push({ ref, message: parseGroundedOutlookMessage(row.input.grounded, ref), at: Date.parse(row.createdAt) });
      }
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found[0] ? { ref: found[0].ref, message: found[0].message } : null;
}

export function parseOutlookOrdinal(text: string): number | null {
  const lower = text.toLowerCase();
  const words: Record<string, number> = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  };
  for (const [word, value] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return value;
  }
  const match = /\b(?:number\s*)?(\d{1,2})(?:st|nd|rd|th)?\b/.exec(lower);
  const value = match?.[1] ? Number(match[1]) : NaN;
  return Number.isInteger(value) && value >= 1 && value <= 20 ? value : null;
}

export async function resolveOutlookReference(
  userId: string,
  text: string,
  ordinal: number | null | undefined,
  itemKind: "message" | "draft" | "either" = "either",
  store: OutlookContextStore = {},
): Promise<OutlookMessageRef | null> {
  const position = ordinal ?? parseOutlookOrdinal(text);
  if (position) {
    const selection = await loadOutlookSelection(userId, store);
    const ref = selection[position - 1] ?? null;
    return ref && (itemKind === "either" || ref.itemKind === itemKind) ? ref : null;
  }
  return loadOutlookEntity(userId, itemKind, store);
}
