import { randomUUID } from "node:crypto";

import { loadGroundedContexts } from "../../../actions/entityContextArbiter";
import { executeAction, type ActionExecutionResult } from "../../../actions/executor";
import { createActionProposal, getActiveProposal, type CreateProposalInput } from "../../../actions/proposals";
import { computeRange } from "../googleCalendar/events";
import { getGoogleCalendarConnection } from "../googleCalendar/client";
import { getUserTimezone } from "../../../reminders/reminders";
import { logger } from "../../../utils/logger";
import { getMicrosoftConnection } from "./client";
import {
  loadOutlookCalendarEntity,
  loadOutlookCalendarSelection,
  recordOutlookCalendarEntity,
  recordOutlookCalendarSelection,
  resolveOutlookCalendarReference,
  type OutlookCalendarContextStore,
} from "./calendarContext";
import {
  explicitCalendarProvider,
  explicitOutlookCalendarIntent,
  extractOutlookCalendarIntent,
  shouldConsiderOutlookCalendar,
  type OutlookCalendarIntent,
  type OutlookCalendarIntentGenerator,
} from "./calendarIntent";
import {
  getOutlookCalendarEvent,
  listOutlookCalendarEvents,
  listOutlookCalendars,
  type OutlookCalendarDeps,
} from "./calendarOperations";
import type { OutlookCalendarEvent } from "./calendarTypes";
import { MicrosoftGraphError } from "./graph";

export interface OutlookCalendarConversationDeps extends OutlookCalendarDeps, OutlookCalendarContextStore {
  arbitrated?: boolean;
  extract?: typeof extractOutlookCalendarIntent;
  generateIntent?: OutlookCalendarIntentGenerator;
  getMicrosoftState?: (userId: string) => Promise<{ connected: boolean }>;
  getGoogleState?: (userId: string) => Promise<{ connected: boolean }>;
  getContexts?: typeof loadGroundedContexts;
  getTimezone?: typeof getUserTimezone;
  listEvents?: typeof listOutlookCalendarEvents;
  listCalendars?: typeof listOutlookCalendars;
  getEvent?: typeof getOutlookCalendarEvent;
  execute?: typeof executeAction;
  propose?: (userId: string, input: CreateProposalInput) => Promise<unknown>;
  getActiveProposal?: typeof getActiveProposal;
}

export interface OutlookCalendarConversationResult {
  handled: boolean;
  reply?: string;
  routeSource?: string;
}

async function microsoftState(userId: string): Promise<{ connected: boolean }> {
  const connection = await getMicrosoftConnection(userId);
  return { connected: connection?.status === "connected" && connection.capabilities.includes("outlook_calendar.read") };
}

async function googleState(userId: string): Promise<{ connected: boolean }> {
  const connection = await getGoogleCalendarConnection(userId);
  return { connected: connection?.status === "connected" };
}

async function calendarOwner(
  userId: string,
  text: string,
  deps: OutlookCalendarConversationDeps,
): Promise<"outlook" | "google" | "ambiguous" | "none"> {
  const explicit = explicitCalendarProvider(text);
  const microsoft = await (deps.getMicrosoftState ?? microsoftState)(userId);
  const google = await (deps.getGoogleState ?? googleState)(userId);
  if (explicit === "outlook_calendar") return microsoft.connected ? "outlook" : "none";
  if (explicit === "google_calendar") return "google";
  if (deps.arbitrated) return "outlook";
  const contexts = await (deps.getContexts ?? loadGroundedContexts)(userId);
  const calendar = contexts.find((item) => item.kind === "outlook_calendar_event" || item.kind === "calendar_event");
  if (calendar?.kind === "outlook_calendar_event") return "outlook";
  if (calendar?.kind === "calendar_event") return "google";
  if (microsoft.connected && google.connected) return "ambiguous";
  if (microsoft.connected) return "outlook";
  if (google.connected) return "google";
  return "none";
}

