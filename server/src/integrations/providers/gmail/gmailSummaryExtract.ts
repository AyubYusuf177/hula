import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";

/**
 * Structured Gmail SUMMARY extraction (Section 17 / Phase 3.2 completion).
 *
 * Phase 3.2 shipped only single-email summaries reachable by naming a sender
 * ("summarise Rob's latest email"). Everything a real conversation actually uses —
 * "summarise them", "which of these need my attention?", "give me a quick inbox
 * overview" — matched no prefilter and reached the generic model, which has no inbox
 * access and could only guess.
 *
 * The model names a SCOPE; it never picks message ids and never calls Gmail.
 */

const nullableText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().optional();

export const GmailSummaryIntentSchema = z.object({
  /**
   * `summarize` — describe what the emails say.
   * `triage`    — which need a reply / my attention.
   */
  action: z.enum(["summarize", "triage", "not_summary"]),
  /** True for "them"/"these"/"those" — the list Hula just showed. */
  useLastResults: z.boolean().nullable().optional(),
  /** 1-based position for "summarise the second one". */
  ordinal: z.number().int().min(1).max(20).nullable().optional(),
  /** A named sender ("what does Robert want from me?"). */
  senderName: nullableText(200),
  /** How many to cover, when stated ("summarise my 5 most recent emails"). */
  limit: z.number().int().min(1).max(5).nullable().optional(),
  unreadOnly: z.boolean().nullable().optional(),
  todayOnly: z.boolean().nullable().optional(),
});

export type GmailSummaryIntent = z.infer<typeof GmailSummaryIntentSchema>;

/** PURE: build the extraction system prompt. */
export function buildSummaryIntentPrompt(todayLocal: string, timezone: string | undefined): string {
  return [
    "You extract a single EMAIL SUMMARY request from one message, for an assistant with access to the user's inbox.",
    `The user's current local date is ${todayLocal} (timezone: ${timezone ?? "UTC"}).`,
    "",
    "Respond with ONE JSON object and nothing else. No markdown, no prose. Shape:",
    "{",
    '  "action": "summarize" | "triage" | "not_summary",',
    '  "useLastResults": boolean | null,  // true for "them" / "these" / "those"',
    '  "ordinal": number | null,          // 1-based, for "the second one"',
    '  "senderName": string | null,       // e.g. "Robert" for "what does Robert want?"',
    '  "limit": number | null,            // 1-5, only if they stated a number',
    '  "unreadOnly": boolean | null,',
    '  "todayOnly": boolean | null',
    "}",
    "",
    "Decide the action:",
    '- "summarize my 5 most recent emails" -> summarize, limit 5',
    '- "summarize them" / "summarize these" -> summarize, useLastResults true',
    '- "summarize the second one" -> summarize, ordinal 2',
    '- "what does Robert want from me?" -> summarize, senderName "Robert"',
    '- "give me a quick inbox overview" -> summarize',
    '- "summarize my unread emails from today" -> summarize, unreadOnly true, todayOnly true',
    '- "which of these need my attention?" / "which emails need a reply?" -> triage',
    "",
    "Rules:",
    '- If the message is not asking about the CONTENT of emails, return {"action":"not_summary"} with all other fields null.',
    '- Searching/finding/listing without asking what they say is NOT a summary -> not_summary.',
    '- Drafting, sending, replying, starring, archiving, or trashing is NOT a summary -> not_summary.',
    '- Anything about a calendar event is NOT a summary -> not_summary.',
    "- Never invent an ordinal, sender, or number the message does not state. Leave it null.",
  ].join("\n");
}

/** PURE: parse a raw model reply into a validated intent, or null. */
export function parseGmailSummaryIntent(raw: string): GmailSummaryIntent | null {
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
  const result = GmailSummaryIntentSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** The generator dependency, injectable so tests never hit the network. */
export type TextGenerator = (params: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}) => Promise<string>;

/** Extract a summary intent via the model, or null when unavailable/invalid. */
export async function extractGmailSummaryIntent(params: {
  text: string;
  todayLocal: string;
  timezone: string | undefined;
  generate?: TextGenerator;
}): Promise<GmailSummaryIntent | null> {
  const generate = params.generate ?? generateAnthropicText;
  try {
    const reply = await generate({
      system: buildSummaryIntentPrompt(params.todayLocal, params.timezone),
      messages: [{ role: "user", content: params.text }],
      maxTokens: 300,
    });
    return parseGmailSummaryIntent(reply);
  } catch {
    return null;
  }
}

/** One grounded summary of one email. */
export interface EmailSummaryResult {
  /** 1–2 sentences describing what the email says. "" when it couldn't be read. */
  summary: string;
  /**
   * A suggested action, ONLY when the email genuinely calls for one. Empty means
   * no action is implied — which is itself useful information and must not be
   * padded into invented urgency.
   */
  action: string;
}

/** Summarise ONE email. Injectable so tests never hit Anthropic. */
export type EmailSummariser = (params: {
  body: string;
  subject: string;
  sender: string;
  /** True when the caller wants the action line emphasised (triage). */
  triage: boolean;
}) => Promise<EmailSummaryResult>;

/** PURE: parse the summariser's strict JSON reply. */
export function parseSummaryResult(raw: string): EmailSummaryResult | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const action = typeof parsed.action === "string" ? parsed.action.trim() : "";
    if (!summary) return null;
    // "none"/"n/a" are the model's way of saying there is nothing to do — normalise
    // them away rather than printing "Action: none".
    const normalised = /^(none|n\/?a|no action( needed| required)?\.?)$/i.test(action)
      ? ""
      : action;
    return { summary, action: normalised };
  } catch {
    return null;
  }
}
