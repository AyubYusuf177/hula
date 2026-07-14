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
import { generateHulaReply } from "../ai/hulaBrain";
import type { BrainMessage } from "../ai/hulaBrain";
import { sanitizeBrainReply } from "../ai/operationalGuard";
import { env } from "../config/env";
import { recordInbound, recordOutbound } from "../db/persist";
import { listRecentBrainMessages } from "../db/queries";
import { resolveInboundLink } from "../users/linking";
import { loadBrainContextForUser } from "../users/profile";
import { buildMemoryContext, handleMemoryCommand } from "../users/memory";
import { listConnectedProviderNames } from "../integrations/connections";
import { handleCalendarQuestion } from "../integrations/providers/googleCalendar/calendarQuestion";
import { handleCalendarWrite } from "../integrations/providers/googleCalendar/calendarActions";
import { handleGmailQuestion } from "../integrations/providers/gmail/gmailQuestion";
import { handleGmailReadOne } from "../integrations/providers/gmail/gmailReadOne";
import {
  handleGmailClarification,
  handleGmailDraftFollowup,
  handleGmailWrite,
} from "../integrations/providers/gmail/gmailActions";
import {
  handleActionConfirmation,
  handlePendingProposalReprompt,
} from "../actions/confirmations";
import { handleActionIntent } from "../actions/detect";
import { handleReminderCommand } from "../reminders/reminders";
import type { HulaPromptContext } from "../ai/prompts";
import { logger } from "../utils/logger";

/**
 * Sendblue webhook routes.
 *
 * Sendblue POSTs inbound messages (and outbound status callbacks) here. We must
 * acknowledge with a 2xx within 45 seconds, so the handler responds immediately
 * and then processes the message on a detached async task.
 *
 * Reply routing (Section 6):
 *   - Connect-code and unknown-sender messages keep their DETERMINISTIC replies
 *     from the linking flow (see `users/linking`) and never call the AI brain.
 *   - A NORMAL message from an already-linked sender is answered by the Hula
 *     brain (Anthropic Claude, see `ai/hulaBrain`), with a safe fallback reply
 *     if the provider is unavailable.
 *
 * Linking state and all inbound/outbound messages are persisted to Postgres
 * (see `db/persist`); the brain reads recent turns back via `db/queries`.
 */
export const sendblueWebhookRouter = Router();

/**
 * In-memory de-duplication of provider message ids. Sendblue may retry a
 * webhook; this Set prevents double replies within a single process lifetime.
 * Kept process-level on purpose (retries arrive within seconds) even though
 * messages are now persisted. Bounded so it can't grow without limit.
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
 * Decide the reply text for an already-linked normal message by calling the Hula
 * brain. Loads recent conversation turns as short-term memory; if persistence
 * gave us no conversation (or the load fails), falls back to the current message
 * text so the brain still has the user's latest turn. Never throws — the brain
 * itself resolves any provider failure to a safe fallback reply.
 */
