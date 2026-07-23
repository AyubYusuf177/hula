import { normalizeOutlookBody } from "./mailBody";
import {
  isSafeMicrosoftNextLink,
  microsoftGraphRequest,
  MicrosoftGraphError,
  type MicrosoftGraphRequestOptions,
} from "./graph";
import type {
  OutlookCalendar,
  OutlookCalendarAttendee,
  OutlookCalendarEvent,
  OutlookCalendarMutation,
  OutlookCalendarMutationReceipt,
  OutlookCalendarRecurrence,
} from "./calendarTypes";

const EVENT_SELECT = [
  "id", "calendar", "seriesMasterId", "type", "subject", "bodyPreview", "body",
  "start", "end", "isAllDay", "isCancelled", "organizer", "attendees", "location",
  "webLink", "isOnlineMeeting", "onlineMeetingProvider", "onlineMeeting", "recurrence",
  "createdDateTime", "lastModifiedDateTime",
].join(",");

export interface OutlookCalendarDeps {
  request?: <T>(userId: string, options: MicrosoftGraphRequestOptions) => Promise<T>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(value: unknown): string | null {
  const raw = string(value);
  if (!raw) return null;
  const normalized = raw.replace(/(\.\d{3})\d+/, "$1");
  const candidate = /(?:Z|[+-]\d\d:\d\d)$/i.test(normalized) ? normalized : `${normalized}Z`;
  const ms = Date.parse(candidate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function graphDateTime(value: unknown): { instant: string | null; timeZone: string | null } {
  const raw = object(value);
  return { instant: iso(raw?.dateTime), timeZone: string(raw?.timeZone) };
}

function graphAddress(value: unknown): { name: string | null; address: string | null } {
  const email = object(object(value)?.emailAddress);
  return { name: string(email?.name), address: string(email?.address)?.toLowerCase() ?? null };
}

function attendee(value: unknown): OutlookCalendarAttendee | null {
  const raw = object(value);
  const address = graphAddress(raw);
  if (!address.address) return null;
  const type = string(raw?.type)?.toLowerCase();
  const status = object(raw?.status);
  return {
    name: address.name,
    address: address.address,
    type: type === "optional" || type === "resource" ? type : "required",
    response: string(status?.response),
  };
}

function recurrence(value: unknown): OutlookCalendarRecurrence | null {
  const raw = object(value);
  if (!raw) return null;
  const pattern = object(raw.pattern);
  const range = object(raw.range);
  return {
    patternType: string(pattern?.type),
    interval: number(pattern?.interval),
    daysOfWeek: Array.isArray(pattern?.daysOfWeek)
      ? pattern.daysOfWeek.filter((item): item is string => typeof item === "string").slice(0, 7)
      : [],
    rangeType: string(range?.type),
    startDate: string(range?.startDate),
    endDate: string(range?.endDate),
    numberOfOccurrences: number(range?.numberOfOccurrences),
  };
}

function safeUrl(value: unknown): string | null {
  const raw = string(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeOutlookCalendar(value: unknown): OutlookCalendar | null {
  const raw = object(value);
  const id = string(raw?.id);
  const name = string(raw?.name);
  if (!id || !name) return null;
  const owner = graphAddress(raw?.owner);
  return {
    id,
    name,
    canEdit: raw?.canEdit === true,
    isDefault: raw?.isDefaultCalendar === true,
    ownerName: owner.name,
    ownerAddress: owner.address,
    color: string(raw?.color),
  };
}

export function normalizeOutlookCalendarEvent(value: unknown): OutlookCalendarEvent | null {
  const raw = object(value);
  const id = string(raw?.id);
  if (!id) return null;
  const start = graphDateTime(raw?.start);
  const end = graphDateTime(raw?.end);
  const organizer = graphAddress(raw?.organizer);
  const online = object(raw?.onlineMeeting);
  const body = object(raw?.body);
  const location = object(raw?.location);
  const calendar = object(raw?.calendar);
  return {
    provider: "microsoft",
    service: "outlook_calendar",
    id,
    calendarId: string(calendar?.id),
    seriesMasterId: string(raw?.seriesMasterId),
    type: string(raw?.type),
    subject: string(raw?.subject) ?? "(Untitled event)",
    bodyPreview: normalizeOutlookBody(string(raw?.bodyPreview) ?? "", "text").slice(0, 1_000),
    body: body ? normalizeOutlookBody(string(body.content) ?? "", string(body.contentType)) : null,
    start: start.instant,
    end: end.instant,
    timeZone: start.timeZone ?? end.timeZone,
    isAllDay: raw?.isAllDay === true,
    isCancelled: raw?.isCancelled === true,
    organizerName: organizer.name,
    organizerAddress: organizer.address,
    attendees: Array.isArray(raw?.attendees)
      ? raw.attendees.flatMap((item) => attendee(item) ?? [])
      : [],
    location: string(location?.displayName),
    webUrl: safeUrl(raw?.webLink),
    isOnlineMeeting: raw?.isOnlineMeeting === true,
    onlineMeetingProvider: string(raw?.onlineMeetingProvider),
    teamsJoinUrl: safeUrl(online?.joinUrl),
    recurrence: recurrence(raw?.recurrence),
    createdAt: iso(raw?.createdDateTime),
    modifiedAt: iso(raw?.lastModifiedDateTime),
  };
}

function collection(value: unknown): { value: unknown[]; nextLink: string | null } {
  const raw = object(value);
  if (!raw || !Array.isArray(raw.value)) throw new MicrosoftGraphError("malformed_provider_response");
  const nextLink = string(raw["@odata.nextLink"]);
  if (nextLink && !isSafeMicrosoftNextLink(nextLink)) throw new MicrosoftGraphError("malformed_provider_response");
  return { value: raw.value, nextLink };
}

export async function listOutlookCalendars(
  userId: string,
  deps: OutlookCalendarDeps = {},
): Promise<OutlookCalendar[]> {
  const request = deps.request ?? microsoftGraphRequest;
  const raw = await request<unknown>(userId, {
    capability: "outlook_calendar.read",
    path: "/me/calendars",
    query: { "$select": "id,name,color,canEdit,isDefaultCalendar,owner", "$top": 50 },
    headers: { Prefer: 'IdType="ImmutableId"' },
  });
  return collection(raw).value.flatMap((item) => normalizeOutlookCalendar(item) ?? []);
}

export async function listOutlookCalendarEvents(
  userId: string,
  input: { start: string; end: string; calendarId?: string | null; maxResults?: number; maxPages?: number },
  deps: OutlookCalendarDeps = {},
): Promise<{ events: OutlookCalendarEvent[]; hasMore: boolean; fetchedCount: number }> {
  const start = iso(input.start);
  const end = iso(input.end);
  if (!start || !end || Date.parse(start) >= Date.parse(end)) throw new MicrosoftGraphError("invalid_request");
  const request = deps.request ?? microsoftGraphRequest;
  const limit = Math.min(Math.max(input.maxResults ?? 10, 1), 25);
  const maxPages = Math.min(Math.max(input.maxPages ?? 3, 1), 5);
  const calendarPath = input.calendarId
    ? `/me/calendars/${encodeURIComponent(input.calendarId)}/calendarView`
    : "/me/calendarView";
  let nextLink: string | null = null;
  let pages = 0;
  let fetchedCount = 0;
  const events: OutlookCalendarEvent[] = [];
  const seen = new Set<string>();
  do {
    const raw = await request<unknown>(userId, {
      capability: "outlook_calendar.read",
      path: nextLink ? undefined : calendarPath,
      nextLink: nextLink ?? undefined,
      query: nextLink ? undefined : {
        startDateTime: start,
        endDateTime: end,
        "$select": EVENT_SELECT,
        "$orderby": "start/dateTime",
        "$top": Math.min(25, limit),
      },
      headers: { Prefer: 'IdType="ImmutableId", outlook.timezone="UTC"' },
    });
    const page = collection(raw);
    fetchedCount += page.value.length;
    for (const item of page.value) {
      const event = normalizeOutlookCalendarEvent(item);
      if (!event || event.isCancelled || seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
      if (events.length >= limit) break;
    }
    nextLink = page.nextLink;
    pages += 1;
  } while (nextLink && pages < maxPages && events.length < limit);
  events.sort((a, b) => Date.parse(a.start ?? "") - Date.parse(b.start ?? ""));
  return { events, hasMore: Boolean(nextLink), fetchedCount };
}

export async function getOutlookCalendarEvent(
  userId: string,
  eventId: string,
  deps: OutlookCalendarDeps = {},
): Promise<OutlookCalendarEvent> {
  const request = deps.request ?? microsoftGraphRequest;
  const raw = await request<unknown>(userId, {
    capability: "outlook_calendar.read",
    path: `/me/events/${encodeURIComponent(eventId)}`,
    query: { "$select": EVENT_SELECT },
    headers: { Prefer: 'IdType="ImmutableId", outlook.timezone="UTC"' },
  });
  const event = normalizeOutlookCalendarEvent(raw);
  if (!event) throw new MicrosoftGraphError("malformed_provider_response");
  return event;
}

function requiredString(input: Record<string, unknown>, key: string, max = 2_000): string {
  const value = string(input[key]);
  if (!value || value.length > max) throw new MicrosoftGraphError("invalid_request");
  return value;
}

function emails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    const candidate = string(item)?.toLowerCase();
    return candidate && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? [candidate] : [];
  }))].slice(0, 50);
}

function eventDateTime(value: string, timeZone: string): { dateTime: string; timeZone: string } {
  const parsed = iso(value);
  if (!parsed) throw new MicrosoftGraphError("invalid_request");
  return { dateTime: parsed, timeZone };
}

function mutationBody(input: Record<string, unknown>, operation: OutlookCalendarMutation): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (operation === "create" || string(input.title)) body.subject = requiredString(input, "title", 998);
  const timeZone = string(input.timeZone) ?? "UTC";
  if (operation === "create" || string(input.start)) body.start = eventDateTime(requiredString(input, "start", 100), timeZone);
  if (operation === "create" || string(input.end)) body.end = eventDateTime(requiredString(input, "end", 100), timeZone);
  if (input.location !== undefined) body.location = { displayName: string(input.location) ?? "" };
  if (input.description !== undefined) body.body = { contentType: "Text", content: string(input.description) ?? "" };
  if (input.attendees !== undefined) {
    body.attendees = emails(input.attendees).map((address) => ({
      emailAddress: { address },
      type: "required",
    }));
  }
  if (input.teamsMeeting === true) {
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = "teamsForBusiness";
  }
  if (operation === "create") body.transactionId = requiredString(input, "transactionId", 200);
  if (operation === "update" && Object.keys(body).length === 0) {
    throw new MicrosoftGraphError("invalid_request");
  }
  return body;
}

