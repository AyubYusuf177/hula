import { sendMessage } from "../channels/sendblue/client";
import type { Channel, Provider } from "../channels/types";
import { recordOutbound } from "../db/persist";
import { getPrisma } from "../db/prisma";
import { getSendableIdentityForUser } from "../users/messagingIdentity";
import { logger } from "../utils/logger";
import { computeNextRun } from "./parse";
import type { RecurrenceRule } from "./types";

/**
 * Reminder delivery worker (Section 9).
 *
 * A conservative, local-only poller: on a fixed interval it looks for due
 * reminders (status `scheduled` with `nextRunAt <= now`) and delivers each as a
 * proactive iMessage via Sendblue. Delivery text is DETERMINISTIC — Hula never
 * calls Anthropic to send a due reminder, which keeps cost and latency out of
 * the hot path.
 *
 * Safety / spam controls:
 *   - At most `MAX_PER_TICK` reminders are sent per tick.
 *   - Overlapping ticks are skipped (a single in-process guard) so a slow tick
 *     can't double-send.
 *   - One-off reminders are marked `sent` after delivery; recurring reminders
 *     advance `nextRunAt`. Both updates are guarded on `status: scheduled` so a
 *     reminder can't be delivered twice.
 *   - A send failure (or no active identity) marks the reminder `failed` with a
 *     reason rather than retrying forever — conservative by design.
 */

/** How often the worker checks for due reminders. */
const DEFAULT_INTERVAL_MS = 30_000;
/** Hard cap on reminders delivered in a single tick (spam/cost guard). */
const MAX_PER_TICK = 10;

/** Injectable sender so the worker can be driven with a stub in tests. */
export interface ReminderSender {
  (to: string, text: string, channel: Channel, provider: Provider): Promise<{
    providerMessageId?: string;
    status?: string;
  }>;
}

/** Default sender: Sendblue iMessage. */
const defaultSender: ReminderSender = async (to, text) => {
  const res = await sendMessage(to, text);
  return {
    providerMessageId:
      typeof res.message_handle === "string" ? res.message_handle : undefined,
    status: typeof res.status === "string" ? res.status : "sent",
  };
};

/** Pure: the deterministic delivery text for a reminder (no Anthropic call). */
export function buildReminderText(title: string, body?: string | null): string {
  return body && body.trim() ? `Reminder: ${title}\n${body.trim()}` : `Reminder: ${title}`;
}

interface DueReminder {
  id: string;
  userId: string;
  title: string;
  body: string | null;
  channel: string;
  provider: string;
  dueAt: Date;
  nextRunAt: Date | null;
  recurrenceRule: string | null;
  sendCount: number;
  maxSends: number;
}

/**
 * Run a single delivery tick. Selects due reminders and delivers them. Returns a
 * small summary for logging/testing. `send` is injectable so tests can avoid
 * real Sendblue traffic. Never throws — per-reminder failures are isolated.
 */
