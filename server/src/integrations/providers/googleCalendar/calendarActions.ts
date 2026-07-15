import { getConnectionForUserProvider } from "../../connections";
import { CONFIRM_INSTRUCTION } from "../../../actions/confirmationCopy";
import { getUserTimezone } from "../../../reminders/reminders";
import { wallTimeToUtc } from "../../../reminders/parse";
import { logger } from "../../../utils/logger";
import { createActionProposal } from "../../../actions/proposals";
import { GoogleCalendarError, isReconnectReason } from "./client";
import { findCalendarEvents, getCalendarEvent } from "./calendarWrites";
import { generateConferenceRequestId } from "./conference";
import { queryFreeBusy, type TimeInterval } from "./freeBusy";
import {
  loadCalendarEntityContext,
  loadLatestCalendarSelection,
  parseCalendarOrdinal,
  recordCalendarSelection,
  recordSelectedCalendarEvent,
  referencesCalendarPronoun,
  referencesLastCalendarAction,
  referencesLastCalendarResults,
  resolveCalendarSelectionItem,
  toSelectionItem,
  type CalendarContextStore,
} from "./calendarContext";
import {
  eventTitle,
  formatAttendees,
  formatEventWhen,
} from "./calendarDisplay";
import {
  extractCalendarAction,
  type CalendarAction,
  type RecurrenceScope,
  type TextGenerator,
} from "./calendarActionExtract";
import {
  CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_PROVIDER,
  type NormalizedCalendarEvent,
} from "./types";

/**
 * Calendar WRITE routing (Sections 15 + 17 + 18) — create / update / delete via
 * iMessage.
 *
 * A deterministic prefilter, then a strictly validated model extraction, then a
 * DETERMINISTIC backend that resolves the real event and guards safety (never
 * write in the past, never on an ambiguous match, never guess a recurrence scope,
 * never invent an attendee). The model never touches Google. Never throws — every
 * failure degrades to an honest reply.
 *
 * Nothing here writes. Each path ends by creating a durable Section 12 proposal
 * holding the fully-resolved event id and ISO instants, and replies with a
 * preview. Only a subsequent natural confirmation ("yh", "do it") executes it —
 * through the same proposal → confirmation → executor → validated-receipt path
 * Gmail sends use. That buys three things: a user-visible preview before anything
 * mutates, durable idempotency across restarts and duplicate webhook deliveries
 * (the atomic `proposed → confirmed` claim can only win once), and a single place
 * where provider receipts are validated.
 *
 * Everything resolved here is resolved ONCE, at proposal time, and the executor
 * replays it verbatim — so the event the user saw previewed is exactly the event
 * that gets written. Section 18 extends what may be resolved (attendees, a Meet
 * request id, a recurrence scope) but not that rule.
 */

/** Default event length when the user gives a start but no duration. */
const DEFAULT_DURATION_MINUTES = 60;
/** How many candidate matches to show when a request is ambiguous. */
const MAX_AMBIGUOUS_SHOWN = 4;

/** Fixed, honest replies matching the codebase voice. */
export const CALENDAR_WRITE_REPLIES = {
  notConnected:
    "I don’t have your Google Calendar connected yet. Connect it in Hula and I’ll be able to manage your events.",
  reconnect:
    "I can read your Google Calendar but I don’t have permission to change it yet. Reconnect it in Hula to let me create, move, and delete events.",
  unavailable:
    "I’m having trouble reaching your Google Calendar right now — mind trying again in a bit?",
  needTitle: "What should I call the event?",
  needTime: "What time should I schedule that for?",
  needDate: "Which day is that event on?",
  needChange: "What would you like to change about it?",
  inPast: "That time’s already passed — when should I schedule it for?",
  notFound: "I couldn’t find a matching calendar event.",
  recurring:
    "That looks like a repeating event. To avoid changing the whole series, tell me the exact date and time of the one you mean.",
  staleReference:
    "I’m not sure which event you mean anymore — tell me the name and the day and I’ll find it.",
  // "this and following" is deliberately NOT offered: Google has no single safe
  // call for it (see `describeRecurrenceChoice`).
  recurrenceScope:
    "That’s a repeating event. Do you mean just this occurrence, or the entire series?",
  seriesUnsupported:
    "I can’t change just the future occurrences yet — Google needs the series split for that. I can do just this one occurrence, or the whole series.",
} as const;

// --- Prefilter (PURE) ----------------------------------------------------

const CREATE_VERB_RE =
  /\b(?:schedule|book|set ?up|add|create|put|block(?: off| out)?|arrange|plan|invite)\b/i;
const UPDATE_VERB_RE =
  /\b(?:move|reschedule|rename|push(?: back)?|shift|change|make it|add|remove|extend|shorten)\b/i;
const DELETE_VERB_RE = /\b(?:delete|cancel|remove|clear|drop)\b/i;

const EVENT_NOUN_RE =
  /\b(?:calendar|events?|meetings?|appointments?|calls?|lunch|dinner|breakfast|coffee|standup|sync|1:1|one on one|catch ?up|google meet|meet link|video call)\b/i;
const TIME_CUE_RE =
  /\b(?:\d{1,2}\s?(?:am|pm)|\d{1,2}:\d{2}|noon|midnight|tonight|tomorrow|today|next week|this (?:week|weekend)|(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:on )?(?:mon|tue|wed|thu|fri|sat|sun))\b/i;

/**
 * PURE: a fast, cheap gate deciding whether a message is worth extracting as a
 * calendar write.
 *
 * It needs an imperative calendar verb plus SOMETHING to anchor it: a calendar
 * noun, a time cue, or — added in Section 18 — a reference to an event already
 * under discussion. That third branch is the important one. Once Hula has shown
 * a list or created an event, the user stops naming things: "cancel the second
 * one", "move it to Friday", "make it a Google Meet". None of those carry a
 * calendar noun or a time cue, so before Section 18 every one of them fell
 * straight through this gate to the generic model.
 *
 * The model extraction is the real classifier — a false positive here just costs
 * one extraction that returns `not_calendar_write`.
 */
export function looksLikeCalendarWrite(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const hasVerb = CREATE_VERB_RE.test(t) || UPDATE_VERB_RE.test(t) || DELETE_VERB_RE.test(t);
  if (!hasVerb) return false;
  if (EVENT_NOUN_RE.test(t) || TIME_CUE_RE.test(t)) return true;
  // A reference to something already on screen or just acted on.
  return (
    referencesLastCalendarResults(t) ||
    referencesLastCalendarAction(t) ||
    referencesCalendarPronoun(t)
  );
}

