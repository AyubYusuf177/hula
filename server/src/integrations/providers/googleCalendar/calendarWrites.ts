import {
  GoogleCalendarError,
  getGoogleCalendarConnection,
  googleCalendarGetForConnection,
  googleCalendarRequestForConnection,
} from "./client";
import type { FetchLike } from "./oauth";
import { normalizeGoogleEvent } from "./events";
import { buildConferenceCreateRequest } from "./conference";
import {
  CALENDAR_CONFERENCE_DATA_VERSION,
  type NormalizedCalendarEvent,
  type RawGoogleEvent,
} from "./types";

/**
 * Google Calendar event WRITES (Sections 15 + 18) — create / update / delete /
 * find / re-fetch.
 *
 * These are the ONLY functions that mutate a user's calendar. Every Google API
 * call stays inside this provider layer (never in a webhook route). Each call
 * reuses the existing connection resolution + token refresh + one-retry policy
 * from `client.ts`, so nothing here touches a token directly. Responses are
 * strictly normalized (whitelisted fields only) exactly like the read path — the
 * caller confirms from the ACTUAL Google response, never from what it sent.
 */

const DEFAULT_CALENDAR_ID = "primary";

/** Resolve the connected connection id, or throw a safe `not_connected`. */
async function requireConnectionId(userId: string): Promise<string> {
  const connection = await getGoogleCalendarConnection(userId);
  if (!connection || connection.status !== "connected") {
    throw new GoogleCalendarError("not_connected", "Google Calendar is not connected");
  }
  return connection.id;
}

/**
 * A single point-in-time, as Google's event API expects. EXACTLY ONE of
 * `dateTime` (a timed event) or `date` (an all-day event) may be set — Google
 * rejects a start/end carrying both, and the distinction is what makes an event
 * all-day.
 */
export interface EventDateTime {
  /** RFC3339 timestamp WITH offset, e.g. "2026-07-14T13:00:00-04:00". */
  dateTime?: string;
  /** `YYYY-MM-DD` for an all-day event. Mutually exclusive with `dateTime`. */
  date?: string;
  /** IANA timezone, e.g. "America/New_York". Optional but recommended. */
  timeZone?: string;
}

/** How Google should notify attendees about a change. */
export type SendUpdatesMode = "all" | "externalOnly" | "none";

/** An attendee to invite, as a verified address. */
export interface EventAttendeeInput {
  email: string;
  optional?: boolean;
}

/** A reminder override on the event. */
export interface EventReminderInput {
  /** Google supports "email" and "popup". */
  method: "email" | "popup";
  /** Minutes before the event start (Google caps at 40320 = 4 weeks). */
  minutes: number;
}

/** The safe, whitelisted fields a create/update may set. */
export interface CalendarEventWriteFields {
  summary?: string;
  location?: string;
  description?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  /**
   * The COMPLETE attendee list. Google's PATCH replaces the whole array rather
   * than merging, so a caller adding one person must send everyone — the
   * resolver above builds the full list precisely for that reason.
   */
  attendees?: EventAttendeeInput[];
  /** Reminder overrides. An empty array means "no reminders" (not "default"). */
  reminders?: EventReminderInput[];
  /**
   * Ask Google to allocate a NEW Meet. Carries the caller-generated, replayable
   * `requestId`. Requires `conferenceDataVersion=1` on the request, which
   * `createCalendarEvent`/`updateCalendarEvent` set whenever this is present.
   */
  addConferenceRequestId?: string;
}

/** Per-call options for a write. */
export interface CalendarWriteOptions {
  /**
   * Whether Google emails the attendees. Defaults to `none` — silence is the
   * safe default, and the caller opts in explicitly ONLY after the user has
   * confirmed a preview that told them invitations would go out.
   */
  sendUpdates?: SendUpdatesMode;
  calendarId?: string;
  fetchImpl?: FetchLike;
}

/**
 * PURE: build the Google event request body from safe fields.
 *
 * Only whitelisted keys are ever emitted, and `undefined` fields are DROPPED so a
 * PATCH never clears a field the user didn't ask to change (patch semantics
 * preserve the rest). The distinction between "absent" and "null" is the whole
 * game here: emitting `location: null` would wipe a location the user never
 * mentioned.
 */
