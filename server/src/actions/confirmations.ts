import { logger } from "../utils/logger";
import { executeAction } from "./executor";
import {
  confirmProposal,
  finalizeProposal,
  getActiveProposal,
  rejectProposal,
} from "./proposals";

/**
 * Natural-language confirmation flow (Section 12).
 *
 * When Hula has proposed a confirmable action, a short reply like "yes" / "do it"
 * / "cancel" resolves it. Crucially, a "yes" ONLY confirms the single ACTIVE
 * (non-expired) proposal for that user — it never becomes standing consent, and a
 * "yes" with no pending proposal does nothing at all (so the message falls
 * through to the normal brain).
 *
 * Pure classification (`classifyConfirmationReply`) is fully testable; the
 * orchestrator loads/updates the proposal and runs the executor.
 */

export type ConfirmationReply = "confirm" | "cancel" | "none";

/** Normalize a reply for matching: lowercase, trim, strip edge punctuation. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/^[^\w']+|[^\w']+$/g, "")
    .replace(/\s+/g, " ");
}

const CONFIRM_RE =
  /^(?:yes|yep|yeah|yup|ya|sure|ok|okay|confirm(?:ed)?|do it|go ahead|go for it|please do|sounds good|that works|perfect|correct|absolutely|sgtm)(?:\s+(?:please|do it|go ahead|thanks|thank you))?$/;

const CANCEL_RE =
  /^(?:no|nope|nah|cancel(?: that| it)?|don'?t|do not|stop|never ?mind|forget it|no thanks|no thank you)$/;

/**
 * Pure: classify a short reply as confirming, cancelling, or neither. Only tight,
 * standalone confirmations match, so ordinary sentences fall through to `none`.
 */
export function classifyConfirmationReply(text: string | undefined): ConfirmationReply {
  const normalized = normalize(text ?? "");
  if (!normalized) return "none";
  if (CONFIRM_RE.test(normalized)) return "confirm";
  if (CANCEL_RE.test(normalized)) return "cancel";
  return "none";
}

/** Result of trying to resolve a message as a confirmation reply. */
export interface ConfirmationResult {
  handled: boolean;
  reply?: string;
  /** What the reply resolved to, for safe logging. */
  outcome?: "confirmed" | "cancelled" | "expired" | "none";
}

/**
 * Resolve a message against the user's active proposal. Returns
 * `{ handled: false }` when the message isn't a confirmation OR there is no active
 * proposal, so the caller falls through to the normal flow. Never throws.
 */
export async function handleActionConfirmation(
  userId: string,
  text: string | undefined,
): Promise<ConfirmationResult> {
  const reply = classifyConfirmationReply(text);
  if (reply === "none") return { handled: false };

  try {
    const active = await getActiveProposal(userId);
    // A "yes"/"no" with no pending proposal must do nothing.
    if (!active) return { handled: false };

    if (reply === "cancel") {
      await rejectProposal(userId, active.id);
      return { handled: true, outcome: "cancelled", reply: "Okay, I’ve cancelled that." };
    }

    // Confirm: flip to confirmed (idempotent — a double "yes" is a no-op), then
    // run the executor. Because every confirmable action is still a stub, this
    // resolves to an honest "not enabled yet" message rather than a real write.
    const confirmed = await confirmProposal(userId, active.id);
    if (!confirmed) {
      return { handled: true, outcome: "none", reply: "That’s already been handled." };
    }

    const result = await executeAction(userId, active.actionId, {
      input: active.input ?? undefined,
      userConfirmed: true,
      proposalId: active.id,
    });
    await finalizeProposal(userId, active.id, result.ok ? "executed" : "failed");

    return { handled: true, outcome: "confirmed", reply: result.userMessage };
  } catch (err) {
    logger.error("action.confirmation failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    // Stay honest rather than pretend anything happened.
    return {
      handled: true,
      outcome: "none",
      reply: "I couldn’t process that just now — mind trying again?",
    };
  }
}
