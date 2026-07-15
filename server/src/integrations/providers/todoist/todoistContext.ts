import {
  createActionProposal,
  listRecentProposalsByAction,
  type ActionProposalView,
  type CreateProposalInput,
} from "../../../actions/proposals";
import { TODOIST_PROVIDER, type NormalizedTodoistTask } from "./types";

/**
 * Todoist conversational context (Section 19) — what "it", "that task", and "the
 * second one" actually mean.
 *
 * Two DIFFERENT memories with different lifetimes, kept apart on purpose (exactly
 * as `calendarContext` does, for the same reasons):
 *
 *  - The RESULT SET: the ordered, numbered list Hula last showed. "Complete the
 *    second one" means position 2 OF THAT LIST — resolved against a stored
 *    snapshot, never by re-running the read. A re-read is NOT equivalent: a task
 *    completed in the Todoist app between Hula printing the list and the user
 *    replying would shift every number, and the write would land on a task they
 *    never saw. Snapshotting is what makes numbered references STABLE.
 *
 *  - The ENTITY the conversation is ABOUT: the task explicitly picked, and the
 *    task an action VERIFIABLY landed on. That is what "it", "that task", "the one
 *    you just completed", and "undo that" resolve against.
 *
 * `acted` is written ONLY after a postcondition-verified write, so "undo that" can
 * never offer to reverse something that did not happen.
 *
 * Storage REUSES the Section 12 proposal store rather than adding a second
 * persistence mechanism: one `confirmationRequired:false` row under a dedicated
 * pseudo `actionId`, invisible to the yes/no confirmation flow and surviving a
 * restart (so it does NOT depend on in-memory process state, as the section
 * requires). Rows are user-scoped by the store, so one user's "it" can never
 * resolve to another user's task. The payload carries safe identifiers and display
 * labels only — never a raw provider payload.
 */

/** The pseudo action ids under which Todoist context is persisted. */
export const TODOIST_SELECTION_ACTION_ID = "todoist.lastSelection" as const;
export const TODOIST_ENTITY_CONTEXT_ACTION_ID = "todoist.entityContext" as const;

/** How long a shown list stays referenceable by number. */
export const TODOIST_SELECTION_TTL_MS = 30 * 60 * 1000;

/**
 * How long the conversation stays "about" a task. Longer than the list window on
 * purpose: "move it to Monday" arrives in the flow of conversation, but a user
 * may also come back to it after a meeting. Two hours is long enough to be useful
 * and short enough that a stale "it" cannot silently mutate the wrong task —
 * after it lapses, Hula asks.
 */
export const TODOIST_ENTITY_TTL_MS = 2 * 60 * 60 * 1000;

/** One safe, positional entry in a remembered list. Display labels + ids only. */
export interface TodoistSelectionItem {
  /** The Todoist-issued task id — the stable handle a follow-up acts on. */
  id: string;
  /** Display label only. Never a raw payload. */
  content: string;
  projectId: string | null;
  /** The due date as shown, for "the one due Friday". */
  dueDate: string | null;
  /** Whether this is a repeating task — completion behaves differently. */
  isRecurring: boolean;
  /** RAW API priority, so "change its priority" can report the change. */
  priority: number;
  labels: string[];
}

/** The redacted, SAFE payload describing one shown list. */
export interface TodoistSelectionData {
  kind: "todoist_selection";
  /** In the EXACT order shown — index 0 is "the first one". */
  items: TodoistSelectionItem[];
}

/** What an action verifiably did to a task. */
export type TodoistActedKind =
  | "created"
  | "updated"
  | "completed"
  | "reopened"
  | "deleted"
  | "moved";

/** An action that VERIFIABLY landed, plus what it proved. */
export interface TodoistActedEntity {
  task: TodoistSelectionItem;
  kind: TodoistActedKind;
  /** ISO instant the action was verified. */
  at: string;
  /**
   * Tasks acted on in a verified BULK action, so "undo that" after "complete all
   * of those" can reverse the set rather than only the last one.
   */
  bulkIds?: string[];
}

/** The safe payload describing the conversation's current subject. */
export interface TodoistEntityContextData {
  kind: "todoist_entity_context";
  /** The task the user explicitly picked ("the second one"), when they did. */
  selected: TodoistSelectionItem | null;
  /** The task an action verifiably landed on. Only written after proof. */
  acted: TodoistActedEntity | null;
}

