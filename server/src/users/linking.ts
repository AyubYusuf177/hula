import type { Channel, Provider } from "../channels/types";
import {
  extractLinkCode,
  getValidLinkSession,
  markLinkCodeUsed,
} from "./linkSessions";
import { getLinkedIdentity, linkIdentity } from "./messagingIdentity";

/**
 * Inbound linking orchestration.
 *
 * Given an inbound sender handle and message text, decide how Hula should reply
 * for the connect flow and (when appropriate) link the handle to a Hula user.
 * No AI/model calls — these replies are fixed placeholders until a later section
 * wires the real agent.
 *
 * The decision is split into a PURE function (`decideLinkOutcome`) that is fully
 * unit-testable without a database, and a DB-backed orchestrator
 * (`resolveInboundLink`) that loads state and applies the side effects.
 */

/** Fixed connect-flow replies. */
export const LINK_REPLIES = {
  connected: "You’re connected — text me whenever you need me.",
  alreadyConnected: "You’re connected to Hula.",
  differentAccount: "This number is already connected to a Hula account.",
  notConnected:
    "I can help once this number is connected to your Hula account. Open the Hula app and tap Text hula to connect.",
} as const;

export type LinkOutcomeStatus =
  | "connected"
  | "already_connected"
  | "different_account"
  | "not_connected";

/** What the orchestrator should persist after the decision. */
export type LinkEffect =
  | "link_and_consume" // create/refresh the identity AND mark the code used
  | "consume_only" // just mark the code used (owner re-sent their code)
  | "none";

export interface LinkOutcome {
  status: LinkOutcomeStatus;
  reply: string;
  /** True when a valid code was present in the message. */
  codeMatched: boolean;
}

interface LinkDecision extends LinkOutcome {
  effect: LinkEffect;
}

/**
 * Pure decision: given the handle's currently-linked user (if any) and the user
 * a valid code belongs to (if any), decide the reply, status, and side effect.
 * No I/O — safe to unit test.
 *
 * @param existingUserId Hula user id the handle is already linked to, or undefined.
 * @param sessionUserId  Hula user id owning a VALID (pending, unexpired) code, or undefined.
 */
export function decideLinkOutcome(params: {
  existingUserId: string | undefined;
  sessionUserId: string | undefined;
}): LinkDecision {
  const { existingUserId, sessionUserId } = params;

  if (sessionUserId) {
    // A valid code was sent.
    if (existingUserId && existingUserId !== sessionUserId) {
      // Never silently relink a handle owned by a different user; don't burn the code.
      return {
        status: "different_account",
        reply: LINK_REPLIES.differentAccount,
        codeMatched: true,
        effect: "none",
      };
    }
    if (existingUserId && existingUserId === sessionUserId) {
      // Owner re-sent their own code — already connected. Consume the code.
      return {
        status: "already_connected",
        reply: LINK_REPLIES.alreadyConnected,
        codeMatched: true,
        effect: "consume_only",
      };
    }
    // Fresh handle: link it and consume the code.
    return {
      status: "connected",
      reply: LINK_REPLIES.connected,
      codeMatched: true,
      effect: "link_and_consume",
    };
  }

  // No valid code (absent, expired, used, or unknown).
  if (existingUserId) {
    return {
      status: "already_connected",
      reply: LINK_REPLIES.alreadyConnected,
      codeMatched: false,
      effect: "none",
    };
  }

  return {
    status: "not_connected",
    reply: LINK_REPLIES.notConnected,
    codeMatched: false,
    effect: "none",
  };
}

/**
 * Pure routing rule for the Hula brain (Section 6): a message should reach the
 * AI brain ONLY when the sender is already linked AND the message carries no
 * connect-code pattern (a normal, non-code message). Every other case — unknown
 * sender, a fresh/valid code, or any code attempt (valid, invalid, expired, or
 * used) — stays deterministic and must NOT call the brain. No I/O; unit-testable.
 */
export function isNormalLinkedMessage(params: {
  existingUserId: string | undefined;
  hadCode: boolean;
}): boolean {
  return Boolean(params.existingUserId) && !params.hadCode;
}

/**
 * Resolve how to handle an inbound message for linking. Loads the current link
 * state from the database, applies the pure decision, performs any side effects,
 * and returns the outcome (including the resolved Hula user id when known). The
 * caller is responsible for actually sending `reply`.
 *
 * `brainEligible` tells the caller whether this is a normal message from an
 * already-linked user (and so should be answered by the AI brain) rather than a
 * deterministic connect-flow reply.
 */
export async function resolveInboundLink(params: {
  senderHandle: string;
  text: string | undefined;
  provider: Provider;
  channel: Channel;
}): Promise<LinkOutcome & { userId?: string; brainEligible: boolean }> {
  const { senderHandle, text, provider, channel } = params;

  const existing = await getLinkedIdentity(senderHandle);
  const code = extractLinkCode(text);
  const session = code ? await getValidLinkSession(code) : undefined;

  const decision = decideLinkOutcome({
    existingUserId: existing?.userId,
    sessionUserId: session?.userId,
  });

  // Normal message from an already-linked sender → the brain answers it. Any
  // code attempt (even invalid/expired) keeps the deterministic connect reply.
  const brainEligible = isNormalLinkedMessage({
    existingUserId: existing?.userId,
    hadCode: code !== undefined,
  });

  // Apply side effects based on the decision.
  let userId = existing?.userId;
  if (decision.effect === "link_and_consume" && session && code) {
    await markLinkCodeUsed(code);
    const identity = await linkIdentity({
      handle: senderHandle,
      userId: session.userId,
      provider,
      channel,
    });
    userId = identity.userId;
  } else if (decision.effect === "consume_only" && code) {
    await markLinkCodeUsed(code);
  }

  return {
    status: decision.status,
    reply: decision.reply,
    codeMatched: decision.codeMatched,
    brainEligible,
    ...(userId ? { userId } : {}),
  };
}
