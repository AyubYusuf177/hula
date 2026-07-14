import {
  createActionProposal,
  listRecentProposalsByAction,
  type ActionProposalView,
  type CreateProposalInput,
} from "../../../actions/proposals";
import { GOOGLE_CALENDAR_PROVIDER, type NormalizedCalendarEvent } from "./types";

/**
 * Calendar conversational context (Section 18) — what "it", "that meeting", and
 * "the second one" actually mean.
 *
 * Two DIFFERENT memories with different lifetimes, kept apart on purpose (the
 * Gmail side learned this the hard way — see `gmailEntityContext`):
 *
 *  - The RESULT SET: the ordered, numbered list Hula last showed. "Cancel the
 *    second one" means position 2 OF THAT LIST — resolved against a stored
 *    snapshot, never by re-running the search. A re-search is not equivalent: a
 *    newly created event can shift what "the second one" points at between the
 *    moment the user reads the list and the moment they reply, and the write
 *    would land on an event they never saw. Snapshotting the ids is what makes
 *    numbered references STABLE, which is the property the section asks for.
 *
 *  - The ENTITY the conversation is ABOUT: the event explicitly picked, and the
 *    event an action VERIFIABLY landed on. That is what "it", "that meeting",
 *    "the meeting you just created", and "move it to Friday" resolve against.
 *
 * `acted` is written ONLY after a postcondition-verified write. An unverified or
 * failed action leaves it untouched, so "undo that" can never offer to reverse
 * something that never happened.
 *
 * Storage REUSES the Section 12 proposal store (exactly as the Gmail context
 * modules do) rather than adding another persistence mechanism: one
 * `confirmationRequired:false` row under a dedicated pseudo `actionId`, which
 * keeps it invisible to the yes/no confirmation flow and survives a restart.
 * Rows are user-scoped by the store, so one user's "it" can never resolve to
 * another user's event. The payload carries safe identifiers and display labels
 * only — never a raw provider payload.
 */

/** The pseudo action ids under which calendar context is persisted. */
export const CALENDAR_SELECTION_ACTION_ID = "calendar.lastSelection" as const;
export const CALENDAR_ENTITY_CONTEXT_ACTION_ID = "calendar.entityContext" as const;

/** How long a shown list stays referenceable by number. */
export const CALENDAR_SELECTION_TTL_MS = 30 * 60 * 1000;

/**
 * How long the conversation stays "about" an event. Longer than the list window
 * on purpose: "move it to Friday" arrives in the flow of conversation, but a
 * user may also come back after a meeting. Two hours is long enough to be useful
 * and short enough that a stale "it" cannot silently mutate the wrong event —
 * after it lapses, Hula asks.
 */
export const CALENDAR_ENTITY_TTL_MS = 2 * 60 * 60 * 1000;

/** One safe, positional entry in a remembered list. */
export interface CalendarSelectionItem {
  /** The Google-issued event id — the stable handle a follow-up acts on. */
  id: string;
  /** The series id, when this is a recurring instance. */
  recurringEventId: string | null;
  /** Display label only. Never a raw payload. */
  title: string;
  /** ISO instant (or `YYYY-MM-DD` for all-day), as shown. */
  start: string | null;
  end: string | null;
  allDay: boolean;
}

/** The redacted, SAFE payload describing one shown list. */
export interface CalendarSelectionData {
  kind: "calendar_selection";
  /** In the EXACT order shown to the user — index 0 is "the first one". */
  items: CalendarSelectionItem[];
}

/** What an action verifiably did to an event. */
export type CalendarActedKind = "created" | "updated" | "cancelled";

/** An action that VERIFIABLY landed, plus what it proved. */
export interface CalendarActedEntity {
  event: CalendarSelectionItem;
  kind: CalendarActedKind;
  /** ISO instant the action was verified. */
  at: string;
}

/** The safe payload describing the conversation's current subject. */
export interface CalendarEntityContextData {
  kind: "calendar_entity_context";
  /** The event the user explicitly picked ("the second one"), when they did. */
  selected: CalendarSelectionItem | null;
  /** The event an action verifiably landed on. Only written after proof. */
  acted: CalendarActedEntity | null;
}

export interface LoadedCalendarSelection {
  id: string;
  data: CalendarSelectionData;
  createdAt: string;
}

export interface LoadedCalendarEntityContext {
  id: string;
  data: CalendarEntityContextData;
  createdAt: string;
}

// --- Projection (PURE) ---------------------------------------------------

/** PURE: reduce a normalized event to the safe fields context remembers. */
export function toSelectionItem(event: NormalizedCalendarEvent): CalendarSelectionItem {
  return {
    id: event.id,
    recurringEventId: event.recurringEventId ?? null,
    title: (event.summary ?? "").trim(),
    start: event.start,
    end: event.end,
    allDay: event.allDay,
  };
}

