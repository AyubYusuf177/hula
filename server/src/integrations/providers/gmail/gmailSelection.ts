import {
  createActionProposal,
  listRecentProposalsByAction,
  type ActionProposalView,
  type CreateProposalInput,
} from "../../../actions/proposals";
import { GMAIL_PROVIDER } from "./types";

/**
 * Last-shown Gmail selection context (Section 17).
 *
 * When Hula shows a NUMBERED list — search results or drafts — the numbers must
 * actually mean something: "summarise the second one", "open the second draft",
 * "delete that draft". This remembers the exact, ordered list it last showed, so a
 * positional follow-up resolves to the EXACT provider id that occupied that
 * position — never a re-search, which could return a different order and act on the
 * wrong email.
 *
 * Like `gmailDraftContext` and `gmailClarification`, this REUSES the Section 12
 * proposal store rather than adding another persistence framework: one
 * `confirmationRequired:false` `ActionProposal` row under a dedicated pseudo
 * `actionId`. That flag keeps it INVISIBLE to the yes/no confirmation flow
 * (`getActiveProposal` only returns confirmation-requiring rows), so a "yes" meant
 * for a real send/delete can never resolve a selection instead.
 *
 * The redacted `inputJson` carries ONLY safe identifiers and display labels —
 * Gmail ids, sender/recipient, subject — never a token or a body.
 */

/** The pseudo action id under which a selection is persisted. */
export const GMAIL_SELECTION_ACTION_ID = "email.lastSelection" as const;

/** How long a shown list stays referenceable. */
export const SELECTION_TTL_MS = 30 * 60 * 1000;

/** What the remembered list is made of. */
export type GmailSelectionKind = "messages" | "drafts";

/** One safe, positional entry in a remembered list. */
export interface GmailSelectionItem {
  /** Gmail message id (`messages`) or draft id (`drafts`). */
  id: string;
  /** Thread id, when known — preserved so a reply stays in-thread. */
  threadId: string | null;
  /** Display label: the sender (messages) or the recipient (drafts). */
  label: string;
  subject: string;
  /**
   * When the message arrived (ISO), for `messages`. Remembered because a positional
   * follow-up ("summarise the second one") answers from THIS list without re-reading
   * metadata, and a summary of one email should say when it arrived. Safe metadata:
   * a timestamp, never content.
   */
  receivedAt?: string | null;
}

/** The redacted, SAFE payload describing one shown list. */
export interface GmailSelectionData {
  kind: "gmail_selection";
  itemKind: GmailSelectionKind;
  /** In the EXACT order shown to the user — index 0 is "the first one". */
  items: GmailSelectionItem[];
}

/** A loaded selection plus derived state. */
export interface LoadedGmailSelection {
  id: string;
  data: GmailSelectionData;
  expired: boolean;
  createdAt: string;
}

// --- Reference detection (PURE) ------------------------------------------

/**
 * PURE: does this message refer to the list Hula last showed?
 *
 * This is the fix for the real failure that shipped: every Gmail prefilter required
 * an email NOUN ("email", "inbox", "message"), but once a list is on screen the user
 * stops naming emails entirely — "Star the first one", "Summarise them", "Which of
 * these need my attention?". None of those matched anything, so they fell through to
 * the generic model, which denied a capability that actually exists.
 *
 * So prefilters must accept a REFERENCE as an alternative to an email noun. This
 * only claims that the message points at something previously shown; whether a list
 * actually exists, and what it holds, is resolved later against the stored selection
 * — with no selection, the caller falls through unchanged.
 */
export function referencesLastResults(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  // A positional reference ("the first one", "the 2nd", "number 3", a bare "2").
  if (parseOrdinalReference(t)) return true;
  // Plural/collective references to the shown set.
  if (/\b(?:them|these|those|they)\b/.test(t)) return true;
  // Singular demonstratives paired with a picking/act verb ("star that one").
  if (/\b(?:that|this|it)\s+one\b/.test(t)) return true;
  return false;
}

// --- Ordinal references (PURE) -------------------------------------------

const WORD_ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  last: -1,
};

/** A resolved positional reference: a 1-based position, or the last item. */
export type OrdinalReference = { position: number } | { last: true };

/**
 * PURE: parse a positional reference out of a message.
 *
 * Handles "the second one", "the 2nd", "number 2", "option 2", "open draft 3", and
 * a bare "2". Returns null when the message names no position, so an ordinary
 * message is never treated as a selection.
 *
 * Deliberately conservative about bare numbers: only a message that is ENTIRELY a
 * number counts, so "change 5pm to 6pm" is never read as "item 5".
 */
