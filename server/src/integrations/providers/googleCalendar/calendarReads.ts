import { getUserTimezone } from "../../../reminders/reminders";
import { wallTimeToUtc } from "../../../reminders/parse";
import { logger } from "../../../utils/logger";
import { GoogleCalendarError, isReconnectReason } from "./client";
import { findCalendarEvents } from "./calendarWrites";
import { dedupeRecurringSeries } from "./events";
import {
  DEFAULT_WORKING_WINDOW,
  computeFreeWindows,
  conflictsIn,
  mergeIntervals,
  queryFreeBusy,
  type TimeInterval,
  type WorkingWindow,
} from "./freeBusy";
import {
  formatClock,
  formatEventDetail,
  formatEventLine,
  formatEventList,
  formatFreeWindows,
  formatWindow,
} from "./calendarDisplay";
import { recordCalendarSelection, type CalendarContextStore } from "./calendarContext";
import { addDaysToDate, formatNowLocal } from "./calendarActions";
import {
  extractCalendarReadIntent,
  type CalendarReadIntent,
} from "./calendarIntentExtract";
import type { TextGenerator } from "./calendarActionExtract";
import { GOOGLE_CALENDAR_PROVIDER, type NormalizedCalendarEvent } from "./types";

/**
 * Flexible Calendar READS — schedules, search, and availability (Section 18).
 *
 * `calendarQuestion.ts` keeps its fast regex path for the fixed shapes it
 * already answers ("what's on my calendar today"), and runs FIRST. This module
 * takes what that path declines: arbitrary dates and ranges, topic/attendee/
 * location search, and real free/busy questions.
 *
 * The division of labour is the same as the write path. The model maps loose
 * language onto typed slots and does nothing else — it never reads the calendar
 * and never decides what is on it. This file queries Google and answers strictly
 * from what comes back. Nothing here writes.
 */

/** Fixed, honest replies. */
export const CALENDAR_READ_REPLIES = {
  notConnected:
    "I don’t have your Google Calendar connected yet. Once you connect it in Hula, I’ll be able to answer that.",
  reconnect:
    "It looks like my access to your Google Calendar has expired. Reconnect it in Hula and I’ll be able to check again.",
  unavailable:
    "I’m having trouble reaching your Google Calendar right now — mind trying again in a bit?",
  // Deliberately explicit: an availability question that cannot be checked must
  // NEVER degrade into a guess. Saying "I couldn't check" is the correct answer.
  availabilityUnavailable:
    "I couldn’t check your availability just now — mind trying again in a bit?",
  noDate: "Which day should I check?",
} as const;

/** How far ahead an undated search looks. */
const DEFAULT_SEARCH_DAYS = 30;
/** Cap on events we read for a range answer. */
const MAX_READ_RESULTS = 25;
/** Cap on events we show in one message. */
const MAX_SHOWN = 8;
/** Default meeting length when the user asks for a slot without saying how long. */
const DEFAULT_SLOT_MINUTES = 60;

// --- Prefilters (PURE) ---------------------------------------------------

/**
 * PURE: is this an AVAILABILITY question?
 *
 * A narrow gate, not an interpretation: it decides whether to spend one model
 * call, and the model does the real work. It has to exist and it has to run
 * before the regex schedule path, because "am I free tomorrow at 3?" already
 * matches that path — which would answer it by listing tomorrow's events. That
 * is a different question, answered from an event list rather than real
 * free/busy, and it is exactly what Section 18 forbids.
 */
export function looksLikeAvailabilityQuestion(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (/\b(?:am|are)\s+i\s+(?:free|busy|available|around|open)\b/.test(t)) return true;
  if (/\bwhen\s+(?:am|are)\s+i\s+(?:free|available|open)\b/.test(t)) return true;
  if (/\b(?:do|have)\s+i\s+(?:have\s+)?(?:a\s+)?(?:conflict|clash)\b/.test(t)) return true;
  if (/\bfind\s+(?:me\s+)?(?:a|an|some)?\s*(?:free|open)\b/.test(t)) return true;
  if (/\b(?:free|open)\s+(?:slot|time|hour|window|space)\b/.test(t)) return true;
  if (/\bany\s+(?:free|open)\b/.test(t)) return true;
  return false;
}

