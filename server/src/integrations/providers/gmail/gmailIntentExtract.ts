import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";

/**
 * UNIFIED Gmail intent extraction (Section 17 correction).
 *
 * WHY THIS EXISTS. Routing was keyword-first, and each handler matched on one word
 * then threw the rest of the sentence away. "Do I have any important emails
 * regarding work?" matched `\bimportant\b` and became "list important emails" — the
 * word "work" never survived the match, so the user got five generically important
 * messages, four of them the same conversation. The meaning was lost at the door.
 *
 * So ONE stage interprets the whole message into ONE validated schema. The model's
 * only job is language: it names a scope. It never picks a message id, never chooses
 * a label id, never builds a Gmail query, never calls Gmail, and cannot claim
 * anything happened. Everything below the schema is deterministic backend code.
 *
 * The schema carries the COMPLETE request — importance AND topic AND count AND
 * reference — because that is exactly what the old routing could not represent.
 */

const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

/** What the user wants done. */
export const GmailOperationSchema = z.enum([
  /** Show me conversations (search / list / "anything important about X"). */
  "list",
  /** Change state on a conversation (star, archive, read, trash, label...). */
  "manage",
  /** Reverse the last verified action ("undo that"). */
  "undo",
  /** Assert our claim was wrong ("it's still starred"). */
  "verify_state",
  /** Not a Gmail request at all. */
  "not_gmail",
]);

/** The conversation-level mutations the model may name. */
export const GmailManageActionSchema = z.enum([
  "star",
  "unstar",
  "archive",
  "unarchive",
  "mark_read",
  "mark_unread",
  "trash",
  "untrash",
  "add_label",
  "remove_label",
]);

/** How the user pointed at the thing they mean. */
export const GmailReferenceSchema = z.enum([
  /** "them", "these", "those" — the whole list just shown. */
  "last_result_set",
  /** "it", "that email" — the entity the conversation is about. */
  "pronoun",
  /** "the one you just starred" — our own last action. */
  "last_acted",
]);

export const GmailIntentSchema = z.object({
  operation: GmailOperationSchema,

  // --- list shaping ---
  /** A count the user actually stated ("my 5 most recent"). Never invented. */
  count: z.number().int().min(1).max(25).nullable().optional(),
  sort: z.enum(["newest", "oldest"]).nullable().optional(),
  /** True when they asked for important/urgent/priority mail. */
  importantOnly: z.boolean().nullable().optional(),
  /** True when they asked which mail needs a reply or their attention. */
  needsActionOnly: z.boolean().nullable().optional(),
  /** True when they want the contents described rather than listed. */
  wantsSummary: z.boolean().nullable().optional(),
  unread: z.boolean().nullable().optional(),
  starred: z.boolean().nullable().optional(),
  hasAttachment: z.boolean().nullable().optional(),

  // --- who / what / when ---
  sender: nullableText(200),
  recipient: nullableText(200),
  subject: nullableText(200),
  /**
   * The SEMANTIC topic in the user's own words ("work", "my background screening",
   * "anything to do with Hula"). Deliberately free text and deliberately NOT a
   * search term: the backend never interpolates this into Gmail's query DSL. It is
   * the concept a bounded relevance pass judges candidates against.
   */
  topic: nullableText(200),
  /** `YYYY-MM-DD`, validated by the backend before it can reach a query. */
  after: nullableText(10),
  before: nullableText(10),
  newerThanDays: z.number().int().min(1).max(365).nullable().optional(),
  mailbox: z.enum(["inbox", "sent", "anywhere", "trash"]).nullable().optional(),

  // --- pointing at something ---
  /** 1-based position into the list just shown ("the second one"). */
  ordinal: z.number().int().min(1).max(20).nullable().optional(),
  reference: GmailReferenceSchema.nullable().optional(),
  /** True for "those"/"all of them" — every entry of the list just shown. */
  all: z.boolean().nullable().optional(),

  // --- managing ---
  manageAction: GmailManageActionSchema.nullable().optional(),
  /** The label NAME as the user said it. Resolved against real labels by the backend. */
  labelName: nullableText(100),
  /** The model's read on whether this is consequential. Advisory only. */
  destructive: z.boolean().nullable().optional(),
});

export type GmailIntent = z.infer<typeof GmailIntentSchema>;
export type GmailOperation = z.infer<typeof GmailOperationSchema>;
export type GmailManageAction = z.infer<typeof GmailManageActionSchema>;