function displayInstant(value: string | null, timeZone: string | undefined): string {
  if (!value) return "time unavailable";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone ?? "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function formatOutlookCalendarEvents(
  events: OutlookCalendarEvent[],
  timeZone?: string,
  hasMore = false,
): string {
  if (!events.length) return "I couldn’t find any Outlook calendar events in that time range.";
  const lines = events.map((event, index) => {
    const when = event.isAllDay ? "all day" : displayInstant(event.start, timeZone);
    const teams = event.teamsJoinUrl ? " — Teams" : "";
    return `${index + 1}. ${event.subject} — ${when}${teams}`;
  });
  const header = hasMore
    ? `I’m showing the first ${events.length} Outlook calendar events:`
    : `I found ${events.length} Outlook calendar event${events.length === 1 ? "" : "s"}:`;
  return [header, ...lines].join("\n");
}

function formatEventDetails(event: OutlookCalendarEvent, timeZone?: string): string {
  const attendees = event.attendees.map((item) => item.name ? `${item.name} <${item.address}>` : item.address);
  return [
    event.subject,
    `${displayInstant(event.start, timeZone)}–${displayInstant(event.end, timeZone)}`,
    `Organizer: ${event.organizerName ?? event.organizerAddress ?? "not shown"}`,
    `Attendees: ${attendees.join(", ") || "none shown"}`,
    `Location: ${event.location || "none"}`,
    event.teamsJoinUrl ? `Teams: ${event.teamsJoinUrl}` : "Teams link: none returned",
  ].join("\n");
}

function graphReply(error: MicrosoftGraphError): string {
  if (error.reason === "not_connected") return "Connect Microsoft 365 in Hula first, then I can check Outlook Calendar.";
  if (error.reason === "reconnect_required") return "Your Microsoft 365 connection needs to be reconnected in Hula.";
  if (error.reason === "insufficient_capability" || error.reason === "permission_denied") return "Reconnect Microsoft 365 and grant Outlook Calendar access before I can do that.";
  if (error.reason === "not_found") return "That Outlook event is no longer available. Ask me to find it again.";
  if (error.reason === "rate_limited") return "Outlook Calendar is rate-limiting requests right now. Please try again shortly.";
  return "I couldn’t retrieve that reliably from Outlook Calendar just now.";
}

function eventAnswer(event: OutlookCalendarEvent, question: string, timeZone?: string): string {
  if (/\b(?:who|attend|invite|coming)\b/i.test(question)) {
    const people = event.attendees.map((item) => item.name ?? item.address);
    return people.length ? `Attendees: ${people.join(", ")}.` : "No attendees are shown on this event.";
  }
  if (/\b(?:where|location|room)\b/i.test(question)) return event.location ? `It’s at ${event.location}.` : "No location is set.";
  if (/\b(?:teams|join\s+link|online\s+meeting)\b/i.test(question)) {
    return event.teamsJoinUrl ? `Teams link: ${event.teamsJoinUrl}` : "Microsoft didn’t return a Teams join link for this event.";
  }
  if (/\b(?:when.*end|what\s+time.*end|finish)\b/i.test(question)) return `It ends ${displayInstant(event.end, timeZone)}.`;
  if (/\borganizer|organis(?:e|er)|who.*set\s+up/i.test(question)) return `The organizer is ${event.organizerName ?? event.organizerAddress ?? "not shown"}.`;
  return formatEventDetails(event, timeZone);
}

function rangeFor(intent: OutlookCalendarIntent, now: Date, timeZone: string): { start: string; end: string } | null {
  if (intent.range === "custom") {
    if (!intent.rangeStart || !intent.rangeEnd || !Number.isFinite(Date.parse(intent.rangeStart)) || !Number.isFinite(Date.parse(intent.rangeEnd))) return null;
    return { start: new Date(intent.rangeStart).toISOString(), end: new Date(intent.rangeEnd).toISOString() };
  }
  const range = intent.range ?? "today";
  const computed = computeRange(range, now, timeZone);
  return {
    start: computed.timeMin,
    end: computed.timeMax ?? new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
  };
}