/**
 * PURE: is this plausibly a calendar READ we should try to interpret?
 *
 * Broad on purpose — this only decides whether to spend one model call on a
 * message that every other handler has already declined. The model's
 * `not_calendar_read` verdict is the real filter.
 */
export function looksLikeCalendarRead(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  const hasCalendarNoun =
    /\b(?:calendar|schedule|agenda|meetings?|events?|appointments?|calls?|booked|doing|plans?)\b/.test(
      t,
    );
  if (!hasCalendarNoun) return false;
  // A question shape, or an explicit lookup verb.
  return (
    /\?$/.test(t) ||
    /\b(?:what|when|where|who|which|do|does|is|are|any)\b/.test(t) ||
    /\b(?:find|search|show|list|look up|pull up)\b/.test(t)
  );
}

// --- Window helpers (PURE) -----------------------------------------------

/** PURE: the working window an intent asks for, or the bounded default. */
export function windowFromIntent(intent: CalendarReadIntent): WorkingWindow {
  const start = intent.windowStartHour;
  const end = intent.windowEndHour;
  if (
    start !== null &&
    start !== undefined &&
    end !== null &&
    end !== undefined &&
    end > start
  ) {
    return { startHour: start, endHour: end };
  }
  return DEFAULT_WORKING_WINDOW;
}

/**
 * PURE: the absolute [timeMin, timeMax) an intent covers.
 *
 * Falls back to a bounded forward window when the model gave no dates, so an
 * undated "find my meetings with Rob" still asks Google a bounded question
 * rather than an unbounded one.
 */
export function rangeFromIntent(
  intent: CalendarReadIntent,
  now: Date,
  tz: string | undefined,
): { timeMin: string; timeMax: string } {
  const from = intent.dateFrom ?? null;
  const to = intent.dateTo ?? intent.dateFrom ?? null;
  if (!from || !to) {
    return {
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + DEFAULT_SEARCH_DAYS * 86_400_000).toISOString(),
    };
  }
  const [fy, fm, fd] = from.split("-").map(Number);
  const start = wallTimeToUtc(fy!, fm!, fd!, 0, 0, tz);
  // `timeMax` is exclusive → local midnight AFTER the last requested day.
  const endDate = addDaysToDate(to, 1);
  const [ty, tm, td] = endDate.split("-").map(Number);
  const end = wallTimeToUtc(ty!, tm!, td!, 0, 0, tz);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

/** PURE: does an intent span more than one local day? */
export function isMultiDay(intent: CalendarReadIntent): boolean {
  if (!intent.dateFrom || !intent.dateTo) return true;
  return intent.dateFrom !== intent.dateTo;
}

/**
 * PURE: keep only events that genuinely involve the named person.
 *
 * Google's free-text `q` also matches the DESCRIPTION, so "meetings with Rob"
 * happily returns an event whose notes merely mention Rob. That is a false
 * positive for the question actually asked, so attendance is re-checked here
 * against the real attendee list and organizer.
 */
export function matchesAttendee(event: NormalizedCalendarEvent, needle: string): boolean {
  const term = needle.trim().toLowerCase();
  if (!term) return true;
  if ((event.organizerEmail ?? "").toLowerCase().includes(term)) return true;
  return event.attendees.some((a) => {
    if (a.email.toLowerCase().includes(term)) return true;
    return (a.displayName ?? "").toLowerCase().includes(term);
  });
}

/** PURE: keep only events whose location genuinely matches. */
export function matchesLocation(event: NormalizedCalendarEvent, needle: string): boolean {
  const term = needle.trim().toLowerCase();
  if (!term) return true;
  return (event.location ?? "").toLowerCase().includes(term);
}