export interface LoadedTodoistSelection {
  id: string;
  data: TodoistSelectionData;
  createdAt: string;
}

export interface LoadedTodoistEntityContext {
  id: string;
  data: TodoistEntityContextData;
  createdAt: string;
}

// --- Projection (PURE) ---------------------------------------------------

/** PURE: reduce a normalized task to the safe fields context remembers. */
export function toSelectionItem(task: NormalizedTodoistTask): TodoistSelectionItem {
  return {
    id: task.id,
    content: (task.content ?? "").trim(),
    projectId: task.projectId,
    dueDate: task.due?.date ?? null,
    isRecurring: task.due?.isRecurring ?? false,
    priority: task.priority,
    labels: [...task.labels],
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

/** A resolved positional reference: a 1-based position, the last, or all. */
export type TodoistOrdinal = { position: number } | { last: true } | { all: true };

/**
 * PURE: parse a positional reference out of a message ("the second one", "the
 * 2nd", "task 2", "all of those", a bare "2").
 *
 * Deliberately conservative about bare numbers: only a message that is ENTIRELY a
 * number counts, so "move it to 3" is never read as "item 3".
 */
export function parseTodoistOrdinal(text: string | undefined): TodoistOrdinal | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;

  const bare = /^#?(\d{1,2})\.?$/.exec(t);
  if (bare) {
    const n = Number(bare[1]);
    return n >= 1 && n <= 20 ? { position: n } : null;
  }

  if (/\ball\s+(?:of\s+)?(?:them|those|these)\b/.test(t)) return { all: true };
  if (/\b(?:the\s+)?last\s+one\b/.test(t)) return { last: true };

  const word = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/.exec(t);
  if (word) {
    const n = WORD_ORDINALS[word[1]!];
    if (n) return { position: n };
  }

  const numeric =
    /\b(?:(\d{1,2})(?:st|nd|rd|th)\b|(?:number|option|item|task|todo)\s+#?(\d{1,2})\b)/.exec(t);
  if (numeric) {
    const n = Number(numeric[1] ?? numeric[2]);
    if (n >= 1 && n <= 20) return { position: n };
  }

  return null;
}

/**
 * PURE: is this phrase a REFERENCE to something, rather than the NAME of a task?
 *
 * THE RULE THIS ENFORCES: a pronoun is never a task title.
 *
 * The live failure it exists to stop: the model, asked to extract a target from
 * "Delete it", answered `targetPhrase: "it"` — which is a perfectly reasonable
 * thing to say the user's target was. The resolver then took that at face value
 * and went looking for a task whose title contains "it", found none, and replied
 * "I couldn't find a task matching 'it'" — while the task the user meant was
 * sitting in the entity context, verified, one turn earlier.
 *
 * Anything matching here is a POINTER at the conversation's subject and must be
 * resolved against context. It must never reach a title search: "it" would match
 * any task with those two letters in its name (silently acting on the wrong task),
 * or nothing at all (a nonsense refusal). Both outcomes are wrong.
 *
 * Deliberately conservative — it matches pronouns, demonstratives with generic
 * nouns ("that task", "the one"), and explicit back-references ("the one I just
 * reopened"). A real title like "the deck" or "Finish Todoist integration test" is
 * NOT a reference and still searches normally.
 */
export function isReferencePhrase(phrase: string | null | undefined): boolean {
  const p = (phrase ?? "")
    .trim()
    .toLowerCase()
    .replace(/^["'“‘]+|["'”’.!?]+$/g, "");
  if (!p) return false;

  // Bare pronouns and demonstratives.
  if (/^(?:it|its|that|this|them|those|these|they|one)$/.test(p)) return true;

  // A demonstrative/article plus a GENERIC noun — "that task", "the one",
  // "this todo", "the last one". A specific noun ("the deck") is not a reference.
  if (
    /^(?:the|that|this|those|these|my)\s+(?:last\s+|previous\s+|first\s+|second\s+|other\s+)?(?:one|ones|task|tasks|todo|todos|to-do|to-dos|item|items|thing|things)$/.test(
      p,
    )
  ) {
    return true;
  }

  // An explicit back-reference to what just happened: "the one I just reopened",
  // "the task you just created".
  if (/\b(?:i|you)\s+just\s+\w+/.test(p)) return true;

  return false;
}

/** PURE: does this message refer to the list Hula last showed? */
export function referencesLastTodoistResults(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (parseTodoistOrdinal(t)) return true;
  if (/\b(?:them|these|those|they)\b/.test(t)) return true;
  if (/\b(?:that|this|it)\s+one\b/.test(t)) return true;
  return false;
}

/**
 * PURE: does this message point at the task we just ACTED on? ("the task I just
 * completed", "undo that", "reopen the one you just closed".)
 */
export function referencesLastTodoistAction(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (/\b(?:you|i)\s+just\s+\w+/.test(t)) return true;
  if (/\bundo\b/.test(t)) return true;
  return false;
}

/** PURE: does this message point at a single task by pronoun, with no position? */
export function referencesTodoistPronoun(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  return /\b(?:it|its|that|this|them|those|these)\b/.test(t);
}

/**
 * PURE: resolve a positional reference against a remembered list.
 *
 * An out-of-range pick ("the fifth one" over three results) returns an EMPTY
 * array — it must ask, never silently clamp to the nearest item and complete the
 * wrong task.
 */
export function resolveTodoistSelection(
  data: TodoistSelectionData,
  ref: TodoistOrdinal,
): TodoistSelectionItem[] {
  if ("all" in ref) return [...data.items];
  if ("last" in ref) {
    const last = data.items[data.items.length - 1];
    return last ? [last] : [];
  }
  const item = data.items[ref.position - 1];
  return item ? [item] : [];
}

/**
 * PURE: resolve a DESCRIPTIVE reference against a remembered list ("the Hula
 * task", "the one due Friday").
 *
 * Returns exactly one item or NOTHING. A phrase matching several remembered tasks
 * is ambiguous, and the section forbids mutating an ambiguous target — so a
 * multi-match resolves to null and the caller asks.
 */
export function resolveTodoistByPhrase(
  data: TodoistSelectionData,
  phrase: string | null | undefined,
): TodoistSelectionItem | null {
  const needle = (phrase ?? "").trim().toLowerCase();
  if (!needle) return null;
  const matches = data.items.filter((item) => item.content.toLowerCase().includes(needle));
  return matches.length === 1 ? matches[0]! : null;
}

// --- Parsing (PURE) ------------------------------------------------------

/** PURE: validate one stored selection item. An item without an id is unusable. */
function parseItem(raw: unknown): TodoistSelectionItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  if (!id) return null;
  return {
    id,
    content: typeof r.content === "string" ? r.content : "",
    projectId: typeof r.projectId === "string" ? r.projectId : null,
    dueDate: typeof r.dueDate === "string" ? r.dueDate : null,
    isRecurring: r.isRecurring === true,
    priority: typeof r.priority === "number" ? r.priority : 1,
    labels: Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === "string") : [],
  };
}

/** PURE: validate a redacted proposal input as a Todoist selection. */
export function parseTodoistSelectionData(
  input: Record<string, unknown> | null,
): TodoistSelectionData | null {
  if (!input || input.kind !== "todoist_selection") return null;
  const rawItems = input.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
  const items: TodoistSelectionItem[] = [];
  for (const raw of rawItems) {
    const item = parseItem(raw);
    if (!item) return null;
    items.push(item);
  }
  return { kind: "todoist_selection", items };
}

function parseActed(raw: unknown): TodoistActedEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const task = parseItem(r.task);
  if (!task) return null;
  const kind = r.kind;
  const valid: TodoistActedKind[] = ["created", "updated", "completed", "reopened", "deleted", "moved"];
  if (typeof kind !== "string" || !valid.includes(kind as TodoistActedKind)) return null;
  return {
    task,
    kind: kind as TodoistActedKind,
    at: typeof r.at === "string" ? r.at : new Date(0).toISOString(),
    bulkIds: Array.isArray(r.bulkIds)
      ? r.bulkIds.filter((x): x is string => typeof x === "string")
      : undefined,
  };
}

/** PURE: validate a redacted proposal input as entity context. */
export function parseTodoistEntityContextData(
  input: Record<string, unknown> | null,
): TodoistEntityContextData | null {
  if (!input || input.kind !== "todoist_entity_context") return null;
  return {
    kind: "todoist_entity_context",
    selected: parseItem(input.selected),
    acted: parseActed(input.acted),
  };
}

// --- Persistence ---------------------------------------------------------

/** Injectable persistence so the whole flow runs with NO database in tests. */
export interface TodoistContextStore {
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
export async function recordTodoistSelection(
  userId: string,
  tasks: readonly NormalizedTodoistTask[],
  store: TodoistContextStore = {},
): Promise<{ id: string }> {
  const create = store.create ?? createActionProposal;
  const data: TodoistSelectionData = {
    kind: "todoist_selection",
    items: tasks.slice(0, MAX_ITEMS).map(toSelectionItem),
  };
  return create(userId, {
    provider: TODOIST_PROVIDER,
    actionId: TODOIST_SELECTION_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: data as unknown as Record<string, unknown>,
    previewText: `Showed ${data.items.length} Todoist tasks.`,
    ttlMs: TODOIST_SELECTION_TTL_MS,
  });
}

/**
 * Load the most recent NON-expired selection, or null. Expired and malformed rows
 * are SKIPPED rather than used — a stale list must not resolve a position, because
 * the numbers the user is looking at may be long gone.
 */
export async function loadLatestTodoistSelection(
  userId: string,
  store: TodoistContextStore = {},
): Promise<LoadedTodoistSelection | null> {
  const listRecent = store.listRecent ?? listRecentProposalsByAction;
  const rows = await listRecent(userId, TODOIST_SELECTION_ACTION_ID);
  for (const row of rows) {
    const data = parseTodoistSelectionData(row.input);
    if (!data) continue;
    if (Date.parse(row.expiresAt) <= Date.now()) continue;
    return { id: row.id, data, createdAt: row.createdAt };
  }
  return null;
}

/** Load the most recent NON-expired entity context, or null. */
export async function loadTodoistEntityContext(
  userId: string,
  store: TodoistContextStore = {},
): Promise<LoadedTodoistEntityContext | null> {
  const listRecent = store.listRecent ?? listRecentProposalsByAction;
  const rows = await listRecent(userId, TODOIST_ENTITY_CONTEXT_ACTION_ID);
  for (const row of rows) {
    const data = parseTodoistEntityContextData(row.input);
    if (!data) continue;
    if (Date.parse(row.expiresAt) <= Date.now()) continue;
    return { id: row.id, data, createdAt: row.createdAt };
  }
  return null;
}

async function writeEntityContext(
  userId: string,
  data: TodoistEntityContextData,
  store: TodoistContextStore,
): Promise<{ id: string }> {
  const create = store.create ?? createActionProposal;
  return create(userId, {
    provider: TODOIST_PROVIDER,
    actionId: TODOIST_ENTITY_CONTEXT_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: data as unknown as Record<string, unknown>,
    previewText: "Todoist conversation context.",
    ttlMs: TODOIST_ENTITY_TTL_MS,
  });
}

/**
 * Remember the task the user explicitly picked. Preserves any existing `acted`
 * record: picking a new task does not un-happen the action we performed.
 */
export async function recordSelectedTodoistTask(
  userId: string,
  task: TodoistSelectionItem,
  store: TodoistContextStore = {},
): Promise<{ id: string }> {
  const existing = await loadTodoistEntityContext(userId, store);
  return writeEntityContext(
    userId,
    {
      kind: "todoist_entity_context",
      selected: task,
      acted: existing?.data.acted ?? null,
    },
    store,
  );
}

/**
 * Remember a write that VERIFIABLY landed.
 *
 * The single caller rule that makes "undo that" safe: this runs ONLY after the
 * postcondition was read back from Todoist and matched. An accepted-but-unverified
 * write must never reach here.
 */
export async function recordActedTodoistTask(
  userId: string,
  acted: TodoistActedEntity,
  store: TodoistContextStore = {},
): Promise<{ id: string }> {
  return writeEntityContext(
    userId,
    {
      kind: "todoist_entity_context",
      // A deleted task is no longer a sensible target for "move it to Monday", so
      // it stays `acted` (nothing to undo, but it explains itself) and is NOT
      // re-selected. Everything else remains the conversation's subject.
      selected: acted.kind === "deleted" ? null : acted.task,
      acted,
    },
    store,
  );
}
