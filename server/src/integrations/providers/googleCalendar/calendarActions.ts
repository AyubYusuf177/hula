import { getConnectionForUserProvider } from "../../connections";
import { getUserTimezone } from "../../../reminders/reminders";
import { wallTimeToUtc } from "../../../reminders/parse";
import { logger } from "../../../utils/logger";
import { createActionProposal } from "../../../actions/proposals";
import { GoogleCalendarError, isReconnectReason } from "./client";
import { findCalendarEvents } from "./calendarWrites";
import {
  extractCalendarAction,
  type CalendarAction,
  type TextGenerator,
} from "./calendarActionExtract";
import {
  CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_PROVIDER,
  type NormalizedCalendarEvent,
} from "./types";

/**
 * Calendar WRITE routing (Sections 15 + 17) — create / update / delete via iMessage.
 *
 * A deterministic prefilter, then a strictly validated model extraction, then a
 * DETERMINISTIC backend that resolves the real event and guards safety (never
 * write in the past, never on ambiguous or recurring matches). The model never
 * touches Google. Never throws — every failure degrades to an honest reply.
 *
 * Section 17 moved the WRITE itself out of this file. Where Section 15 called the
 * provider inline, this now ends by creating a durable Section 12 proposal holding
 * the fully-resolved event id and ISO instants, and replies with a preview. Only a
 * subsequent natural confirmation ("yh", "do it") executes it — through the same
 * proposal → confirmation → executor → validated-receipt path Gmail sends use. That
 * buys three things this file cannot provide on its own: a user-visible preview
 * before anything mutates, durable idempotency across restarts and duplicate
 * webhook deliveries (the atomic `proposed → confirmed` claim can only win once),
 * and a single place where provider receipts are validated.
 *
 * Everything resolved here is resolved ONCE, at proposal time, and the executor
 * replays it verbatim — so the event the user saw previewed is exactly the event
 * that gets written.
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
} as const;

// --- Prefilter (PURE) ----------------------------------------------------

const CREATE_VERB_RE =
  /\b(?:schedule|book|set ?up|add|create|put|block(?: off| out)?|arrange|plan)\b/i;
const UPDATE_VERB_RE = /\b(?:move|reschedule|rename|push(?: back)?|shift|change)\b/i;
const DELETE_VERB_RE = /\b(?:delete|cancel|remove|clear|drop)\b/i;

const EVENT_NOUN_RE =
  /\b(?:calendar|events?|meetings?|appointments?|calls?|lunch|dinner|breakfast|coffee|standup|sync|1:1|one on one|catch ?up)\b/i;
const TIME_CUE_RE =
  /\b(?:\d{1,2}\s?(?:am|pm)|\d{1,2}:\d{2}|noon|midnight|tonight|tomorrow|today|next week|this (?:week|weekend)|(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:on )?(?:mon|tue|wed|thu|fri|sat|sun))\b/i;

/**
 * PURE: a fast, cheap gate deciding whether a message is worth extracting as a
 * calendar write. It only needs an imperative calendar verb plus either a
 * calendar noun or a time cue. The model extraction is the real classifier — a
 * false positive here just costs one extraction that returns `not_calendar_write`.
 */
