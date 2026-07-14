import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";

/**
 * Structured Calendar-write extraction (Sections 15 + 18).
 *
 * The model NEVER calls Google. Its ONLY job here is to turn one natural-language
 * message into a small, strictly-validated JSON intent. The deterministic backend
 * (`calendarActions.ts`) then validates every field again, resolves the real
 * event, and performs the write. The model resolves relative dates ("tomorrow",
 * "Friday") against the current local date/time we pass it, and emits LOCAL
 * wall-clock fields — the backend converts them to absolute times with the user's
 * timezone using the same tested machinery the reminders use.
 *
 * WHY A MODEL AND NOT MORE REGEX. Section 18 asks for "move it back thirty
 * minutes", "add Rob and change the location to the office", "make it a Google
 * Meet". Matching those phrase-by-phrase means an ever-growing pattern list that
 * is wrong in a new way for every user who phrases it differently. The model is
 * good at exactly this — mapping loose language onto fixed fields — and bad at
 * exactly what it is not allowed to do here: deciding what is true, or acting.
 * So it interprets language into typed slots and nothing else. The typed slots
 * are then treated as UNTRUSTED input and re-validated below and again in the
 * backend.
 *
 * PURE prompt building + Zod validation live here (fully unit-testable); the one
 * network call is injectable so tests never hit Anthropic.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
/**
 * A pragmatic address shape. This is a FORMAT check, not a claim the address is
 * real or belongs to who the user named — the backend still refuses to invent an
 * address, and only ever uses one the user actually typed.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const nullableDate = z.string().regex(DATE_RE).nullable().optional();
const nullableTime = z.string().regex(TIME_RE).nullable().optional();
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const nullableDuration = z.number().int().positive().max(24 * 60).nullable().optional();
const emailList = z
  .array(z.string().trim().regex(EMAIL_RE))
  .max(20)
  .nullable()
  .optional();
const nameList = z.array(z.string().trim().min(1).max(100)).max(20).nullable().optional();

/**
 * Which occurrences of a recurring event a write applies to. Google models these
 * as genuinely different operations, and guessing wrong is destructive — so the
 * model may report what the user SAID, and `null` means they didn't say, which
 * makes the backend ask rather than assume.
 */
export const RecurrenceScopeSchema = z
  .enum(["this_event", "this_and_following", "entire_series"])
  .nullable()
  .optional();

export type RecurrenceScope = "this_event" | "this_and_following" | "entire_series";

/**
 * The validated shape the model must produce. Every field is optional/nullable
 * except `action`; the backend decides which fields are REQUIRED per action and
 * asks for clarification when something essential is missing.
 */
export const CalendarActionSchema = z.object({
  action: z.enum(["create", "update", "delete", "not_calendar_write"]),
  /** Event title (create) or the title to search for (update/delete). */
  title: nullableText(300),
  /** New title when renaming (update only). */
  newTitle: nullableText(300),
  /** Event date (create) or target date to search (update/delete). */
  date: nullableDate,
  /** Start time (create) or disambiguating time (update/delete). 24h HH:MM. */
  time: nullableTime,
  /** Duration in minutes (create/update). */
  durationMinutes: nullableDuration,
  location: nullableText(500),
  description: nullableText(2000),
  /** New date/time when rescheduling (update only). */
  newDate: nullableDate,
  newTime: nullableTime,
  newLocation: nullableText(500),
  newDescription: nullableText(2000),
  /** New length when the user changes duration without moving the start. */
  newDurationMinutes: nullableDuration,
  /**
   * A relative reschedule in minutes: "move it back 30 minutes" → -30, "push it
   * an hour later" → +60. Kept SEPARATE from `newTime` because it means
   * something different — it can only be applied against the event's real
   * current start, which only the backend knows after resolving the event.
   */
  shiftMinutes: z.number().int().min(-1440).max(1440).nullable().optional(),
  /** True when the user asked for an all-day event. */
  allDay: z.boolean().nullable().optional(),
  /** True when the user asked for a Google Meet / video link. */
  addMeet: z.boolean().nullable().optional(),
  /** Attendee EMAIL ADDRESSES the user actually typed. Never invented. */
  attendees: emailList,
  /**
   * Bare NAMES the user mentioned with no address ("book an hour with Sarah").
   * Reported separately and never treated as addresses — the backend asks for
   * the address rather than guessing one, because a guessed invite goes to a
   * real stranger's inbox and cannot be recalled.
   */
  attendeeNames: nameList,
  /** Attendee addresses to REMOVE from the event. */
  removeAttendees: emailList,
  /** Reminder minutes-before, when the user asked for one. */
  reminderMinutes: z.number().int().min(0).max(40320).nullable().optional(),
  /** The recurrence scope the user EXPLICITLY stated, else null. */
  recurrenceScope: RecurrenceScopeSchema,
  /**
   * True when the message refers to an event by context rather than by name
   * ("move IT to Friday", "cancel THAT", "the meeting you just created") — the
   * backend resolves that against stored conversation context.
   */
  refersToContext: z.boolean().nullable().optional(),
});