// --- Shared plumbing -----------------------------------------------------

/** Injectable dependencies so the whole flow runs with NO DB / network in tests. */
export interface CalendarReadDeps {
  getTimezone?: (userId: string) => Promise<string | undefined>;
  extract?: (params: {
    text: string;
    nowLocalIso: string;
    timezone: string | undefined;
    generate?: TextGenerator;
  }) => Promise<CalendarReadIntent | null>;
  generate?: TextGenerator;
  find?: typeof findCalendarEvents;
  freeBusy?: typeof queryFreeBusy;
  contextStore?: CalendarContextStore;
  now?: Date;
}

export interface CalendarReadResult {
  handled: boolean;
  reply?: string;
  intent?: CalendarReadIntent["intent"];
}

/** Map a provider error to an honest reply. */
function replyForError(err: unknown, availability: boolean): string {
  if (err instanceof GoogleCalendarError) {
    if (err.reason === "not_connected") return CALENDAR_READ_REPLIES.notConnected;
    if (isReconnectReason(err.reason) || err.reason === "insufficient_scope") {
      return CALENDAR_READ_REPLIES.reconnect;
    }
  }
  return availability
    ? CALENDAR_READ_REPLIES.availabilityUnavailable
    : CALENDAR_READ_REPLIES.unavailable;
}

/** Safe structured log — a coded reason only, never a token or raw body. */
function logReadError(operation: string, err: unknown): void {
  if (err instanceof GoogleCalendarError) {
    logger.error("googleCalendar.read failed", {
      provider: GOOGLE_CALENDAR_PROVIDER,
      operation,
      errorCode: err.reason,
      httpStatus: err.httpStatus,
    });
    return;
  }
  logger.error("googleCalendar.read failed", {
    provider: GOOGLE_CALENDAR_PROVIDER,
    operation,
    reason: err instanceof Error ? err.message : "unknown error",
  });
}

