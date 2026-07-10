import { Router } from "express";

import { requireClerkAuth } from "../auth/clerk";
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  clampMessageLimit,
  listConversationsForUser,
  listRecentMessagesForUser,
  parseMessageOrder,
} from "../db/queries";
import { logger } from "../utils/logger";

/**
 * Authenticated inspection routes (Section 5).
 *
 * These let the signed-in Clerk user read back their OWN stored conversation
 * data so we can verify persistence before the AI brain is added. They are
 * read-only, require a valid Clerk session token, and never expose other users'
 * data, raw provider payloads, or secrets.
 *
 *   GET /v1/me/messages       — recent inbound/outbound messages (newest first)
 *   GET /v1/me/conversations  — conversation summaries with message counts
 */
export const meRouter = Router();

/** Read the first value of a possibly-repeated query param as a string. */
function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

meRouter.get("/v1/me/messages", requireClerkAuth, async (req, res) => {
  // `requireClerkAuth` guarantees this is set on success.
  const clerkUserId = req.clerkUserId as string;

  const limit = clampMessageLimit(firstQueryValue(req.query.limit));
  const order = parseMessageOrder(firstQueryValue(req.query.order));

  try {
    const messages = await listRecentMessagesForUser({
      clerkUserId,
      limit,
      order,
    });

    // Safe log: counts only, never the message text or the user id.
    logger.info("me.messages served", { count: messages.length, limit, order });

    res.status(200).json({
      messages,
      limit,
      order,
      defaultLimit: DEFAULT_MESSAGE_LIMIT,
      maxLimit: MAX_MESSAGE_LIMIT,
    });
  } catch (err) {
    logger.error("me.messages failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "messages_query_failed" });
  }
});

meRouter.get("/v1/me/conversations", requireClerkAuth, async (req, res) => {
  const clerkUserId = req.clerkUserId as string;

  const limit = clampMessageLimit(firstQueryValue(req.query.limit));

  try {
    const conversations = await listConversationsForUser({ clerkUserId, limit });

    logger.info("me.conversations served", {
      count: conversations.length,
      limit,
    });

    res.status(200).json({ conversations, limit });
  } catch (err) {
    logger.error("me.conversations failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "conversations_query_failed" });
  }
});
