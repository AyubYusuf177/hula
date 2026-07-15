import { uiPriorityToApi, type NormalizedTodoistTask, type TodoistDue } from "./types";

/**
 * Todoist read scoping (Section 19) — ALL PURE.
 *
 * THE SAFETY BOUNDARY THIS FILE ENFORCES. Todoist's filter language is powerful
 * enough to select the wrong tasks quietly, and a write built on top of a bad
 * selection acts on tasks the user never saw. The section is explicit: the model
 * may extract typed intent fields, but it must NEVER construct provider query
 * DSL. So:
 *
 *  - `buildScopeFilterQuery` emits ONLY allowlisted fragments derived from a
 *    closed enum + an integer priority. No user text reaches it, ever — there is
 *    no code path that can inject into it, because it takes no strings.
 *  - Anything involving user-supplied text (a project name, a label, a search
 *    phrase) is resolved to a provider id / matched with a PURE predicate here,
 *    rather than being interpolated into a filter expression.
 *
 * The date predicates are pure and timezone-aware so "due today" means today
 * WHERE THE USER IS, and they can be tested exhaustively with no provider.
 */

/** The bounded set of date scopes a read can ask for. A closed enum by design. */
export type TodoistScope =
  | "today"
  | "overdue"
  | "upcoming"
  | "week"
  | "no_date"
  | "all";

export const TODOIST_SCOPES: readonly TodoistScope[] = [
  "today",
  "overdue",
  "upcoming",
  "week",
  "no_date",
  "all",
];

/** PURE: is this a scope we support? */
export function isTodoistScope(value: unknown): value is TodoistScope {
  return typeof value === "string" && TODOIST_SCOPES.includes(value as TodoistScope);
}

/**
 * PURE: the allowlisted Todoist filter fragment for a scope.
 *
 * Every returned value is a CONSTANT — never built from input — which is what
 * makes this injection-proof by construction rather than by escaping.
 */
function scopeFragment(scope: TodoistScope): string | null {
  switch (scope) {
    case "today":
      return "today";
    case "overdue":
      return "overdue";
    case "week":
      // Todoist's own "next 7 days", which includes today.
      return "next 7 days";
    case "upcoming":
      // Everything with a future due date. Bounded by the caller's result limit.
      return "due after: today";
    case "no_date":
      return "no date";
    case "all":
      return null;
    default:
      return null;
  }
}

/**
 * PURE: build a Todoist filter expression from a scope + optional UI priority.
 *
 * Takes NO free text. The priority fragment uses Todoist's UI numbering (`p1` is
 * urgent), which is why the caller passes a UI priority and not the raw API value
 * — writing `p4` here for "urgent" would silently return the user's least
 * important tasks.
 *
 * Returns "" when nothing constrains the query; callers treat that as "list
 * tasks" rather than sending an empty filter.
 */
export function buildScopeFilterQuery(
  scope: TodoistScope,
  uiPriority?: number | null,
): string {
  const fragments: string[] = [];
  const scopeFrag = scopeFragment(scope);
  if (scopeFrag) fragments.push(scopeFrag);

  if (typeof uiPriority === "number" && uiPriority >= 1 && uiPriority <= 4) {
    fragments.push(`p${Math.trunc(uiPriority)}`);
  }
  return fragments.join(" & ");
}

// --- Timezone-aware date logic (PURE) ------------------------------------

/**
 * PURE: the `YYYY-MM-DD` calendar date an instant falls on IN A GIVEN ZONE.
 *
 * `en-CA` formats as ISO-style `YYYY-MM-DD`, which makes these keys directly
 * comparable as strings. Doing this in the user's zone is what stops a task due
 * "today" in London reading as tomorrow's task to a UTC server at 23:30.
 */
export function localDateKey(instant: Date | string, timezone?: string): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** PURE: shift a `YYYY-MM-DD` key by N days, staying in date-space. */
export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  // UTC math on a date-only value: no zone involved, so no DST drift.
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * What a due date means to the user, resolved once so every consumer agrees.
 *
 * This exists because "when is this due?" has three different answers depending on
 * the form Todoist returned, and getting the distinction wrong shifts the time the
 * user sees — the whole class of bug this module now guards.
 */