function verifiedFields(event: OutlookCalendarEvent, input: Record<string, unknown>): boolean {
  if (string(input.title) && event.subject !== string(input.title)) return false;
  if (string(input.start) && event.start !== iso(input.start)) return false;
  if (string(input.end) && event.end !== iso(input.end)) return false;
  if (input.location !== undefined && event.location !== (string(input.location) ?? null)) return false;
  if (input.description !== undefined && (event.body ?? "") !== (string(input.description) ?? "")) return false;
  const expectedAttendees = emails(input.attendees);
  if (input.attendees !== undefined) {
    const actual = new Set(event.attendees.map((item) => item.address));
    if (!expectedAttendees.every((email) => actual.has(email))) return false;
  }
  return true;
}

export async function executeOutlookCalendarMutation(
  userId: string,
  input: Record<string, unknown>,
  deps: OutlookCalendarDeps = {},
): Promise<OutlookCalendarMutationReceipt> {
  const operation = string(input.operation) as OutlookCalendarMutation | null;
  if (operation !== "create" && operation !== "update" && operation !== "delete") {
    throw new MicrosoftGraphError("invalid_request");
  }
  const request = deps.request ?? microsoftGraphRequest;
  if (operation === "delete") {
    const eventId = requiredString(input, "eventId", 1_000);
    await getOutlookCalendarEvent(userId, eventId, deps);
    await request(userId, {
      method: "DELETE",
      capability: "outlook_calendar.write",
      path: `/me/events/${encodeURIComponent(eventId)}`,
      responseKind: "empty",
    });
    try {
      await getOutlookCalendarEvent(userId, eventId, deps);
      throw new MicrosoftGraphError("verification_inconclusive");
    } catch (error) {
      if (!(error instanceof MicrosoftGraphError) || error.reason !== "not_found") throw error;
    }
    return { operation, event: null, eventId, verification: "verified" };
  }

  const body = mutationBody(input, operation);
  let eventId: string;
  if (operation === "create") {
    const calendarId = string(input.calendarId);
    const raw = await request<unknown>(userId, {
      method: "POST",
      capability: "outlook_calendar.write",
      path: calendarId ? `/me/calendars/${encodeURIComponent(calendarId)}/events` : "/me/events",
      body,
      headers: { Prefer: 'IdType="ImmutableId", outlook.timezone="UTC"' },
    });
    const created = normalizeOutlookCalendarEvent(raw);
    if (!created) throw new MicrosoftGraphError("malformed_provider_response");
    eventId = created.id;
  } else {
    eventId = requiredString(input, "eventId", 1_000);
    await request(userId, {
      method: "PATCH",
      capability: "outlook_calendar.write",
      path: `/me/events/${encodeURIComponent(eventId)}`,
      body,
      headers: { Prefer: 'IdType="ImmutableId", outlook.timezone="UTC"' },
    });
  }
  const verified = await getOutlookCalendarEvent(userId, eventId, deps);
  if (!verifiedFields(verified, input)) throw new MicrosoftGraphError("verification_inconclusive");
  return { operation, event: verified, eventId, verification: "verified" };
}