async function generateBrainReply(
  message: InboundMessage,
  conversationId: string | null,
  userId: string | null,
): Promise<{ reply: string; usedFallback: boolean; historyCount: number }> {
  let history: BrainMessage[] = [];
  if (conversationId) {
    try {
      history = await listRecentBrainMessages(conversationId);
    } catch (err) {
      logger.error("sendblue.webhook brain history load failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  // If nothing was loaded (no conversation / load failed), seed with the current
  // message text so the brain always has the user's latest turn.
  if (history.length === 0 && message.content.text) {
    history = [{ role: "user", text: message.content.text }];
  }

  // Load the user's safe profile context (best-effort). A missing profile or a
  // load failure just means the brain personalises less — it never blocks the
  // reply.
  let context: HulaPromptContext = { channel: message.channel };
  if (userId) {
    try {
      const profileContext = await loadBrainContextForUser(userId);
      context = { ...profileContext, channel: message.channel };
    } catch (err) {
      logger.error("sendblue.webhook brain profile load failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }

    // Load explicit long-term memories (Section 8) so the brain can use them
    // lightly. `buildMemoryContext` is best-effort and never throws.
    const memories = await buildMemoryContext(userId);
    if (memories.length > 0) context = { ...context, memories };

    // Connected integrations (Section 10) — display names only, never tokens or
    // scopes. Today this is always empty (no real connect flow yet); it keeps
    // Hula honest without letting it claim it can act on any app.
    try {
      const connectedProviders = await listConnectedProviderNames(userId);
      if (connectedProviders.length > 0) {
        context = { ...context, connectedProviders };
      }
    } catch (err) {
      logger.error("sendblue.webhook integration status load failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  const { reply, usedFallback } = await generateHulaReply({ history, context });

  // Operational-honesty backstop (Section 16): the brain never holds an action
  // receipt, so any completion claim it produces ("Reply sent to …") is a
  // fabrication. Deterministic handlers (which DO carry receipts) never reach this
  // path. If the brain fabricated a success, substitute an honest reply.
  const sanitized = sanitizeBrainReply(reply);
  if (sanitized.blocked) {
    logger.warn("sendblue.webhook brain fabricated-success blocked");
  }
  return { reply: sanitized.text, usedFallback, historyCount: history.length };
}

/**
 * Handle an inbound user message: mark read, show typing, then reply. A normal
 * message from an already-linked sender is answered by the Hula brain; every
 * other case keeps its deterministic linking reply. Runs detached from the HTTP
 * response. Best-effort steps (read/typing) never abort the reply; a failed
 * reply is logged safely.
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

  // Decide the reply from the linking state (DB-backed, no AI). This also links
  // the sender to their Hula user when a valid connect code is present.
  const outcome = await resolveInboundLink({
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

  // Persist the inbound event + message (best-effort; never blocks the reply).
  const { conversationId } = await recordInbound({
    message,
    userId: outcome.userId ?? null,
    outcomeStatus: outcome.status,
    codeMatched: outcome.codeMatched,
  });

  // Best-effort presence signals — these must not block or fail the reply.
  await markRead(to);
  await sendTypingIndicator(to);

  // Normal messages from linked users get an AI reply; connect-code and unknown
  // sender flows keep their deterministic linking reply (no brain call).
  let replyText = outcome.reply;
  if (outcome.brainEligible) {
    const userId = outcome.userId ?? null;

    // Explicit memory commands ("remember …", "forget …", "what do you
    // remember") are handled DETERMINISTICALLY and never call the brain.
    const memory = userId
      ? await handleMemoryCommand(userId, message.content.text)
      : { handled: false as const };

    // Explicit reminder commands ("remind me …", "what reminders do I have",
    // "cancel my … reminder") are handled DETERMINISTICALLY after memory and
    // before the brain — they never call Anthropic.
    const reminder =
      userId && !(memory.handled && memory.reply)
        ? await handleReminderCommand(userId, message.content.text)
        : { handled: false as const };

    // Action confirmations (Section 12). A short "yes"/"do it"/"cancel" resolves
    // the user's single ACTIVE action proposal (if any). Runs before the calendar
    // read and brain so a confirmation is never misrouted; a "yes" with no pending
    // proposal is a no-op and falls through.
    const confirmation =
      userId &&
      !(memory.handled && memory.reply) &&
      !(reminder.handled && reminder.reply)
        ? await handleActionConfirmation(userId, message.content.text)
        : { handled: false as const };

    // Gmail reply-target CLARIFICATION (Section 16 live-fix). When Hula listed
    // several matching emails and asked "which one?", a short "2" / "option 2" /
    // "the second one" / "actually 2" resolves against the EXACT thread it stored.
    // Runs AFTER confirmations (so an existing send/confirm path is untouched) and
    // only when a valid pending clarification exists AND the message reads as a
    // selection; otherwise it falls through unchanged and never intercepts an
    // ordinary number or unrelated message.
    const gmailClarify =
      userId &&
      !(memory.handled && memory.reply) &&
      !(reminder.handled && reminder.reply) &&
      !(confirmation.handled && confirmation.reply)
        ? await handleGmailClarification(userId, message.content.text)
        : { handled: false as const };

    // Gmail DRAFT FOLLOW-UP (Section 16 live-fix) — "send the draft", "send it",
    // "send the draft to Rob". After Hula creates a REAL Gmail draft it remembers a
    // safe, expiring reference to it; this resolves that exact draft and sends the
    // ACTUAL draft via Gmail's draft-send operation (never a reconstructed message,
    // never a guessed id). Runs AFTER confirmation/clarification and BEFORE the
    // Gmail write handler so "send the draft" is never re-extracted as a new
    // compose or fabricated as a success by the brain. A bare "send it" with no
    // stored draft falls through unchanged; an explicit "send the draft" with none
    // is answered honestly.
    const gmailDraftFollowup =
      userId &&
      !(memory.handled && memory.reply) &&
      !(reminder.handled && reminder.reply) &&
      !(confirmation.handled && confirmation.reply) &&
      !(gmailClarify.handled && gmailClarify.reply)
        ? await handleGmailDraftFollowup(userId, message.content.text)
        : { handled: false as const };

    // Calendar WRITES (Section 15) — "schedule lunch with Adam tomorrow at 1pm",
    // "move lunch with Adam to 2pm", "delete lunch with Adam tomorrow". These
    // create/update/delete real events on the user's connected Google Calendar via
    // the dedicated Calendar action service (model extraction → deterministic
    // validation → provider write → confirmation from Google's response). Runs
    // before the generic action-intent stub so an imperative "schedule …" performs
    // the write instead of the honest "not enabled yet" reply; if the model can't
    // be reached this returns handled:false and falls through to that stub.
    const calendarWrite =
      userId &&
      !(memory.handled && memory.reply) &&
      !(reminder.handled && reminder.reply) &&
      !(confirmation.handled && confirmation.reply) &&
      !(gmailClarify.handled && gmailClarify.reply) &&
      !(gmailDraftFollowup.handled && gmailDraftFollowup.reply)
        ? await handleCalendarWrite(userId, message.content.text)
        : { handled: false as const };

    // Gmail WRITES (Section 16) — "send Rob an email saying …", "draft a reply to
    // Rob's latest email". These create real Gmail drafts IMMEDIATELY, or — for an
    // actual send — create a persisted Section 12 proposal that only a subsequent
    // "yes" executes. Runs BEFORE the generic action-intent stub and the Gmail READ
    // handler so an imperative "send/draft an email …" composes instead of being
    // read as an inbox question or an "not enabled" stub. A read request ("send me
    // the latest email from Rob") is NOT matched and falls through to the read
    // path; if the model can't be reached this returns handled:false and falls
    // through too.
    const gmailWrite =
      userId &&
      !(memory.handled && memory.reply) &&
      !(reminder.handled && reminder.reply) &&
      !(confirmation.handled && confirmation.reply) &&
      !(gmailClarify.handled && gmailClarify.reply) &&
      !(gmailDraftFollowup.handled && gmailDraftFollowup.reply) &&
      !(calendarWrite.handled && calendarWrite.reply)
        ? await handleGmailWrite(userId, message.content.text)
        : { handled: false as const };

    // Imperative action intents (Section 12) — "create a task …". These map to
    // typed Hula actions; still-stubbed write/send actions reply HONESTLY that the
    // action isn't enabled yet. Calendar and Gmail writes are handled above, so
    // they never reach here.
    const actionIntent =
      userId &&
      !(memory.handled && memory.reply) &&
      !(reminder.handled && reminder.reply) &&
      !(confirmation.handled && confirmation.reply) &&
      !(gmailClarify.handled && gmailClarify.reply) &&
      !(gmailDraftFollowup.handled && gmailDraftFollowup.reply) &&
      !(calendarWrite.handled && calendarWrite.reply) &&
      !(gmailWrite.handled && gmailWrite.reply)
        ? await handleActionIntent(userId, message.content.text)
        : { handled: false as const };

    // Calendar questions ("what's on my calendar today", "when's my next
    // meeting") are answered from the user's connected Google Calendar (Section
    // 11), read-only. Handled after memory/reminders/actions and before the
    // brain. If Google Calendar isn't connected, this replies honestly.
    const calendar =
      userId &&
      !(memory.handled && memory.reply) &&
      !(reminder.handled && reminder.reply) &&
      !(confirmation.handled && confirmation.reply) &&
      !(gmailClarify.handled && gmailClarify.reply) &&
      !(gmailDraftFollowup.handled && gmailDraftFollowup.reply) &&
      !(calendarWrite.handled && calendarWrite.reply) &&
      !(gmailWrite.handled && gmailWrite.reply) &&
      !(actionIntent.handled && actionIntent.reply)
        ? await handleCalendarQuestion(userId, message.content.text)
        : { handled: false as const };

    // Gmail READ-ONE / SUMMARISE-ONE (Section 16 / Fix 4) — "what does Rob's
    // latest email say", "summarise Rob's most recent email". Resolves ONE newest
    // matching message and answers strictly from its real body. Runs BEFORE the
    // list handler so a specific-email content question is never answered with the
    // inbox list; a plain list query ("what are my latest emails") isn't matched
    // here and falls through to the list handler below.
    const gmailReadOne =
      userId &&
      !(memory.handled && memory.reply) &&
      !(reminder.handled && reminder.reply) &&
      !(confirmation.handled && confirmation.reply) &&
      !(gmailClarify.handled && gmailClarify.reply) &&
      !(gmailDraftFollowup.handled && gmailDraftFollowup.reply) &&
      !(calendarWrite.handled && calendarWrite.reply) &&
      !(gmailWrite.handled && gmailWrite.reply) &&
      !(actionIntent.handled && actionIntent.reply) &&
      !(calendar.handled && calendar.reply)
        ? await handleGmailReadOne(userId, message.content.text)
        : { handled: false as const };

    // Gmail questions ("do I have any important emails", "what are my latest
    // emails", "any unread emails") are answered read-only from the user's
    // connected Gmail (Section 14). Handled after the calendar read and before
    // the brain, and only when nothing earlier already replied. A supported Gmail
    // question never falls through to the model; if Gmail isn't connected this
    // replies honestly. Gmail and Calendar are independent — neither's connection
    // state affects the other.
    const gmail =
      userId &&
      !(memory.handled && memory.reply) &&
      !(reminder.handled && reminder.reply) &&
      !(confirmation.handled && confirmation.reply) &&
      !(gmailClarify.handled && gmailClarify.reply) &&
      !(gmailDraftFollowup.handled && gmailDraftFollowup.reply) &&
      !(calendarWrite.handled && calendarWrite.reply) &&
      !(gmailWrite.handled && gmailWrite.reply) &&
      !(actionIntent.handled && actionIntent.reply) &&
      !(calendar.handled && calendar.reply) &&
      !(gmailReadOne.handled && gmailReadOne.reply)
        ? await handleGmailQuestion(userId, message.content.text)
        : { handled: false as const };

    if (memory.handled && memory.reply) {
      replyText = memory.reply;
      logger.info("sendblue.webhook memory command", {
        sender: maskHandle(to),
        intent: memory.intent,
      });
    } else if (reminder.handled && reminder.reply) {
      replyText = reminder.reply;
      logger.info("sendblue.webhook reminder command", {
        sender: maskHandle(to),
        intent: reminder.intent,
      });
    } else if (confirmation.handled && confirmation.reply) {
      replyText = confirmation.reply;
      logger.info("sendblue.webhook action confirmation", {
        sender: maskHandle(to),
        outcome: confirmation.outcome,
      });
    } else if (gmailClarify.handled && gmailClarify.reply) {
      replyText = gmailClarify.reply;
      logger.info("sendblue.webhook gmail clarification", {
        sender: maskHandle(to),
        action: gmailClarify.action,
      });
    } else if (gmailDraftFollowup.handled && gmailDraftFollowup.reply) {
      replyText = gmailDraftFollowup.reply;
      logger.info("sendblue.webhook gmail draft follow-up", {
        sender: maskHandle(to),
      });
    } else if (calendarWrite.handled && calendarWrite.reply) {
      replyText = calendarWrite.reply;
      logger.info("sendblue.webhook calendar write", {
        sender: maskHandle(to),
        action: calendarWrite.action,
      });
    } else if (gmailWrite.handled && gmailWrite.reply) {
      replyText = gmailWrite.reply;
      logger.info("sendblue.webhook gmail write", {
        sender: maskHandle(to),
        action: gmailWrite.action,
      });
    } else if (actionIntent.handled && actionIntent.reply) {
      replyText = actionIntent.reply;
      logger.info("sendblue.webhook action intent", {
        sender: maskHandle(to),
        actionId: actionIntent.actionId,
      });
    } else if (calendar.handled && calendar.reply) {
      replyText = calendar.reply;
      logger.info("sendblue.webhook calendar question", {
        sender: maskHandle(to),
        intent: calendar.intent,
      });
    } else if (gmailReadOne.handled && gmailReadOne.reply) {
      replyText = gmailReadOne.reply;
      logger.info("sendblue.webhook gmail read-one", {
        sender: maskHandle(to),
        mode: gmailReadOne.mode,
      });
    } else if (gmail.handled && gmail.reply) {
      replyText = gmail.reply;
      logger.info("sendblue.webhook gmail question", {
        sender: maskHandle(to),
        intent: gmail.intent,
      });
    } else {
      // Safety net (Fix 1): while a confirmable action awaits yes/no, an
      // unrecognised reply must NEVER reach the generic brain — which could
      // hallucinate an operational success ("sent!"). Re-prompt deterministically
      // and keep the action safely pending. No active proposal → normal brain.
      const guard = userId
        ? await handlePendingProposalReprompt(userId)
        : { handled: false as const };
      if (guard.handled && guard.reply) {
        replyText = guard.reply;
        logger.info("sendblue.webhook pending-proposal reprompt", {
          sender: maskHandle(to),
        });
      } else {
        const brain = await generateBrainReply(message, conversationId, userId);
        replyText = brain.reply;
        logger.info("sendblue.webhook brain reply", {
          sender: maskHandle(to),
          usedFallback: brain.usedFallback,
          historyCount: brain.historyCount,
        });
      }
    }
  }

  try {
    const response = await sendMessage(to, replyText);
    // Persist the outbound reply (best-effort; failures never affect delivery).
    await recordOutbound({
      conversationId,
      userId: outcome.userId ?? null,
      channel: message.channel,
      provider: message.provider,
      recipientHandle: to,
      text: replyText,
      providerMessageId:
        typeof response.message_handle === "string"
          ? response.message_handle
          : undefined,
      status: typeof response.status === "string" ? response.status : "sent",
    });
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
