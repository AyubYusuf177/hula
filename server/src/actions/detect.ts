import { logger } from "../utils/logger";
import { executeAction } from "./executor";

/**
 * Deterministic action-intent detection (Section 12).
 *
 * NOT a general planner. It recognises a few clear IMPERATIVE write/send intents
 * ("schedule …", "send an email …", "create a task …") so Hula can respond
 * HONESTLY that those actions aren't enabled yet — instead of the read-only
 * calendar handler mistaking "schedule gym at 7pm" for a calendar question, or
 * the brain pretending it sent an email.
 *
 * Questions ("what's on my calendar", "what should I say in an email") never
 * match here — they fall through to the calendar read path or the brain.
 */

/** Opener words that make a message a QUESTION, never a create/send command. */
const QUESTION_RE = /^(?:what|when|where|which|who|why|how|do i|does|is|are|am i|can you|could you|would you|should i|any\b)/i;

// Imperative calendar-write verbs (must lead the request).
const CREATE_EVENT_VERB_RE =
  /^(?:can you |could you |please |pls )?(?:schedule|book|set ?up|add|create|put|block(?: off)?|arrange|plan)\b/i;

// A concrete time cue, so we only treat it as an event when there's a "when".
const TIME_CUE_RE =
  /\b(?:\d{1,2}\s?(?:am|pm)|\d{1,2}:\d{2}|noon|midnight|tonight|tomorrow|today|next week|this (?:week|weekend)|on (?:mon|tue|wed|thu|fri|sat|sun)|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;

// Calendar nouns that also signal an event even without an explicit clock time.
const EVENT_NOUN_RE = /\b(?:meeting|appointment|event|call|reminder\b)/i;

const EMAIL_RE = /\bemail\b/i;
const EMAIL_VERB_RE =
  /^(?:can you |could you |please |pls )?(?:send|shoot|fire off|compose|write|draft|email)\b/i;
const DRAFT_RE = /\bdraft\b/i;

const TASK_RE =
  /^(?:can you |could you |please |pls )?(?:create|add|make|set ?up)\b[^.!?]*\b(?:task|to-?do|todo)\b/i;

/**
 * Pure: map an imperative message to the action id it implies, or null. Only
 * clearly imperative write/send phrasings match; questions and ordinary chat
 * return null.
 */
export function detectActionIntent(text: string | undefined): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  if (QUESTION_RE.test(trimmed)) return null;

  // Email send/draft — an email verb plus the word "email".
  if (EMAIL_RE.test(trimmed) && EMAIL_VERB_RE.test(trimmed)) {
    return DRAFT_RE.test(trimmed) ? "email.createDraft" : "email.sendDraft";
  }

  // Task creation.
  if (TASK_RE.test(trimmed)) return "task.create";

  // Calendar event creation — an imperative scheduling verb plus a time/noun cue.
  if (CREATE_EVENT_VERB_RE.test(trimmed) && (TIME_CUE_RE.test(trimmed) || EVENT_NOUN_RE.test(trimmed))) {
    return "calendar.createEvent";
  }

  return null;
}

/** Result of trying to resolve a message as an action intent. */
export interface ActionIntentResult {
  handled: boolean;
  reply?: string;
  actionId?: string;
}

/**
 * Handle a detected imperative action intent by running it through the executor,
 * which (for every stubbed write/send action) returns an honest "not enabled yet"
 * message and records a `blocked` ledger entry. Returns `{ handled: false }` for
 * non-action messages so the caller falls through to the calendar read / brain.
 * Never throws.
 */
export async function handleActionIntent(
  userId: string,
  text: string | undefined,
): Promise<ActionIntentResult> {
  const actionId = detectActionIntent(text);
  if (!actionId) return { handled: false };

  try {
    // No structured input is parsed yet — we only need the honest policy verdict.
    const result = await executeAction(userId, actionId, { input: {} });
    return { handled: true, actionId, reply: result.userMessage };
  } catch (err) {
    logger.error("action.intent failed", {
      actionId,
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: false };
  }
}