/** PURE: build the extraction system prompt. */
export function buildGmailIntentPrompt(todayLocal: string, timezone: string | undefined): string {
  return [
    "You interpret ONE message from a user to an assistant that manages their Gmail.",
    `The user's current local date is ${todayLocal} (timezone: ${timezone ?? "UTC"}).`,
    "",
    "You do NOT act. You only describe what the message means, as ONE JSON object and",
    "nothing else. No markdown, no prose. Shape:",
    "{",
    '  "operation": "list" | "manage" | "undo" | "verify_state" | "not_gmail",',
    '  "count": number | null,            // only if they stated one',
    '  "sort": "newest" | "oldest" | null,',
    '  "importantOnly": boolean | null,   // important / urgent / priority',
    '  "needsActionOnly": boolean | null, // needs a reply / my attention',
    '  "wantsSummary": boolean | null,',
    '  "unread": boolean | null,',
    '  "starred": boolean | null,',
    '  "hasAttachment": boolean | null,',
    '  "sender": string | null,',
    '  "recipient": string | null,',
    '  "subject": string | null,',
    '  "topic": string | null,            // the subject matter, in their words',
    '  "after": "YYYY-MM-DD" | null,',
    '  "before": "YYYY-MM-DD" | null,',
    '  "newerThanDays": number | null,',
    '  "mailbox": "inbox" | "sent" | "anywhere" | "trash" | null,',
    '  "ordinal": number | null,          // "the second one" -> 2',
    '  "reference": "last_result_set" | "pronoun" | "last_acted" | null,',
    '  "all": boolean | null,',
    '  "manageAction": "star" | "unstar" | "archive" | "unarchive" | "mark_read" | "mark_unread" | "trash" | "untrash" | "add_label" | "remove_label" | null,',
    '  "labelName": string | null,',
    '  "destructive": boolean | null',
    "}",
    "",
    "Capture the WHOLE message. Never drop part of it because another part matched:",
    '- "Do I have any important emails regarding work?"',
    '  -> list, importantOnly true, topic "work"',
    '- "anything urgent regarding my job?"  -> list, importantOnly true, topic "my job"',
    '- "emails about my background screening" -> list, topic "my background screening"',
    '- "anything from recruiters that needs attention?"',
    '  -> list, needsActionOnly true, topic "recruiters"',
    '- "show me my 5 most recent emails" -> list, count 5, sort "newest"',
    '- "star the first one"   -> manage, manageAction "star", ordinal 1',
    '- "unstar the second one" -> manage, manageAction "unstar", ordinal 2',
    '- "now unstar it"        -> manage, manageAction "unstar", reference "pronoun"',
    '- "the one you just starred" -> reference "last_acted"',
    '- "archive those"        -> manage, manageAction "archive", all true, reference "last_result_set"',
    '- "undo that"            -> undo',
    '- "it\'s still starred" / "that didn\'t work, it\'s starred"  -> verify_state',
    '- "add my Work label to it" -> manage, manageAction "add_label", labelName "Work", reference "pronoun"',
    "",
    "Rules:",
    '- topic is the SUBJECT MATTER, in the user\'s own words. Do not translate it into',
    "  search keywords, do not expand it, do not guess synonyms. Copy their phrasing.",
    '- "delete"/"remove"/"bin" an email means trash. There is no permanent delete.',
    '- A DRAFT request ("delete that draft", "send the draft") is NOT this. -> not_gmail',
    '- Composing, replying, or forwarding is NOT this. -> not_gmail',
    '- A calendar request is NOT this. -> not_gmail',
    '- A reminder or a memory request is NOT this. -> not_gmail',
    '- Ordinary conversation is NOT this. -> not_gmail',
    "- Never invent a count, ordinal, sender, topic, or label the message does not state.",
    "  Leave it null. A guessed value here acts on the wrong email.",
  ].join("\n");
}

/** PURE: parse a raw model reply into a validated intent, or null. */
export function parseGmailIntent(raw: string): GmailIntent | null {
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
  const result = GmailIntentSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** The generator dependency, injectable so tests never hit the network. */
export type TextGenerator = (params: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}) => Promise<string>;

/** Extract a Gmail intent via the model, or null when unavailable/invalid. */
export async function extractGmailIntent(params: {
  text: string;
  todayLocal: string;
  timezone: string | undefined;
  generate?: TextGenerator;
}): Promise<GmailIntent | null> {
  const generate = params.generate ?? generateAnthropicText;
  try {
    const reply = await generate({
      system: buildGmailIntentPrompt(params.todayLocal, params.timezone),
      messages: [{ role: "user", content: params.text }],
      maxTokens: 500,
    });
    return parseGmailIntent(reply);
  } catch {
    return null;
  }
}