async function resolveTarget(
  userId: string,
  text: string,
  intent: OutlookCalendarIntent,
  deps: OutlookCalendarConversationDeps,
): Promise<{ event: OutlookCalendarEvent | null; reply?: string }> {
  // An explicit semantic name is authoritative. Active context remains useful for
  // pronouns, but it may never replace the event the user actually named.
  if (intent.eventQuery) {
    const now = deps.now ?? new Date();
    const page = await (deps.listEvents ?? listOutlookCalendarEvents)(userId, {
      start: now.toISOString(),
      end: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
      maxResults: 25,
    }, deps);
    const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
    const query = normalize(intent.eventQuery);
    const exact = page.events.filter((event) => normalize(event.subject) === query);
    const matches = exact.length > 0
      ? exact
      : page.events.filter((event) => normalize(event.subject).includes(query));
    if (matches.length === 1) return { event: matches[0]! };
    if (matches.length > 1) {
      await recordOutlookCalendarSelection(userId, matches, deps);
      const timezone = await (deps.getTimezone ?? getUserTimezone)(userId);
      return { event: null, reply: `${formatOutlookCalendarEvents(matches, timezone)}\nWhich one do you mean?` };
    }
    return { event: null, reply: `I couldn’t find an Outlook event called “${intent.eventQuery}”.` };
  }
  const ref = await resolveOutlookCalendarReference(userId, text, intent.ordinal, deps);
  if (ref) return { event: await (deps.getEvent ?? getOutlookCalendarEvent)(userId, ref.eventId, deps) };
  return { event: null, reply: "Which Outlook event do you mean? Ask me to list or find it first." };
}