// --- Reference detection (PURE) ------------------------------------------

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
};

/** A resolved positional reference: a 1-based position, or the last item. */
export type CalendarOrdinal = { position: number } | { last: true };

/**
 * PURE: parse a positional reference out of a message ("the second one", "the
 * 2nd", "number 2", "cancel the first meeting", a bare "2").
 *
 * Deliberately conservative about bare numbers: only a message that is ENTIRELY
 * a number counts, so "move it to 3" is never read as "item 3".
 */
export function parseCalendarOrdinal(text: string | undefined): CalendarOrdinal | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;

  const bare = /^#?(\d{1,2})\.?$/.exec(t);
  if (bare) {
    const n = Number(bare[1]);
    return n >= 1 && n <= 20 ? { position: n } : null;
  }

  if (/\b(?:the\s+)?last\s+one\b/.test(t)) return { last: true };

  const word = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/.exec(t);
  if (word) {
    const n = WORD_ORDINALS[word[1]!];
    if (n) return { position: n };
  }

  const numeric =
    /\b(?:(\d{1,2})(?:st|nd|rd|th)\b|(?:number|option|item|event|meeting)\s+#?(\d{1,2})\b)/.exec(t);
  if (numeric) {
    const n = Number(numeric[1] ?? numeric[2]);
    if (n >= 1 && n <= 20) return { position: n };
  }

  return null;
}

/**
 * PURE: does this message refer to the list Hula last showed?
 *
 * Once a numbered list is on screen the user stops naming events entirely —
 * "cancel the second one", "move the first one to Friday". A prefilter that
 * demands a calendar noun misses every one of those.
 */
export function referencesLastCalendarResults(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (parseCalendarOrdinal(t)) return true;
  if (/\b(?:them|these|those|they)\b/.test(t)) return true;
  if (/\b(?:that|this|it)\s+one\b/.test(t)) return true;
  return false;
}

/**
 * PURE: does this message point at the event we just ACTED on? ("the meeting you
 * just created", "undo that", "cancel the one you just made".)
 */
export function referencesLastCalendarAction(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (/\byou\s+(?:just|already)\s+\w+/.test(t)) return true;
  if (/\bundo\b/.test(t)) return true;
  return false;
}

/**
 * PURE: does this message point at a single event by pronoun, with no position?
 * ("move it to Friday", "cancel that", "add Rob to it".)
 *
 * A pronoun alone is only a reference when there is nothing else to go on; the
 * caller resolves it by PRIORITY (acted → selected → a single-result set) rather
 * than guessing.
 */
export function referencesCalendarPronoun(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  return /\b(?:it|that|this|them|those|these)\b/.test(t);
}

/**
 * PURE: resolve a positional reference against a remembered list.
 *
 * An out-of-range pick ("the fifth one" over three results) returns null — it
 * must ask, never silently clamp to the nearest item and cancel the wrong event.
 */
export function resolveCalendarSelectionItem(
  data: CalendarSelectionData,
  ref: CalendarOrdinal,
): CalendarSelectionItem | null {
  if ("last" in ref) return data.items[data.items.length - 1] ?? null;
  const idx = ref.position - 1;
  if (idx < 0 || idx >= data.items.length) return null;
  return data.items[idx] ?? null;
}

// --- Parsing (PURE) ------------------------------------------------------

/** PURE: validate one stored selection item. An item without an id is unusable. */
function parseItem(raw: unknown): CalendarSelectionItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  if (!id) return null;
  return {
    id,
    recurringEventId: typeof r.recurringEventId === "string" ? r.recurringEventId : null,
    title: typeof r.title === "string" ? r.title : "",
    start: typeof r.start === "string" ? r.start : null,
    end: typeof r.end === "string" ? r.end : null,
    allDay: r.allDay === true,
  };
}

/** PURE: validate a redacted proposal input as a calendar selection. */
export function parseCalendarSelectionData(
  input: Record<string, unknown> | null,
): CalendarSelectionData | null {
  if (!input || input.kind !== "calendar_selection") return null;
  const rawItems = input.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
  const items: CalendarSelectionItem[] = [];
  for (const raw of rawItems) {
    const item = parseItem(raw);
    if (!item) return null;
    items.push(item);
  }
  return { kind: "calendar_selection", items };
}

/** PURE: validate a redacted proposal input as entity context. */
export function parseCalendarEntityContextData(
  input: Record<string, unknown> | null,
): CalendarEntityContextData | null {
  if (!input || input.kind !== "calendar_entity_context") return null;
  return {
    kind: "calendar_entity_context",
    selected: parseItem(input.selected),
    acted: parseActed(input.acted),
  };
}

function parseActed(raw: unknown): CalendarActedEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const event = parseItem(r.event);
  if (!event) return null;
  const kind = r.kind;
  if (kind !== "created" && kind !== "updated" && kind !== "cancelled") return null;
  return {
    event,
    kind,
    at: typeof r.at === "string" ? r.at : new Date(0).toISOString(),
  };
}

