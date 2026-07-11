/**
 * Google Calendar provider types (Section 11).
 *
 * Read-only. These describe the small, SAFE surface Hula keeps from Google
 * Calendar — a normalized event shape with only whitelisted fields. Raw Google
 * event payloads are NEVER stored or returned; only the fields below survive
 * normalization (see `events.ts`).
 */

/** The stable provider slug for Google Calendar (matches the catalog). */
export const GOOGLE_CALENDAR_PROVIDER = "google_calendar" as const;

/** A time window to query events over. */
export interface CalendarTimeRange {
  /** RFC3339 lower bound (inclusive). */
  timeMin: string;
  /** RFC3339 upper bound (exclusive). Omitted for open-ended "next" lookups. */
  timeMax?: string;
}

/** The supported query ranges for calendar reads. */
export type CalendarRange = "today" | "tomorrow" | "week" | "next";

/**
 * A normalized, app-safe calendar event. Deliberately omits the event
 * description and any raw provider payload. `start`/`end` are ISO strings for
 * timed events or `YYYY-MM-DD` for all-day events.
 */
export interface NormalizedCalendarEvent {
  id: string;
  calendarId: string;
  summary: string | null;
  location: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  status: string | null;
  htmlLink: string | null;
  attendeeCount: number | null;
  organizerEmail: string | null;
  source: typeof GOOGLE_CALENDAR_PROVIDER;
}

/** The raw shape (subset) of a Google Calendar `events.list` item we read. */
export interface RawGoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: unknown[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
}