export async function runReminderTick(
  now: Date = new Date(),
  send: ReminderSender = defaultSender,
): Promise<{ due: number; sent: number; failed: number }> {
  const prisma = getPrisma();

  const due = (await prisma.reminder.findMany({
    where: { status: "scheduled", nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: MAX_PER_TICK,
    select: {
      id: true,
      userId: true,
      title: true,
      body: true,
      channel: true,
      provider: true,
      dueAt: true,
      nextRunAt: true,
      recurrenceRule: true,
      sendCount: true,
      maxSends: true,
    },
  })) as DueReminder[];

  let sent = 0;
  let failed = 0;

  for (const reminder of due) {
    const outcome = await deliverOne(reminder, now, send);
    if (outcome === "sent") sent += 1;
    else if (outcome === "failed") failed += 1;
  }

  return { due: due.length, sent, failed };
}

/** Deliver one reminder. Isolated so one failure never aborts the tick. */
async function deliverOne(
  reminder: DueReminder,
  now: Date,
  send: ReminderSender,
): Promise<"sent" | "failed" | "skipped"> {
  const prisma = getPrisma();

  // Resolve where to send. No active identity → mark failed (conservative).
  const identity = await getSendableIdentityForUser(reminder.userId);
  if (!identity) {
    await markFailed(reminder.id, "no active messaging identity");
    return "failed";
  }

  const text = buildReminderText(reminder.title, reminder.body);

  try {
    const res = await send(identity.handle, text, identity.channel, identity.provider);

    // Atomically claim the send: only advance/complete if still scheduled. This
    // stops a second overlapping tick from delivering the same reminder twice.
    const nextSendCount = reminder.sendCount + 1;
    const isRecurring = Boolean(reminder.recurrenceRule);
    const hasMoreRuns = isRecurring && nextSendCount < reminder.maxSends;

    let claim;
    if (hasMoreRuns) {
      const anchor = reminder.nextRunAt ?? reminder.dueAt;
      const nextRunAt = computeNextRun(anchor, reminder.recurrenceRule as RecurrenceRule, now);
      claim = await prisma.reminder.updateMany({
        where: { id: reminder.id, status: "scheduled" },
        data: { lastSentAt: now, sendCount: nextSendCount, nextRunAt, failureReason: null },
      });
    } else {
      claim = await prisma.reminder.updateMany({
        where: { id: reminder.id, status: "scheduled" },
        data: { status: "sent", lastSentAt: now, sendCount: nextSendCount, failureReason: null },
      });
    }

    // If nothing was updated, another tick already handled it — don't persist a
    // duplicate outbound message.
    if (claim.count === 0) return "skipped";

    // Persist the outbound reminder message (best-effort; tied to the user).
    await recordOutbound({
      conversationId: null,
      userId: reminder.userId,
      channel: identity.channel,
      provider: identity.provider,
      recipientHandle: identity.handle,
      text,
      providerMessageId: res.providerMessageId,
      status: res.status ?? "sent",
    });

    logger.info("reminders.worker delivered", {
      recurring: isRecurring,
      remaining: hasMoreRuns ? reminder.maxSends - nextSendCount : 0,
    });
    return "sent";
  } catch (err) {
    await markFailed(reminder.id, err instanceof Error ? err.message.slice(0, 200) : "send failed");
    logger.error("reminders.worker delivery failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return "failed";
  }
}

/** Mark a reminder failed with a short reason (guarded on `scheduled`). */
async function markFailed(reminderId: string, reason: string): Promise<void> {
  try {
    await getPrisma().reminder.updateMany({
      where: { id: reminderId, status: "scheduled" },
      data: { status: "failed", failureReason: reason },
    });
  } catch {
    // Nothing more we can safely do here.
  }
}

// --- Interval lifecycle --------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * Start the reminder worker on an interval. Idempotent — calling twice is a
 * no-op. Overlapping ticks are skipped via the `ticking` guard. Only starts when
 * `DATABASE_URL` is configured (there is nothing to poll otherwise).
 */
export function startReminderWorker(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  if (!process.env.DATABASE_URL) {
    logger.warn("reminders.worker not started — DATABASE_URL is not set");
    return;
  }

  logger.info("reminders.worker started", { intervalMs });
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void runReminderTick()
      .catch((err) => {
        logger.error("reminders.worker tick error", {
          reason: err instanceof Error ? err.message : "unknown error",
        });
      })
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);

  // Don't keep the event loop alive solely for the worker. `unref` only exists
  // on Node's timer handle; guard via a portable shape so this also compiles
  // under the app's (DOM-typed) tsconfig where `setInterval` returns a number.
  const handle = timer as unknown as { unref?: () => void };
  if (typeof handle.unref === "function") handle.unref();
}

/** Stop the reminder worker (used in tests / graceful shutdown). */
export function stopReminderWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
