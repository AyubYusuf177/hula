import { Router } from "express";

import {
  markRead,
  sendMessage,
  sendTypingIndicator,
} from "../channels/sendblue/client";
import {
  digitsOf,
  isInboundUserMessage,
  isPlaceholderHandle,
  normalizeSendblueInbound,
} from "../channels/sendblue/normalize";
import type { SendblueInboundWebhook } from "../channels/sendblue/types";
import type { InboundMessage } from "../channels/types";
import { env } from "../config/env";
import { resolveInboundLink } from "../users/linking";
import { logger } from "../utils/logger";

/**
 * Sendblue webhook routes.
 *
 * Sendblue POSTs inbound messages (and outbound status callbacks) here. We must
 * acknowledge with a 2xx within 45 seconds, so the handler responds immediately
 * and then processes the message on a detached async task. Section 3 replies
 * based on the connect-code linking flow (see `users/linking`) — still no AI and
 * only in-memory state.
 */
export const sendblueWebhookRouter = Router();

/**
 * In-memory de-duplication of provider message ids. Sendblue may retry a
 * webhook; without persistence (no DB yet) this Set prevents double replies
 * within a single process lifetime. Section 2 only — replace with real storage
 * later. Bounded so it can't grow unboundedly in a long-running process.
 */
const seenMessageIds = new Set<string>();
const MAX_SEEN_IDS = 5000;

function rememberMessageId(id: string): void {
  if (seenMessageIds.size >= MAX_SEEN_IDS) {
    // Drop the oldest entry (insertion order) to keep the Set bounded.
    const oldest = seenMessageIds.values().next().value;
    if (oldest !== undefined) seenMessageIds.delete(oldest);
  }
  seenMessageIds.add(id);
}

/** Mask a handle for logs: keep only the last 4 characters. */
function maskHandle(handle: string): string {
  if (handle.length <= 4) return "****";
  return `****${handle.slice(-4)}`;
}

/**
 * True when the resolved recipient is our own Hula line. We must never reply to
 * ourselves — that would happen if the sender couldn't be extracted and fell
 * back to the line the message was received on.
 */
function isHulaLine(handle: string): boolean {
  const hula = env.SENDBLUE_HULA_NUMBER;
  if (!hula) return false;
  return digitsOf(handle) === digitsOf(hula);
}

/**
 * Log only safe, non-sensitive summary fields from an inbound message. Never
 * logs message text, media URLs, credentials, or the full sender number.
 */
function logInboundSummary(message: InboundMessage): void {
  logger.info("sendblue.webhook inbound", {
    providerMessageId: message.providerMessageId,
    channel: message.channel,
    provider: message.provider,
    sender: maskHandle(message.senderHandle),
    contentType: message.content.type,
    hasText: Boolean(message.content.text),
    attachmentCount: message.content.attachments?.length ?? 0,
    isIMessage: message.isIMessage,
  });
}

/**
 * Handle an inbound user message: mark read, show typing, then reply based on
 * the connect-code linking flow. Runs detached from the HTTP response.
 * Best-effort steps (read/typing) never abort the reply; a failed reply is
 * logged safely.
 */
async function processInbound(message: InboundMessage): Promise<void> {
  const to = message.senderHandle;

  // Never send to a missing/placeholder recipient or to our own Hula line.
  // This is what stops accidental outbound to numbers like +10000000000.
  if (isPlaceholderHandle(to) || isHulaLine(to)) {
    logger.warn("Skipping outbound reply: missing or invalid sender.", {
      sender: maskHandle(to),
      providerMessageId: message.providerMessageId,
    });
    return;
  }

  // Decide the reply from the linking state (in-memory, no AI, no DB).
  const outcome = resolveInboundLink({
    senderHandle: to,
    text: message.content.text,
    provider: message.provider,
    channel: message.channel,
  });

  // Safe outcome log: masked sender + linking status only (no code, no text).
  logger.info("sendblue.webhook link outcome", {
    sender: maskHandle(to),
    status: outcome.status,
    codeMatched: outcome.codeMatched,
  });

  // Best-effort presence signals — these must not block or fail the reply.
  await markRead(to);
  await sendTypingIndicator(to);

  try {
    await sendMessage(to, outcome.reply);
  } catch (err) {
    logger.error("sendblue.webhook reply failed", {
      to: maskHandle(to),
      providerMessageId: message.providerMessageId,
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}

sendblueWebhookRouter.post("/webhooks/sendblue", (req, res) => {
  // Accept the payload defensively — never assume its shape.
  const payload = (req.body ?? {}) as SendblueInboundWebhook;

  // Acknowledge immediately so Sendblue's 45s webhook window is satisfied.
  res.status(200).json({ ok: true });

  // Ignore anything that isn't a genuine inbound user message (e.g. our own
  // outbound delivery/read status callbacks).
  if (!isInboundUserMessage(payload)) {
    logger.info("sendblue.webhook ignored non-inbound event", {
      isOutbound: payload.is_outbound === true,
      status: payload.status,
    });
    return;
  }

  const message = normalizeSendblueInbound(payload);
  logInboundSummary(message);

  // De-dupe obvious provider retries within this process.
  const id = message.providerMessageId;
  if (id && seenMessageIds.has(id)) {
    logger.info("sendblue.webhook duplicate ignored", { providerMessageId: id });
    return;
  }
  if (id) rememberMessageId(id);

  // Process detached — the response has already been sent.
  void processInbound(message).catch((err) => {
    logger.error("sendblue.webhook processing error", {
      providerMessageId: id,
      reason: err instanceof Error ? err.message : "unknown error",
    });
  });
});
