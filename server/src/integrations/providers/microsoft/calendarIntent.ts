import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";
import {
  structuredBoolean,
  structuredInteger,
  structuredJsonObjectCandidates,
  structuredRecord,
  structuredStringList,
  structuredToken,
} from "../../../ai/structuredJson";

const OUTLOOK_CALENDAR_INTENT_ATTEMPTS = 2;

export const OutlookCalendarIntentSchema = z.object({
  provider: z.enum(["outlook_calendar", "google_calendar", "unknown", "not_calendar"]),
  operation: z.enum(["list_calendars", "list", "get", "question", "create", "update", "delete", "not_calendar"]),
  range: z.enum(["today", "tomorrow", "week", "next", "custom"]).nullable().optional(),
  rangeStart: z.string().max(100).nullable().optional(),
  rangeEnd: z.string().max(100).nullable().optional(),
  ordinal: z.number().int().min(1).max(20).nullable().optional(),
  title: z.string().trim().min(1).max(998).nullable().optional(),
  eventQuery: z.string().trim().min(1).max(300).nullable().optional(),
  start: z.string().max(100).nullable().optional(),
  end: z.string().max(100).nullable().optional(),
  relativeStartMinutes: z.number().int().min(-10_080).max(10_080).nullable().optional(),
  timeZone: z.string().max(100).nullable().optional(),
  attendees: z.array(z.string().email()).max(50).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  description: z.string().max(5_000).nullable().optional(),
  teamsMeeting: z.boolean().nullable().optional(),
  question: z.string().max(1_000).nullable().optional(),
  count: z.number().int().min(1).max(20).nullable().optional(),
});

export type OutlookCalendarIntent = z.infer<typeof OutlookCalendarIntentSchema>;
export type OutlookCalendarIntentGenerator = typeof generateAnthropicText;

const calendarOperationAliases: Record<string, OutlookCalendarIntent["operation"]> = {
  calendars: "list_calendars",
  list_events: "list",
  upcoming: "list",
  details: "get",
  open: "get",
  create_event: "create",
  schedule: "create",
  schedule_event: "create",
  edit: "update",
  edit_event: "update",
  reschedule: "update",
  move: "update",
  cancel: "delete",
  cancel_event: "delete",
  remove_event: "delete",
};

function normalizeCalendarCandidate(candidate: unknown): Record<string, unknown> | null {
  const value = structuredRecord(candidate);
  if (!value) return null;
  const operationToken = structuredToken(value.operation ?? value.action ?? value.intent);
  const operation = operationToken && OutlookCalendarIntentSchema.shape.operation.safeParse(operationToken).success
    ? operationToken as OutlookCalendarIntent["operation"]
    : operationToken ? calendarOperationAliases[operationToken] : null;
  if (!operation) return null;
  const providerToken = structuredToken(value.provider ?? value.service);
  const provider = providerToken && OutlookCalendarIntentSchema.shape.provider.safeParse(providerToken).success
    ? providerToken
    : providerToken && ["outlook", "microsoft", "microsoft_365", "office_365"].includes(providerToken)
      ? "outlook_calendar"
      : "unknown";
  return {
    ...value,
    provider,
    operation,
    ordinal: structuredInteger(value.ordinal, 1, 20) ?? value.ordinal,
    count: structuredInteger(value.count, 1, 20) ?? value.count,
    relativeStartMinutes: structuredInteger(
      value.relativeStartMinutes ?? value.relativeMinutes ?? value.shiftMinutes ?? value.deltaMinutes,
      -10_080,
      10_080,
    ) ?? value.relativeStartMinutes,
    attendees: structuredStringList(value.attendees ?? value.attendee),
    teamsMeeting: structuredBoolean(value.teamsMeeting ?? value.isOnlineMeeting) ?? value.teamsMeeting,
    timeZone: value.timeZone ?? value.timezone ?? null,
  };
}

export function explicitCalendarProvider(text: string): "outlook_calendar" | "google_calendar" | null {
  if (/\b(?:outlook|microsoft(?:\s*365)?|office\s*365)\s+(?:calendar|meeting|event)s?\b|\bteams\s+(?:meeting|call)\b/i.test(text)) return "outlook_calendar";
  if (/\bgoogle\s+calendar\b|\bgoogle\s+meet\b/i.test(text)) return "google_calendar";
  return null;
}

export function shouldConsiderOutlookCalendar(text: string, arbitrated = false): boolean {
  if (!text.trim()) return false;
  if (arbitrated) return true;
  if (explicitCalendarProvider(text)) return true;
  return /\b(?:calendar|meetings?|events?|attendees?|organizer|teams\s+(?:call|link))\b/i.test(text)
    || /\bwhat(?:'s| is| have i got)\b[^.!?]{0,80}\b(?:today|tomorrow|this week|next week)\b/i.test(text)
    || /\banything\s+on\b[^.!?]{0,80}\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text);
}