export interface DueLocalStamp {
  /** The `YYYY-MM-DD` the user would say it is due on, in THEIR zone. */
  dateKey: string;
  /** Local `HH:MM`, or null for an all-day task. */
  time: string | null;
  /** The absolute instant, when one is knowable. Null for all-day. */
  instantMs: number | null;
}

/**
 * PURE: resolve a due into the local date/time the user actually sees.
 *
 * The three branches are the three real Todoist forms, and each MUST be handled
 * differently:
 *
 *  - ALL-DAY (`2018-10-14`): already a local calendar date. Passing it through a
 *    timezone conversion would be wrong — it denotes a date, not an instant.
 *  - FLOATING (`2018-10-14T10:00:00`): a LOCAL WALL TIME. It is *not* an instant,
 *    and parsing it as one (which `Date.parse` silently does, as UTC) then
 *    converting to the user's zone reports 11:00 for a 10:00 task. It is read
 *    verbatim.
 *  - FIXED (`2018-10-14T05:00:00Z`): a genuine instant, and the only form that
 *    SHOULD be converted into the user's zone.
 */
export function dueLocalStamp(
  due: TodoistDue | null,
  timezone?: string,
): DueLocalStamp | null {
  if (!due) return null;

  if (!due.datetime) {
    // All-day. Guard against a `date` longer than a bare date defensively.
    return { dateKey: due.date.slice(0, 10), time: null, instantMs: null };
  }

  if (due.isFloating) {
    // Wall time, verbatim. No zone maths whatsoever.
    const dateKey = due.datetime.slice(0, 10);
    const time = due.datetime.slice(11, 16);
    const iso = zonedDateTimeToIso(dateKey, time, timezone);
    return { dateKey, time, instantMs: iso ? Date.parse(iso) : null };
  }

  const ms = Date.parse(due.datetime);
  if (!Number.isFinite(ms)) {
    return { dateKey: due.datetime.slice(0, 10), time: null, instantMs: null };
  }
  // Absolute instant → render in the user's zone.
  const dateKey = localDateKey(new Date(ms), timezone);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
  return { dateKey, time, instantMs: ms };
}

/**
 * PURE: the local calendar date a task is DUE on, or null when it has no due.
 * Thin wrapper over `dueLocalStamp` so there is exactly one implementation.
 */
export function taskDueDateKey(
  task: NormalizedTodoistTask,
  timezone?: string,
): string | null {
  return dueLocalStamp(task.due, timezone)?.dateKey ?? null;
}

/**
 * PURE: does a task fall in a scope, as of `now` in the user's zone?
 *
 * `overdue` deliberately compares INSTANTS for a timed task and DATES for an
 * all-day one, because those are genuinely different questions: a task due at 5pm
 * today is not overdue at noon, while an all-day task due today is not overdue at
 * all until the day turns over.
 */
export function matchesScope(
  task: NormalizedTodoistTask,
  scope: TodoistScope,
  now: Date,
  timezone?: string,
): boolean {
  if (scope === "all") return true;

  const dueKey = taskDueDateKey(task, timezone);
  if (scope === "no_date") return dueKey === null;
  if (dueKey === null) return false;

  const todayKey = localDateKey(now, timezone);

  switch (scope) {
    case "today":
      return dueKey === todayKey;
    case "overdue": {
      if (dueKey < todayKey) return true;
      // Same day + a specific time that has already passed. The instant comes from
      // `dueLocalStamp`, which resolves a FLOATING wall time through the user's
      // zone rather than mis-parsing it as UTC.
      if (dueKey === todayKey) {
        const instantMs = dueLocalStamp(task.due, timezone)?.instantMs ?? null;
        return instantMs !== null && instantMs < now.getTime();
      }
      return false;
    }
    case "upcoming":
      return dueKey > todayKey;
    case "week":
      // Todoist's "next 7 days" semantics: today through today+6 inclusive.
      return dueKey >= todayKey && dueKey <= addDaysToKey(todayKey, 6);
    default:
      return false;
  }
}

/**
 * PURE: the offset (ms) a zone is from UTC at a given instant.
 *
 * Formats the instant IN the zone, reads the wall-clock back as if it were UTC,
 * and diffs. This is the standard trick for doing zone math with only `Intl`,
 * which is what the codebase already relies on rather than adding a date library.
 */
function zoneOffsetMs(instant: Date, timezone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) parts[part.type] = part.value;
  // `hour12:false` can render midnight as "24" — normalize it back to 0.
  const hour = Number(parts.hour) % 24;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant.getTime();
}

