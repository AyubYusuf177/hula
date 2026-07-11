import type { RecurrenceRule } from "./types";

/**
 * Deterministic reminder date/time parsing (Section 9) — PURE, no I/O.
 *
 * This is intentionally SMALL. It understands a fixed set of natural phrases and
 * nothing more; anything it can't confidently parse returns `needsTime` so Hula
 * can ask one clarifying question rather than guess. No natural-language date
 * library is used — timezone maths is done with the built-in `Intl` API so the
 * backend has zero new dependencies.
 *
 * Supported:
 *   - "in 10 minutes" / "in 2 hours"
 *   - "tonight"            (→ today at 20:00 local)
 *   - "today at 6pm"
 *   - "tomorrow at 7pm"
 *   - "Monday at 9am"      (next occurrence of that weekday)
 *   - "every day at 8am"   (daily recurrence)
 *   - "every Monday at 9am"(weekly recurrence)
 *
 * All wall-clock times are interpreted in the user's timezone when known,
 * otherwise UTC (documented fallback). DST is handled to within one correction
 * pass, which is plenty for reminders.
 */

/** Result of parsing a "when" phrase out of a reminder request. */
export type WhenParse =
  | {
      ok: true;
      /** First fire time as an absolute instant. */
      dueAt: Date;
      /** `daily`/`weekly` for recurring reminders, else null. */
      recurrenceRule: RecurrenceRule | null;
      /** Human phrasing for the confirmation, e.g. "tomorrow at 7:00 PM". */
      humanWhen: string;
    }
  | {
      /** No usable time was found (or it was too frequent / in the past). */
      ok: false;
      reason: "needs_time" | "too_frequent" | "in_past";
    };

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** "tonight" defaults to this hour (local) when no explicit time is given. */
const TONIGHT_HOUR = 20;

// --- Timezone helpers (Intl-based, dependency-free) ----------------------

/**
 * The offset (ms) of `timeZone` at the instant `date`: `localWallTime - utc`.
 * Uses `Intl` to read what the instant looks like in the zone. Falls back to 0
 * (UTC) if the zone name is invalid.
 */
function tzOffsetMs(date: Date, timeZone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(date);
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== "literal") map[p.type] = Number(p.value);
    }
    const asUtc = Date.UTC(
      map.year!,
      (map.month ?? 1) - 1,
      map.day ?? 1,
      (map.hour ?? 0) % 24,
      map.minute ?? 0,
      map.second ?? 0,
    );
    return asUtc - date.getTime();
  } catch {
    return 0;
  }
}

/**
 * Convert a wall-clock time (as observed in `timeZone`) into an absolute UTC
 * `Date`. Applies one correction pass so DST boundaries land correctly.
 */
export function wallTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string | undefined,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  if (!timeZone) return new Date(utcGuess);
  const offset1 = tzOffsetMs(new Date(utcGuess), timeZone);
  const candidate = new Date(utcGuess - offset1);
  // Second pass corrects for the case where the guess landed on the wrong side
  // of a DST transition.
  const offset2 = tzOffsetMs(candidate, timeZone);
  if (offset2 !== offset1) return new Date(utcGuess - offset2);
  return candidate;
}

/** The wall-clock calendar fields for `now` as observed in `timeZone` (or UTC). */
function nowFieldsInTz(
  now: Date,
  timeZone: string | undefined,
): { year: number; month: number; day: number; hour: number; minute: number } {
  if (!timeZone) {
    return {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
    };
  }
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const map: Record<string, number> = {};
    for (const p of dtf.formatToParts(now)) {
      if (p.type !== "literal") map[p.type] = Number(p.value);
    }
    return {
      year: map.year!,
      month: map.month ?? 1,
      day: map.day ?? 1,
      hour: (map.hour ?? 0) % 24,
      minute: map.minute ?? 0,
    };
  } catch {
    return {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
    };
  }
}

/** Weekday index (0=Sun..6=Sat) for a calendar date — timezone-independent. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Add `days` to a calendar date, returning new {year,month,day}. */
function addDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// --- Clock-time parsing --------------------------------------------------

/** Parse a clock time like "7pm", "9am", "6:30pm", "18:00" → {hour,minute}. */
function parseClock(raw: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (!ampm && hour > 23) return null;
  return { hour, minute };
}

/** Format an {hour,minute} as "7:00 PM". */
export function formatClock(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  let h = hour % 12;
  if (h === 0) h = 12;
  const mm = minute.toString().padStart(2, "0");
  return `${h}:${mm} ${ampm}`;
}

/** Capitalise a weekday name ("monday" → "Monday"). */
function titleWeekday(index: number): string {
  const name = WEEKDAYS[index] ?? "";
  return name ? name[0]!.toUpperCase() + name.slice(1) : "";
}

// --- Time-phrase extraction ----------------------------------------------

/**
 * A matched time phrase and the rest of the text with that phrase removed (so
 * the caller can derive the reminder title from what's left).
 */
