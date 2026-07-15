/**
 * Todoist provider types (Section 19).
 *
 * The NORMALIZED shapes the rest of Hula sees. Nothing outside `client.ts` /
 * `tasks.ts` ever touches a raw Todoist payload: everything is projected into
 * these types first, so a provider field rename can never leak into a reply, a
 * ledger row, or the conversational context.
 *
 * Pure type declarations plus PURE priority helpers — no I/O, no tokens.
 */

/** Stable provider slug. Matches the catalog entry and the DB `provider` column. */
export const TODOIST_PROVIDER = "todoist" as const;

/**
 * Todoist's due object, normalized.
 *
 * THE CONTRACT THAT CAUSED A REAL BUG. Todoist API v1 returns the SYNC-shaped due
 * object (the response schema is literally `ItemSyncView`), which has **no
 * `datetime` field**. The time lives INSIDE `date`, and its form encodes meaning:
 *
 *   all-day   → "2018-10-14"                    (no time at all)
 *   floating  → "2018-10-14T10:00:00.000000"    (LOCAL wall time, no Z)
 *   fixed zone→ "2018-10-14T05:00:00.000000Z"   (absolute instant, `timezone` set)
 *
 * Reading a `datetime` property here — as the older REST v2 shape had — silently
 * yields `null` for EVERY timed task, which is exactly what happened: a 5pm task
 * normalized as all-day, the time vanished from the reply, and postcondition
 * verification then reported the whole due date as failed.
 *
 * `isFloating` is the distinction that must never be collapsed. A floating time
 * means "10:00 wherever the user is" and must NOT be timezone-converted; an
 * absolute instant must be. Treating one as the other shifts the displayed time.
 */
export interface TodoistDue {
  /** Todoist's raw `date`: `YYYY-MM-DD`, or a datetime when a time is set. */
  date: string;
  /**
   * The datetime portion when the task has a time-of-day, else null. Carries the
   * ORIGINAL form (floating or Z-suffixed) — interpret it with `isFloating`.
   */
  datetime: string | null;
  /**
   * True when `datetime` is a floating LOCAL wall time (no `Z`/offset). Such a
   * value is not an instant and must never be parsed as one.
   */
  isFloating: boolean;
  /** IANA zone when Todoist recorded a fixed zone for this due date. */
  timezone: string | null;
  /** True for a repeating task ("every Monday"). */
  isRecurring: boolean;
  /** The natural-language expression Todoist echoes, e.g. "every day at 9". */
  string: string | null;
}

/** PURE: does this Todoist `date` value carry a time-of-day? */
export function hasTimeComponent(date: string | null | undefined): boolean {
  return typeof date === "string" && date.includes("T");
}

/**
 * PURE: is this datetime a FLOATING local wall time rather than an instant?
 *
 * Floating values carry no zone designator at all. A trailing `Z` or a numeric
 * offset (`+01:00`) makes it absolute.
 */
export function isFloatingDatetime(datetime: string | null | undefined): boolean {
  if (!hasTimeComponent(datetime)) return false;
  return !/(?:Z|[+-]\d{2}:?\d{2})$/.test(datetime as string);
}

/**
 * A task, normalized.
 *
 * `priority` is kept as Todoist's RAW API value (1..4) rather than the UI value.
 * They are inverted and mixing them up silently sets the wrong urgency — see
 * `apiPriorityToUi`. Everything user-facing must convert.
 */
export interface NormalizedTodoistTask {
  id: string;
  /** The task title. Todoist calls this `content`. */
  content: string;
  description: string | null;
  projectId: string | null;
  sectionId: string | null;
  parentId: string | null;
  /** Label NAMES (Todoist returns names on a task, not ids). */
  labels: string[];
  /** RAW API priority: 1 = natural … 4 = urgent. See `apiPriorityToUi`. */
  priority: number;
  due: TodoistDue | null;
  /** A date-only deadline (`YYYY-MM-DD`), distinct from `due`. */
  deadline: string | null;
  completed: boolean;
  assigneeId: string | null;
  /** Todoist web URL for the task, when supplied. Safe to show. */
  url: string | null;
  createdAt: string | null;
  completedAt: string | null;
  source: "todoist";
}

/** A project, normalized. */
export interface NormalizedTodoistProject {
  id: string;
  name: string;
  isInboxProject: boolean;
  parentId: string | null;
}

/** A section within a project, normalized. */
export interface NormalizedTodoistSection {
  id: string;
  projectId: string;
  name: string;
}

/** A personal label, normalized. */
export interface NormalizedTodoistLabel {
  id: string;
  name: string;
}

/** One page of a cursor-paginated Todoist collection. */
export interface TodoistPage<T> {
  results: T[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
}

// --- Priority (PURE) -----------------------------------------------------

/**
 * Todoist's API priority is INVERTED relative to the UI, and this is the single
 * most dangerous small detail in the integration:
 *
 *   API 4 = UI "p1" = urgent
 *   API 3 = UI "p2" = high
 *   API 2 = UI "p3" = medium
 *   API 1 = UI "p4" = normal (Todoist's default)
 *
 * A user asking for "high priority" who gets API priority 3 stored as UI p3 has
 * silently had their urgency downgraded, and nothing would fail loudly. Every
 * conversion goes through these two helpers so the mapping exists in ONE place.
 */
export function apiPriorityToUi(apiPriority: number): number {
  return 5 - clampApiPriority(apiPriority);
}

/** PURE: UI priority (p1..p4) → the raw API value Todoist expects. */
export function uiPriorityToApi(uiPriority: number): number {
  return 5 - clampUiPriority(uiPriority);
}

/** PURE: coerce any value into a valid raw API priority (1..4), defaulting to 1. */
export function clampApiPriority(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 1;
  return Math.min(Math.max(n, 1), 4);
}

/** PURE: coerce any value into a valid UI priority (1..4), defaulting to 4. */
export function clampUiPriority(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 4;
  return Math.min(Math.max(n, 1), 4);
}

/** PURE: the human word for a UI priority, as Todoist itself labels them. */
export function priorityLabel(apiPriority: number): string {
  switch (clampApiPriority(apiPriority)) {
    case 4:
      return "Urgent";
    case 3:
      return "High";
    case 2:
      return "Medium";
    default:
      return "Normal";
  }
}
