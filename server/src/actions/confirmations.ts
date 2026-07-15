import { logger } from "../utils/logger";
import { CONFIRM_INSTRUCTION } from "./confirmationCopy";
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
  /^(?:y|yh|yes|yep|yeah|yea|yup|ya|sure|ok|okay|k|confirm(?:ed)?|do it|send|send it|send that|go ahead|go for it|proceed|please do|sounds good|looks good|that works|perfect|correct|absolutely|sgtm)(?:\s+(?:please|do it|go ahead|thanks|thank you))?$/;

/**
 * "cancel" and "stop" REMAIN cancellations even though Hula no longer asks for
 * them (they are carrier opt-out keywords — see `CONFIRM_INSTRUCTION`).
 *
 * Keeping them is the safe direction. A user who types "Cancel" unambiguously
 * means stop; the carrier will swallow Hula's reply, but abandoning the pending
 * write is still exactly right — far better than leaving it armed because the word
 * was also meaningful to the network. `no` is the word Hula actually advertises.
 */
const CANCEL_RE =
  /^(?:no|nope|nah|cancel(?: that| it)?|don'?t(?: send| do it)?|do not(?: send)?|stop|reject|never ?mind|forget it|leave it|no thanks|no thank you)$/;

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
 * Injectable dependencies. Defaults use the real proposal store + executor; tests
 * pass fakes so the full confirm/cancel/expire/idempotency lifecycle can be
 * exercised with NO database and NO provider call.
 */
export interface ConfirmationDeps {
  getActiveProposal?: typeof getActiveProposal;
  confirmProposal?: typeof confirmProposal;
  rejectProposal?: typeof rejectProposal;
  finalizeProposal?: typeof finalizeProposal;
  executeAction?: typeof executeAction;
}

/**
 * Resolve a message against the user's active proposal. Returns
 * `{ handled: false }` when the message isn't a confirmation OR there is no active
 * proposal, so the caller falls through to the normal flow. Never throws.
 *
 * A confirmed SEND (Section 16) runs through the executor's Gmail adapter here;
 * because the proposal transition is guarded (only a still-`proposed` row flips),
 * a double "yes", an expired proposal, or a duplicate delivery can never send
 * twice — a second attempt finds no active proposal (or a no-op transition).
 */
export async function handleActionConfirmation(
  userId: string,
  text: string | undefined,
  deps: ConfirmationDeps = {},
): Promise<ConfirmationResult> {
  const reply = classifyConfirmationReply(text);
  if (reply === "none") return { handled: false };

  const loadActive = deps.getActiveProposal ?? getActiveProposal;
  const confirm = deps.confirmProposal ?? confirmProposal;
  const reject = deps.rejectProposal ?? rejectProposal;
  const finalize = deps.finalizeProposal ?? finalizeProposal;
  const execute = deps.executeAction ?? executeAction;

  try {
    const active = await loadActive(userId);
    // A "yes"/"no" with no pending proposal (or an expired one) must do nothing.
    if (!active) return { handled: false };

    if (reply === "cancel") {
      await reject(userId, active.id);
      return { handled: true, outcome: "cancelled", reply: "Okay, I’ve cancelled that." };
    }

    // Confirm: flip to confirmed (idempotent — a double "yes" is a no-op), then
    // run the executor. The executor performs the real provider write ONLY for
    // implemented actions (e.g. a Gmail send); everything else stays honest.
    const confirmed = await confirm(userId, active.id);
    if (!confirmed) {
      return { handled: true, outcome: "none", reply: "That’s already been handled." };
    }

    const result = await execute(userId, active.actionId, {
      input: active.input ?? undefined,
      userConfirmed: true,
      proposalId: active.id,
    });
    await finalize(userId, active.id, result.ok ? "executed" : "failed");

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

/**
 * The deterministic re-prompt shown when a confirmable action is awaiting go-ahead.
 *
 * It no longer instructs "cancel": Sendblue treats that word as a carrier opt-out
 * and blocks Hula's replies. See `CONFIRM_INSTRUCTION`.
 */
export const PENDING_PROPOSAL_REPROMPT = `I’m waiting for your go-ahead. ${CONFIRM_INSTRUCTION}`;

/** Result of the active-proposal safety net. */
export interface PendingProposalGuardResult {
  handled: boolean;
  reply?: string;
}

/**
 * Safety net (Fix 1): when the user has an ACTIVE confirmable proposal but their
 * message was NOT recognised by any deterministic handler, this returns a concise
 * deterministic re-prompt so the message can NEVER fall through to the generic
 * brain — which could otherwise hallucinate an operational success ("sent!").
 *
 * Call this ONLY as the last step before the brain, after every real handler has
 * already declined. It performs NO provider write and NEVER confirms anything: it
 * merely keeps an unresolved send/change safely pending until the user gives a
 * clear yes/no. Returns `{ handled:false }` when there is no active proposal, so a
 * normal conversation is completely unaffected. Never throws.
 */
export async function handlePendingProposalReprompt(
  userId: string,
  deps: Pick<ConfirmationDeps, "getActiveProposal"> = {},
): Promise<PendingProposalGuardResult> {
  const loadActive = deps.getActiveProposal ?? getActiveProposal;
  try {
    const active = await loadActive(userId);
    if (!active) return { handled: false };
    return { handled: true, reply: PENDING_PROPOSAL_REPROMPT };
  } catch (err) {
    // A lookup failure must not fabricate anything — fall through to the brain's
    // own safe fallback rather than block the reply.
    logger.error("action.pendingReprompt failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: false };
  }
}
