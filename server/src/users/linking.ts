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
 * for the Section 3 connect flow and (when appropriate) link the handle to a
 * Clerk user. No AI/model calls — these replies are fixed placeholders until
 * Section 5/6 wires the real agent.
 */

/** Fixed Section 3 replies. */
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

export interface LinkOutcome {
  status: LinkOutcomeStatus;
  reply: string;
  /** True when a valid code was present in the message. */
  codeMatched: boolean;
}

/**
 * Resolve how to handle an inbound message for linking. Pure decision + side
 * effect on the in-memory stores; the caller is responsible for actually
 * sending `reply`.
 */
export function resolveInboundLink(params: {
  senderHandle: string;
  text: string | undefined;
  provider: Provider;
  channel: Channel;
}): LinkOutcome {
  const { senderHandle, text, provider, channel } = params;

  const existing = getLinkedIdentity(senderHandle);
  const code = extractLinkCode(text);

  if (code) {
    const session = getValidLinkSession(code);
    if (session) {
      // A valid code was sent. If this handle already belongs to a DIFFERENT
      // Clerk user, never silently relink — and don't burn the code.
      if (existing && existing.clerkUserId !== session.clerkUserId) {
        return {
          status: "different_account",
          reply: LINK_REPLIES.differentAccount,
          codeMatched: true,
        };
      }

      markLinkCodeUsed(code);
      linkIdentity({
        handle: senderHandle,
        clerkUserId: session.clerkUserId,
        provider,
        channel,
      });
      return {
        status: "connected",
        reply: LINK_REPLIES.connected,
        codeMatched: true,
      };
    }
    // Code shape matched but it was expired/used/unknown — fall through to the
    // identity-based replies below.
  }

  if (existing) {
    return {
      status: "already_connected",
      reply: LINK_REPLIES.alreadyConnected,
      codeMatched: false,
    };
  }

  return {
    status: "not_connected",
    reply: LINK_REPLIES.notConnected,
    codeMatched: false,
  };
}
