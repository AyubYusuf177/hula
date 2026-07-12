import {
  GoogleCalendarError,
  getGoogleCalendarConnection,
  googleCalendarGetForConnection,
  googleCalendarRequestForConnection,
} from "./client";
import type { FetchLike } from "./oauth";
import { normalizeGoogleEvent } from "./events";
import { type NormalizedCalendarEvent, type RawGoogleEvent } from "./types";

/**
 * Google Calendar event WRITES (Section 15) — create / update / delete / find.
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

/** A single point-in-time with a timezone, as Google's event API expects. */
export interface EventDateTime {
  /** RFC3339 timestamp WITH offset, e.g. "2026-07-14T13:00:00-04:00". */
  dateTime: string;
  /** IANA timezone, e.g. "America/New_York". Optional but recommended. */
  timeZone?: string;
}

/** The safe, whitelisted fields a create/update may set. */
export interface CalendarEventWriteFields {
  summary?: string;
  location?: string;
  description?: string;
  start?: EventDateTime;
  end?: EventDateTime;
}

/**
 * PURE: build the Google event request body from safe fields. Only whitelisted
 * keys are ever emitted, and `undefined` fields are dropped so a PATCH never
 * clears a field the user didn't ask to change (patch semantics preserve the
 * rest). Never includes attendees, conferencing, or any field we don't manage.
 */
export function buildEventBody(fields: CalendarEventWriteFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.summary !== undefined) body.summary = fields.summary;
  if (fields.location !== undefined) body.location = fields.location;
  if (fields.description !== undefined) body.description = fields.description;
  if (fields.start !== undefined) {
    body.start = fields.start.timeZone
      ? { dateTime: fields.start.dateTime, timeZone: fields.start.timeZone }
      : { dateTime: fields.start.dateTime };
  }
  if (fields.end !== undefined) {
    body.end = fields.end.timeZone
      ? { dateTime: fields.end.dateTime, timeZone: fields.end.timeZone }
      : { dateTime: fields.end.dateTime };
  }
  return body;
}

/** Create an event on the user's primary calendar. Returns the normalized event. */
export async function createCalendarEvent(
  userId: string,
  fields: CalendarEventWriteFields,
  fetchImpl?: FetchLike,
): Promise<NormalizedCalendarEvent> {
  const connectionId = await requireConnectionId(userId);
  const raw = await googleCalendarRequestForConnection<RawGoogleEvent>(
    connectionId,
    "POST",
    `/calendars/${encodeURIComponent(DEFAULT_CALENDAR_ID)}/events`,
    { body: buildEventBody(fields) },
    fetchImpl,
  );
  return normalizeGoogleEvent(raw, DEFAULT_CALENDAR_ID);
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
  fetchImpl?: FetchLike,
): Promise<NormalizedCalendarEvent> {
  const connectionId = await requireConnectionId(userId);
  const raw = await googleCalendarRequestForConnection<RawGoogleEvent>(
    connectionId,
    "PATCH",
    `/calendars/${encodeURIComponent(DEFAULT_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
    { body: buildEventBody(fields) },
    fetchImpl,
  );
  return normalizeGoogleEvent(raw, DEFAULT_CALENDAR_ID);
}

/** Delete an event by id from the user's primary calendar. */
export async function deleteCalendarEvent(
  userId: string,
  eventId: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const connectionId = await requireConnectionId(userId);
  await googleCalendarRequestForConnection<Record<string, never>>(
    connectionId,
    "DELETE",
    `/calendars/${encodeURIComponent(DEFAULT_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
    {},
    fetchImpl,
  );
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
  fetchImpl?: FetchLike;
}

/**
 * Find events in a NARROW time window (single events, expanded from recurrence),
 * optionally filtered by Google's free-text `q`. Read-only — used to resolve the
 * one event an update/delete refers to, and to detect ambiguity (>1 match).
 */
export async function findCalendarEvents(
  userId: string,
  options: FindEventsOptions,
): Promise<NormalizedCalendarEvent[]> {
  const connectionId = await requireConnectionId(userId);
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
    `/calendars/${encodeURIComponent(DEFAULT_CALENDAR_ID)}/events`,
    query,
    options.fetchImpl,
  );
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((raw) => normalizeGoogleEvent(raw, DEFAULT_CALENDAR_ID));
}
