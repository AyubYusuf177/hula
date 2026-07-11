import { getUserTimezone } from "../../../reminders/reminders";
import { logger } from "../../../utils/logger";
import { GoogleCalendarError } from "./client";
import { fetchUpcomingGoogleCalendarEvents } from "./events";
import type { CalendarRange, NormalizedCalendarEvent } from "./types";

/**
 * Calendar question routing (Section 11) — READ-ONLY.
 *
 * Detects simple calendar questions in an inbound iMessage from an already-linked
 * user ("what's on my calendar today", "when's my next meeting"), reads their
 * connected Google Calendar, and answers deterministically. If Google Calendar
 * isn't connected, Hula says so honestly instead of pretending.
 *
 * Mirrors the memory/reminder command pattern: PURE classification + formatting
 * (fully unit-testable) plus one DB/network orchestrator. It never creates,
 * edits, or deletes events, and never sets reminders.
 */

/** The classified calendar intent (or `none`). */
export type CalendarIntent = CalendarRange | "none";

// Fixed, honest replies matching the codebase voice.
export const CALENDAR_REPLIES = {
  notConnected:
    "I don’t have your Google Calendar connected yet. Once you connect it in Hula, I’ll be able to answer that.",
  unavailable:
    "I’m having trouble reaching your Google Calendar right now — mind trying again in a bit?",
} as const;

// "when's my next meeting", "what's my next event", "my next appointment".
const NEXT_RE =
  /\b(?:my )?next\s+(?:meeting|event|appointment|call)\b/i;

// Bare calendar-topic keyword.
const CALENDAR_KEYWORD_RE =
  /\b(?:calendar|schedule|agenda|meetings?|events?|appointments?)\b/i;

// Schedule-style openers that imply a calendar question without the keyword.
const SCHEDULE_OPENERS: readonly RegExp[] = [
  /\bdo i have (?:anything|any (?:meetings?|events?|plans|appointments?)|meetings?|events?|plans|appointments?)\b/i,
  /\bwhat(?:'|’)?s (?:on )?(?:my )?(?:calendar|schedule|agenda|day|plate)\b/i,
  /\bwhat do i have (?:on|going on|planned|scheduled|coming up)?\b/i,
  /\bwhat(?:'|’)?s (?:happening|going on)\b/i,
  /\bam i (?:free|busy)\b/i,
  /\bwhat(?:'|’)?s my schedule\b/i,
];

// Timeframe cues.
const TOMORROW_RE = /\btomorrow\b/i;
const WEEK_RE = /\b(?:this week|the week|rest of (?:the|this) week)\b/i;
const TODAY_RE = /\b(?:today|tonight|this (?:morning|afternoon|evening))\b/i;

function isScheduleQuestion(text: string): boolean {
  if (CALENDAR_KEYWORD_RE.test(text)) return true;
  return SCHEDULE_OPENERS.some((re) => re.test(text));
}

function detectTimeframe(text: string): CalendarRange | null {
  if (TOMORROW_RE.test(text)) return "tomorrow";
  if (WEEK_RE.test(text)) return "week";
  if (TODAY_RE.test(text)) return "today";
  return null;
}

/**
 * Pure: classify an inbound message as a calendar question (or `none`). Only
 * clearly calendar-shaped questions match, so ordinary messages fall through to
 * the normal Hula brain. Memory/reminder commands are handled upstream first, so
 * "remind me …" never reaches here.
 */
export function classifyCalendarQuestion(text: string | undefined): CalendarIntent {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "none";

  // "next meeting/event" is inherently a calendar question.
  if (NEXT_RE.test(trimmed)) return "next";

  const scheduleish = isScheduleQuestion(trimmed);
  if (!scheduleish) return "none";

  const timeframe = detectTimeframe(trimmed);
  if (timeframe) return timeframe;

  // A calendar-keyword question with no explicit timeframe → default to today.
  if (CALENDAR_KEYWORD_RE.test(trimmed)) return "today";

  return "none";
}

// --- Answer formatting (PURE) --------------------------------------------

/** Human label for a range, used in empty-state replies. */
function rangeLabel(range: CalendarRange): string {
  switch (range) {
    case "tomorrow":
      return "tomorrow";
    case "week":
      return "this week";
    case "today":
    default:
      return "today";
  }
}

/** Format an event's clock time (or "all day") in a timezone. */
function formatEventClock(event: NormalizedCalendarEvent, tz: string | undefined): string {
  if (event.allDay || !event.start) return "all day";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(event.start));
  } catch {
    return "";
  }
}

/** Format an event's weekday + date (e.g. "Mon, Jul 14") in a timezone. */
function formatEventDay(event: NormalizedCalendarEvent, tz: string | undefined): string {
  if (!event.start) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date(event.start));
  } catch {
    return "";
  }
}