/** Best-effort: remember the numbered list so "the second one" resolves. */
async function rememberShown(
  userId: string,
  events: NormalizedCalendarEvent[],
  deps: CalendarReadDeps,
): Promise<void> {
  if (events.length === 0) return;
  try {
    await recordCalendarSelection(userId, events, deps.contextStore ?? {});
  } catch (err) {
    // Losing the list costs "the second one", never the reply itself.
    logger.error("googleCalendar.selection record failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}

/** Resolve the intent for a message, or null to fall through. */
async function resolveIntent(
  userId: string,
  text: string | undefined,
  deps: CalendarReadDeps,
): Promise<{ intent: CalendarReadIntent; tz: string | undefined; now: Date } | null> {
  const getTz = deps.getTimezone ?? getUserTimezone;
  const extract = deps.extract ?? extractCalendarReadIntent;
  const now = deps.now ?? new Date();

  let tz: string | undefined;
  try {
    tz = await getTz(userId);
  } catch {
    tz = undefined;
  }

  const intent = await extract({
    text: text ?? "",
    nowLocalIso: formatNowLocal(now, tz),
    timezone: tz,
    generate: deps.generate,
  });
  if (!intent || intent.intent === "not_calendar_read") return null;
  return { intent, tz, now };
}

// --- Availability --------------------------------------------------------

/**
 * PURE: the FORM of an availability question, when the model didn't say.
 *
 * A deliberate, general fallback — not phrase-by-phrase matching. It keys on the
 * grammatical shape that separates the two questions in English: a
 * "when/find"-style request enumerates, everything else in the availability
 * family is a yes/no. Defaulting to `check` is also the safer default: a yes/no
 * answer to a gap request is merely terse, whereas gap-listing in reply to a
 * yes/no question is the actual reported bug (it reads as "these are your ONLY
 * free hours").
 */
export function inferAvailabilityKind(text: string | undefined): "check" | "find" {
  const t = (text ?? "").trim().toLowerCase();
  if (/\bwhen\s+(?:am|are)\s+i\b/.test(t)) return "find";
  if (/\b(?:find|show|list|give)\b/.test(t)) return "find";
  if (/\bwhat\s+(?:times?|slots?|windows?)\b/.test(t)) return "find";
  return "check";
}

/**
 * PURE: a general daypart label from an hour window.
 *
 * Derived from the HOURS, not from the word the user typed, so it works for any
 * daypart the extractor produces and never special-cases "afternoon". A window
 * that isn't a recognisable daypart gets an explicit time range instead of a
 * name it doesn't deserve.
 */
export function dayPartLabel(
  window: WorkingWindow | null,
  tz: string | undefined,
  onDate: string | null,
): string {
  if (!window) return "";
  // Named ONLY on an exact match against the canonical dayparts (the same
  // definitions the extractor is told to use). A window that merely sits inside
  // the afternoon band is NOT "the afternoon" — "free between 2 and 4?" asked
  // about two hours, and calling that "the afternoon" would put words in the
  // user's mouth and make the answer look broader than the question.
  const named = DAYPARTS.find(
    (d) => d.startHour === window.startHour && d.endHour === window.endHour,
  );
  if (named) return named.name;

  // Not a canonical daypart — say the actual hours rather than invent a name.
  if (onDate) {
    const from = formatClock(hourInstant(onDate, window.startHour, tz), tz);
    const to = formatClock(hourInstant(onDate, window.endHour, tz), tz);
    if (from && to) return `between ${from} and ${to}`;
  }
  return "";
}

/**
 * The canonical dayparts, as a table rather than scattered conditionals.
 *
 * These are the SAME bounds `calendarIntentExtract` instructs the model to
 * produce, kept in one place so the label and the query can never drift apart.
 * Adding a daypart is a row here — there is no per-word special-casing anywhere.
 */
const DAYPARTS: readonly { name: string; startHour: number; endHour: number }[] = [
  { name: "morning", startHour: 9, endHour: 12 },
  { name: "afternoon", startHour: 12, endHour: 17 },
  { name: "evening", startHour: 17, endHour: 21 },
];

/** PURE: the absolute instant of a local wall-clock hour on a date. */
function hourInstant(date: string, hour: number, tz: string | undefined): string {
  const [y, m, d] = date.split("-").map(Number);
  if (hour >= 24) {
    return wallTimeToUtc(y!, m!, d! + 1, 0, 0, tz).toISOString();
  }
  return wallTimeToUtc(y!, m!, d!, hour, 0, tz).toISOString();
}

/** PURE: "today" / "tomorrow" / "Friday" for a date, relative to now. */
export function dayLabel(
  date: string | null,
  now: Date,
  tz: string | undefined,
): string {
  if (!date) return "";
  const todayLocal = localDateString(now, tz);
  const tomorrowLocal = localDateString(new Date(now.getTime() + 86_400_000), tz);
  if (date === todayLocal) return "today";
  if (date === tomorrowLocal) return "tomorrow";
  try {
    // Format the bare date at UTC noon so a timezone can't roll it to the
    // neighbouring day and name the wrong weekday.
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "long",
    }).format(new Date(`${date}T12:00:00Z`));
  } catch {
    return "";
  }
}

/** PURE: the local `YYYY-MM-DD` for an instant in a timezone. */
function localDateString(date: Date, tz: string | undefined): string {
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(date)) if (p.type !== "literal") map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return "";
  }
}

/**
 * PURE: how to describe the interval the user actually asked about — "Friday
 * afternoon", "tomorrow", "Friday between 2:00 PM and 4:00 PM".
 *
 * This is what makes the answer echo the QUESTION rather than our internal
 * query bounds.
 */
export function describeQueriedInterval(input: {
  date: string | null;
  window: WorkingWindow | null;
  wholeDay: boolean;
  now: Date;
  tz: string | undefined;
}): string {
  const day = dayLabel(input.date, input.now, input.tz);
  if (input.wholeDay) return day ? `all day ${day}` : "all day";
  const part = dayPartLabel(input.window, input.tz, input.date);
  if (day && part) return `${day} ${part}`;
  return day || part;
}