export function looksLikeCalendarWrite(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const hasVerb = CREATE_VERB_RE.test(t) || UPDATE_VERB_RE.test(t) || DELETE_VERB_RE.test(t);
  if (!hasVerb) return false;
  return EVENT_NOUN_RE.test(t) || TIME_CUE_RE.test(t);
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
function titleOf(event: NormalizedCalendarEvent): string {
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

export function formatCreated(event: NormalizedCalendarEvent, tz: string | undefined): string {
  const when = formatWhen(event, tz);
  return `Done — “${titleOf(event)}” is scheduled for ${when}.`;
}

export function formatUpdated(event: NormalizedCalendarEvent, tz: string | undefined, renamedOnly: boolean): string {
  if (renamedOnly) return `Updated — renamed to “${titleOf(event)}”.`;
  return `Updated — “${titleOf(event)}” is now scheduled for ${formatWhen(event, tz)}.`;
}

export function formatDeleted(event: NormalizedCalendarEvent, tz: string | undefined): string {
  const day = weekday(event.start, tz);
  const at = clock(event.start, tz);
  const when = day && at ? `${day} at ${at}` : day || at;
  return `Deleted — “${titleOf(event)}”${when ? ` on ${when}` : ""}.`;
}

// --- Preview formatting (PURE) -------------------------------------------

/**
 * PURE: the concise preview shown BEFORE a write runs (Section 17). Each ends with
 * a clear ask so the user knows a confirmation is required and nothing has happened
 * yet — the wording must never imply the change is already made.
 */
export function formatCreatePreview(
  title: string,
  startIso: string,
  endIso: string,
  tz: string | undefined,
): string {
  const when = formatWhen(
    { start: startIso, end: endIso } as NormalizedCalendarEvent,
    tz,
  );
  return `I’ll schedule “${title}” for ${when}. Want me to go ahead?`;
}

export function formatUpdatePreview(
  event: NormalizedCalendarEvent,
  changes: { newTitle?: string; newLocation?: string; startIso?: string; endIso?: string },
  tz: string | undefined,
): string {
  const lines: string[] = [];
  if (changes.newTitle) lines.push(`• Rename to “${changes.newTitle}”`);
  if (changes.newLocation) lines.push(`• Location: ${changes.newLocation}`);
  if (changes.startIso && changes.endIso) {
    const when = formatWhen(
      { start: changes.startIso, end: changes.endIso } as NormalizedCalendarEvent,
      tz,
    );
    lines.push(`• Move to ${when}`);
  }
  return `I’ll update “${titleOf(event)}”:\n${lines.join("\n")}\nWant me to go ahead?`;
}

export function formatDeletePreview(
  event: NormalizedCalendarEvent,
  tz: string | undefined,
): string {
  const when = formatWhen(event, tz);
  return `I’ll delete “${titleOf(event)}”${when ? ` (${when})` : ""}. This can’t be undone — want me to go ahead?`;
}

export function formatAmbiguous(matches: NormalizedCalendarEvent[], tz: string | undefined): string {
  const lines = matches.slice(0, MAX_AMBIGUOUS_SHOWN).map((e, i) => {
    const at = clock(e.start, tz);
    return `${i + 1}. ${titleOf(e)}${at ? ` at ${at}` : ""}`;
  });
  return `I found a few matching events. Which one did you mean?\n${lines.join("\n")}`;
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
  /**
   * Creates the durable proposal a confirmation later executes. Injected so tests
   * exercise the full resolve → preview → propose path with NO database.
   */
  propose?: typeof createActionProposal;
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
        return await runUpdate(userId, action, timezone, deps);
      case "delete":
        return await runDelete(userId, action, timezone, deps);
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

  // Nothing is written here. The proposal carries the exact instants previewed
  // below, so a later confirmation replays them without re-parsing the request.
  await propose(userId, {
    provider: GOOGLE_CALENDAR_PROVIDER,
    actionId: "calendar.createEvent",
    riskLevel: "write",
    confirmationRequired: true,
    input: {
      title,
      startIso,
      endIso,
      timezone: tz,
      ...(action.location ? { location: action.location } : {}),
      ...(action.description ? { description: action.description } : {}),
    },
    previewText: formatCreatePreview(title, startIso, endIso, tz),
  });

  return {
    handled: true,
    action: "create",
    reply: formatCreatePreview(title, startIso, endIso, tz),
  };
}

/** Resolve the single target event for an update/delete, or a clarify/None reply. */
async function resolveTarget(
  userId: string,
  action: CalendarAction,
  tz: string | undefined,
  deps: CalendarWriteDeps,
): Promise<
  | { kind: "one"; event: NormalizedCalendarEvent }
  | { kind: "reply"; reply: string }
> {
  const find = deps.find ?? findCalendarEvents;
  if (!action.date) return { kind: "reply", reply: CALENDAR_WRITE_REPLIES.needDate };

  const window = localDayWindow(action.date, tz);
  const events = await find(userId, {
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    query: action.title ?? undefined,
  });
  const matches = selectMatches(events, { title: action.title, time: action.time, tz });

  if (matches.length === 0) return { kind: "reply", reply: CALENDAR_WRITE_REPLIES.notFound };
  if (matches.length > 1) return { kind: "reply", reply: formatAmbiguous(matches, tz) };

  const event = matches[0]!;
  // Recurring-series safety: never risk touching the whole series. Ask instead.
  if (event.recurringEventId) return { kind: "reply", reply: CALENDAR_WRITE_REPLIES.recurring };
  return { kind: "one", event };
}

async function runUpdate(
  userId: string,
  action: CalendarAction,
  tz: string | undefined,
  deps: CalendarWriteDeps,
): Promise<CalendarWriteResult> {
  const propose = deps.propose ?? createActionProposal;

  const target = await resolveTarget(userId, action, tz, deps);
  if (target.kind === "reply") return { handled: true, action: "update", reply: target.reply };
  const event = target.event;

  const changes: { newTitle?: string; newLocation?: string; startIso?: string; endIso?: string } = {};
  let renamedOnly = true;

  if (action.newTitle && action.newTitle.trim()) changes.newTitle = action.newTitle.trim();
  if (action.newLocation && action.newLocation.trim()) {
    changes.newLocation = action.newLocation.trim();
    renamedOnly = false;
  }

  // Reschedule: a new time and/or new date. Preserve the original duration.
  if (action.newTime || action.newDate) {
    renamedOnly = false;
    const baseYmd = action.newDate
      ? splitDate(action.newDate)
      : ((): { y: number; m: number; d: number } => {
          const ymd = localYmd(event.start ?? "", tz);
          return ymd ?? splitDate(action.date ?? "");
        })();
    const baseHm = action.newTime ? splitTime(action.newTime) : localHm(event.start ?? "", tz) ?? { hour: 9, minute: 0 };
    const newStart = wallTimeToUtc(baseYmd.y, baseYmd.m, baseYmd.d, baseHm.hour, baseHm.minute, tz);
    if (Number.isNaN(newStart.getTime())) {
      return { handled: true, action: "update", reply: CALENDAR_WRITE_REPLIES.needTime };
    }
    // Preserve the existing duration (fall back to default when unknown).
    const origMs =
      event.start && event.end ? new Date(event.end).getTime() - new Date(event.start).getTime() : NaN;
    const durationMs = Number.isFinite(origMs) && origMs > 0 ? origMs : DEFAULT_DURATION_MINUTES * 60_000;
    const newEnd = new Date(newStart.getTime() + durationMs);
    changes.startIso = newStart.toISOString();
    changes.endIso = newEnd.toISOString();
  }

  if (Object.keys(changes).length === 0) {
    return { handled: true, action: "update", reply: CALENDAR_WRITE_REPLIES.needChange };
  }

  const preview = formatUpdatePreview(event, changes, tz);
  await propose(userId, {
    provider: GOOGLE_CALENDAR_PROVIDER,
    actionId: "calendar.updateEvent",
    riskLevel: "write",
    confirmationRequired: true,
    // The resolved event id is captured here, so the confirmation can never land
    // on a different event than the one previewed.
    input: { eventId: event.id, timezone: tz, renamedOnly, ...changes },
    previewText: preview,
  });

  return { handled: true, action: "update", reply: preview };
}

async function runDelete(
  userId: string,
  action: CalendarAction,
  tz: string | undefined,
  deps: CalendarWriteDeps,
): Promise<CalendarWriteResult> {
  const propose = deps.propose ?? createActionProposal;

  const target = await resolveTarget(userId, action, tz, deps);
  if (target.kind === "reply") return { handled: true, action: "delete", reply: target.reply };
  const event = target.event;

  // Capture the details now: once the event is deleted Google returns 204 with no
  // body, so these are the only accurate details the confirmation can report.
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
    },
    previewText: preview,
  });

  return { handled: true, action: "delete", reply: preview };
}