export function parseOrdinalReference(text: string | undefined): OrdinalReference | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;

  // A message that is nothing but a number: "2", "2." — a direct pick.
  const bare = /^#?(\d{1,2})\.?$/.exec(t);
  if (bare) {
    const n = Number(bare[1]);
    return n >= 1 && n <= 20 ? { position: n } : null;
  }

  // "the last one" / "the latest one".
  if (/\b(?:the\s+)?last\s+one\b/.test(t)) return { last: true };

  // Word ordinals: "the second one", "open the second draft".
  const word = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/.exec(t);
  if (word) {
    const n = WORD_ORDINALS[word[1]!];
    if (n && n > 0) return { position: n };
  }

  // Numeric ordinals and explicit indexes: "the 2nd", "number 2", "option 3",
  // "draft 3", "email 2".
  const numeric =
    /\b(?:(\d{1,2})(?:st|nd|rd|th)\b|(?:number|option|item|draft|email|message)\s+#?(\d{1,2})\b)/.exec(t);
  if (numeric) {
    const n = Number(numeric[1] ?? numeric[2]);
    if (n >= 1 && n <= 20) return { position: n };
  }

  return null;
}

/**
 * PURE: resolve a reference against a remembered list.
 *
 * Returns the item, or null when the position doesn't exist — an out-of-range pick
 * ("the fifth one" over three results) must ask, never silently clamp to the
 * nearest item and act on the wrong email.
 */
export function resolveSelectionItem(
  data: GmailSelectionData,
  ref: OrdinalReference,
): GmailSelectionItem | null {
  if ("last" in ref) return data.items[data.items.length - 1] ?? null;
  const idx = ref.position - 1;
  if (idx < 0 || idx >= data.items.length) return null;
  return data.items[idx] ?? null;
}

// --- Persistence ---------------------------------------------------------

/** PURE: validate that a redacted proposal input is a selection payload. */
export function parseGmailSelectionData(
  input: Record<string, unknown> | null,
): GmailSelectionData | null {
  if (!input || input.kind !== "gmail_selection") return null;
  const itemKind = input.itemKind;
  if (itemKind !== "messages" && itemKind !== "drafts") return null;
  const rawItems = input.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;

  const items: GmailSelectionItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length === 0) return null;
    items.push({
      id: r.id,
      threadId: typeof r.threadId === "string" ? r.threadId : null,
      label: typeof r.label === "string" ? r.label : "",
      subject: typeof r.subject === "string" ? r.subject : "",
      receivedAt: typeof r.receivedAt === "string" ? r.receivedAt : null,
    });
  }
  return { kind: "gmail_selection", itemKind, items };
}

/** Injectable persistence so the whole flow runs with NO database in tests. */
export interface GmailSelectionStore {
  create?: (userId: string, input: CreateProposalInput) => Promise<{ id: string }>;
  listRecent?: (userId: string, actionId: string) => Promise<ActionProposalView[]>;
}

/** Cap on remembered items — matches what we ever show. */
const MAX_ITEMS = 10;

/**
 * Remember the list Hula just showed. Best-effort at the call site: a failure here
 * must never block the list reply itself — the user just loses the ability to say
 * "the second one" and can re-ask by name.
 */
export async function recordGmailSelection(
  userId: string,
  data: GmailSelectionData,
  store: GmailSelectionStore = {},
): Promise<{ id: string }> {
  const create = store.create ?? createActionProposal;
  const bounded: GmailSelectionData = {
    ...data,
    items: data.items.slice(0, MAX_ITEMS),
  };
  return create(userId, {
    provider: GMAIL_PROVIDER,
    actionId: GMAIL_SELECTION_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: bounded as unknown as Record<string, unknown>,
    previewText: `Showed ${bounded.items.length} ${bounded.itemKind}.`,
    ttlMs: SELECTION_TTL_MS,
  });
}

/**
 * Load the most recent NON-expired selection for a user, or null. Expired and
 * malformed rows are skipped rather than used — a stale list must not resolve a
 * position, because the numbers the user is looking at may be long gone.
 */
export async function loadLatestGmailSelection(
  userId: string,
  store: GmailSelectionStore = {},
): Promise<LoadedGmailSelection | null> {
  const listRecent = store.listRecent ?? listRecentProposalsByAction;
  const rows = await listRecent(userId, GMAIL_SELECTION_ACTION_ID);
  for (const row of rows) {
    const data = parseGmailSelectionData(row.input);
    if (!data) continue;
    if (Date.parse(row.expiresAt) <= Date.now()) continue;
    return { id: row.id, data, expired: false, createdAt: row.createdAt };
  }
  return null;
}
