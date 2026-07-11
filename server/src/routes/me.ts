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
import { isKnownProvider, listIntegrationCatalog } from "../integrations/catalog";
import {
  disconnectIntegrationConnection,
  getUserIntegrationStatus,
} from "../integrations/connections";
import { listActionDefinitions } from "../actions/registry";
import {
  confirmProposal,
  finalizeProposal,
  getProposalForUser,
  listProposalsForUser,
  rejectProposal,
} from "../actions/proposals";
import { listExecutionsForUser } from "../actions/executions";
import { executeAction } from "../actions/executor";
import {
  listActiveMemoriesForUser,
  softDeleteMemory,
} from "../users/memory";
import {
  cancelReminderById,
  listActiveRemindersForUser,
} from "../reminders/reminders";
import {
  getUserProfile,
  sanitizeProfileInput,
  upsertUserProfile,
} from "../users/profile";
import { getOrCreateUserByClerkId } from "../users/store";
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
 *   GET /v1/me/memories       — active explicit long-term memories (Section 8)
 *   DELETE /v1/me/memories/:id — soft-delete one of the user's own memories
 *   GET /v1/me/reminders      — active scheduled reminders (Section 9)
 *   DELETE /v1/me/reminders/:id — cancel one of the user's own reminders
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

meRouter.get("/v1/me/memories", requireClerkAuth, async (req, res) => {
  const clerkUserId = req.clerkUserId as string;

  try {
    const user = await getOrCreateUserByClerkId(clerkUserId);
    const memories = await listActiveMemoriesForUser(user.id);
    // Safe log: count only, never the memory text or the user id.
    logger.info("me.memories served", { count: memories.length });
    res.status(200).json({ memories });
  } catch (err) {
    logger.error("me.memories failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "memories_query_failed" });
  }
});

meRouter.delete("/v1/me/memories/:id", requireClerkAuth, async (req, res) => {
  const clerkUserId = req.clerkUserId as string;
  const memoryId = req.params.id;

  if (!memoryId) {
    res.status(400).json({ error: "missing_memory_id" });
    return;
  }

  try {
    const user = await getOrCreateUserByClerkId(clerkUserId);
    const deleted = await softDeleteMemory(user.id, memoryId);
    logger.info("me.memories deleted", { deleted });
    if (!deleted) {
      res.status(404).json({ error: "memory_not_found" });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error("me.memories delete failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "memory_delete_failed" });
  }
});

meRouter.get("/v1/me/reminders", requireClerkAuth, async (req, res) => {
  const clerkUserId = req.clerkUserId as string;

  try {
    const user = await getOrCreateUserByClerkId(clerkUserId);
    const reminders = await listActiveRemindersForUser(user.id);
    // Safe log: count only, never the reminder text or the user id.
    logger.info("me.reminders served", { count: reminders.length });
    res.status(200).json({ reminders });
  } catch (err) {
    logger.error("me.reminders failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "reminders_query_failed" });
  }
});

meRouter.delete("/v1/me/reminders/:id", requireClerkAuth, async (req, res) => {
  const clerkUserId = req.clerkUserId as string;
  const reminderId = req.params.id;

  if (!reminderId) {
    res.status(400).json({ error: "missing_reminder_id" });
    return;
  }

  try {
    const user = await getOrCreateUserByClerkId(clerkUserId);
    const cancelled = await cancelReminderById(user.id, reminderId);
    logger.info("me.reminders cancelled", { cancelled });
    if (!cancelled) {
      res.status(404).json({ error: "reminder_not_found" });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error("me.reminders delete failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "reminder_delete_failed" });
  }
});

// --- Section 10: integrations foundation ---------------------------------
//
// Read-only status + a disconnect. There is intentionally NO working connect
// flow yet: `connect` returns 501 { status: "not_implemented" }. No tokens,
// scopes-as-secrets, or raw provider payloads are ever exposed; a user only
// ever sees their OWN integration records.

// NOTE: `/catalog` MUST be registered before `/:provider` so it isn't captured
// as a provider slug.
meRouter.get("/v1/me/integrations/catalog", requireClerkAuth, (_req, res) => {
  // Static, non-sensitive provider metadata (no user data, no secrets).
  res.status(200).json({ providers: listIntegrationCatalog() });
});

meRouter.get("/v1/me/integrations", requireClerkAuth, async (req, res) => {
  const clerkUserId = req.clerkUserId as string;

  try {
    const user = await getOrCreateUserByClerkId(clerkUserId);
    const integrations = await getUserIntegrationStatus(user.id);
    const connectedCount = integrations.filter((i) => i.connected).length;
    // Safe log: counts only, never provider account details or the user id.
    logger.info("me.integrations served", {
      count: integrations.length,
      connected: connectedCount,
    });
    res.status(200).json({ integrations });
  } catch (err) {
    logger.error("me.integrations failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "integrations_query_failed" });
  }
});

meRouter.get("/v1/me/integrations/:provider", requireClerkAuth, async (req, res) => {
  const clerkUserId = req.clerkUserId as string;
  const provider = req.params.provider ?? "";

  if (!isKnownProvider(provider)) {
    res.status(404).json({ error: "unknown_provider" });
    return;
  }

  try {
    const user = await getOrCreateUserByClerkId(clerkUserId);
    const all = await getUserIntegrationStatus(user.id);
    const integration = all.find((i) => i.provider === provider);
    if (!integration) {
      // Known provider but not user-facing (e.g. internal stub).
      res.status(404).json({ error: "unknown_provider" });
      return;
    }
    logger.info("me.integration status served", { connected: integration.connected });
    res.status(200).json({ integration });
  } catch (err) {
    logger.error("me.integration status failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "integration_query_failed" });
  }
});

meRouter.post(
  "/v1/me/integrations/:provider/connect",
  requireClerkAuth,
  (req, res) => {
    const provider = req.params.provider ?? "";
    if (!isKnownProvider(provider)) {
      res.status(404).json({ error: "unknown_provider" });
      return;
    }
    // Real OAuth (Authorization Code + PKCE via the system browser) arrives in a
    // later section. Nothing is connected and no token is issued here.
    logger.info("me.integration connect not implemented", { provider });
    res.status(501).json({ status: "not_implemented" });
  },
);

meRouter.post(
  "/v1/me/integrations/:provider/disconnect",
  requireClerkAuth,
  async (req, res) => {
    const clerkUserId = req.clerkUserId as string;
    const provider = req.params.provider ?? "";

    if (!isKnownProvider(provider)) {
      res.status(404).json({ error: "unknown_provider" });
      return;
    }

    try {
      const user = await getOrCreateUserByClerkId(clerkUserId);
      const changed = await disconnectIntegrationConnection(user.id, provider);
      logger.info("me.integration disconnected", { provider, changed });
      // Idempotent: disconnecting an already-disconnected provider is a success.
      res.status(200).json({ ok: true, changed });
    } catch (err) {
      logger.error("me.integration disconnect failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
      res.status(500).json({ error: "integration_disconnect_failed" });
    }
  },
);

// --- Section 12: agentic action runtime ----------------------------------
//
// Backend-only inspection + confirmation endpoints for the action runtime. No
// frontend UI consumes these yet. A user only ever sees their OWN proposals and
// executions; responses carry sanitised action metadata only — never a token or
// a raw provider payload.

meRouter.get("/v1/me/actions/catalog", requireClerkAuth, (_req, res) => {
  // Static, non-sensitive action metadata (no user data, no secrets).
  res.status(200).json({ actions: listActionDefinitions() });
});

meRouter.get("/v1/me/actions/proposals", requireClerkAuth, async (req, res) => {
  const clerkUserId = req.clerkUserId as string;

  try {
    const user = await getOrCreateUserByClerkId(clerkUserId);
    const proposals = await listProposalsForUser(user.id);
    logger.info("me.actions.proposals served", { count: proposals.length });
    res.status(200).json({ proposals });
  } catch (err) {
    logger.error("me.actions.proposals failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "proposals_query_failed" });
  }
});

meRouter.get("/v1/me/actions/executions", requireClerkAuth, async (req, res) => {
  const clerkUserId = req.clerkUserId as string;

  try {
    const user = await getOrCreateUserByClerkId(clerkUserId);
    const executions = await listExecutionsForUser(user.id);
    logger.info("me.actions.executions served", { count: executions.length });
    res.status(200).json({ executions });
  } catch (err) {
    logger.error("me.actions.executions failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "executions_query_failed" });
  }
});

meRouter.post(
  "/v1/me/actions/proposals/:id/confirm",
  requireClerkAuth,
  async (req, res) => {
    const clerkUserId = req.clerkUserId as string;
    const proposalId = req.params.id;
    if (!proposalId) {
      res.status(400).json({ error: "missing_proposal_id" });
      return;
    }

    try {
      const user = await getOrCreateUserByClerkId(clerkUserId);
      const existing = await getProposalForUser(user.id, proposalId);
      if (!existing) {
        res.status(404).json({ error: "proposal_not_found" });
        return;
      }
      if (existing.status !== "proposed") {
        res.status(409).json({ error: "proposal_not_pending", status: existing.status });
        return;
      }
      if (new Date(existing.expiresAt).getTime() <= Date.now()) {
        res.status(409).json({ error: "proposal_expired" });
        return;
      }

      const confirmed = await confirmProposal(user.id, proposalId);
      if (!confirmed) {
        res.status(409).json({ error: "proposal_not_pending" });
        return;
      }

      const result = await executeAction(user.id, existing.actionId, {
        input: existing.input ?? undefined,
        userConfirmed: true,
        proposalId,
      });
      await finalizeProposal(user.id, proposalId, result.ok ? "executed" : "failed");

      logger.info("me.actions.confirm", { actionId: existing.actionId, ok: result.ok });
      res.status(200).json({
        ok: result.ok,
        status: result.status,
        message: result.userMessage,
      });
    } catch (err) {
      logger.error("me.actions.confirm failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
      res.status(500).json({ error: "proposal_confirm_failed" });
    }
  },
);

meRouter.post(
  "/v1/me/actions/proposals/:id/reject",
  requireClerkAuth,
  async (req, res) => {
    const clerkUserId = req.clerkUserId as string;
    const proposalId = req.params.id;
    if (!proposalId) {
      res.status(400).json({ error: "missing_proposal_id" });
      return;
    }

    try {
      const user = await getOrCreateUserByClerkId(clerkUserId);
      const rejected = await rejectProposal(user.id, proposalId);
      if (!rejected) {
        // Either not found for this user, or already resolved.
        const existing = await getProposalForUser(user.id, proposalId);
        res
          .status(existing ? 409 : 404)
          .json({ error: existing ? "proposal_not_pending" : "proposal_not_found" });
        return;
      }
      logger.info("me.actions.reject", { proposalId });
      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error("me.actions.reject failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
      res.status(500).json({ error: "proposal_reject_failed" });
    }
  },
);

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