/** The resolved interval an availability CHECK asks about. */
interface CheckTarget {
  interval: TimeInterval;
  /** How to describe it back to the user. */
  label: string;
  /** True when this covers the whole local day already. */
  isWholeDay: boolean;
}

/**
 * PURE: resolve the exact interval a `check` asks about.
 *
 * Three shapes, in order of specificity:
 *   1. a named time      → [checkTime, +duration)
 *   2. an explicit/​daypart window → [windowStart, windowEnd) on the date
 *   3. nothing narrower  → the whole local day
 *
 * Case 3 matters: "am I free all day Friday?" must query the WHOLE day, not the
 * 9–5 working window. The working window is a device for OFFERING slots; it has
 * no business narrowing a yes/no question the user scoped themselves.
 */
export function resolveCheckTarget(
  intent: CalendarReadIntent,
  now: Date,
  tz: string | undefined,
): CheckTarget | null {
  const date = intent.dateFrom ?? null;
  if (!date) return null;

  if (intent.checkTime) {
    const [h, min] = intent.checkTime.split(":").map(Number);
    const [y, m, d] = date.split("-").map(Number);
    const start = wallTimeToUtc(y!, m!, d!, h!, min!, tz);
    const minutes = intent.durationMinutes ?? DEFAULT_SLOT_MINUTES;
    return {
      interval: {
        start: start.toISOString(),
        end: new Date(start.getTime() + minutes * 60_000).toISOString(),
      },
      label: "",
      isWholeDay: false,
    };
  }

  const hasWindow =
    !intent.wholeDay &&
    intent.windowStartHour !== null &&
    intent.windowStartHour !== undefined &&
    intent.windowEndHour !== null &&
    intent.windowEndHour !== undefined &&
    intent.windowEndHour > intent.windowStartHour;

  const window: WorkingWindow | null = hasWindow
    ? { startHour: intent.windowStartHour!, endHour: intent.windowEndHour! }
    : null;

  const startHour = window ? window.startHour : 0;
  const endHour = window ? window.endHour : 24;

  return {
    interval: {
      start: hourInstant(date, startHour, tz),
      end: hourInstant(date, endHour, tz),
    },
    label: describeQueriedInterval({
      date,
      window,
      wholeDay: !window,
      now,
      tz,
    }),
    isWholeDay: !window,
  };
}

/** PURE: the whole local day as an interval. */
function wholeDayInterval(date: string, tz: string | undefined): TimeInterval {
  return { start: hourInstant(date, 0, tz), end: hourInstant(date, 24, tz) };
}

/**
 * Answer an availability question from Google's REAL free/busy.
 *
 * Returns `{ handled:false }` when the message isn't an availability question or
 * the model can't be reached, so the caller falls through. Never throws.
 *
 * The one rule: a failure to CHECK is reported as a failure to check. There is
 * no branch here that answers "you're free" from anything other than a
 * successful free/busy query, and nothing is ever claimed about time outside the
 * interval that was actually queried.
 */
export async function handleCalendarAvailability(
  userId: string,
  text: string | undefined,
  deps: CalendarReadDeps = {},
): Promise<CalendarReadResult> {
  if (!looksLikeAvailabilityQuestion(text)) return { handled: false };

  const resolved = await resolveIntent(userId, text, deps);
  if (!resolved) return { handled: false };
  const { intent, tz, now } = resolved;
  if (intent.intent !== "availability") return { handled: false };

  const kind = intent.availabilityKind ?? inferAvailabilityKind(text);
  const freeBusy = deps.freeBusy ?? queryFreeBusy;

  try {
    if (kind === "check") {
      return await answerAvailabilityCheck(userId, intent, now, tz, deps, freeBusy);
    }
    return await answerAvailabilityFind(userId, intent, now, tz, freeBusy);
  } catch (err) {
    logReadError("calendar.availability", err);
    return { handled: true, intent: "availability", reply: replyForError(err, true) };
  }
}