// --- Time helpers (PURE) -------------------------------------------------

/** Format the current local time for the extraction prompt (stable, readable). */
export function formatNowLocal(now: Date, tz: string | undefined): string {
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz ?? "UTC",
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(now)) if (p.type !== "literal") map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute} (${map.weekday})`;
  } catch {
    return now.toISOString();
  }
}

/** PURE: local Y/M/D for an instant in a timezone. */
function localYmd(iso: string, tz: string | undefined): { y: number; m: number; d: number } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const map: Record<string, number> = {};
    for (const p of dtf.formatToParts(date)) if (p.type !== "literal") map[p.type] = Number(p.value);
    return { y: map.year!, m: map.month!, d: map.day! };
  } catch {
    return null;
  }
}

/** PURE: local 24h hour:minute for an instant in a timezone. */
function localHm(iso: string, tz: string | undefined): { hour: number; minute: number } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz ?? "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const map: Record<string, number> = {};
    for (const p of dtf.formatToParts(date)) if (p.type !== "literal") map[p.type] = Number(p.value);
    return { hour: (map.hour ?? 0) % 24, minute: map.minute ?? 0 };
  } catch {
    return null;
  }
}

/** Split a "YYYY-MM-DD" date and "HH:MM" time into numeric parts. */
function splitDate(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}
function splitTime(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":").map(Number);
  return { hour: hour!, minute: minute! };
}

/** PURE: add days to a `YYYY-MM-DD`, staying on the calendar (no DST drift). */
export function addDaysToDate(date: string, days: number): string {
  const { y, m, d } = splitDate(date);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * PURE: the RFC3339 [start, end) bounds of a local calendar day, in a timezone.
 * Used to search a NARROW window around the event an update/delete refers to.
 */
export function localDayWindow(
  date: string,
  tz: string | undefined,
): { timeMin: string; timeMax: string } {
  const { y, m, d } = splitDate(date);
  const start = wallTimeToUtc(y, m, d, 0, 0, tz);
  // Next local midnight: add a day at the calendar level, then convert.
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const end = wallTimeToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    tz,
  );
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

// --- Title / time matching (PURE) ----------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "my", "our", "with", "and", "to", "at", "on", "for", "of",
  "in", "this", "that", "event", "meeting", "appointment", "calendar",
]);

function significantTokens(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z0-9']+/g) ?? []);
  return words.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/**
 * PURE: whether an event's title plausibly matches the requested title. Needs at
 * least one significant query token AND at least half of the query's significant
 * tokens to appear in the event title. No embeddings — simple overlap.
 */
export function eventTitleMatches(eventTitle: string | null, query: string): boolean {
  const q = significantTokens(query);
  if (q.length === 0) return true; // no title constraint → time/window decides
  const t = new Set(significantTokens(eventTitle ?? ""));
  const hits = q.filter((w) => t.has(w)).length;
  return hits >= Math.max(1, Math.ceil(q.length / 2));
}

/**
 * PURE: narrow a day's events to those matching the requested title, and — when a
 * disambiguating time was given — the requested clock time. Returns the surviving
 * candidates; the caller decides zero/one/many.
 */
export function selectMatches(
  events: NormalizedCalendarEvent[],
  opts: { title?: string | null; time?: string | null; tz: string | undefined },
): NormalizedCalendarEvent[] {
  let matches = events.filter((e) => eventTitleMatches(e.summary, opts.title ?? ""));
  if (opts.time) {
    const want = splitTime(opts.time);
    matches = matches.filter((e) => {
      if (!e.start) return false;
      const hm = localHm(e.start, opts.tz);
      return hm !== null && hm.hour === want.hour && hm.minute === want.minute;
    });
  }
  return matches;
}

// --- Confirmation formatting (PURE) --------------------------------------

function clock(iso: string | null, tz: string | undefined): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(
      new Date(iso),
    );
  } catch {
    return "";
  }
}
function weekday(iso: string | null, tz: string | undefined): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date(iso));
  } catch {
    return "";
  }
}
function titleOf(event: Pick<NormalizedCalendarEvent, "summary">): string {
  const s = (event.summary ?? "").trim();
  return s.length > 0 ? s : "(untitled event)";
}

/** "Tuesday from 1:00 PM to 2:00 PM" (or just the start when there's no end). */
export function formatWhen(event: NormalizedCalendarEvent, tz: string | undefined): string {
  const day = weekday(event.start, tz);
  const from = clock(event.start, tz);
  const to = clock(event.end, tz);
  if (day && from && to) return `${day} from ${from} to ${to}`;
  if (day && from) return `${day} at ${from}`;
  if (from) return from;
  return day;
}

/**
 * The receipt for a created event. Section 18 appends the REAL Meet link when
 * Google issued one — and says so honestly when it is still pending, rather than
 * silently omitting it (which would read as "no Meet was created").
 */
export function formatCreated(event: NormalizedCalendarEvent, tz: string | undefined): string {
  const when = event.allDay
    ? `${formatEventWhen(event, tz, { includeDay: true })}`
    : formatWhen(event, tz);
  const lines = [`Done — “${titleOf(event)}” is scheduled for ${when}.`];
  const attendees = formatAttendees(event.attendees);
  if (attendees) lines.push(`Invites sent to ${attendees}.`);
  if (event.conference?.meetUrl) {
    lines.push(`Google Meet: ${event.conference.meetUrl}`);
  } else if (event.conference?.status === "pending") {
    lines.push("Google is still creating the Meet link — it’ll show up on the event shortly.");
  }
  return lines.join("\n");
}

export function formatUpdated(
  event: NormalizedCalendarEvent,
  tz: string | undefined,
  renamedOnly: boolean,
): string {
  const lines: string[] = [];
  if (renamedOnly) {
    lines.push(`Updated — renamed to “${titleOf(event)}”.`);
  } else {
    lines.push(`Updated — “${titleOf(event)}” is now scheduled for ${formatWhen(event, tz)}.`);
  }
  if (event.conference?.meetUrl) {
    lines.push(`Google Meet: ${event.conference.meetUrl}`);
  } else if (event.conference?.status === "pending") {
    lines.push("Google is still creating the Meet link — it’ll show up on the event shortly.");
  }
  return lines.join("\n");
}

export function formatDeleted(event: NormalizedCalendarEvent, tz: string | undefined): string {
  const day = weekday(event.start, tz);
  const at = clock(event.start, tz);
  const when = day && at ? `${day} at ${at}` : day || at;
  return `Deleted — “${titleOf(event)}”${when ? ` on ${when}` : ""}.`;
}

// --- Preview formatting (PURE) -------------------------------------------

/** The details a create preview describes. */
export interface CreatePreviewFields {
  title: string;
  startIso?: string;
  endIso?: string;
  /** All-day events preview a bare date rather than a clock time. */
  startDate?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
  addMeet?: boolean;
  reminderMinutes?: number;
  /** Busy blocks that overlap the proposed slot, when there are any. */
  conflicts?: TimeInterval[];
}

/**
 * PURE: the concise preview shown BEFORE a write runs.
 *
 * Every line describes something that has NOT happened yet, and the wording must
 * never imply otherwise. Two lines here are load-bearing:
 *
 *  - the INVITATION warning. Confirming an event with attendees makes Google
 *    email real people, and that cannot be taken back. The user has to know that
 *    before they say yes, not after.
 *  - the CONFLICT warning. Booking over an existing meeting is usually a
 *    mistake; surfacing it costs one line and saves a double-booking. It warns
 *    rather than blocks, because sometimes the user genuinely means it.
 */
export function formatCreatePreview(
  fields: CreatePreviewFields,
  tz: string | undefined,
): string {
  const lines: string[] = [];
  const when = fields.allDay
    ? `${fields.startDate ?? ""} (all day)`
    : formatWhen(
        { start: fields.startIso ?? null, end: fields.endIso ?? null } as NormalizedCalendarEvent,
        tz,
      );
  lines.push(`I’ll schedule “${fields.title}” for ${when}.`);
  if (fields.location) lines.push(`📍 ${fields.location}`);
  if (fields.addMeet) lines.push("🎥 With a Google Meet link");
  if (fields.reminderMinutes !== undefined) {
    lines.push(`⏰ Reminder ${fields.reminderMinutes} minutes before`);
  }
  if (fields.attendees && fields.attendees.length > 0) {
    lines.push(`👥 Inviting: ${fields.attendees.join(", ")}`);
    lines.push("Confirming will email them an invitation.");
  }
  if (fields.conflicts && fields.conflicts.length > 0) {
    const first = fields.conflicts[0]!;
    lines.push(
      `⚠️ Heads up — you’re already busy ${clock(first.start, tz)}–${clock(first.end, tz)}.`,
    );
  }
  lines.push(`Want me to go ahead? ${CONFIRM_INSTRUCTION}`);
  return lines.join("\n");
}

/** The changes an update preview describes, as exact before/after values. */
export interface UpdatePreviewChanges {
  newTitle?: string;
  newLocation?: string;
  newDescription?: string;
  startIso?: string;
  endIso?: string;
  addAttendees?: string[];
  removeAttendees?: string[];
  addMeet?: boolean;
  reminderMinutes?: number;
}

/**
 * PURE: the update preview, showing exact BEFORE → AFTER values.
 *
 * Showing both sides is the point: "Move to Friday 2pm" alone gives the user no
 * way to catch that Hula resolved the wrong event. "Tuesday 1:00 PM → Friday
 * 2:00 PM" does.
 */
export function formatUpdatePreview(
  event: NormalizedCalendarEvent,
  changes: UpdatePreviewChanges,
  tz: string | undefined,
): string {
  const lines: string[] = [];
  if (changes.newTitle) lines.push(`• Rename: “${titleOf(event)}” → “${changes.newTitle}”`);
  if (changes.newLocation) {
    const before = event.location ? `“${event.location}”` : "(none)";
    lines.push(`• Location: ${before} → “${changes.newLocation}”`);
  }
  if (changes.newDescription) lines.push("• Update the description");
  if (changes.startIso && changes.endIso) {
    const before = formatWhen(event, tz);
    const after = formatWhen(
      { start: changes.startIso, end: changes.endIso } as NormalizedCalendarEvent,
      tz,
    );
    lines.push(`• Time: ${before} → ${after}`);
  }
  if (changes.addAttendees && changes.addAttendees.length > 0) {
    lines.push(`• Invite: ${changes.addAttendees.join(", ")}`);
  }
  if (changes.removeAttendees && changes.removeAttendees.length > 0) {
    lines.push(`• Remove: ${changes.removeAttendees.join(", ")}`);
  }
  if (changes.addMeet) lines.push("• Add a Google Meet link");
  if (changes.reminderMinutes !== undefined) {
    lines.push(`• Reminder ${changes.reminderMinutes} minutes before`);
  }
  const tail: string[] = [];
  if (
    (changes.addAttendees && changes.addAttendees.length > 0) ||
    (changes.removeAttendees && changes.removeAttendees.length > 0) ||
    ((changes.startIso || changes.newLocation) && event.attendees.some((a) => !a.self))
  ) {
    // Google notifies the guest list on a time/location change too, not just on
    // an invite — so the warning has to cover those.
    tail.push("Confirming will email the guests about this change.");
  }
  tail.push(`Want me to go ahead? ${CONFIRM_INSTRUCTION}`);
  return `I’ll update “${titleOf(event)}”:\n${lines.join("\n")}\n${tail.join("\n")}`;
}

export function formatDeletePreview(
  event: NormalizedCalendarEvent,
  tz: string | undefined,
  scope?: RecurrenceScope,
): string {
  const when = formatWhen(event, tz);
  const what =
    scope === "entire_series"
      ? `every occurrence of “${titleOf(event)}”`
      : `“${titleOf(event)}”${when ? ` (${when})` : ""}`;
  const lines = [`I’ll delete ${what}.`];
  if (event.attendees.some((a) => !a.self)) {
    lines.push("Confirming will email the guests a cancellation.");
  }
  lines.push("This can’t be undone — want me to go ahead?");
  return lines.join("\n");
}

export function formatAmbiguous(matches: NormalizedCalendarEvent[], tz: string | undefined): string {
  const lines = matches.slice(0, MAX_AMBIGUOUS_SHOWN).map((e, i) => {
    const at = clock(e.start, tz);
    return `${i + 1}. ${titleOf(e)}${at ? ` at ${at}` : ""}`;
  });
  return `I found a few matching events. Which one did you mean?\n${lines.join("\n")}`;
}

/**
 * PURE: ask which attendee address the user means.
 *
 * This reply exists because the alternative is unacceptable. "Book an hour with
 * Sarah" gives Hula a first name and nothing else. Guessing `sarah@…` sends a
 * real calendar invitation to whoever owns that address — possibly a stranger,
 * certainly unrecallable. So Hula asks. It is a small friction that prevents a
 * category of error the user cannot undo.
 */
export function formatNeedAttendeeAddress(names: string[]): string {
  if (names.length === 1) {
    return `What’s ${names[0]}’s email address? I don’t want to guess and invite the wrong person.`;
  }
  return `What are the email addresses for ${names.join(" and ")}? I don’t want to guess and invite the wrong people.`;
}

// --- Write-capability check ----------------------------------------------

export type WriteCapability = "not_connected" | "connected_readonly" | "connected_write";

/** Default capability check: connected + holds the `calendar.events` scope. */
async function defaultWriteCapability(userId: string): Promise<WriteCapability> {
  const conn = await getConnectionForUserProvider(userId, GOOGLE_CALENDAR_PROVIDER);
  if (!conn || conn.status !== "connected") return "not_connected";
  return conn.grantedScopes.includes(CALENDAR_EVENTS_SCOPE)
    ? "connected_write"
    : "connected_readonly";
}

// --- Orchestrator --------------------------------------------------------

/** Injectable dependencies so the whole flow runs with NO DB / network in tests. */
export interface CalendarWriteDeps {
  getTimezone?: (userId: string) => Promise<string | undefined>;
  writeCapability?: (userId: string) => Promise<WriteCapability>;
  extract?: (params: {
    text: string;
    nowLocalIso: string;
    timezone: string | undefined;
    generate?: TextGenerator;
  }) => Promise<CalendarAction | null>;
  generate?: TextGenerator;
  find?: typeof findCalendarEvents;
  /** Re-fetch one event by id — used to resolve a context reference freshly. */
  getEvent?: typeof getCalendarEvent;
  /** Real free/busy, for the conflict warning. */
  freeBusy?: typeof queryFreeBusy;
  /**
   * Creates the durable proposal a confirmation later executes. Injected so tests
   * exercise the full resolve → preview → propose path with NO database.
   */
  propose?: typeof createActionProposal;
  /** Conversation context store — injected so tests run with NO database. */
  contextStore?: CalendarContextStore;
  /** Meet request-id generator, injectable so tests can pin it. */
  newRequestId?: () => string;
  now?: Date;
}

export interface CalendarWriteResult {
  handled: boolean;
  reply?: string;
  action?: CalendarAction["action"];
}

/** Map a provider error to an honest reply (reconnect vs transient). */
function replyForProviderError(err: GoogleCalendarError): string {
  if (err.reason === "not_connected") return CALENDAR_WRITE_REPLIES.notConnected;
  if (isReconnectReason(err.reason)) return CALENDAR_WRITE_REPLIES.reconnect;
  if (err.reason === "insufficient_scope") return CALENDAR_WRITE_REPLIES.reconnect;
  return CALENDAR_WRITE_REPLIES.unavailable;
}

/**
 * Handle a calendar CREATE/UPDATE/DELETE request from an already-linked user.
 * Returns `{ handled: false }` for non-calendar-write messages (and when the
 * model can't be reached) so the caller falls through to the normal flow. Never
 * throws.
 */
export async function handleCalendarWrite(
  userId: string,
  text: string | undefined,
  deps: CalendarWriteDeps = {},
): Promise<CalendarWriteResult> {
  if (!looksLikeCalendarWrite(text)) return { handled: false };

  const getTz = deps.getTimezone ?? getUserTimezone;
  const extract = deps.extract ?? extractCalendarAction;
  const now = deps.now ?? new Date();

  let timezone: string | undefined;
  try {
    timezone = await getTz(userId);
  } catch {
    timezone = undefined;
  }

  // Extract FIRST so we only ever surface a connect/reconnect message for a
  // genuine calendar-write request (a prefilter false positive stays silent).
  const action = await extract({
    text: text ?? "",
    nowLocalIso: formatNowLocal(now, timezone),
    timezone,
    generate: deps.generate,
  });
  if (!action || action.action === "not_calendar_write") return { handled: false };

  // Now gate on write capability with a clear, honest message.
  const capability = deps.writeCapability
    ? await deps.writeCapability(userId)
    : await defaultWriteCapability(userId);
  if (capability === "not_connected") {
    return { handled: true, action: action.action, reply: CALENDAR_WRITE_REPLIES.notConnected };
  }
  if (capability === "connected_readonly") {
    return { handled: true, action: action.action, reply: CALENDAR_WRITE_REPLIES.reconnect };
  }

  try {
    switch (action.action) {
      case "create":
        return await runCreate(userId, action, timezone, now, deps);
      case "update":
        return await runUpdate(userId, action, text, timezone, now, deps);
      case "delete":
        return await runDelete(userId, action, text, timezone, deps);
      default:
        return { handled: false };
    }
  } catch (err) {
    if (err instanceof GoogleCalendarError) {
      logger.error("googleCalendar.write failed", {
        provider: GOOGLE_CALENDAR_PROVIDER,
        operation: `calendar.${action.action}`,
        errorCode: err.reason,
        httpStatus: err.httpStatus,
      });
      return { handled: true, action: action.action, reply: replyForProviderError(err) };
    }
    logger.error("googleCalendar.write failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: true, action: action.action, reply: CALENDAR_WRITE_REPLIES.unavailable };
  }
}

// --- Attendee resolution (PURE) ------------------------------------------

/**
 * PURE: the attendee addresses to use, or the names we must ask about.
 *
 * The rule the section states plainly, encoded once: an address is only ever one
 * the user actually typed. A bare name with no verified address produces a
 * question, never a guess.
 */
export function resolveAttendees(action: CalendarAction): {
  emails: string[];
  needAddressFor: string[];
} {
  const emails = (action.attendees ?? []).map((e) => e.trim()).filter(Boolean);
  const names = (action.attendeeNames ?? []).map((n) => n.trim()).filter(Boolean);
  // A name accompanied by an address in the same message is already covered —
  // only ask about names we have nothing for.
  return { emails, needAddressFor: emails.length > 0 ? [] : names };
}

// --- Per-action runners --------------------------------------------------

async function runCreate(
  userId: string,
  action: CalendarAction,
  tz: string | undefined,
  now: Date,
  deps: CalendarWriteDeps,
): Promise<CalendarWriteResult> {
  const propose = deps.propose ?? createActionProposal;

  const title = (action.title ?? "").trim();
  if (!title) return { handled: true, action: "create", reply: CALENDAR_WRITE_REPLIES.needTitle };

  const { emails, needAddressFor } = resolveAttendees(action);
  if (needAddressFor.length > 0) {
    return {
      handled: true,
      action: "create",
      reply: formatNeedAttendeeAddress(needAddressFor),
    };
  }

  // --- All-day events take a different shape entirely: a bare date, no clock.
  if (action.allDay === true) {
    if (!action.date) {
      return { handled: true, action: "create", reply: CALENDAR_WRITE_REPLIES.needDate };
    }
    // Google's all-day `end.date` is EXCLUSIVE — a one-day event on the 14th
    // ends on the 15th. Sending the same date for both makes Google reject it.
    const startDate = action.date;
    const endDate = addDaysToDate(startDate, 1);
    const input: Record<string, unknown> = {
      title,
      allDay: true,
      startDate,
      endDate,
      timezone: tz,
      ...(action.location ? { location: action.location } : {}),
      ...(action.description ? { description: action.description } : {}),
      ...(emails.length > 0 ? { attendees: emails } : {}),
    };
    const preview = formatCreatePreview(
      { title, allDay: true, startDate, location: action.location ?? undefined, attendees: emails },
      tz,
    );
    await propose(userId, {
      provider: GOOGLE_CALENDAR_PROVIDER,
      actionId: "calendar.createEvent",
      riskLevel: "write",
      confirmationRequired: true,
      input,
      previewText: preview,
    });
    return { handled: true, action: "create", reply: preview };
  }

  if (!action.date || !action.time) {
    return { handled: true, action: "create", reply: CALENDAR_WRITE_REPLIES.needTime };
  }

  const { y, m, d } = splitDate(action.date);
  const { hour, minute } = splitTime(action.time);
  const start = wallTimeToUtc(y, m, d, hour, minute, tz);
  if (Number.isNaN(start.getTime())) {
    return { handled: true, action: "create", reply: CALENDAR_WRITE_REPLIES.needTime };
  }
  if (start.getTime() <= now.getTime()) {
    return { handled: true, action: "create", reply: CALENDAR_WRITE_REPLIES.inPast };
  }
  const durationMin = action.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  const end = new Date(start.getTime() + durationMin * 60_000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  // A Meet request id is generated ONCE, here, and stored on the proposal. The
  // executor replays it, so a duplicate confirmation reuses the same id and
  // Google returns the SAME conference instead of allocating a second one.
  const conferenceRequestId = action.addMeet
    ? (deps.newRequestId ?? generateConferenceRequestId)()
    : undefined;

  const conflicts = await findConflicts(userId, startIso, endIso, deps);

  const input: Record<string, unknown> = {
    title,
    startIso,
    endIso,
    timezone: tz,
    ...(action.location ? { location: action.location } : {}),
    ...(action.description ? { description: action.description } : {}),
    ...(emails.length > 0 ? { attendees: emails } : {}),
    ...(conferenceRequestId ? { conferenceRequestId } : {}),
    ...(action.reminderMinutes !== null && action.reminderMinutes !== undefined
      ? { reminderMinutes: action.reminderMinutes }
      : {}),
  };

  const preview = formatCreatePreview(
    {
      title,
      startIso,
      endIso,
      location: action.location ?? undefined,
      attendees: emails,
      addMeet: Boolean(action.addMeet),
      reminderMinutes: action.reminderMinutes ?? undefined,
      conflicts,
    },
    tz,
  );

  // Nothing is written here. The proposal carries the exact instants previewed
  // above, so a later confirmation replays them without re-parsing the request.
  await propose(userId, {
    provider: GOOGLE_CALENDAR_PROVIDER,
    actionId: "calendar.createEvent",
    riskLevel: "write",
    confirmationRequired: true,
    input,
    previewText: preview,
  });

  return { handled: true, action: "create", reply: preview };
}

/**
 * Real free/busy for the proposed slot, for the conflict warning.
 *
 * Best-effort by design: a free/busy failure must NOT block scheduling. The
 * warning is a courtesy, and losing it costs a heads-up, not the action. It
 * returns [] on failure rather than throwing — but note it never returns [] as a
 * POSITIVE claim of freedom; nothing downstream reads an empty list as "free".
 */
async function findConflicts(
  userId: string,
  startIso: string,
  endIso: string,
  deps: CalendarWriteDeps,
): Promise<TimeInterval[]> {
  const freeBusy = deps.freeBusy ?? queryFreeBusy;
  try {
    const busy = await freeBusy(userId, { timeMin: startIso, timeMax: endIso });
    return busy;
  } catch {
    return [];
  }
}

/**
 * The single event an update/delete refers to, or a reply to send instead.
 *
 * Resolution order matters and is deliberate:
 *  1. CONTEXT first — a numbered pick, "the one you just created", or a bare
 *     pronoun. If the user is pointing at something already on screen, that is
 *     the most precise signal available and re-searching could easily find a
 *     different event.
 *  2. Otherwise a narrow same-day search by title/time.
 *
 * A context hit is RE-FETCHED from Google before use, never trusted from the
 * stored snapshot: the event may have moved or been deleted since it was shown,
 * and the preview must show what is true now.
 */
async function resolveTarget(
  userId: string,
  action: CalendarAction,
  text: string | undefined,
  tz: string | undefined,
  deps: CalendarWriteDeps,
): Promise<
  | { kind: "one"; event: NormalizedCalendarEvent }
  | { kind: "reply"; reply: string }
> {
  const contextHit = await resolveFromContext(userId, text, action, deps);
  if (contextHit) return contextHit;

  const find = deps.find ?? findCalendarEvents;
  if (!action.date) {
    // No date AND no usable context: we genuinely don't know what they mean.
    return {
      kind: "reply",
      reply: action.refersToContext
        ? CALENDAR_WRITE_REPLIES.staleReference
        : CALENDAR_WRITE_REPLIES.needDate,
    };
  }

  const window = localDayWindow(action.date, tz);
  const events = await find(userId, {
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    query: action.title ?? undefined,
  });
  const matches = selectMatches(events, { title: action.title, time: action.time, tz });

  if (matches.length === 0) return { kind: "reply", reply: CALENDAR_WRITE_REPLIES.notFound };
  if (matches.length > 1) {
    // Remember the numbered list we're about to show, so "the second one"
    // resolves against exactly these ids and this order.
    await rememberSelection(userId, matches.slice(0, MAX_AMBIGUOUS_SHOWN), deps);
    return { kind: "reply", reply: formatAmbiguous(matches, tz) };
  }
  return { kind: "one", event: matches[0]! };
}

/** Resolve an event from stored conversation context, or null to fall through. */
async function resolveFromContext(
  userId: string,
  text: string | undefined,
  action: CalendarAction,
  deps: CalendarWriteDeps,
): Promise<{ kind: "one"; event: NormalizedCalendarEvent } | { kind: "reply"; reply: string } | null> {
  const store = deps.contextStore ?? {};
  const getEvent = deps.getEvent ?? getCalendarEvent;

  let targetId: string | null = null;

  // 1. A numbered pick against the list we last showed.
  const ordinal = parseCalendarOrdinal(text);
  if (ordinal) {
    const selection = await loadLatestCalendarSelection(userId, store);
    if (!selection) return { kind: "reply", reply: CALENDAR_WRITE_REPLIES.staleReference };
    const item = resolveCalendarSelectionItem(selection.data, ordinal);
    // An out-of-range pick must ask, never clamp onto a neighbouring event.
    if (!item) return { kind: "reply", reply: CALENDAR_WRITE_REPLIES.staleReference };
    targetId = item.id;
  }

  // 2. "the meeting you just created" / "undo that".
  if (!targetId && referencesLastCalendarAction(text)) {
    const ctx = await loadCalendarEntityContext(userId, store);
    targetId = ctx?.data.acted?.event.id ?? null;
    if (!targetId) return { kind: "reply", reply: CALENDAR_WRITE_REPLIES.staleReference };
  }

  // 3. A bare pronoun ("move it to Friday") — only when the message gives us
  //    nothing else to search on. With a title or date present, the search path
  //    is more precise and takes over.
  if (!targetId && (action.refersToContext === true || referencesCalendarPronoun(text))) {
    if (!action.title && !action.date) {
      const ctx = await loadCalendarEntityContext(userId, store);
      targetId = ctx?.data.acted?.event.id ?? ctx?.data.selected?.id ?? null;
      if (!targetId) return { kind: "reply", reply: CALENDAR_WRITE_REPLIES.staleReference };
    }
  }

  if (!targetId) return null;

  // Re-fetch: the stored snapshot is a REFERENCE, not a source of truth.
  try {
    const event = await getEvent(userId, targetId);
    if (event.status === "cancelled") {
      return { kind: "reply", reply: CALENDAR_WRITE_REPLIES.notFound };
    }
    return { kind: "one", event };
  } catch (err) {
    if (err instanceof GoogleCalendarError && err.reason === "calendar_not_found") {
      return { kind: "reply", reply: CALENDAR_WRITE_REPLIES.notFound };
    }
    throw err;
  }
}

/** Best-effort: remember a shown list. Losing it costs "the second one", not the reply. */
async function rememberSelection(
  userId: string,
  events: NormalizedCalendarEvent[],
  deps: CalendarWriteDeps,
): Promise<void> {
  try {
    await recordCalendarSelection(userId, events, deps.contextStore ?? {});
  } catch {
    // Non-fatal by design.
  }
}

/**
 * Decide the recurrence scope for a write, or ask.
 *
 * `this_and_following` is deliberately NOT executed. Google's API has no single
 * call for it: the Calendar UI implements it by truncating the original series
 * with an UNTIL and creating a REPLACEMENT series — two writes, non-atomic, and
 * a failure between them leaves the user's calendar in a state neither they nor
 * Hula asked for. Section 18 says to support it "where Google safely supports
 * it"; it does not, so Hula says so plainly and offers the two scopes that ARE
 * single, safe, verifiable calls. That is a deferred capability, not a silent
 * gap.
 */
export function describeRecurrenceChoice(
  event: NormalizedCalendarEvent,
  scope: RecurrenceScope | null | undefined,
): { kind: "scope"; scope: RecurrenceScope; targetId: string } | { kind: "reply"; reply: string } {
  const isRecurring = Boolean(event.recurringEventId);
  if (!isRecurring) return { kind: "scope", scope: "this_event", targetId: event.id };

  if (!scope) return { kind: "reply", reply: CALENDAR_WRITE_REPLIES.recurrenceScope };
  if (scope === "this_and_following") {
    return { kind: "reply", reply: CALENDAR_WRITE_REPLIES.seriesUnsupported };
  }
  if (scope === "entire_series") {
    // The series MASTER is the id to write. `recurringEventId` points at it from
    // any instance; on a master it points at itself.
    return { kind: "scope", scope, targetId: event.recurringEventId ?? event.id };
  }
  // `this_event`: the expanded INSTANCE id is already the right target — a PATCH
  // or DELETE against it affects only that occurrence.
  return { kind: "scope", scope: "this_event", targetId: event.id };
}

async function runUpdate(
  userId: string,
  action: CalendarAction,
  text: string | undefined,
  tz: string | undefined,
  now: Date,
  deps: CalendarWriteDeps,
): Promise<CalendarWriteResult> {
  const propose = deps.propose ?? createActionProposal;

  const target = await resolveTarget(userId, action, text, tz, deps);
  if (target.kind === "reply") return { handled: true, action: "update", reply: target.reply };
  const event = target.event;

  const scopeChoice = describeRecurrenceChoice(event, action.recurrenceScope);
  if (scopeChoice.kind === "reply") {
    // Remember the event so the user's scope answer resolves against it.
    await rememberEntity(userId, event, deps);
    return { handled: true, action: "update", reply: scopeChoice.reply };
  }

  const { emails, needAddressFor } = resolveAttendees(action);
  if (needAddressFor.length > 0) {
    await rememberEntity(userId, event, deps);
    return { handled: true, action: "update", reply: formatNeedAttendeeAddress(needAddressFor) };
  }

  const changes: UpdatePreviewChanges = {};
  let renamedOnly = true;

  if (action.newTitle && action.newTitle.trim()) changes.newTitle = action.newTitle.trim();
  if (action.newLocation && action.newLocation.trim()) {
    changes.newLocation = action.newLocation.trim();
    renamedOnly = false;
  }
  if (action.newDescription && action.newDescription.trim()) {
    changes.newDescription = action.newDescription.trim();
    renamedOnly = false;
  }
  if (action.addMeet === true) {
    changes.addMeet = true;
    renamedOnly = false;
  }
  if (action.reminderMinutes !== null && action.reminderMinutes !== undefined) {
    changes.reminderMinutes = action.reminderMinutes;
    renamedOnly = false;
  }
  if (emails.length > 0) {
    changes.addAttendees = emails;
    renamedOnly = false;
  }
  const removeEmails = (action.removeAttendees ?? []).map((e) => e.trim()).filter(Boolean);
  if (removeEmails.length > 0) {
    changes.removeAttendees = removeEmails;
    renamedOnly = false;
  }

  // Reschedule: an absolute new time/date, a relative shift, or a new duration.
  const timing = computeNewTiming(event, action, tz);
  if (timing.kind === "invalid") {
    return { handled: true, action: "update", reply: CALENDAR_WRITE_REPLIES.needTime };
  }
  if (timing.kind === "timed") {
    renamedOnly = false;
    if (new Date(timing.startIso).getTime() <= now.getTime()) {
      return { handled: true, action: "update", reply: CALENDAR_WRITE_REPLIES.inPast };
    }
    changes.startIso = timing.startIso;
    changes.endIso = timing.endIso;
  }

  if (Object.keys(changes).length === 0) {
    return { handled: true, action: "update", reply: CALENDAR_WRITE_REPLIES.needChange };
  }

  // Adding a Meet to an existing event uses the same createRequest mechanism as
  // creation — generated once here, replayed by the executor.
  const conferenceRequestId = changes.addMeet
    ? (deps.newRequestId ?? generateConferenceRequestId)()
    : undefined;

  // Google's PATCH REPLACES the attendee array rather than merging it, so an
  // "add Rob" that sent only Rob would silently uninvite everyone else. The
  // complete list is computed here, from the event's real current attendees.
  const finalAttendees = computeFinalAttendees(event, emails, removeEmails);

  const preview = formatUpdatePreview(event, changes, tz);
  await propose(userId, {
    provider: GOOGLE_CALENDAR_PROVIDER,
    actionId: "calendar.updateEvent",
    riskLevel: "write",
    confirmationRequired: true,
    // The resolved event id is captured here, so the confirmation can never land
    // on a different event than the one previewed.
    input: {
      eventId: scopeChoice.targetId,
      timezone: tz,
      renamedOnly,
      recurrenceScope: scopeChoice.scope,
      ...(changes.newTitle ? { newTitle: changes.newTitle } : {}),
      ...(changes.newLocation ? { newLocation: changes.newLocation } : {}),
      ...(changes.newDescription ? { newDescription: changes.newDescription } : {}),
      ...(changes.startIso ? { startIso: changes.startIso } : {}),
      ...(changes.endIso ? { endIso: changes.endIso } : {}),
      ...(finalAttendees ? { attendees: finalAttendees } : {}),
      ...(conferenceRequestId ? { conferenceRequestId } : {}),
      ...(changes.reminderMinutes !== undefined
        ? { reminderMinutes: changes.reminderMinutes }
        : {}),
      // Guests must be told when their meeting moves — but only after the user
      // has confirmed a preview that said so.
      ...(finalAttendees || changes.startIso ? { notifyGuests: true } : {}),
    },
    previewText: preview,
  });

  return { handled: true, action: "update", reply: preview };
}

/**
 * PURE: the event's new start/end, from an absolute time, a relative shift, or a
 * duration change. Returns `none` when the user didn't ask to change the timing.
 */
export function computeNewTiming(
  event: NormalizedCalendarEvent,
  action: CalendarAction,
  tz: string | undefined,
):
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "timed"; startIso: string; endIso: string } {
  const wantsShift = action.shiftMinutes !== null && action.shiftMinutes !== undefined;
  const wantsAbsolute = Boolean(action.newTime || action.newDate);
  const wantsDuration =
    action.newDurationMinutes !== null && action.newDurationMinutes !== undefined;
  if (!wantsShift && !wantsAbsolute && !wantsDuration) return { kind: "none" };

  const origStartMs = event.start ? new Date(event.start).getTime() : NaN;
  const origEndMs = event.end ? new Date(event.end).getTime() : NaN;
  const origDurationMs =
    Number.isFinite(origStartMs) && Number.isFinite(origEndMs) && origEndMs > origStartMs
      ? origEndMs - origStartMs
      : DEFAULT_DURATION_MINUTES * 60_000;

  // A relative shift is only meaningful against a real current start.
  if (wantsShift) {
    if (!Number.isFinite(origStartMs)) return { kind: "invalid" };
    const startMs = origStartMs + action.shiftMinutes! * 60_000;
    const durationMs = wantsDuration
      ? action.newDurationMinutes! * 60_000
      : origDurationMs;
    return {
      kind: "timed",
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(startMs + durationMs).toISOString(),
    };
  }

  if (wantsAbsolute) {
    const baseYmd = action.newDate
      ? splitDate(action.newDate)
      : (localYmd(event.start ?? "", tz) ??
        (action.date ? splitDate(action.date) : null));
    if (!baseYmd) return { kind: "invalid" };
    const baseHm = action.newTime
      ? splitTime(action.newTime)
      : (localHm(event.start ?? "", tz) ?? { hour: 9, minute: 0 });
    const newStart = wallTimeToUtc(baseYmd.y, baseYmd.m, baseYmd.d, baseHm.hour, baseHm.minute, tz);
    if (Number.isNaN(newStart.getTime())) return { kind: "invalid" };
    const durationMs = wantsDuration ? action.newDurationMinutes! * 60_000 : origDurationMs;
    return {
      kind: "timed",
      startIso: newStart.toISOString(),
      endIso: new Date(newStart.getTime() + durationMs).toISOString(),
    };
  }

  // Duration only: keep the start exactly where it is, move the end.
  if (!Number.isFinite(origStartMs)) return { kind: "invalid" };
  return {
    kind: "timed",
    startIso: new Date(origStartMs).toISOString(),
    endIso: new Date(origStartMs + action.newDurationMinutes! * 60_000).toISOString(),
  };
}

/**
 * PURE: the COMPLETE attendee list to send, or null when attendees are untouched.
 *
 * Exists because Google's PATCH replaces the array wholesale. Merging has to
 * happen here, against the event's real current guests, or "add Rob" quietly
 * removes everyone else.
 */
export function computeFinalAttendees(
  event: NormalizedCalendarEvent,
  add: string[],
  remove: string[],
): string[] | null {
  if (add.length === 0 && remove.length === 0) return null;
  const removeSet = new Set(remove.map((e) => e.toLowerCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const attendee of event.attendees) {
    const email = attendee.email.trim();
    const key = email.toLowerCase();
    if (removeSet.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  for (const email of add) {
    const key = email.trim().toLowerCase();
    if (seen.has(key) || removeSet.has(key)) continue;
    seen.add(key);
    out.push(email.trim());
  }
  return out;
}

/** Best-effort: remember the event the conversation is now about. */
async function rememberEntity(
  userId: string,
  event: NormalizedCalendarEvent,
  deps: CalendarWriteDeps,
): Promise<void> {
  try {
    await recordSelectedCalendarEvent(userId, toSelectionItem(event), deps.contextStore ?? {});
  } catch {
    // Non-fatal by design.
  }
}

async function runDelete(
  userId: string,
  action: CalendarAction,
  text: string | undefined,
  tz: string | undefined,
  deps: CalendarWriteDeps,
): Promise<CalendarWriteResult> {
  const propose = deps.propose ?? createActionProposal;

  const target = await resolveTarget(userId, action, text, tz, deps);
  if (target.kind === "reply") return { handled: true, action: "delete", reply: target.reply };
  const event = target.event;

  const scopeChoice = describeRecurrenceChoice(event, action.recurrenceScope);
  if (scopeChoice.kind === "reply") {
    await rememberEntity(userId, event, deps);
    return { handled: true, action: "delete", reply: scopeChoice.reply };
  }

  // Capture the details now: once the event is deleted Google returns 204 with no
  // body, so these are the only accurate details the confirmation can report.
  const preview = formatDeletePreview(event, tz, scopeChoice.scope);
  await propose(userId, {
    provider: GOOGLE_CALENDAR_PROVIDER,
    actionId: "calendar.cancelEvent",
    riskLevel: "write",
    confirmationRequired: true,
    input: {
      eventId: scopeChoice.targetId,
      title: event.summary ?? "",
      startIso: event.start ?? "",
      endIso: event.end ?? "",
      timezone: tz,
      recurrenceScope: scopeChoice.scope,
      ...(event.attendees.some((a) => !a.self) ? { notifyGuests: true } : {}),
    },
    previewText: preview,
  });

  return { handled: true, action: "delete", reply: preview };
}

// --- Undo ----------------------------------------------------------------

/** Honest replies for the undo path. */
export const CALENDAR_UNDO_REPLIES = {
  /**
   * An update's inverse needs the event's BEFORE state, which is not stored — so
   * there is nothing to reverse it to. A cancelled event's inverse (recreating
   * it) is worse: the new event has a new id, a new Meet, and re-invites every
   * guest, which is a fresh action wearing an "undo" label rather than a
   * reversal. Both say so plainly.
   */
  cannot:
    "I can’t safely undo that one — tell me what you’d like it changed back to and I’ll do that.",
} as const;

/**
 * PURE: is this message asking to undo our last calendar action?
 *
 * Deliberately narrow — a bare, standalone "undo". Anything richer ("undo the
 * change to the location") is a normal update request and belongs on the update
 * path, which can preview exactly what it will do.
 */
export function isCalendarUndoRequest(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase().replace(/[.!]+$/, "");
  return /^undo(?:\s+(?:that|it|the last one))?$/.test(t);
}

/**
 * Handle "undo that" for the ONE inverse that is genuinely safe: deleting an
 * event we verifiably just created.
 *
 * Section 18 asks for undo "where a safe verified inverse exists", and that
 * qualifier is the whole design. A verified create has an exact, complete
 * inverse — the event did not exist before, so removing it restores the prior
 * state precisely. Nothing else here does, so nothing else is offered.
 *
 * And even this inverse is not performed directly: it goes through the SAME
 * proposal → confirmation → executor → receipt path as any other delete, so the
 * user sees what will be removed and confirms it. "Undo" is not a licence to
 * skip the confirmation.
 *
 * Returns `{handled:false}` when there is nothing to undo, so the message falls
 * through (Gmail's own undo runs earlier in the cascade and keeps priority).
 * Never throws.
 */
export async function handleCalendarUndo(
  userId: string,
  text: string | undefined,
  deps: CalendarWriteDeps = {},
): Promise<CalendarWriteResult> {
  if (!isCalendarUndoRequest(text)) return { handled: false };

  const store = deps.contextStore ?? {};
  const getTz = deps.getTimezone ?? getUserTimezone;
  const getEvent = deps.getEvent ?? getCalendarEvent;
  const propose = deps.propose ?? createActionProposal;

  try {
    const ctx = await loadCalendarEntityContext(userId, store);
    const acted = ctx?.data.acted;
    // Nothing of ours to undo → let another handler (or the brain) have it.
    if (!acted) return { handled: false };
    if (acted.kind !== "created") {
      return { handled: true, action: "delete", reply: CALENDAR_UNDO_REPLIES.cannot };
    }

    let tz: string | undefined;
    try {
      tz = await getTz(userId);
    } catch {
      tz = undefined;
    }

    // Re-read before offering: the event may already be gone, and offering to
    // delete something that no longer exists is its own small lie.
    let event: NormalizedCalendarEvent;
    try {
      event = await getEvent(userId, acted.event.id);
    } catch (err) {
      if (err instanceof GoogleCalendarError && err.reason === "calendar_not_found") {
        return { handled: true, action: "delete", reply: CALENDAR_WRITE_REPLIES.notFound };
      }
      throw err;
    }
    if (event.status === "cancelled") {
      return { handled: true, action: "delete", reply: CALENDAR_WRITE_REPLIES.notFound };
    }

    const preview = formatDeletePreview(event, tz);
    await propose(userId, {
      provider: GOOGLE_CALENDAR_PROVIDER,
      actionId: "calendar.cancelEvent",
      riskLevel: "write",
      confirmationRequired: true,
      input: {
        eventId: event.id,
        title: event.summary ?? "",
        startIso: event.start ?? "",
        endIso: event.end ?? "",
        timezone: tz,
        recurrenceScope: "this_event",
        ...(event.attendees.some((a) => !a.self) ? { notifyGuests: true } : {}),
      },
      previewText: preview,
    });
    return { handled: true, action: "delete", reply: preview };
  } catch (err) {
    if (err instanceof GoogleCalendarError) {
      logger.error("googleCalendar.undo failed", {
        provider: GOOGLE_CALENDAR_PROVIDER,
        operation: "calendar.undo",
        errorCode: err.reason,
        httpStatus: err.httpStatus,
      });
      return { handled: true, action: "delete", reply: replyForProviderError(err) };
    }
    logger.error("googleCalendar.undo failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: true, action: "delete", reply: CALENDAR_WRITE_REPLIES.unavailable };
  }
}

/** Re-exported so the executor can record verified context after a write. */
export { titleOf as calendarEventTitle, eventTitle as calendarDisplayTitle };
