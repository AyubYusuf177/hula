import { Router } from "express";

import { requireClerkAuth } from "../auth/clerk";
import { env } from "../config/env";
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  clampMessageLimit,
  listConversationsForUser,
  listRecentMessagesForUser,
  parseMessageOrder,
} from "../db/queries";
import { getMessagingStatus } from "../users/messagingIdentity";
import {
  getUserProfile,
  sanitizeProfileInput,
  upsertUserProfile,
} from "../users/profile";
import { logger } from "../utils/logger";

/** Fallback Hula line if the env value isn't configured (matches Section 3). */
const DEFAULT_HULA_NUMBER = "+16465480761";

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

meRouter.get("/v1/me/profile", requireClerkAuth, async (req, res) => {
  const clerkUserId = req.clerkUserId as string;

  try {
    const profile = await getUserProfile(clerkUserId);
    // Safe log: which fields exist, never their values.
    logger.info("me.profile served", { hasProfile: profile.updatedAt !== null });
    res.status(200).json({ profile });
  } catch (err) {
    logger.error("me.profile get failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "profile_query_failed" });
  }
});

meRouter.put("/v1/me/profile", requireClerkAuth, async (req, res) => {
  const clerkUserId = req.clerkUserId as string;

  // Never trust the client body: keep only known, capped, validated fields.
  const input = sanitizeProfileInput(req.body);

  try {
    const profile = await upsertUserProfile(clerkUserId, input);
    // Safe log: count of accepted fields only, never their values.
    logger.info("me.profile synced", { fieldCount: Object.keys(input).length });
    res.status(200).json({ profile });
  } catch (err) {
    logger.error("me.profile put failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "profile_update_failed" });
  }
});

meRouter.get("/v1/me/messaging-status", requireClerkAuth, async (req, res) => {
  const clerkUserId = req.clerkUserId as string;

  try {
    const imessage = await getMessagingStatus(clerkUserId);
    // Hula's own line is public (not a secret); the app needs it to open the
    // existing thread when the user is already connected.
    const hulaNumber = env.SENDBLUE_HULA_NUMBER ?? DEFAULT_HULA_NUMBER;

    // Safe log: connection flag only, never the handle or user id.
    logger.info("me.messaging-status served", { connected: imessage.connected });

    res.status(200).json({ imessage, hulaNumber });
  } catch (err) {
    logger.error("me.messaging-status failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "messaging_status_query_failed" });
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