/**
 * "Am I free Friday afternoon?" — a direct yes/no about ONE interval.
 *
 * Only the requested interval is queried, and only it is described. The internal
 * daypart bounds are used to ASK Google the right question; they are never
 * presented as if they were the user's availability.
 */
async function answerAvailabilityCheck(
  userId: string,
  intent: CalendarReadIntent,
  now: Date,
  tz: string | undefined,
  deps: CalendarReadDeps,
  freeBusy: typeof queryFreeBusy,
): Promise<CalendarReadResult> {
  const target = resolveCheckTarget(intent, now, tz);
  if (!target) {
    return { handled: true, intent: "availability", reply: CALENDAR_READ_REPLIES.noDate };
  }

  const busy = await freeBusy(userId, {
    timeMin: target.interval.start,
    timeMax: target.interval.end,
    ...(tz ? { timeZone: tz } : {}),
  });
  const clashes = conflictsIn(target.interval, busy);

  // --- A specific time: "am I free at 3?" ---------------------------------
  if (intent.checkTime) {
    const at = formatClock(target.interval.start, tz);
    if (clashes.length === 0) {
      return { handled: true, intent: "availability", reply: `Yes — you’re free at ${at}.` };
    }
    const first = clashes[0]!;
    return {
      handled: true,
      intent: "availability",
      reply: `No — you’ve got something at ${at}. You’re booked ${formatClock(
        first.start,
        tz,
      )}–${formatClock(first.end, tz)}.`,
    };
  }

  const label = target.label;

  // --- Free across the whole requested interval ---------------------------
  if (clashes.length === 0) {
    let reply = label ? `Yes — you’re free ${label}.` : "Yes — you’re free then.";
    // The whole-day claim is allowed ONLY on a SEPARATE, successful verification
    // of the whole day. An afternoon query says nothing about the morning, so it
    // must never be stretched into one.
    if (!target.isWholeDay && intent.dateFrom) {
      const dayClear = await isWholeDayClear(userId, intent.dateFrom, tz, freeBusy);
      if (dayClear) reply += " Your calendar is clear all day.";
    }
    return { handled: true, intent: "availability", reply };
  }

  // --- Not free: say so, and ground it in real events/gaps ----------------
  // "not completely free X" composes correctly for every label shape — including
  // "all day Friday", where "not free all of all day Friday" would be nonsense.
  const lines: string[] = [
    label ? `No — you’re not completely free ${label}.` : "No — you’re not completely free then.",
  ];

  const events = await conflictingEvents(userId, target.interval, deps);
  if (events.length > 0) {
    lines.push("You’ve got:");
    for (const e of events.slice(0, MAX_SHOWN)) {
      lines.push(`• ${formatEventLine(e, tz)}`);
    }
  } else {
    // No readable events (e.g. busy from another calendar). Report the real busy
    // intervals rather than inventing an event to name.
    lines.push("You’re busy:");
    for (const b of clashes.slice(0, MAX_SHOWN)) {
      lines.push(`• ${formatClock(b.start, tz)}–${formatClock(b.end, tz)}`);
    }
  }

  // Accurately derived gaps INSIDE the requested interval only.
  const gaps = subtractBusy(target.interval, busy).filter(
    (g) => Date.parse(g.end) - Date.parse(g.start) >= MIN_GAP_MINUTES * 60_000,
  );
  if (gaps.length > 0) {
    lines.push(
      `You’re free ${gaps.map((g) => formatWindow(g, tz)).join(", ")}.`,
    );
  }

  return { handled: true, intent: "availability", reply: lines.join("\n") };
}

/**
 * A SEPARATE whole-day free/busy query — the only thing that can license a
 * "clear all day" claim. Best-effort: if it fails we simply don't make the
 * claim, because an unverified one would be exactly the fabrication the section
 * forbids.
 */
