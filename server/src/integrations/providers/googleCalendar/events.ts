import {
  GoogleCalendarError,
  getGoogleCalendarConnection,
  googleCalendarGet,
  googleCalendarGetForConnection,
} from "./client";
import type { FetchLike } from "./oauth";
import {
  GOOGLE_CALENDAR_PROVIDER,
  type CalendarRange,
  type CalendarTimeRange,
  type NormalizedCalendarEvent,
  type RawGoogleEvent,
} from "./types";

/**
 * Google Calendar event reads (Section 11) — READ-ONLY.
 *
 * Pure helpers (range computation, normalization) plus one DB+network
 * orchestrator (`fetchUpcomingGoogleCalendarEvents`). Normalization is strict:
 * only whitelisted fields survive, so raw Google payloads and event descriptions
 * are never stored or returned.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 25;

/** Get the numeric UTC-offset string (e.g. "-04:00") for an instant in a tz. */
function tzOffsetString(date: Date, timeZone: string | undefined): string {
  if (!timeZone) return "+00:00";
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    });
    const part = dtf.formatToParts(date).find((p) => p.type === "timeZoneName");
    const raw = part?.value ?? "GMT";
    const offset = raw.replace("GMT", "").trim();
    return offset === "" ? "+00:00" : offset;
  } catch {
    return "+00:00";
  }
}

/** Local calendar Y-M-D for an instant in a tz (UTC when tz is absent). */
function localDateParts(
  date: Date,
  timeZone: string | undefined,
): { year: string; month: string; day: string } {
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(date)) {
      if (p.type !== "literal") map[p.type] = p.value;
    }
    return { year: map.year ?? "1970", month: map.month ?? "01", day: map.day ?? "01" };
  } catch {
    return {
      year: String(date.getUTCFullYear()),
      month: String(date.getUTCMonth() + 1).padStart(2, "0"),
      day: String(date.getUTCDate()).padStart(2, "0"),
    };
  }
}

/** RFC3339 start-of-local-day, `plusDays` from `now`, in the given timezone. */
function startOfLocalDay(now: Date, timeZone: string | undefined, plusDays: number): string {
  const shifted = new Date(now.getTime() + plusDays * MS_PER_DAY);
  const { year, month, day } = localDateParts(shifted, timeZone);
  const offset = tzOffsetString(shifted, timeZone);
  return `${year}-${month}-${day}T00:00:00${offset}`;
}

/**
 * Pure: compute the RFC3339 time window for a named range in a timezone.
 *   - today    : local midnight today → local midnight tomorrow
 *   - tomorrow : local midnight tomorrow → the day after
 *   - week     : now → local midnight 7 days out
 *   - next     : now → open-ended (caller caps results to 1)
 */
export function computeRange(
  range: CalendarRange,
  now: Date,
  timeZone: string | undefined,
): CalendarTimeRange {
  switch (range) {
    case "today":
      return { timeMin: startOfLocalDay(now, timeZone, 0), timeMax: startOfLocalDay(now, timeZone, 1) };
    case "tomorrow":
      return { timeMin: startOfLocalDay(now, timeZone, 1), timeMax: startOfLocalDay(now, timeZone, 2) };
    case "week":
      return { timeMin: now.toISOString(), timeMax: startOfLocalDay(now, timeZone, 7) };
    case "next":
    default:
      return { timeMin: now.toISOString() };
  }
}

/**
 * Pure: normalize one raw Google event into the safe, app-facing shape. Only
 * whitelisted fields are kept — the event description and any other raw payload
 * are deliberately dropped.
 */
export function normalizeGoogleEvent(
  raw: RawGoogleEvent,
  calendarId: string,
): NormalizedCalendarEvent {
  const allDay = Boolean(raw.start?.date && !raw.start?.dateTime);
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    calendarId,
    summary: typeof raw.summary === "string" ? raw.summary : null,
    location: typeof raw.location === "string" ? raw.location : null,
    start: raw.start?.dateTime ?? raw.start?.date ?? null,
    end: raw.end?.dateTime ?? raw.end?.date ?? null,
    allDay,
    status: typeof raw.status === "string" ? raw.status : null,
    htmlLink: typeof raw.htmlLink === "string" ? raw.htmlLink : null,
    attendeeCount: Array.isArray(raw.attendees) ? raw.attendees.length : null,
    organizerEmail:
      typeof raw.organizer?.email === "string" ? raw.organizer.email : null,
    source: GOOGLE_CALENDAR_PROVIDER,
  };
}

/** The safe Google account identity we may store (email + display name). */
export interface GoogleCalendarIdentity {
  email: string | null;
  displayName: string | null;
}

/**
 * Read the user's primary calendar to capture a safe account identity (the
 * primary calendar id IS the account email). Read-only. Never throws token data.
 */
export async function fetchGoogleCalendarIdentity(
  accessToken: string,
  fetchImpl?: FetchLike,
): Promise<GoogleCalendarIdentity> {
  const cal = await googleCalendarGet<{ id?: string; summary?: string }>(
    accessToken,
    "/calendars/primary",
    {},
    fetchImpl,
  );
  return {
    email: typeof cal.id === "string" ? cal.id : null,
    displayName: typeof cal.summary === "string" ? cal.summary : null,
  };
}

/** Options for fetching upcoming events. */
export interface FetchEventsOptions {
  range?: CalendarRange;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  calendarId?: string;
  timezone?: string;
  now?: Date;
  fetchImpl?: FetchLike;
}

/**
 * Fetch upcoming events for a user's connected Google Calendar, normalized.
 *
 * Resolves the connection (throwing `not_connected` when there is none or it is
 * not currently connected), obtains a valid access token (refreshing if needed),
 * calls `events.list` (single events, ordered by start), and returns only
 * normalized events. Raw payloads are never returned or stored.
 */
export async function fetchUpcomingGoogleCalendarEvents(
  userId: string,
  options: FetchEventsOptions = {},
): Promise<NormalizedCalendarEvent[]> {
  const connection = await getGoogleCalendarConnection(userId);
  if (!connection || connection.status !== "connected") {
    throw new GoogleCalendarError("not_connected", "Google Calendar is not connected");
  }

  const now = options.now ?? new Date();
  const window: CalendarTimeRange = options.range
    ? computeRange(options.range, now, options.timezone)
    : { timeMin: options.timeMin ?? now.toISOString(), timeMax: options.timeMax };

  const maxResults = Math.min(
    Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS),
    MAX_RESULTS_CAP,
  );
  const calendarId = options.calendarId ?? "primary";

  const query: Record<string, string> = {
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(maxResults),
    timeMin: window.timeMin,
  };
  if (window.timeMax) query.timeMax = window.timeMax;

  // Connection-aware read: refreshes + retries once on a single 401. An HTTP-200
  // response with `items: []` is a SUCCESSFUL empty calendar — it returns [] here
  // and never becomes a provider error.
  const data = await googleCalendarGetForConnection<{ items?: RawGoogleEvent[] }>(
    connection.id,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    query,
    options.fetchImpl,
  );

  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((raw) => normalizeGoogleEvent(raw, calendarId));
}
