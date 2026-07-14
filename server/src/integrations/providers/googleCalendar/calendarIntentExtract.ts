import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";
import type { TextGenerator } from "./calendarActionExtract";

/**
 * Structured Calendar READ intent extraction (Section 18).
 *
 * The companion to `calendarActionExtract` (which covers writes). This one turns
 * a question into typed slots: a date range to read, a search to run, or an
 * availability check.
 *
 * WHY THIS EXISTS ALONGSIDE THE REGEX CLASSIFIER. `calendarQuestion.ts` already
 * answers the fixed, well-tested shapes ("what's on my calendar today") with
 * pure regex, and that path stays exactly as it was — it is fast, free, and
 * proven. But Section 18 asks for "What am I doing next Tuesday?", "Find my
 * meetings with Rob this month", "Am I free Friday afternoon?" — an open set of
 * dates, topics, people and windows that regex cannot cover without the
 * phrase-by-phrase sprawl the section explicitly rules out. So this runs ONLY
 * for messages the regex path declined, and the regex path keeps priority.
 *
 * The model does not read the calendar and does not decide what is on it. It
 * fills slots. The backend queries Google and answers strictly from what comes
 * back. Its output is untrusted and re-validated here and again downstream.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

const nullableDate = z.string().regex(DATE_RE).nullable().optional();
const nullableTime = z.string().regex(TIME_RE).nullable().optional();
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

/**
 * The read intents Hula supports.
 *  - `schedule`     : "what am I doing next Tuesday", "what's on this week"
 *  - `search`       : "find my meetings with Rob this month", "when's the dentist"
 *  - `availability` : "am I free Friday at 3", "find me a free hour next week"
 *  - `next`         : "what's my next meeting"
 */
export const CalendarReadIntentSchema = z.object({
  intent: z.enum(["schedule", "search", "availability", "next", "not_calendar_read"]),
  /**
   * The FORM of an availability question — the fix for a real device failure.
   *
   *  - `check` : "Am I free Friday afternoon?" / "Do I have a conflict at 10?"
   *              A yes/no question about ONE interval. Answer it directly.
   *  - `find`  : "When am I free Friday afternoon?" / "Find me a free hour"
   *              A request to enumerate open gaps.
   *
   * These are genuinely different questions and were previously conflated,
   * because the code branched only on whether a specific `checkTime` was given.
   * "Am I free Friday afternoon?" has no specific time, so it fell into the
   * slot-finder and answered a completely empty Friday with "Here's when you're
   * free: 12:00 PM–5:00 PM" — which reads as though 12–5 were the user's ONLY
   * free time, when in fact it was just our internal query window echoed back.
   */
  availabilityKind: z.enum(["check", "find"]).nullable().optional(),
  /**
   * True when the user explicitly scoped to the WHOLE day ("am I free all day
   * Friday?"). Kept distinct from an absent daypart: absent means "use the
   * bounded working window", whereas this means "the user asked about the whole
   * day, so query the whole day".
   */
  wholeDay: z.boolean().nullable().optional(),
  /** Inclusive first day to read. */
  dateFrom: nullableDate,
  /** Inclusive last day to read. Equal to `dateFrom` for a single day. */
  dateTo: nullableDate,
  /** Free-text topic/title to search for. */
  query: nullableText(200),
  /** A person named in a search ("meetings with Rob") — name OR address. */
  attendee: nullableText(200),
  /** A location named in a search ("meetings at the office"). */
  location: nullableText(200),
  /**
   * The specific time an availability check asks about ("free at 3?"). Null for
   * an open "when am I free Friday?" search.
   */
  checkTime: nullableTime,
  /** How long the user needs ("a free hour" -> 60). */
  durationMinutes: z.number().int().positive().max(24 * 60).nullable().optional(),
  /**
   * A bounded part of the day the user named: "Friday AFTERNOON" -> 12..17,
   * "morning" -> 9..12. Null means use the default working window.
   */
  windowStartHour: z.number().int().min(0).max(23).nullable().optional(),
  windowEndHour: z.number().int().min(1).max(24).nullable().optional(),
});

export type CalendarReadIntent = z.infer<typeof CalendarReadIntentSchema>;

