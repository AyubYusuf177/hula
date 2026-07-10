import type { InboundMessage } from "../channels/types";
import type { Channel, Provider } from "../channels/types";
import { normalizeHandleKey } from "../users/messagingIdentity";
import { logger } from "../utils/logger";
import { getPrisma } from "./prisma";

/**
 * Message + provider-event persistence (Section 4).
 *
 * These helpers begin storing conversations, messages, and a SAFE SUMMARY of
 * each provider event. They are intentionally best-effort: every entry point is
 * wrapped so a database failure logs and returns gracefully instead of breaking
 * the fast webhook acknowledgement or the outbound reply. Raw webhook payloads
 * are never stored — only a redacted summary.
 */

/** Mask a handle for logs: keep only the last 4 characters. */
function maskHandle(handle: string): string {
  if (handle.length <= 4) return "****";
  return `****${handle.slice(-4)}`;
}

/**
 * Find or create the conversation for a given user/handle on a channel+provider.
 * The normalized sender handle is used as the external thread id so the same
 * thread is reused across restarts (and before/after the sender is linked).
 */
async function findOrCreateConversation(params: {
  userId: string | null;
  channel: Channel;
  provider: Provider;
  handle: string;
}): Promise<string> {
  const prisma = getPrisma();
  const externalThreadId = normalizeHandleKey(params.handle);

  const existing = await prisma.conversation.findFirst({
    where: {
      channel: params.channel,
      provider: params.provider,
      externalThreadId,
    },
    select: { id: true, userId: true },
  });

  if (existing) {
    // Backfill the user id once the sender becomes linked.
    if (!existing.userId && params.userId) {
      await prisma.conversation.update({
        where: { id: existing.id },
        data: { userId: params.userId },
      });
    }
    return existing.id;
  }

  const created = await prisma.conversation.create({
    data: {
      userId: params.userId,
      channel: params.channel,
      provider: params.provider,
      externalThreadId,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Persist an inbound provider event + message. Best-effort: on any failure it
 * logs a masked summary and returns `null` so the webhook flow continues.
 * Returns the conversation id (when created) so the outbound reply can be tied
 * to the same thread.
 */
export async function recordInbound(params: {
  message: InboundMessage;
  userId?: string | null;
  outcomeStatus: string;
  codeMatched: boolean;
}): Promise<{ conversationId: string | null }> {
  const { message } = params;
  const userId = params.userId ?? null;

  try {
    const prisma = getPrisma();

    // Safe summary only — NEVER the raw payload or message text/media urls.
    await prisma.providerEvent.create({
      data: {
        provider: message.provider,
        eventType: "inbound_message",
        providerMessageId: message.providerMessageId ?? null,
        payloadSummaryJson: {
          channel: message.channel,
          contentType: message.content.type,
          hasText: Boolean(message.content.text),
          attachmentCount: message.content.attachments?.length ?? 0,
          isIMessage: message.isIMessage ?? false,
          linkOutcome: params.outcomeStatus,
          codeMatched: params.codeMatched,
        },
      },
    });

    const conversationId = await findOrCreateConversation({
      userId,
      channel: message.channel,
      provider: message.provider,
      handle: message.senderHandle,
    });

    await prisma.message.create({
      data: {
        conversationId,
        userId,
        direction: "inbound",
        channel: message.channel,
        provider: message.provider,
        providerMessageId: message.providerMessageId ?? null,
        senderHandle: message.senderHandle,
        recipientHandle: message.recipientHandle || null,
        text: message.content.text ?? null,
        status: "received",
      },
    });

    return { conversationId };
  } catch (err) {
    logger.error("persist.recordInbound failed", {
      sender: maskHandle(message.senderHandle),
      providerMessageId: message.providerMessageId,
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { conversationId: null };
  }
}

/**
 * Persist an outbound reply message. Best-effort: failures are logged (masked)
 * and swallowed so a persistence problem never affects the user-facing reply.
 */
export async function recordOutbound(params: {
  conversationId: string | null;
  userId?: string | null;
  channel: Channel;
  provider: Provider;
  recipientHandle: string;
  text: string;
  providerMessageId?: string;
  status?: string;
}): Promise<void> {
  try {
    await getPrisma().message.create({
      data: {
        conversationId: params.conversationId,
        userId: params.userId ?? null,
        direction: "outbound",
        channel: params.channel,
        provider: params.provider,
        providerMessageId: params.providerMessageId ?? null,
        senderHandle: null,
        recipientHandle: params.recipientHandle,
        text: params.text,
        status: params.status ?? "sent",
      },
    });
  } catch (err) {
    logger.error("persist.recordOutbound failed", {
      to: maskHandle(params.recipientHandle),
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}