/**
 * PURE: turn a LOCAL date + time in a zone into a UTC ISO instant.
 *
 * Todoist's `due_datetime` is an absolute instant, but users speak in local wall
 * time ("Friday at 5"). Sending the wall time as though it were UTC is the classic
 * bug that puts a 5pm task at 5pm UTC — a different moment for almost everyone.
 *
 * The two-step offset correction handles the DST edge: the first offset is read at
 * the approximate instant, applied, then re-read at the corrected instant in case
 * the correction crossed a transition. Returns null for unusable input rather than
 * inventing a time.
 */
export function zonedDateTimeToIso(
  dateKey: string,
  time: string,
  timezone?: string,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const zone = timezone || "UTC";
  const naive = new Date(`${dateKey}T${time}:00Z`);
  if (Number.isNaN(naive.getTime())) return null;
  try {
    const firstPass = new Date(naive.getTime() - zoneOffsetMs(naive, zone));
    const corrected = new Date(naive.getTime() - zoneOffsetMs(firstPass, zone));
    return corrected.toISOString();
  } catch {
    // An invalid IANA zone must not fabricate a time.
    return null;
  }
}

// --- Client-side predicates (PURE) ---------------------------------------

/**
 * PURE: strip characters that carry meaning in Todoist's filter language.
 *
 * Search text is the one genuinely user-authored value in a read. It is never
 * interpolated into a filter expression (searching is done client-side), but it
 * is sanitised anyway: defence in depth costs one function and means a future
 * caller cannot turn a search box into a filter injection.
 */
export function sanitizeSearchText(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/[#@&|!()/,:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** PURE: does a task's title/description contain the search text? */
export function matchesSearch(
  task: NormalizedTodoistTask,
  search: string | null | undefined,
): boolean {
  const needle = sanitizeSearchText(search).toLowerCase();
  if (!needle) return true;
  const haystack = `${task.content} ${task.description ?? ""}`.toLowerCase();
  return haystack.includes(needle);
}

/** PURE: does a task carry this UI priority? */
export function matchesPriority(
  task: NormalizedTodoistTask,
  uiPriority: number | null | undefined,
): boolean {
  if (typeof uiPriority !== "number") return true;
  return task.priority === uiPriorityToApi(uiPriority);
}

/** PURE: does a task carry this label (case-insensitive)? */
export function matchesLabel(
  task: NormalizedTodoistTask,
  label: string | null | undefined,
): boolean {
  const want = (label ?? "").trim().toLowerCase();
  if (!want) return true;
  return task.labels.some((l) => l.trim().toLowerCase() === want);
}

// --- Name resolution (PURE) ----------------------------------------------

/** A named provider object the user might refer to by name. */
export interface NamedEntity {
  id: string;
  name: string;
}

/** The outcome of resolving a user-typed name against real provider objects. */
export type NameResolution =
  | { kind: "resolved"; entity: NamedEntity }
  | { kind: "ambiguous"; candidates: NamedEntity[] }
  | { kind: "not_found" };

/**
 * PURE: resolve a user-typed name against the REAL objects Todoist returned.
 *
 * The section is explicit that Hula must not silently create a project after a
 * typo, and must never mutate an ambiguous target. So this reports three
 * genuinely different outcomes and NEVER guesses:
 *
 *  1. An exact (case-insensitive) match wins outright — even if it is also a
 *     prefix of other names, because the user named it exactly.
 *  2. Otherwise, substring candidates are collected. Exactly one → resolved.
 *     More than one → `ambiguous`, and the caller asks rather than picking.
 *  3. None → `not_found`, and the caller says so rather than inventing one.
 */
export function resolveEntityByName(
  name: string | null | undefined,
  entities: readonly NamedEntity[],
): NameResolution {
  const want = (name ?? "").trim().toLowerCase();
  if (!want) return { kind: "not_found" };

  const exact = entities.filter((e) => e.name.trim().toLowerCase() === want);
  if (exact.length === 1) return { kind: "resolved", entity: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };

  const partial = entities.filter((e) => e.name.trim().toLowerCase().includes(want));
  if (partial.length === 1) return { kind: "resolved", entity: partial[0]! };
  if (partial.length > 1) return { kind: "ambiguous", candidates: partial };

  return { kind: "not_found" };
}
