import {
  createActionProposal,
  listRecentProposalsByAction,
  type ActionProposalView,
  type CreateProposalInput,
} from "../../../actions/proposals";
import type { OutlookCalendarEvent } from "./calendarTypes";

export const OUTLOOK_CALENDAR_SELECTION_ACTION_ID = "microsoft.calendar.lastSelection" as const;
export const OUTLOOK_CALENDAR_ENTITY_ACTION_ID = "microsoft.calendar.entityContext" as const;
export const OUTLOOK_CALENDAR_SELECTION_TTL_MS = 30 * 60 * 1_000;
export const OUTLOOK_CALENDAR_ENTITY_TTL_MS = 2 * 60 * 60 * 1_000;

export interface OutlookCalendarEventRef {
  provider: "microsoft";
  service: "outlook_calendar";
  calendarId: string | null;
  eventId: string;
  seriesMasterId: string | null;
  subject: string;
  start: string | null;
  end: string | null;
  timeZone: string | null;
  isAllDay: boolean;
  teamsJoinUrl: string | null;
}

export interface OutlookCalendarContextStore {
  create?: (userId: string, input: CreateProposalInput) => Promise<{ id: string }>;
  listRecent?: (userId: string, actionId: string, limit?: number) => Promise<ActionProposalView[]>;
  now?: Date;
}

export function toOutlookCalendarEventRef(event: OutlookCalendarEvent): OutlookCalendarEventRef {
  return {
    provider: "microsoft",
    service: "outlook_calendar",
    calendarId: event.calendarId,
    eventId: event.id,
    seriesMasterId: event.seriesMasterId,
    subject: event.subject,
    start: event.start,
    end: event.end,
    timeZone: event.timeZone,
    isAllDay: event.isAllDay,
    teamsJoinUrl: event.teamsJoinUrl,
  };
}

function parseRef(value: unknown): OutlookCalendarEventRef | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.provider !== "microsoft" || raw.service !== "outlook_calendar" || typeof raw.eventId !== "string" || !raw.eventId) return null;
  return {
    provider: "microsoft",
    service: "outlook_calendar",
    calendarId: typeof raw.calendarId === "string" ? raw.calendarId : null,
    eventId: raw.eventId,
    seriesMasterId: typeof raw.seriesMasterId === "string" ? raw.seriesMasterId : null,
    subject: typeof raw.subject === "string" ? raw.subject : "(Untitled event)",
    start: typeof raw.start === "string" ? raw.start : null,
    end: typeof raw.end === "string" ? raw.end : null,
    timeZone: typeof raw.timeZone === "string" ? raw.timeZone : null,
    isAllDay: raw.isAllDay === true,
    teamsJoinUrl: typeof raw.teamsJoinUrl === "string" ? raw.teamsJoinUrl : null,
  };
}

function isLive(row: ActionProposalView, now: Date): boolean {
  return Date.parse(row.expiresAt) > now.getTime();
}

export async function recordOutlookCalendarSelection(
  userId: string,
  events: OutlookCalendarEvent[],
  store: OutlookCalendarContextStore = {},
): Promise<void> {
  await (store.create ?? createActionProposal)(userId, {
    provider: "microsoft",
    actionId: OUTLOOK_CALENDAR_SELECTION_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: {
      kind: "outlook_calendar_selection",
      items: events.slice(0, 20).map(toOutlookCalendarEventRef),
      contextEstablishedAt: (store.now ?? new Date()).getTime(),
    },
    previewText: `Showed ${Math.min(events.length, 20)} Outlook calendar events.`,
    ttlMs: OUTLOOK_CALENDAR_SELECTION_TTL_MS,
  });
}

export async function recordOutlookCalendarEntity(
  userId: string,
  event: OutlookCalendarEvent,
  store: OutlookCalendarContextStore = {},
): Promise<void> {
  await (store.create ?? createActionProposal)(userId, {
    provider: "microsoft",
    actionId: OUTLOOK_CALENDAR_ENTITY_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: {
      kind: "outlook_calendar_entity",
      ref: toOutlookCalendarEventRef(event),
      snapshot: event,
      contextEstablishedAt: (store.now ?? new Date()).getTime(),
    },
    previewText: "Selected an Outlook calendar event.",
    ttlMs: OUTLOOK_CALENDAR_ENTITY_TTL_MS,
  });
}

export async function loadOutlookCalendarSelection(
  userId: string,
  store: OutlookCalendarContextStore = {},
): Promise<OutlookCalendarEventRef[]> {
  const rows = await (store.listRecent ?? listRecentProposalsByAction)(userId, OUTLOOK_CALENDAR_SELECTION_ACTION_ID, 100);
  const now = store.now ?? new Date();
  for (const row of rows) {
    if (!isLive(row, now) || row.input?.kind !== "outlook_calendar_selection" || !Array.isArray(row.input.items)) continue;
    const refs = row.input.items.flatMap((item) => parseRef(item) ?? []);
    if (refs.length) return refs;
  }
  return [];
}

export async function loadOutlookCalendarEntity(
  userId: string,
  store: OutlookCalendarContextStore = {},
): Promise<{ ref: OutlookCalendarEventRef; event: OutlookCalendarEvent | null } | null> {
  const rows = await (store.listRecent ?? listRecentProposalsByAction)(userId, OUTLOOK_CALENDAR_ENTITY_ACTION_ID, 100);
  const now = store.now ?? new Date();
  for (const row of rows) {
    if (!isLive(row, now) || row.input?.kind !== "outlook_calendar_entity") continue;
    const ref = parseRef(row.input.ref);
    if (!ref) continue;
    const snapshot = row.input.snapshot && typeof row.input.snapshot === "object"
      ? row.input.snapshot as unknown as OutlookCalendarEvent
      : null;
    return { ref, event: snapshot?.id === ref.eventId ? snapshot : null };
  }
  return null;
}

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

export function parseOutlookCalendarOrdinal(text: string): number | null {
  const lower = text.toLowerCase();
  const word = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/.exec(lower);
  if (word) return ORDINALS[word[1]!] ?? null;
  const numeric = /\b(?:number\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/.exec(lower);
  if (!numeric) return null;
  const result = Number(numeric[1]);
  return result >= 1 && result <= 20 ? result : null;
}

export async function resolveOutlookCalendarReference(
  userId: string,
  text: string,
  ordinal: number | null | undefined,
  store: OutlookCalendarContextStore = {},
): Promise<OutlookCalendarEventRef | null> {
  const position = ordinal ?? parseOutlookCalendarOrdinal(text);
  if (position) return (await loadOutlookCalendarSelection(userId, store))[position - 1] ?? null;
  return (await loadOutlookCalendarEntity(userId, store))?.ref ?? null;
}