export function buildEventBody(fields: CalendarEventWriteFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.summary !== undefined) body.summary = fields.summary;
  if (fields.location !== undefined) body.location = fields.location;
  if (fields.description !== undefined) body.description = fields.description;
  if (fields.start !== undefined) body.start = buildEventDateTime(fields.start);
  if (fields.end !== undefined) body.end = buildEventDateTime(fields.end);
  if (fields.attendees !== undefined) {
    body.attendees = fields.attendees.map((a) =>
      a.optional ? { email: a.email, optional: true } : { email: a.email },
    );
  }
  if (fields.reminders !== undefined) {
    // `useDefault:false` is REQUIRED for overrides to take effect — with it true
    // Google ignores the array entirely and silently applies calendar defaults.
    body.reminders = {
      useDefault: false,
      overrides: fields.reminders.map((r) => ({ method: r.method, minutes: r.minutes })),
    };
  }
  if (fields.addConferenceRequestId !== undefined) {
    body.conferenceData = buildConferenceCreateRequest(fields.addConferenceRequestId);
  }
  return body;
}

/**
 * PURE: emit a Google start/end. An all-day event uses `date` ALONE — including
 * a `dateTime` alongside it makes Google reject the request.
 */
function buildEventDateTime(dt: EventDateTime): Record<string, unknown> {
  if (dt.date !== undefined) {
    // All-day: `timeZone` is meaningless against a bare date, so it is omitted.
    return { date: dt.date };
  }
  return dt.timeZone
    ? { dateTime: dt.dateTime, timeZone: dt.timeZone }
    : { dateTime: dt.dateTime };
}

/**
 * Validate a Google event response before ANY success claim (Section 17).
 *
 * Mirrors the Gmail rule: a write is only "done" when the provider echoes back a
 * real, Google-issued event identifier. A 2xx carrying a malformed or id-less body
 * is NOT evidence the event exists, so it must fail rather than be formatted as a
 * success. When `expectedId` is given (an update), the response must describe the
 * event we actually targeted — never a different one.
 */
export function requireEventReceipt(
  raw: RawGoogleEvent,
  operation: "create" | "update",
  expectedId?: string,
): NormalizedCalendarEvent {
  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  if (!id) {
    throw new GoogleCalendarError(
      "malformed_provider_response",
      `Google Calendar did not return an event id for ${operation}`,
    );
  }
  if (expectedId !== undefined && id !== expectedId) {
    throw new GoogleCalendarError(
      "malformed_provider_response",
      `Google Calendar ${operation} confirmed a different event than requested`,
    );
  }
  // A cancelled event is not a live create/update result — never claim otherwise.
  if (operation === "create" && raw.status === "cancelled") {
    throw new GoogleCalendarError(
      "malformed_provider_response",
      "Google Calendar returned a cancelled event for create",
    );
  }
  return normalizeGoogleEvent(raw, DEFAULT_CALENDAR_ID);
}

/** PURE: the query params a write needs (conference version + notifications). */
export function buildWriteQuery(
  fields: CalendarEventWriteFields,
  options: CalendarWriteOptions,
): Record<string, string> {
  const query: Record<string, string> = {};
  // Without this, Google IGNORES conferenceData and returns a normal event —
  // a 200 for a request that silently did not do what was asked.
  if (fields.addConferenceRequestId !== undefined) {
    query.conferenceDataVersion = String(CALENDAR_CONFERENCE_DATA_VERSION);
  }
  query.sendUpdates = options.sendUpdates ?? "none";
  return query;
}

/**
 * Create an event on the user's calendar. Returns the normalized event, but ONLY
 * after Google confirms it with a real event id — a malformed response throws
 * rather than resolving to a fabricated success.
 */
export async function createCalendarEvent(
  userId: string,
  fields: CalendarEventWriteFields,
  options: CalendarWriteOptions = {},
): Promise<NormalizedCalendarEvent> {
  const connectionId = await requireConnectionId(userId);
  const calendarId = options.calendarId ?? DEFAULT_CALENDAR_ID;
  const raw = await googleCalendarRequestForConnection<RawGoogleEvent>(
    connectionId,
    "POST",
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { query: buildWriteQuery(fields, options), body: buildEventBody(fields) },
    options.fetchImpl,
  );
  return requireEventReceipt(raw, "create");
}

/**
 * Update (PATCH) an existing event by id, changing ONLY the supplied fields.
 * PATCH semantics preserve every field not present in the body — so the title,
 * description, location, attendees, and duration the user didn't touch stay put.
 */
export async function updateCalendarEvent(
  userId: string,
  eventId: string,
  fields: CalendarEventWriteFields,
  options: CalendarWriteOptions = {},
): Promise<NormalizedCalendarEvent> {
  const connectionId = await requireConnectionId(userId);
  const calendarId = options.calendarId ?? DEFAULT_CALENDAR_ID;
  const raw = await googleCalendarRequestForConnection<RawGoogleEvent>(
    connectionId,
    "PATCH",
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { query: buildWriteQuery(fields, options), body: buildEventBody(fields) },
    options.fetchImpl,
  );
  return requireEventReceipt(raw, "update", eventId);
}