function sameInstant(left: string | null, right: string | null): boolean {
  if (!left || !right) return left === right;
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

async function proposeMutation(
  userId: string,
  preview: string,
  input: Record<string, unknown>,
  deps: OutlookCalendarConversationDeps,
): Promise<OutlookCalendarConversationResult> {
  const pending = await (deps.getActiveProposal ?? getActiveProposal)(userId);
  if (pending) return { handled: true, reply: `I’m already waiting for confirmation on another action:\n${pending.previewText}\nReply Yes to confirm or No to cancel.` };
  await (deps.propose ?? createActionProposal)(userId, {
    provider: "microsoft",
    actionId: "microsoft.calendar.mutate",
    riskLevel: "write",
    confirmationRequired: true,
    input,
    previewText: preview,
  });
  return { handled: true, reply: `${preview}\nReply Yes to confirm or No to cancel.` };
}

async function handleWrite(
  userId: string,
  text: string,
  intent: OutlookCalendarIntent,
  timeZone: string,
  deps: OutlookCalendarConversationDeps,
): Promise<OutlookCalendarConversationResult> {
  if (intent.operation === "create") {
    if (!intent.title) return { handled: true, reply: "What should I call the Outlook event?" };
    if (!intent.start || !Number.isFinite(Date.parse(intent.start))) return { handled: true, reply: "What date and time should the Outlook event start?" };
    if (/\b(?:with|invite|add)\s+[A-Za-z]/i.test(text) && !intent.attendees?.length) {
      return { handled: true, reply: "What is the attendee’s exact email address? I won’t guess it from a name." };
    }
    const start = new Date(intent.start);
    const end = intent.end && Number.isFinite(Date.parse(intent.end))
      ? new Date(intent.end)
      : new Date(start.getTime() + 60 * 60 * 1_000);
    const input = {
      operation: "create",
      transactionId: randomUUID(),
      title: intent.title,
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone: intent.timeZone ?? timeZone,
      attendees: intent.attendees ?? [],
      ...(intent.location !== undefined ? { location: intent.location } : {}),
      ...(intent.description !== undefined ? { description: intent.description } : {}),
      ...(intent.teamsMeeting === true ? { teamsMeeting: true } : {}),
    };
    const preview = [
      `Create this event in Outlook Calendar${intent.teamsMeeting ? " as a Teams meeting" : ""}?`,
      `Title: ${intent.title}`,
      `When: ${displayInstant(start.toISOString(), timeZone)}–${displayInstant(end.toISOString(), timeZone)}`,
      ...(intent.attendees?.length ? [`Attendees: ${intent.attendees.join(", ")}`] : []),
      ...(intent.location ? [`Location: ${intent.location}`] : []),
    ].join("\n");
    return proposeMutation(userId, preview, input, deps);
  }

  const target = await resolveTarget(userId, text, intent, deps);
  if (!target.event) return { handled: true, reply: target.reply };
  if (target.event.seriesMasterId && !/\bthis\s+(?:occurrence|instance)\b/i.test(text)) {
    return { handled: true, reply: "That is part of a recurring series. Say whether you mean this occurrence or the whole series before I change it." };
  }
  if (intent.operation === "delete") {
    return proposeMutation(userId, `Cancel “${target.event.subject}” on ${displayInstant(target.event.start, timeZone)}?`, {
      operation: "delete",
      eventId: target.event.id,
    }, deps);
  }

  const input: Record<string, unknown> = { operation: "update", eventId: target.event.id };
  if (intent.title && intent.title !== target.event.subject) input.title = intent.title;

  const previousStart = Date.parse(target.event.start ?? "");
  const previousEnd = Date.parse(target.event.end ?? "");
  const duration = previousEnd - previousStart;
  let requestedStart: string | null = null;
  let requestedEnd: string | null = null;
  if (intent.relativeStartMinutes !== null && intent.relativeStartMinutes !== undefined) {
    if (!Number.isFinite(previousStart) || !Number.isFinite(previousEnd) || duration <= 0) {
      return { handled: true, reply: "I couldn’t verify that event’s current start and end time, so I haven’t proposed a move." };
    }
    requestedStart = new Date(previousStart + intent.relativeStartMinutes * 60_000).toISOString();
    requestedEnd = new Date(previousEnd + intent.relativeStartMinutes * 60_000).toISOString();
  } else if (intent.start && Number.isFinite(Date.parse(intent.start))) {
    if (!Number.isFinite(previousStart) || !Number.isFinite(previousEnd) || duration <= 0) {
      return { handled: true, reply: "I couldn’t verify that event’s current duration, so I haven’t proposed a move." };
    }
    requestedStart = new Date(intent.start).toISOString();
    requestedEnd = intent.end && Number.isFinite(Date.parse(intent.end))
      ? new Date(intent.end).toISOString()
      : new Date(Date.parse(requestedStart) + duration).toISOString();
  }
  if (requestedStart && requestedEnd && (
    !sameInstant(requestedStart, target.event.start) || !sameInstant(requestedEnd, target.event.end)
  )) {
    input.start = requestedStart;
    input.end = requestedEnd;
    input.timeZone = intent.timeZone ?? target.event.timeZone ?? timeZone;
  }
  if (typeof intent.location === "string" && intent.location.trim() !== (target.event.location ?? "")) input.location = intent.location.trim();
  if (typeof intent.description === "string" && intent.description !== (target.event.body ?? "")) input.description = intent.description;
  if (intent.teamsMeeting === true && !target.event.isOnlineMeeting) input.teamsMeeting = true;
  if (intent.attendees?.length) {
    const current = target.event.attendees.map((item) => item.address.toLowerCase());
    const combined = [...new Set([...current, ...intent.attendees.map((item) => item.toLowerCase())])];
    if (combined.length !== current.length) input.attendees = combined;
  } else if (/\b(?:invite|add)\s+[A-Za-z]/i.test(text)) {
    return { handled: true, reply: "What is the attendee’s exact email address? I won’t guess it from a name." };
  }
  if (Object.keys(input).length === 2) {
    return { handled: true, reply: requestedStart ? "That Outlook event is already at the requested time." : "What should I change about that Outlook event?" };
  }
  const preview = [
    `Update “${target.event.subject}” in Outlook Calendar?`,
    ...(typeof input.start === "string" ? [
      `From: ${displayInstant(target.event.start, timeZone)}–${displayInstant(target.event.end, timeZone)}`,
      `To: ${displayInstant(input.start, timeZone)}–${displayInstant(String(input.end), timeZone)}`,
    ] : []),
    ...(typeof input.title === "string" ? [`New title: ${input.title}`] : []),
    ...(Array.isArray(input.attendees) ? [`Attendees: ${input.attendees.join(", ")}`] : []),
    ...(typeof input.location === "string" ? [`Location: ${input.location || "none"}`] : []),
    ...(typeof input.description === "string" ? [`Description: ${input.description.slice(0, 200)}`] : []),
    ...(input.teamsMeeting === true ? ["Add a Microsoft Teams meeting link"] : []),
  ].join("\n");
  return proposeMutation(userId, preview, input, deps);
}

export async function handleOutlookCalendarConversation(
  userId: string,
  text: string | undefined,
  deps: OutlookCalendarConversationDeps = {},
): Promise<OutlookCalendarConversationResult> {
  const value = (text ?? "").trim();
  if (!shouldConsiderOutlookCalendar(value, deps.arbitrated)) return { handled: false };
  try {
    const explicit = explicitCalendarProvider(value);
    const owner = await calendarOwner(userId, value, deps);
    if (explicit === "outlook_calendar" && owner === "none") {
      return { handled: true, reply: "Your Outlook Calendar isn’t available. Reconnect Microsoft 365 in Hula; I won’t silently use Google Calendar instead." };
    }
    if (owner === "google") return { handled: false };
    if (owner === "ambiguous") return { handled: true, reply: "Do you want Google Calendar or Outlook Calendar? Both are connected, and I don’t want to choose the wrong one." };
    if (owner === "none") return { handled: false };

    const timeZone = await (deps.getTimezone ?? getUserTimezone)(userId).catch(() => undefined) ?? "UTC";
    const active = await loadOutlookCalendarEntity(userId, deps);
    const semantic = await (deps.extract ?? extractOutlookCalendarIntent)({
      text: value,
      now: deps.now,
      timeZone,
      hasContext: Boolean(active),
      generate: deps.generateIntent,
    });
    let intent = semantic && semantic.operation !== "not_calendar" ? semantic : explicitOutlookCalendarIntent(value);
    if (intent && explicit === "outlook_calendar") intent = { ...intent, provider: "outlook_calendar" };
    if (!intent || intent.operation === "not_calendar" || intent.provider === "google_calendar" || intent.provider === "not_calendar") {
      return explicit === "outlook_calendar"
        ? { handled: true, reply: "What would you like me to check or change in Outlook Calendar?" }
        : { handled: false };
    }

    if (intent.operation === "create" || intent.operation === "update" || intent.operation === "delete") {
      return handleWrite(userId, value, intent, timeZone, deps);
    }
    if (intent.operation === "list_calendars") {
      const calendars = await (deps.listCalendars ?? listOutlookCalendars)(userId, deps);
      return { handled: true, reply: calendars.length
        ? `Your Outlook calendars:\n${calendars.map((calendar, index) => `${index + 1}. ${calendar.name}${calendar.isDefault ? " — default" : ""}${calendar.canEdit ? "" : " — read-only"}`).join("\n")}`
        : "I couldn’t find any Outlook calendars." };
    }
    if (intent.operation === "list") {
      const range = rangeFor(intent, deps.now ?? new Date(), timeZone);
      if (!range) return { handled: true, reply: "What date range should I check in Outlook Calendar?" };
      const page = await (deps.listEvents ?? listOutlookCalendarEvents)(userId, {
        ...range,
        maxResults: intent.range === "next" ? 1 : intent.count ?? 10,
      }, deps);
      const events = intent.eventQuery
        ? page.events.filter((event) => event.subject.toLowerCase().includes(intent.eventQuery!.toLowerCase()))
        : page.events;
      await recordOutlookCalendarSelection(userId, events, deps);
      return { handled: true, reply: formatOutlookCalendarEvents(events, timeZone, page.hasMore) };
    }
    const target = await resolveTarget(userId, value, intent, deps);
    if (!target.event) return { handled: true, reply: target.reply };
    await recordOutlookCalendarEntity(userId, target.event, deps);
    return { handled: true, reply: intent.operation === "question"
      ? eventAnswer(target.event, intent.question ?? value, timeZone)
      : formatEventDetails(target.event, timeZone) };
  } catch (error) {
    if (error instanceof MicrosoftGraphError) return { handled: true, reply: graphReply(error) };
    logger.error("outlook.calendar conversation failed", { errorCode: "unexpected" });
    return { handled: true, reply: "I couldn’t handle that Outlook Calendar request reliably just now." };
  }
}