// --- Persistence ---------------------------------------------------------

/** Injectable persistence so the whole flow runs with NO database in tests. */
export interface CalendarContextStore {
  create?: (userId: string, input: CreateProposalInput) => Promise<{ id: string }>;
  listRecent?: (userId: string, actionId: string) => Promise<ActionProposalView[]>;
}

/** Cap on remembered items — matches what we ever show. */
const MAX_ITEMS = 10;

/**
 * Remember the numbered list Hula just showed. Best-effort at the call site: a
 * failure here must never block the list reply itself — the user just loses the
 * ability to say "the second one" and can re-ask by name.
 */
export async function recordCalendarSelection(
  userId: string,
  events: NormalizedCalendarEvent[],
  store: CalendarContextStore = {},
): Promise<{ id: string }> {
  const create = store.create ?? createActionProposal;
  const data: CalendarSelectionData = {
    kind: "calendar_selection",
    items: events.slice(0, MAX_ITEMS).map(toSelectionItem),
  };
  return create(userId, {
    provider: GOOGLE_CALENDAR_PROVIDER,
    actionId: CALENDAR_SELECTION_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: data as unknown as Record<string, unknown>,
    previewText: `Showed ${data.items.length} calendar events.`,
    ttlMs: CALENDAR_SELECTION_TTL_MS,
  });
}

/**
 * Load the most recent NON-expired selection, or null. Expired and malformed
 * rows are SKIPPED rather than used — a stale list must not resolve a position,
 * because the numbers the user is looking at may be long gone.
 */
export async function loadLatestCalendarSelection(
  userId: string,
  store: CalendarContextStore = {},
): Promise<LoadedCalendarSelection | null> {
  const listRecent = store.listRecent ?? listRecentProposalsByAction;
  const rows = await listRecent(userId, CALENDAR_SELECTION_ACTION_ID);
  for (const row of rows) {
    const data = parseCalendarSelectionData(row.input);
    if (!data) continue;
    if (Date.parse(row.expiresAt) <= Date.now()) continue;
    return { id: row.id, data, createdAt: row.createdAt };
  }
  return null;
}

/** Load the most recent NON-expired entity context, or null. */
export async function loadCalendarEntityContext(
  userId: string,
  store: CalendarContextStore = {},
): Promise<LoadedCalendarEntityContext | null> {
  const listRecent = store.listRecent ?? listRecentProposalsByAction;
  const rows = await listRecent(userId, CALENDAR_ENTITY_CONTEXT_ACTION_ID);
  for (const row of rows) {
    const data = parseCalendarEntityContextData(row.input);
    if (!data) continue;
    if (Date.parse(row.expiresAt) <= Date.now()) continue;
    return { id: row.id, data, createdAt: row.createdAt };
  }
  return null;
}

async function writeEntityContext(
  userId: string,
  data: CalendarEntityContextData,
  store: CalendarContextStore,
): Promise<{ id: string }> {
  const create = store.create ?? createActionProposal;
  return create(userId, {
    provider: GOOGLE_CALENDAR_PROVIDER,
    actionId: CALENDAR_ENTITY_CONTEXT_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: data as unknown as Record<string, unknown>,
    previewText: "Calendar conversation context.",
    ttlMs: CALENDAR_ENTITY_TTL_MS,
  });
}

/**
 * Remember the event the user explicitly picked. Preserves any existing `acted`
 * record: picking a new event does not un-happen the action we performed on the
 * previous one.
 */
export async function recordSelectedCalendarEvent(
  userId: string,
  event: CalendarSelectionItem,
  store: CalendarContextStore = {},
): Promise<{ id: string }> {
  const existing = await loadCalendarEntityContext(userId, store);
  return writeEntityContext(
    userId,
    {
      kind: "calendar_entity_context",
      selected: event,
      acted: existing?.data.acted ?? null,
    },
    store,
  );
}

/**
 * Remember a write that VERIFIABLY landed.
 *
 * The single caller rule that makes "the meeting you just created" safe: this
 * runs ONLY after the postcondition was read back from Google and matched. An
 * accepted-but-unverified write must never reach here.
 *
 * The acted event also becomes the selected one — after "book lunch Friday",
 * both "it" and "that meeting" mean that event.
 */
export async function recordActedCalendarEvent(
  userId: string,
  acted: CalendarActedEntity,
  store: CalendarContextStore = {},
): Promise<{ id: string }> {
  return writeEntityContext(
    userId,
    {
      kind: "calendar_entity_context",
      // A cancelled event is no longer a sensible target for "move it to
      // Friday", so it stays `acted` (for "undo that") but is NOT re-selected.
      selected: acted.kind === "cancelled" ? null : acted.event,
      acted,
    },
    store,
  );
}