/**
 * Delete an event by id from the user's calendar.
 *
 * Success is established by Google's own response, never assumed: the client
 * throws a classified error on any non-2xx (404 → `calendar_not_found`, 403 →
 * scope/permission, …), so returning normally means Google answered 2xx — for a
 * delete, a 204 No Content, which the client maps to an empty object. The caller
 * may claim deletion on that basis and no other. There is no id to validate here,
 * which is exactly why the target id is resolved and pinned at proposal time.
 */
export async function deleteCalendarEvent(
  userId: string,
  eventId: string,
  options: CalendarWriteOptions = {},
): Promise<void> {
  const connectionId = await requireConnectionId(userId);
  const calendarId = options.calendarId ?? DEFAULT_CALENDAR_ID;
  await googleCalendarRequestForConnection<Record<string, never>>(
    connectionId,
    "DELETE",
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { query: { sendUpdates: options.sendUpdates ?? "none" } },
    options.fetchImpl,
  );
}

/**
 * Re-fetch ONE event by id (Section 18) — the postcondition read.
 *
 * A write's own response is Google telling us what it believes it did. This is a
 * SEPARATE read that asks what is actually on the calendar now, which is what
 * lets a caller verify a change landed rather than trusting the echo.
 */
export async function getCalendarEvent(
  userId: string,
  eventId: string,
  options: CalendarWriteOptions = {},
): Promise<NormalizedCalendarEvent> {
  const connectionId = await requireConnectionId(userId);
  const calendarId = options.calendarId ?? DEFAULT_CALENDAR_ID;
  const raw = await googleCalendarGetForConnection<RawGoogleEvent>(
    connectionId,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {},
    options.fetchImpl,
  );
  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  if (!id) {
    throw new GoogleCalendarError(
      "malformed_provider_response",
      "Google Calendar returned no event id on re-fetch",
    );
  }
  return normalizeGoogleEvent(raw, calendarId);
}

/**
 * Whether an event is GONE from the user's calendar (Section 18) — the delete
 * postcondition.
 *
 * Google keeps a deleted event readable for a while with `status: "cancelled"`
 * rather than 404-ing immediately, so "it 404s" is too narrow a test and would
 * report a successful delete as unverified. Both a `calendar_not_found` (404 or
 * 410) and a `cancelled` status are genuine proof of deletion. Any OTHER error
 * is NOT proof of anything and propagates — an unreachable Google must never be
 * read as "well, it's probably deleted".
 */
export async function verifyEventDeleted(
  userId: string,
  eventId: string,
  options: CalendarWriteOptions = {},
): Promise<boolean> {
  try {
    const event = await getCalendarEvent(userId, eventId, options);
    return event.status === "cancelled";
  } catch (err) {
    if (err instanceof GoogleCalendarError && err.reason === "calendar_not_found") {
      return true;
    }
    throw err;
  }
}

/** Options for finding candidate events to update/delete. */
export interface FindEventsOptions {
  /** RFC3339 lower bound (inclusive). */
  timeMin: string;
  /** RFC3339 upper bound (exclusive). */
  timeMax: string;
  /** Free-text query Google matches against summary/description/etc. */
  query?: string;
  /** Cap on results (defaults small — we only need to detect ambiguity). */
  maxResults?: number;
  calendarId?: string;
  fetchImpl?: FetchLike;
}

/**
 * Find events in a time window (single events, expanded from recurrence),
 * optionally filtered by Google's free-text `q`. Read-only — used to resolve the
 * one event an update/delete refers to, to detect ambiguity (>1 match), and to
 * back event search.
 */
export async function findCalendarEvents(
  userId: string,
  options: FindEventsOptions,
): Promise<NormalizedCalendarEvent[]> {
  const connectionId = await requireConnectionId(userId);
  const calendarId = options.calendarId ?? DEFAULT_CALENDAR_ID;
  const query: Record<string, string> = {
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(Math.max(1, options.maxResults ?? 10), 25)),
    timeMin: options.timeMin,
    timeMax: options.timeMax,
  };
  if (options.query && options.query.trim().length > 0) query.q = options.query.trim();

  const data = await googleCalendarGetForConnection<{ items?: RawGoogleEvent[] }>(
    connectionId,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    query,
    options.fetchImpl,
  );
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((raw) => normalizeGoogleEvent(raw, calendarId));
}
