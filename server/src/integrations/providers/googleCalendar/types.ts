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

/** Read-only Calendar scope (list calendars + read events). */
export const CALENDAR_READONLY_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly";

/**
 * Write-capable Calendar scope (create/update/delete events). Section 15 adds
 * this to the requested scopes so a newly connected user can have Hula act on
 * their calendar. A connection that predates this only holds the read-only scope
 * and must be reconnected before any write can run.
 */
export const CALENDAR_EVENTS_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

/**
 * Google Meet conference creation is authorised by the SAME `calendar.events`
 * scope as any other event write (Section 18) — Google issues the conference as
 * part of `events.insert`/`events.patch` when `conferenceDataVersion=1` is set.
 * There is NO separate Meet scope and no separate Meet API involved here, which
 * is exactly why Hula's Meet support cannot claim anything beyond what Calendar
 * itself returns: no recordings, no transcripts, no attendance administration.
 */
export const CALENDAR_CONFERENCE_DATA_VERSION = 1 as const;

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
 * One attendee on an event, normalized (Section 18). Only the safe identity and
 * RSVP state survive — never a raw provider attendee object.
 */
export interface CalendarAttendee {
  email: string;
  displayName: string | null;
  /** Google's RSVP state: needsAction | declined | tentative | accepted. */
  responseStatus: string | null;
  optional: boolean;
  /** True for the connected user's own attendee row. */
  self: boolean;
  organizer: boolean;
}

/**
 * The state of a Google Meet conference ON an event (Section 18).
 *
 * `pending` is REAL and load-bearing: `events.insert` with a conference
 * `createRequest` may return before Google has finished allocating the Meet, in
 * which case `conferenceData.createRequest.status.statusCode` is `pending` and
 * NO entry point exists yet. Hula reports that honestly rather than inventing a
 * URL or claiming a link exists.
 */
export type ConferenceStatus = "success" | "pending" | "failure";

/** A normalized Google Meet conference, built ONLY from what Google returned. */
export interface CalendarConference {
  status: ConferenceStatus;
  /**
   * The real, Google-issued Meet URL. Non-null ONLY when Google returned a
   * `video` entry point whose URI passed validation. NEVER constructed by Hula.
   */
  meetUrl: string | null;
  /** The conference id Google assigned (e.g. "abc-defg-hij"), when present. */
  conferenceId: string | null;
  /** Dial-in / phone entry point, when Google supplied one. */
  phoneNumber: string | null;
}

/**
 * A normalized, app-safe calendar event. Raw Google payloads are never stored or
 * returned; only the fields below survive normalization. `start`/`end` are ISO
 * strings for timed events or `YYYY-MM-DD` for all-day events.
 */
export interface NormalizedCalendarEvent {
  id: string;
  calendarId: string;
  summary: string | null;
  location: string | null;
  /**
   * The event description (Section 18). Section 11 deliberately dropped this to
   * keep the read surface minimal; Section 18 needs it because the user can now
   * SET and CHANGE it, and an update preview must show the real before-value.
   * It is provider-authored text and therefore UNTRUSTED — it is only ever shown
   * to the user, never interpreted as an instruction.
   */
  description: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  status: string | null;
  htmlLink: string | null;
  attendeeCount: number | null;
  /** The full normalized attendee list (Section 18). Empty when there are none. */
  attendees: CalendarAttendee[];
  organizerEmail: string | null;
  /** The event's own timezone, when Google supplied one. */
  timeZone: string | null;
  /**
   * The Google Meet conference on this event, or null when there is none.
   * Populated STRICTLY from Google's `conferenceData` — see `conference.ts`.
   */
  conference: CalendarConference | null;
  /**
   * The id of the recurring series this event instance belongs to, when it is
   * one (Section 15). `null`/absent for ordinary one-off events. Used as a
   * safety signal — a write that resolves to a recurring instance asks the user
   * which scope they mean rather than guessing.
   */
  recurringEventId?: string | null;
  /** True when THIS event is the master of a series (it carries `recurrence`). */
  isRecurringMaster: boolean;
  source: typeof GOOGLE_CALENDAR_PROVIDER;
}

/** The raw shape (subset) of a Google Calendar attendee. */
export interface RawGoogleAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  optional?: boolean;
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
}

/** The raw shape (subset) of Google's `conferenceData` on an event. */
export interface RawGoogleConferenceData {
  conferenceId?: string;
  conferenceSolution?: { key?: { type?: string }; name?: string };
  entryPoints?: {
    entryPointType?: string;
    uri?: string;
    label?: string;
  }[];
  createRequest?: {
    requestId?: string;
    conferenceSolutionKey?: { type?: string };
    status?: { statusCode?: string };
  };
}

/** The raw shape (subset) of a Google Calendar `events.list` item we read. */
export interface RawGoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: RawGoogleAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  conferenceData?: RawGoogleConferenceData;
  /** Present when this event is an instance of a recurring series. */
  recurringEventId?: string;
  /** Present on the master event of a recurring series. */
  recurrence?: unknown[];
}
