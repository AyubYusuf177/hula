import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";

/**
 * Structured Gmail draft-lifecycle extraction (Section 17).
 *
 * Turns one natural-language message into a strictly-validated draft command:
 * list / open / edit / delete. The model NEVER calls Gmail, never chooses a draft
 * id, and never performs the edit itself — the deterministic backend
 * (`gmailDraftLifecycle.ts`) resolves the real draft, re-fetches it, and applies
 * the change.
 *
 * The critical distinction this must get right is DELETE vs CANCEL:
 *  - "delete that draft" destroys real user data in Gmail.
 *  - "no, cancel" / "never mind" abandons a PENDING Hula action and touches nothing.
 * Conflating them either destroys mail the user wanted, or silently keeps an action
 * armed the user thought they'd stopped. So "cancel" is deliberately NOT a draft
 * command here: it belongs to the confirmation flow, which runs earlier.
 */

const nullableText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().optional();

export const GmailDraftCommandSchema = z.object({
  action: z.enum([
    "list_drafts",
    "open_draft",
    "edit_draft",
    "delete_draft",
    "not_draft_command",
  ]),
  /** 1-based position when the user referenced a shown list ("the second one"). */
  ordinal: z.number().int().min(1).max(20).nullable().optional(),
  /** A recipient hint ("the draft to Rob"). */
  recipientHint: nullableText(200),
  /** For edit: the user's instruction, verbatim ("make it shorter"). */
  editInstruction: nullableText(2000),
});

export type GmailDraftCommand = z.infer<typeof GmailDraftCommandSchema>;

/** PURE: build the extraction system prompt. Pins output to strict JSON. */
export function buildDraftCommandPrompt(): string {
  return [
    "You extract a single DRAFT command from one message, for an assistant that manages Gmail drafts.",
    "",
    "Respond with ONE JSON object and nothing else. No markdown, no prose. Shape:",
    "{",
    '  "action": "list_drafts" | "open_draft" | "edit_draft" | "delete_draft" | "not_draft_command",',
    '  "ordinal": number | null,          // 1-based position if they said "the second one"',
    '  "recipientHint": string | null,    // e.g. "Rob" for "the draft to Rob"',
    '  "editInstruction": string | null   // the edit request, verbatim',
    "}",
    "",
    "Decide the action:",
    '- "show me my drafts" / "what drafts do I have" -> list_drafts',
    '- "open the second draft" / "read that draft" / "what does the draft say" -> open_draft',
    '- "make it shorter" / "change Friday to Monday" / "make that more professional" -> edit_draft',
    '- "delete that draft" / "bin the draft to Rob" / "get rid of that draft" -> delete_draft',
    "",
    "Rules:",
    '- If the message is not about managing an existing draft, return {"action":"not_draft_command"} with all other fields null.',
    '- "cancel" / "no" / "never mind" / "stop" is NOT a draft command — it abandons a pending action. Return not_draft_command.',
    '- Creating a NEW draft or sending one is NOT a draft command here. Return not_draft_command.',
    '- Only use delete_draft when the user clearly wants the DRAFT ITSELF destroyed.',
    '- A request about a calendar event, meeting, or appointment ("move lunch to 2pm", "cancel my 3pm") is NOT a draft command. Return not_draft_command.',
    '- For edit_draft, copy the instruction verbatim into editInstruction. Do NOT rewrite the email yourself.',
    "- Never invent an ordinal the message does not state. Leave it null.",
  ].join("\n");
}

/**
 * PURE: parse a raw model reply into a validated `GmailDraftCommand`, or null.
 * Anything off-schema returns null so the caller never acts on malformed output.
 */
export function parseGmailDraftCommand(raw: string): GmailDraftCommand | null {
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
  const result = GmailDraftCommandSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** The generator dependency, injectable so tests never hit the network. */
export type TextGenerator = (params: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}) => Promise<string>;

/** Extract a draft command via the model, or null when unavailable/invalid. */
export async function extractGmailDraftCommand(params: {
  text: string;
  generate?: TextGenerator;
}): Promise<GmailDraftCommand | null> {
  const generate = params.generate ?? generateAnthropicText;
  try {
    const reply = await generate({
      system: buildDraftCommandPrompt(),
      messages: [{ role: "user", content: params.text }],
      maxTokens: 400,
    });
    return parseGmailDraftCommand(reply);
  } catch {
    return null;
  }
}

/**
 * Rewrite a draft body per the user's instruction. Injectable so tests never hit
 * Anthropic. Returns "" on failure, which the caller treats as "couldn't edit" —
 * never as an empty body to save over the real draft.
 */
export type DraftBodyRewriter = (params: {
  currentBody: string;
  instruction: string;
  subject: string;
  recipient: string;
}) => Promise<string>;

/** Max characters of a draft body we ever feed the rewriter (bounds tokens). */
export const REWRITE_SOURCE_MAX = 6000;

/**
 * Default rewriter: applies ONE instruction to an existing body and returns the
 * complete new body.
 *
 * The body being edited is Hula/user-authored (we never quote incoming mail into a
 * draft), so it is not third-party content — but the instruction must still only
 * ever produce an email body, never a claim about actions taken.
 */
export async function rewriteDraftBody(params: {
  currentBody: string;
  instruction: string;
  subject: string;
  recipient: string;
}): Promise<string> {
  const system = [
    "You revise ONE email body according to a single instruction.",
    "Return ONLY the complete revised email body as plain text.",
    "No preamble, no explanation, no markdown, no subject line, no signature block unless one already exists.",
    "Preserve the author's voice and intent. Change only what the instruction asks.",
    "Never invent facts, commitments, names, or dates that are not in the original body or the instruction.",
    "Never state that anything has been sent, saved, or scheduled.",
  ].join("\n");
  try {
    const text = await generateAnthropicText({
      system,
      messages: [
        {
          role: "user",
          content: [
            `Recipient: ${params.recipient}`,
            `Subject: ${params.subject}`,
            "",
            "Current body:",
            params.currentBody.slice(0, REWRITE_SOURCE_MAX),
            "",
            `Instruction: ${params.instruction}`,
          ].join("\n"),
        },
      ],
      maxTokens: 1200,
    });
    return text.trim();
  } catch {
    return "";
  }
}