export function buildOutlookCalendarIntentPrompt(input: { now: Date; timeZone: string; hasContext: boolean }): string {
  return [
    "Extract one calendar intent for Hula. Return strict JSON only; do not answer or execute.",
    `Current instant: ${input.now.toISOString()}. User timezone: ${input.timeZone}.`,
    `Fresh selected Outlook event context: ${input.hasContext}.`,
    "Use outlook_calendar for explicit Outlook/Microsoft/Office 365 calendar language, Teams meeting creation, or supplied Outlook event context.",
    "Use google_calendar only when Google Calendar or Google Meet is explicit. Generic calendar language stays unknown; deterministic code chooses only a sole capable provider or asks.",
    "Resolve relative dates and wall-clock times into absolute ISO instants using the user timezone. Preserve that IANA timezone in timeZone.",
    "list handles today/tomorrow/week/custom ranges. get opens an ordinal or named event. question asks about the selected event.",
    "create/update/delete are consequential and will be confirmed by deterministic code. Never invent attendees; include only exact email addresses supplied by the user.",
    "attendees MUST be a JSON array of exact email-address strings, even when there is only one attendee.",
    "For a create without an explicit end, use one hour after start.",
    "For a relative update, return relativeStartMinutes as a signed integer and do not invent absolute times. Later/delay/push back is positive; earlier/bring forward is negative. Deterministic code applies it to authoritative event times and preserves duration.",
    "For an absolute move such as 'move it to 4pm', return start as an absolute ISO instant and omit relativeStartMinutes.",
    "teamsMeeting is true only when the user explicitly requests a Teams meeting/call/link. It does not imply Teams chat or messaging.",
    "Mail, files, Slack, tasks, Notion, Asana, reminders, and memory are not_calendar.",
    JSON.stringify({
      provider: "outlook_calendar|google_calendar|unknown|not_calendar",
      operation: "list_calendars|list|get|question|create|update|delete|not_calendar",
      range: "today|tomorrow|week|next|custom|null",
      rangeStart: null,
      rangeEnd: null,
      ordinal: null,
      title: null,
      eventQuery: null,
      start: null,
      end: null,
      relativeStartMinutes: null,
      timeZone: input.timeZone,
      attendees: null,
      location: null,
      description: null,
      teamsMeeting: null,
      question: null,
      count: 10,
    }),
  ].join("\n");
}

export function parseOutlookCalendarIntent(raw: string): OutlookCalendarIntent | null {
  for (const candidate of structuredJsonObjectCandidates(raw)) {
    const parsed = OutlookCalendarIntentSchema.safeParse(normalizeCalendarCandidate(candidate));
    if (parsed.success) return parsed.data;
  }
  return null;
}

export async function extractOutlookCalendarIntent(input: {
  text: string;
  now?: Date;
  timeZone?: string;
  hasContext?: boolean;
  generate?: OutlookCalendarIntentGenerator;
}): Promise<OutlookCalendarIntent | null> {
  const generate = input.generate ?? generateAnthropicText;
  const system = buildOutlookCalendarIntentPrompt({
    now: input.now ?? new Date(),
    timeZone: input.timeZone ?? "UTC",
    hasContext: input.hasContext === true,
  });
  let messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: input.text }];
  for (let attempt = 0; attempt < OUTLOOK_CALENDAR_INTENT_ATTEMPTS; attempt += 1) {
    try {
      const raw = await generate({ system, messages, maxTokens: 900, timeoutMs: 12_000 });
      const parsed = parseOutlookCalendarIntent(raw);
      if (parsed) return parsed;
      messages = [
        { role: "user", content: input.text },
        { role: "assistant", content: raw.slice(0, 10_000) },
        { role: "user", content: "Repair only the JSON representation. Preserve the same operation and user-supplied values. Attendees must be an array. Never invent a time, attendee, mutation, or Teams request." },
      ];
    } catch {
      // Intent extraction is read-only; one bounded retry is safe.
    }
  }
  return null;
}

export function explicitOutlookCalendarIntent(text: string): OutlookCalendarIntent | null {
  if (explicitCalendarProvider(text) !== "outlook_calendar") return null;
  const lower = text.toLowerCase();
  if (/\b(?:create|schedule|book|add|move|reschedule|push|change|update|edit|cancel|delete|remove|invite|make)\b/.test(lower)) return null;
  const ordinal = /\b(first|1st)\b/.test(lower) ? 1
    : /\b(second|2nd)\b/.test(lower) ? 2
      : /\b(third|3rd)\b/.test(lower) ? 3 : null;
  if (/\blist\b[^.!?]*\bcalendars?\b|\bwhich\s+calendars?\b/.test(lower)) {
    return OutlookCalendarIntentSchema.parse({ provider: "outlook_calendar", operation: "list_calendars" });
  }
  if (ordinal && /\b(?:open|show|view|details?)\b/.test(lower)) {
    return OutlookCalendarIntentSchema.parse({ provider: "outlook_calendar", operation: "get", ordinal });
  }
  const range = /\btomorrow\b/.test(lower) ? "tomorrow"
    : /\b(?:next|this)\s+week\b/.test(lower) ? "week"
      : /\bnext\s+(?:meeting|event)\b/.test(lower) ? "next" : "today";
  if (/\b(?:calendar|meetings?|events?|schedule)\b/.test(lower)) {
    return OutlookCalendarIntentSchema.parse({ provider: "outlook_calendar", operation: "list", range, count: 10 });
  }
  return null;
}