export type CalendarAction = z.infer<typeof CalendarActionSchema>;

/**
 * PURE: build the extraction system prompt. Gives the model the current local
 * date/time and timezone so it can resolve relative dates, and pins the output
 * to strict JSON matching `CalendarActionSchema`.
 */
export function buildExtractionPrompt(nowLocalIso: string, timezone: string | undefined): string {
  const tz = timezone ?? "UTC";
  return [
    "You extract a single calendar command from one message.",
    `The user's current local date and time is ${nowLocalIso} (timezone: ${tz}).`,
    'Resolve relative dates like "today", "tomorrow", "Friday", "next Tuesday" to a concrete calendar date using that current date.',
    "",
    "Respond with ONE JSON object and nothing else. No markdown, no prose. Shape:",
    "{",
    '  "action": "create" | "update" | "delete" | "not_calendar_write",',
    '  "title": string | null,          // event title, or the title to find for update/delete',
    '  "newTitle": string | null,       // new title when renaming (update)',
    '  "date": "YYYY-MM-DD" | null,      // event date (create) or the date to search (update/delete)',
    '  "time": "HH:MM" | null,           // 24-hour start time (create) or disambiguating time (update/delete)',
    '  "durationMinutes": number | null, // event length in minutes',
    '  "location": string | null,',
    '  "description": string | null,',
    '  "newDate": "YYYY-MM-DD" | null,   // when rescheduling (update)',
    '  "newTime": "HH:MM" | null,        // when rescheduling (update)',
    '  "newLocation": string | null,',
    '  "newDescription": string | null,',
    '  "newDurationMinutes": number | null, // when only the length changes',
    '  "shiftMinutes": number | null,    // relative move: "back 30 minutes" -> -30, "an hour later" -> 60',
    '  "allDay": boolean | null,         // true for an all-day event',
    '  "addMeet": boolean | null,        // true if they asked for a Google Meet / video call link',
    '  "attendees": string[] | null,     // ONLY real email addresses written in the message',
    '  "attendeeNames": string[] | null, // bare names with no address ("with Sarah")',
    '  "removeAttendees": string[] | null,',
    '  "reminderMinutes": number | null, // "remind me 15 minutes before" -> 15',
    '  "recurrenceScope": "this_event" | "this_and_following" | "entire_series" | null,',
    '  "refersToContext": boolean | null',
    "}",
    "",
    "Rules:",
    '- If the message is NOT a request to create, move/reschedule/rename, or delete a calendar event, return {"action":"not_calendar_write"} with all other fields null.',
    "- Use 24-hour HH:MM for every time (1pm -> 13:00).",
    "- Never invent a date or time that the message does not imply. Leave it null instead.",
    '- For a move/reschedule, put the ORIGINAL date in "date" and the NEW time/date in "newTime"/"newDate".',
    '- Keep titles short and human (e.g. "Lunch with Adam").',
    // The single most consequential rule in this prompt. A fabricated address
    // emails a real person who never asked to be invited.
    '- NEVER invent, guess, or complete an email address. Put an address in "attendees" ONLY if it is written out in the message. If the user names a person without an address, put the bare name in "attendeeNames".',
    '- Set "refersToContext": true when the message points at an event without naming it ("move it to Friday", "cancel that", "the meeting you just created", "the second one").',
    '- Set "recurrenceScope" ONLY if the user actually said which occurrences they mean ("just this one", "all of them"). Otherwise null.',
    '- "make it a Google Meet" / "add a video link" is an update with "addMeet": true.',
  ].join("\n");
}

/**
 * PURE: parse a raw model reply into a validated `CalendarAction`, or null.
 * Tolerates a stray ```json fence and leading/trailing prose by extracting the
 * first {...} block. Anything that doesn't match the schema returns null so the
 * caller never acts on malformed output.
 */
export function parseCalendarAction(raw: string): CalendarAction | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  // Pull out the first JSON object if the model wrapped it in prose/fences.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonSlice = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return null;
  }
  const result = CalendarActionSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** The generator dependency, injectable so tests never hit the network. */
export type TextGenerator = (params: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}) => Promise<string>;

/**
 * Extract a structured calendar action from a message via the model. Returns a
 * validated `CalendarAction`, or null when the model is unavailable, errors, or
 * returns something invalid — the caller treats null as "couldn't extract".
 * `generate` is injectable for tests; production uses the real Anthropic client.
 */
export async function extractCalendarAction(params: {
  text: string;
  nowLocalIso: string;
  timezone: string | undefined;
  generate?: TextGenerator;
}): Promise<CalendarAction | null> {
  const generate = params.generate ?? generateAnthropicText;
  const system = buildExtractionPrompt(params.nowLocalIso, params.timezone);
  try {
    const reply = await generate({
      system,
      messages: [{ role: "user", content: params.text }],
      maxTokens: 500,
    });
    return parseCalendarAction(reply);
  } catch {
    return null;
  }
}
