import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";

/**
 * Structured Calendar-write extraction (Section 15).
 *
 * The model NEVER calls Google. Its ONLY job here is to turn one natural-language
 * message into a small, strictly-validated JSON intent. The deterministic backend
 * (`calendarActions.ts`) then validates every field again, resolves the real
 * event, and performs the write. The model resolves relative dates ("tomorrow",
 * "Friday") against the current local date/time we pass it, and emits LOCAL
 * wall-clock fields — the backend converts them to absolute times with the user's
 * timezone using the same tested machinery the reminders use.
 *
 * PURE prompt building + Zod validation live here (fully unit-testable); the one
 * network call is injectable so tests never hit Anthropic.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

const nullableDate = z.string().regex(DATE_RE).nullable().optional();
const nullableTime = z.string().regex(TIME_RE).nullable().optional();
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const nullableDuration = z.number().int().positive().max(24 * 60).nullable().optional();

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
    "Resolve relative dates like \"today\", \"tomorrow\", \"Friday\", \"next Tuesday\" to a concrete calendar date using that current date.",
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
    '  "newLocation": string | null',
    "}",
    "",
    "Rules:",
    "- If the message is NOT a request to create, move/reschedule/rename, or delete a calendar event, return {\"action\":\"not_calendar_write\"} with all other fields null.",
    "- Use 24-hour HH:MM for every time (1pm -> 13:00).",
    "- Never invent a date or time that the message does not imply. Leave it null instead.",
    "- For a move/reschedule, put the ORIGINAL date in \"date\" and the NEW time/date in \"newTime\"/\"newDate\".",
    "- Keep titles short and human (e.g. \"Lunch with Adam\").",
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
      maxTokens: 400,
    });
    return parseCalendarAction(reply);
  } catch {
    return null;
  }
}