/** PURE: build the read-extraction system prompt. */
export function buildReadIntentPrompt(
  nowLocalIso: string,
  timezone: string | undefined,
): string {
  const tz = timezone ?? "UTC";
  return [
    "You extract a single calendar QUESTION from one message. You never answer it.",
    `The user's current local date and time is ${nowLocalIso} (timezone: ${tz}).`,
    'Resolve relative dates ("today", "next Tuesday", "this month", "next week") to concrete calendar dates using that current date.',
    "",
    "Respond with ONE JSON object and nothing else. No markdown, no prose. Shape:",
    "{",
    '  "intent": "schedule" | "search" | "availability" | "next" | "not_calendar_read",',
    '  "availabilityKind": "check" | "find" | null, // yes/no question vs. list-the-gaps request',
    '  "wholeDay": boolean | null,       // true if they said "all day"',
    '  "dateFrom": "YYYY-MM-DD" | null,',
    '  "dateTo": "YYYY-MM-DD" | null,',
    '  "query": string | null,           // topic/title to search for',
    '  "attendee": string | null,        // a person named in the search',
    '  "location": string | null,',
    '  "checkTime": "HH:MM" | null,      // the exact time an availability check asks about',
    '  "durationMinutes": number | null, // "a free hour" -> 60',
    '  "windowStartHour": number | null, // "afternoon" -> 12',
    '  "windowEndHour": number | null    // "afternoon" -> 17',
    "}",
    "",
    "Rules:",
    '- "schedule" = asking what is on their calendar over a day or range.',
    '- "search" = looking for particular events by topic, person, or place.',
    '- "availability" = asking whether they are free, when they are free, or if something conflicts.',
    '- For "availability", set "availabilityKind": "check" when it is a YES/NO question ("Am I free Friday afternoon?", "Do I have a conflict at 10?"), and "find" when they want the open gaps listed ("When am I free Friday afternoon?", "Find me a free hour next week").',
    '- Set "wholeDay": true only if they scoped it to the whole day ("am I free all day Friday?"). Leave windowStartHour/windowEndHour null in that case.',
    '- "next" = asking about their single next upcoming event.',
    '- If the message is not about reading their calendar, return {"intent":"not_calendar_read"} with all other fields null.',
    '- A request to CREATE, MOVE, or CANCEL an event is NOT a read: return "not_calendar_read".',
    "- Use 24-hour HH:MM (3pm -> 15:00).",
    '- For a single day, set dateFrom and dateTo to the SAME date.',
    '- "morning" -> windowStartHour 9, windowEndHour 12. "afternoon" -> 12 and 17. "evening" -> 17 and 21.',
    "- Never invent a date the message does not imply. Leave it null.",
  ].join("\n");
}

/** PURE: parse a raw model reply into a validated read intent, or null. */
export function parseCalendarReadIntent(raw: string): CalendarReadIntent | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = CalendarReadIntentSchema.safeParse(parsed);
  if (!result.success) return null;

  // A window that isn't a real window is worse than no window: it would silently
  // produce zero free slots and read as "you're fully booked".
  const data = result.data;
  if (
    data.windowStartHour !== null &&
    data.windowStartHour !== undefined &&
    data.windowEndHour !== null &&
    data.windowEndHour !== undefined &&
    data.windowEndHour <= data.windowStartHour
  ) {
    return { ...data, windowStartHour: null, windowEndHour: null };
  }
  return data;
}

/**
 * Extract a structured calendar read intent via the model. Returns null when the
 * model is unavailable, errors, or returns something invalid — the caller treats
 * null as "couldn't extract" and falls through unchanged.
 */
export async function extractCalendarReadIntent(params: {
  text: string;
  nowLocalIso: string;
  timezone: string | undefined;
  generate?: TextGenerator;
}): Promise<CalendarReadIntent | null> {
  const generate = params.generate ?? generateAnthropicText;
  const system = buildReadIntentPrompt(params.nowLocalIso, params.timezone);
  try {
    const reply = await generate({
      system,
      messages: [{ role: "user", content: params.text }],
      maxTokens: 400,
    });
    return parseCalendarReadIntent(reply);
  } catch {
    return null;
  }
}
