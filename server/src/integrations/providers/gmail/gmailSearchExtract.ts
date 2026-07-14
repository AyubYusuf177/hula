import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";

/**
 * Structured Gmail-search extraction (Section 17).
 *
 * The model NEVER calls Gmail and NEVER writes a Gmail query. Its only job is to
 * turn one natural-language message into a small, strictly-validated JSON intent;
 * `gmailSearch.buildGmailQuery` is the sole place a real query string is built,
 * from typed fields it validates again. That split is deliberate: if the model
 * emitted query text, a hallucinated `OR from:...` would become a real search the
 * user never asked for.
 *
 * PURE prompt building + Zod validation live here (fully unit-testable); the one
 * network call is injectable so tests never hit Anthropic.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const nullableDate = z.string().regex(DATE_RE).nullable().optional();
const nullableText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().optional();
const nullableBool = z.boolean().nullable().optional();

/**
 * The validated shape the model must produce. Enums are closed sets — anything
 * outside them fails the parse rather than being passed through.
 */
export const GmailSearchIntentSchema = z.object({
  action: z.enum(["search", "not_email_search"]),
  from: nullableText(200),
  to: nullableText(200),
  subject: nullableText(200),
  keywords: nullableText(200),
  unread: nullableBool,
  starred: nullableBool,
  hasAttachment: nullableBool,
  after: nullableDate,
  before: nullableDate,
  newerThanDays: z.number().int().min(1).max(365).nullable().optional(),
  /**
   * How many the user actually asked for ("my 5 most recent emails"). Null when
   * they didn't say — the backend then uses its own default and never invents a
   * count or advertises one.
   */
  limit: z.number().int().min(1).max(10).nullable().optional(),
  scope: z.enum(["inbox", "sent", "drafts", "anywhere"]).nullable().optional(),
  category: z
    .enum(["personal", "social", "promotions", "updates", "forums"])
    .nullable()
    .optional(),
  label: nullableText(100),
});

export type GmailSearchIntent = z.infer<typeof GmailSearchIntentSchema>;

/**
 * PURE: build the extraction system prompt. Gives the model today's local date so
 * it can resolve "last week" / "yesterday" into concrete bounds, and pins output to
 * strict JSON matching `GmailSearchIntentSchema`.
 */
export function buildSearchExtractionPrompt(
  todayLocal: string,
  timezone: string | undefined,
): string {
  const tz = timezone ?? "UTC";
  return [
    "You extract a single email-search request from one message.",
    `The user's current local date is ${todayLocal} (timezone: ${tz}).`,
    'Resolve relative dates like "today", "yesterday", "last week", "this month" into concrete bounds using that date.',
    "",
    "Respond with ONE JSON object and nothing else. No markdown, no prose. Shape:",
    "{",
    '  "action": "search" | "not_email_search",',
    '  "from": string | null,            // sender name or email address',
    '  "to": string | null,              // recipient name or email address',
    '  "subject": string | null,         // words expected in the subject line',
    '  "keywords": string | null,        // words to match anywhere in the email',
    '  "unread": boolean | null,',
    '  "starred": boolean | null,',
    '  "hasAttachment": boolean | null,',
    '  "after": "YYYY-MM-DD" | null,     // inclusive earliest date',
    '  "before": "YYYY-MM-DD" | null,    // exclusive latest date',
    '  "newerThanDays": number | null,   // relative window, 1-365',
    '  "limit": number | null,           // how many they asked for, 1-10 ("my 5 most recent" -> 5)',
    '  "scope": "inbox" | "sent" | "drafts" | "anywhere" | null,',
    '  "category": "personal" | "social" | "promotions" | "updates" | "forums" | null,',
    '  "label": string | null            // an existing Gmail label name',
    "}",
    "",
    "Rules:",
    '- If the message is NOT a request to find/search/show emails, return {"action":"not_email_search"} with all other fields null.',
    "- Never invent a sender, subject, date, or label the message does not imply. Leave it null.",
    '- Set "limit" ONLY to a number the user actually stated ("show me 5 emails" -> 5). If they gave no number, leave it null.',
    '- "Emails I sent to X" -> scope "sent" with to: "X". "Emails from X" -> from: "X".',
    '- Prefer "newerThanDays" for vague recency ("recently", "lately"); use after/before for explicit ranges.',
    "- Put a person's name in \"from\"/\"to\" as written; do NOT guess their email address.",
    '- Do NOT put search operators (OR, from:, is:) in any field. Fields are plain values only.',
    '- A request to READ or SUMMARISE a specific email is still a search — extract what identifies it.',
  ].join("\n");
}

/**
 * PURE: parse a raw model reply into a validated `GmailSearchIntent`, or null.
 * Tolerates a stray ```json fence and surrounding prose by extracting the first
 * {...} block. Anything off-schema returns null so the caller never acts on
 * malformed output.
 */
export function parseGmailSearchIntent(raw: string): GmailSearchIntent | null {
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
  const result = GmailSearchIntentSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** The generator dependency, injectable so tests never hit the network. */
export type TextGenerator = (params: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}) => Promise<string>;

/**
 * Extract a structured Gmail search intent from a message via the model. Returns
 * null when the model is unavailable, errors, or returns something invalid — the
 * caller treats null as "couldn't extract" and falls through rather than guessing.
 */
export async function extractGmailSearchIntent(params: {
  text: string;
  todayLocal: string;
  timezone: string | undefined;
  generate?: TextGenerator;
}): Promise<GmailSearchIntent | null> {
  const generate = params.generate ?? generateAnthropicText;
  const system = buildSearchExtractionPrompt(params.todayLocal, params.timezone);
  try {
    const reply = await generate({
      system,
      messages: [{ role: "user", content: params.text }],
      maxTokens: 400,
    });
    return parseGmailSearchIntent(reply);
  } catch {
    return null;
  }
}