async function isWholeDayClear(
  userId: string,
  date: string,
  tz: string | undefined,
  freeBusy: typeof queryFreeBusy,
): Promise<boolean> {
  try {
    const day = wholeDayInterval(date, tz);
    const busy = await freeBusy(userId, {
      timeMin: day.start,
      timeMax: day.end,
      ...(tz ? { timeZone: tz } : {}),
    });
    return conflictsIn(day, busy).length === 0;
  } catch {
    return false;
  }
}

/** The real events inside an interval, for a grounded conflict list. */
async function conflictingEvents(
  userId: string,
  interval: TimeInterval,
  deps: CalendarReadDeps,
): Promise<NormalizedCalendarEvent[]> {
  const find = deps.find ?? findCalendarEvents;
  try {
    const events = await find(userId, {
      timeMin: interval.start,
      timeMax: interval.end,
      maxResults: MAX_READ_RESULTS,
    });
    // An all-day event spans the window without being a "conflict at 2pm"; keep
    // only timed events that genuinely overlap.
    return events.filter(
      (e) =>
        !e.allDay &&
        e.start !== null &&
        e.end !== null &&
        isIntervalOverlap({ start: e.start, end: e.end }, interval),
    );
  } catch {
    return [];
  }
}

/** PURE: do two intervals genuinely overlap (half-open)? */
function isIntervalOverlap(a: TimeInterval, b: TimeInterval): boolean {
  const as = Date.parse(a.start);
  const ae = Date.parse(a.end);
  const bs = Date.parse(b.start);
  const be = Date.parse(b.end);
  if (![as, ae, bs, be].every(Number.isFinite)) return false;
  return as < be && ae > bs;
}

/** Gaps shorter than this aren't worth offering as availability. */
const MIN_GAP_MINUTES = 15;

/**
 * PURE: the free gaps inside ONE interval, given busy blocks.
 *
 * Deliberately NOT `computeFreeWindows`: that one clips to the bounded working
 * window, which is right for "find me a slot" and wrong here — the user named
 * the interval themselves, so the answer must stay inside exactly that and not
 * be re-narrowed by our 9–5 default.
 */
export function subtractBusy(
  interval: TimeInterval,
  busy: TimeInterval[],
): TimeInterval[] {
  const merged = mergeIntervals(busy);
  const end = Date.parse(interval.end);
  let cursor = Date.parse(interval.start);
  const out: TimeInterval[] = [];

  for (const block of merged) {
    const bs = Date.parse(block.start);
    const be = Date.parse(block.end);
    if (be <= cursor) continue;
    if (bs >= end) break;
    if (bs > cursor) {
      out.push({ start: new Date(cursor).toISOString(), end: new Date(Math.min(bs, end)).toISOString() });
    }
    cursor = Math.max(cursor, be);
    if (cursor >= end) break;
  }
  if (end > cursor) {
    out.push({ start: new Date(cursor).toISOString(), end: new Date(end).toISOString() });
  }
  return out;
}

/**
 * "When am I free Friday afternoon?" — enumerate the real open gaps.
 *
 * Here the working window IS appropriate: the user asked us to offer slots, and
 * offering 3am is a wrong answer even though it is technically free.
 */
async function answerAvailabilityFind(
  userId: string,
  intent: CalendarReadIntent,
  now: Date,
  tz: string | undefined,
  freeBusy: typeof queryFreeBusy,
): Promise<CalendarReadResult> {
  const range = rangeFromIntent(intent, now, tz);
  const busy = await freeBusy(userId, {
    timeMin: range.timeMin,
    timeMax: range.timeMax,
    ...(tz ? { timeZone: tz } : {}),
  });

  const minMinutes = intent.durationMinutes ?? DEFAULT_SLOT_MINUTES;
  const windows = computeFreeWindows({
    from: range.timeMin,
    to: range.timeMax,
    busy,
    timeZone: tz,
    minMinutes,
    workingWindow: windowFromIntent(intent),
    // Never offer a slot that has already passed.
    notBefore: now.toISOString(),
  });

  if (windows.length === 0) {
    return {
      handled: true,
      intent: "availability",
      reply: `I couldn’t find a free ${minMinutes}-minute slot in that window.`,
    };
  }
  const multiDay = isMultiDay(intent);
  return {
    handled: true,
    intent: "availability",
    reply: `Here’s when you’re free:\n${formatFreeWindows(windows, tz, {
      includeDay: multiDay,
    })}`,
  };
}

