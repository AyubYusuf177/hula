import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";

/**
 * Structured Gmail-write extraction (Section 16).
 *
 * The model NEVER calls Gmail. Its ONLY job here is to turn one natural-language
 * message into a small, strictly-validated JSON intent. The deterministic backend
 * (`gmailActions.ts`) then validates every field again, RESOLVES the real
 * recipient/thread against the user's actual Gmail, and performs the draft/send.
 * The model may name a recipient or paraphrase a body, but it can never choose an
 * address, a thread, or bypass the backend's resolution and safety checks.
 *
 * PURE prompt building + Zod validation live here (fully unit-testable); the one
 * network call is injectable so tests never hit Anthropic.
 */

const nullableText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().optional();

/**
 * The validated shape the model must produce. Every field is optional/nullable
 * except `action`; the backend decides which fields are REQUIRED per action and
 * asks a concise clarification when something essential is missing or unresolved.
 */
export const GmailActionSchema = z.object({
  action: z.enum([
    "create_new_draft",
    "create_reply_draft",
    "send_new_email",
    "send_reply",
    "not_gmail_write",
  ]),
  /** The person to email (new) or whose message to reply to (reply). */
  recipientName: nullableText(200),
  /** A LITERAL email address the user supplied (never invented by the model). */
  recipientEmail: nullableText(320),
  /** Subject for a NEW email/draft (replies derive a `Re:` subject). */
  subject: nullableText(998),
  /** The complete message body, in the user's intent. */
  body: nullableText(10000),
});

export type GmailAction = z.infer<typeof GmailActionSchema>;

/** PURE: build the extraction system prompt. Pins output to strict JSON. */
export function buildGmailExtractionPrompt(): string {
  return [
    "You extract a single EMAIL command from one message for an assistant that can draft and send Gmail.",
    "",
    "Respond with ONE JSON object and nothing else. No markdown, no prose. Shape:",
    "{",
    '  "action": "create_new_draft" | "create_reply_draft" | "send_new_email" | "send_reply" | "not_gmail_write",',
    '  "recipientName": string | null,   // the person to email, or whose email to reply to',
    '  "recipientEmail": string | null,  // ONLY if the user literally gave an email address',
    '  "subject": string | null,         // subject for a NEW email (omit for replies)',
    '  "body": string | null             // the full message body the user wants sent',
    "}",
    "",
    "Decide the action:",
    '- "draft ..." / "write a draft ..." / "prepare an email ..." -> create_new_draft',
    '- "draft a reply ..." / "draft a response to X\'s email" -> create_reply_draft',
    '- "send X an email ..." / "email X ..." / "send an email to X ..." -> send_new_email',
    '- "reply to X ..." / "send a reply ..." / "respond to X\'s email ..." -> send_reply',
    "",
    "Rules:",
    '- If the message is NOT a request to draft or send an email, return {"action":"not_gmail_write"} with all other fields null.',
    '- A request to READ/SHOW email ("send me the latest email", "what emails do I have", "any unread") is NOT a write -> not_gmail_write.',
    "- NEVER invent an email address. Put recipientEmail ONLY when the user literally typed an address; otherwise leave it null and put the name in recipientName.",
    "- Capture the body faithfully and completely from the user's intent. Do not summarise it.",
    "- Keep the subject short and human. For replies, leave subject null.",
  ].join("\n");
}

/**
 * PURE: parse a raw model reply into a validated `GmailAction`, or null. Tolerates
 * a stray ```json fence and surrounding prose by extracting the first {...} block.
 * Anything off-schema returns null so the caller never acts on malformed output.
 */
export function parseGmailAction(raw: string): GmailAction | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
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
  const result = GmailActionSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** The generator dependency, injectable so tests never hit the network. */
export type TextGenerator = (params: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}) => Promise<string>;

/**
 * Extract a structured Gmail action from a message via the model. Returns a
 * validated `GmailAction`, or null when the model is unavailable, errors, or
 * returns something invalid — the caller treats null as "couldn't extract".
 * `generate` is injectable for tests; production uses the real Anthropic client.
 */
export async function extractGmailAction(params: {
  text: string;
  generate?: TextGenerator;
}): Promise<GmailAction | null> {
  const generate = params.generate ?? generateAnthropicText;
  const system = buildGmailExtractionPrompt();
  try {
    const reply = await generate({
      system,
      messages: [{ role: "user", content: params.text }],
      maxTokens: 800,
    });
    return parseGmailAction(reply);
  } catch {
    return null;
  }
}