function eventTitle(event: NormalizedCalendarEvent): string {
  const s = (event.summary ?? "").trim();
  return s.length > 0 ? s : "(untitled event)";
}

/**
 * Pure: turn normalized events into a concise iMessage-friendly answer. Empty
 * results produce an honest "nothing" reply. `next` describes the single next
 * event; the day ranges list events with their times.
 */
export function formatCalendarAnswer(
  intent: CalendarRange,
  events: NormalizedCalendarEvent[],
  tz: string | undefined,
): string {
  if (events.length === 0) {
    if (intent === "next") {
      return "You don’t have any upcoming events on your calendar.";
    }
    return `You’ve got nothing on your calendar ${rangeLabel(intent)}.`;
  }

  if (intent === "next") {
    const next = events[0];
    if (!next) return "You don’t have any upcoming events on your calendar.";
    const day = formatEventDay(next, tz);
    if (next.allDay) {
      return `Your next event is “${eventTitle(next)}”${day ? ` on ${day}` : ""} (all day).`;
    }
    const clock = formatEventClock(next, tz);
    const when = [day, clock].filter(Boolean).join(" at ");
    return `Your next event is “${eventTitle(next)}”${when ? ` on ${when}` : ""}.`;
  }

  const includeDay = intent === "week";
  const lines = events.map((e) => {
    const time = e.allDay ? "All day" : formatEventClock(e, tz);
    const prefix = includeDay ? `${formatEventDay(e, tz)} ${time}`.trim() : time;
    return `• ${prefix} — ${eventTitle(e)}`;
  });

  const header =
    intent === "tomorrow"
      ? "Here’s tomorrow:"
      : intent === "week"
        ? "Here’s your week:"
        : "Here’s today:";
  return `${header}\n${lines.join("\n")}`;
}

// --- Orchestrator (DB + network) -----------------------------------------

/** Result of attempting to answer a message as a calendar question. */
export interface CalendarQuestionResult {
  handled: boolean;
  reply?: string;
  intent?: CalendarIntent;
}

/** Max events to read for a range answer. "next" only needs one. */
function maxResultsFor(intent: CalendarRange): number {
  return intent === "next" ? 1 : 10;
}

/**
 * Handle a calendar question from an already-linked user. Returns
 * `{ handled: false }` for non-calendar messages so the caller falls through to
 * the normal Hula brain. Never throws — provider/DB failures degrade to an honest
 * reply. Read-only: it never writes to the calendar.
 */
export async function handleCalendarQuestion(
  userId: string,
  text: string | undefined,
): Promise<CalendarQuestionResult> {
  const intent = classifyCalendarQuestion(text);
  if (intent === "none") return { handled: false };

  try {
    const timezone = await getUserTimezone(userId);
    const events = await fetchUpcomingGoogleCalendarEvents(userId, {
      range: intent,
      maxResults: maxResultsFor(intent),
      timezone,
    });
    return {
      handled: true,
      intent,
      reply: formatCalendarAnswer(intent, events, timezone),
    };
  } catch (err) {
    if (err instanceof GoogleCalendarError && err.reason === "not_connected") {
      return { handled: true, intent, reply: CALENDAR_REPLIES.notConnected };
    }
    // Any other failure (refresh/expired/request) — stay honest, never pretend.
    logger.error("googleCalendar.question failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: true, intent, reply: CALENDAR_REPLIES.unavailable };
  }
}