export interface TimeExtraction {
  parse: WhenParse;
  /** The input with the recognised time phrase stripped out. */
  remainder: string;
}

/** Regexes for the supported time phrases, tried in priority order. */
const RELATIVE_RE = /\bin\s+(\d{1,3})\s+(min(?:ute)?s?|hours?|hrs?|days?)\b/i;
const EVERY_DAY_RE = /\bevery\s+day\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i;
const EVERY_WEEKDAY_RE =
  /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?\b/i;
const TOO_FREQUENT_RE =
  /\bevery\s+(?:\d+\s+)?(minute|min|hour|hr|second|sec)s?\b/i;
const TOMORROW_RE = /\btomorrow(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?\b/i;
const TODAY_RE = /\btoday\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i;
const TONIGHT_RE = /\btonight(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?\b/i;
const WEEKDAY_RE =
  /\b(?:on\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?\b/i;

/** Remove a matched span from `text` and tidy whitespace/leading joiners. */
function stripMatch(text: string, match: RegExpExecArray): string {
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  return `${before} ${after}`.replace(/\s+/g, " ").trim();
}

/** Build the daily recurrence at a specific local time. */
function buildDaily(
  now: Date,
  timeZone: string | undefined,
  hour: number,
  minute: number,
): WhenParse {
  const f = nowFieldsInTz(now, timeZone);
  let due = wallTimeToUtc(f.year, f.month, f.day, hour, minute, timeZone);
  if (due.getTime() <= now.getTime()) {
    const n = addDays(f.year, f.month, f.day, 1);
    due = wallTimeToUtc(n.year, n.month, n.day, hour, minute, timeZone);
  }
  return {
    ok: true,
    dueAt: due,
    recurrenceRule: "daily",
    humanWhen: `every day at ${formatClock(hour, minute)}`,
  };
}

/** Build the weekly recurrence (or a one-off next-weekday) at a local time. */
function buildWeekday(
  now: Date,
  timeZone: string | undefined,
  targetWeekday: number,
  hour: number,
  minute: number,
  recurring: boolean,
): WhenParse {
  const f = nowFieldsInTz(now, timeZone);
  const todayWeekday = weekdayOf(f.year, f.month, f.day);
  let delta = (targetWeekday - todayWeekday + 7) % 7;
  // Compute the candidate for today/delta days out; if it's already past, roll a
  // full week forward so we never schedule in the past.
  let cand = addDays(f.year, f.month, f.day, delta);
  let due = wallTimeToUtc(cand.year, cand.month, cand.day, hour, minute, timeZone);
  if (due.getTime() <= now.getTime()) {
    delta += 7;
    cand = addDays(f.year, f.month, f.day, delta);
    due = wallTimeToUtc(cand.year, cand.month, cand.day, hour, minute, timeZone);
  }
  return {
    ok: true,
    dueAt: due,
    recurrenceRule: recurring ? "weekly" : null,
    humanWhen: recurring
      ? `every ${titleWeekday(targetWeekday)} at ${formatClock(hour, minute)}`
      : `${titleWeekday(targetWeekday)} at ${formatClock(hour, minute)}`,
  };
}

/**
 * Pure: find and interpret a supported time phrase inside `text`. Returns the
 * parse result plus the text with the phrase removed. When no supported phrase
 * is present, `parse.ok` is false with reason `needs_time`.
 */
export function extractTime(
  text: string,
  now: Date,
  timeZone: string | undefined,
): TimeExtraction {
  // Reject clearly-too-frequent recurrence up front (before generic weekday).
  const tooFreq = TOO_FREQUENT_RE.exec(text);
  if (tooFreq) {
    return { parse: { ok: false, reason: "too_frequent" }, remainder: stripMatch(text, tooFreq) };
  }

  // 1. Relative: "in N minutes/hours/days".
  const rel = RELATIVE_RE.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    let ms = 0;
    let human = "";
    if (unit.startsWith("min")) {
      ms = n * 60_000;
      human = `in ${n} minute${n === 1 ? "" : "s"}`;
    } else if (unit.startsWith("h")) {
      ms = n * 3_600_000;
      human = `in ${n} hour${n === 1 ? "" : "s"}`;
    } else {
      ms = n * 86_400_000;
      human = `in ${n} day${n === 1 ? "" : "s"}`;
    }
    if (n <= 0) {
      return { parse: { ok: false, reason: "needs_time" }, remainder: stripMatch(text, rel) };
    }
    return {
      parse: { ok: true, dueAt: new Date(now.getTime() + ms), recurrenceRule: null, humanWhen: human },
      remainder: stripMatch(text, rel),
    };
  }

  // 2. Recurring daily: "every day at TIME".
  const everyDay = EVERY_DAY_RE.exec(text);
  if (everyDay) {
    const clock = parseClock(everyDay[1]!);
    if (!clock) return { parse: { ok: false, reason: "needs_time" }, remainder: stripMatch(text, everyDay) };
    return { parse: buildDaily(now, timeZone, clock.hour, clock.minute), remainder: stripMatch(text, everyDay) };
  }

  // 3. Recurring weekly: "every Monday at TIME".
  const everyWeekday = EVERY_WEEKDAY_RE.exec(text);
  if (everyWeekday) {
    const weekday = WEEKDAYS.indexOf(everyWeekday[1]!.toLowerCase() as (typeof WEEKDAYS)[number]);
    if (!everyWeekday[2]) {
      return { parse: { ok: false, reason: "needs_time" }, remainder: stripMatch(text, everyWeekday) };
    }
    const clock = parseClock(everyWeekday[2]);
    if (!clock) return { parse: { ok: false, reason: "needs_time" }, remainder: stripMatch(text, everyWeekday) };
    return {
      parse: buildWeekday(now, timeZone, weekday, clock.hour, clock.minute, true),
      remainder: stripMatch(text, everyWeekday),
    };
  }

  // 4. "tonight" (optionally with a time).
  const tonight = TONIGHT_RE.exec(text);
  if (tonight) {
    const clock = tonight[1] ? parseClock(tonight[1]) : { hour: TONIGHT_HOUR, minute: 0 };
    if (!clock) return { parse: { ok: false, reason: "needs_time" }, remainder: stripMatch(text, tonight) };
    const f = nowFieldsInTz(now, timeZone);
    const due = wallTimeToUtc(f.year, f.month, f.day, clock.hour, clock.minute, timeZone);
    const parse: WhenParse =
      due.getTime() <= now.getTime()
        ? { ok: false, reason: "in_past" }
        : { ok: true, dueAt: due, recurrenceRule: null, humanWhen: `tonight at ${formatClock(clock.hour, clock.minute)}` };
    return { parse, remainder: stripMatch(text, tonight) };
  }

  // 5. "tomorrow at TIME" (defaults to 9:00 AM when no time is given).
  const tomorrow = TOMORROW_RE.exec(text);
  if (tomorrow) {
    if (!tomorrow[1]) {
      // "tomorrow" with no time is ambiguous — ask for the time.
      return { parse: { ok: false, reason: "needs_time" }, remainder: stripMatch(text, tomorrow) };
    }
    const clock = parseClock(tomorrow[1]);
    if (!clock) return { parse: { ok: false, reason: "needs_time" }, remainder: stripMatch(text, tomorrow) };
    const f = nowFieldsInTz(now, timeZone);
    const n = addDays(f.year, f.month, f.day, 1);
    const due = wallTimeToUtc(n.year, n.month, n.day, clock.hour, clock.minute, timeZone);
    return {
      parse: { ok: true, dueAt: due, recurrenceRule: null, humanWhen: `tomorrow at ${formatClock(clock.hour, clock.minute)}` },
      remainder: stripMatch(text, tomorrow),
    };
  }

  // 6. "today at TIME".
  const today = TODAY_RE.exec(text);
  if (today) {
    const clock = parseClock(today[1]!);
    if (!clock) return { parse: { ok: false, reason: "needs_time" }, remainder: stripMatch(text, today) };
    const f = nowFieldsInTz(now, timeZone);
    const due = wallTimeToUtc(f.year, f.month, f.day, clock.hour, clock.minute, timeZone);
    const parse: WhenParse =
      due.getTime() <= now.getTime()
        ? { ok: false, reason: "in_past" }
        : { ok: true, dueAt: due, recurrenceRule: null, humanWhen: `today at ${formatClock(clock.hour, clock.minute)}` };
    return { parse, remainder: stripMatch(text, today) };
  }

  // 7. "Monday at TIME" (next occurrence). A weekday without a time is ambiguous.
  const weekday = WEEKDAY_RE.exec(text);
  if (weekday) {
    if (!weekday[2]) {
      return { parse: { ok: false, reason: "needs_time" }, remainder: stripMatch(text, weekday) };
    }
    const clock = parseClock(weekday[2]);
    if (!clock) return { parse: { ok: false, reason: "needs_time" }, remainder: stripMatch(text, weekday) };
    const idx = WEEKDAYS.indexOf(weekday[1]!.toLowerCase() as (typeof WEEKDAYS)[number]);
    return {
      parse: buildWeekday(now, timeZone, idx, clock.hour, clock.minute, false),
      remainder: stripMatch(text, weekday),
    };
  }

  return { parse: { ok: false, reason: "needs_time" }, remainder: text.trim() };
}

/**
 * Pure: advance a recurring reminder's next fire time past `now`. Keeps the same
 * clock time by stepping one full period (day/week) at a time.
 */
export function computeNextRun(current: Date, rule: RecurrenceRule, now: Date): Date {
  const stepMs = rule === "weekly" ? 7 * 86_400_000 : 86_400_000;
  let next = current.getTime() + stepMs;
  while (next <= now.getTime()) next += stepMs;
  return new Date(next);
}