// --- Schedules and search ------------------------------------------------

/**
 * Answer a flexible schedule/search question.
 *
 * Runs only for messages `calendarQuestion`'s regex path declined, so the tested
 * fixed shapes keep their exact behaviour. Never throws.
 */
export async function handleCalendarFlexibleRead(
  userId: string,
  text: string | undefined,
  deps: CalendarReadDeps = {},
): Promise<CalendarReadResult> {
  if (!looksLikeCalendarRead(text)) return { handled: false };

  const resolved = await resolveIntent(userId, text, deps);
  if (!resolved) return { handled: false };
  const { intent, tz, now } = resolved;
  if (intent.intent !== "schedule" && intent.intent !== "search") return { handled: false };

  const find = deps.find ?? findCalendarEvents;
  const range = rangeFromIntent(intent, now, tz);

  // Build Google's free-text query from every term the user actually gave.
  const qParts = [intent.query, intent.attendee, intent.location]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  const q = qParts.join(" ");

  try {
    let events = await find(userId, {
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      maxResults: MAX_READ_RESULTS,
      ...(q ? { query: q } : {}),
    });

    // Re-check the constraints Google's `q` is too loose about.
    if (intent.attendee) {
      events = events.filter((e) => matchesAttendee(e, intent.attendee!));
    }
    if (intent.location) {
      events = events.filter((e) => matchesLocation(e, intent.location!));
    }

    // Collapse a repeated series on a MULTI-DAY read only. A single day
    // legitimately shows every occurrence that falls that day.
    if (isMultiDay(intent)) events = dedupeRecurringSeries(events);

    if (events.length === 0) {
      return { handled: true, intent: intent.intent, reply: emptyReply(intent) };
    }

    const shown = events.slice(0, MAX_SHOWN);
    await rememberShown(userId, shown, deps);

    // A single result is more useful as a full card than as a one-item list.
    if (shown.length === 1) {
      return {
        handled: true,
        intent: intent.intent,
        reply: formatEventDetail(shown[0]!, tz),
      };
    }

    const header = headerFor(intent, events.length, shown.length);
    return {
      handled: true,
      intent: intent.intent,
      reply: formatEventList(shown, tz, { header, includeDay: isMultiDay(intent) }),
    };
  } catch (err) {
    logReadError(`calendar.${intent.intent}`, err);
    return { handled: true, intent: intent.intent, reply: replyForError(err, false) };
  }
}

/** PURE: the honest empty-state reply for an intent. */
export function emptyReply(intent: CalendarReadIntent): string {
  if (intent.intent === "search") {
    const what = [intent.query, intent.attendee, intent.location].find(
      (s) => s && s.trim().length > 0,
    );
    return what
      ? `I couldn’t find anything matching “${what.trim()}” on your calendar.`
      : "I couldn’t find any matching events on your calendar.";
  }
  return "You’ve got nothing on your calendar then.";
}

/** PURE: the list header, naming what was searched and how much is shown. */
export function headerFor(
  intent: CalendarReadIntent,
  total: number,
  shown: number,
): string {
  const truncated = total > shown ? ` (showing ${shown} of ${total})` : "";
  if (intent.intent === "search") {
    const what = [intent.query, intent.attendee, intent.location].find(
      (s) => s && s.trim().length > 0,
    );
    return what
      ? `Here’s what I found for “${what.trim()}”${truncated}:`
      : `Here’s what I found${truncated}:`;
  }
  return `Here’s what you’ve got${truncated}:`;
}
