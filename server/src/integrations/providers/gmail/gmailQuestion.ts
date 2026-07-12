import { getUserTimezone } from "../../../reminders/reminders";
import { logger } from "../../../utils/logger";
import { GmailError, isReconnectReason } from "./client";
import { fetchRecentGmailMessages } from "./messages";
import { selectLikelyImportant } from "./importance";
import { GMAIL_PROVIDER, type NormalizedGmailMessage } from "./types";

/**
 * Gmail question routing (Section 14) — READ-ONLY.
 *
 * Detects a small, fixed set of Gmail questions in an inbound iMessage from an
 * already-linked user and answers them DETERMINISTICALLY from the user's
 * connected Gmail inbox. It intercepts BEFORE general Anthropic generation: a
 * supported Gmail question is always `handled:true` (with an honest reply), so
 * the model is never asked to invent inbox contents. Ordinary messages return
 * `{ handled:false }` and fall through to the normal Hula brain.
 *
 * Read-only: it never sends, drafts, replies, forwards, deletes, trashes,
 * archives, stars, marks read/unread, or changes labels.
 */

/** The classified Gmail intent (or `none`). */
export type GmailIntent = "important" | "latest" | "today" | "unread" | "none";

/** Fixed, honest replies matching the codebase voice. */
export const GMAIL_REPLIES = {
  notConnected:
    "Your Gmail isn’t connected yet. Connect it from Hula → Integrations → Gmail.",
  reconnect:
    "Your Gmail access needs reconnecting. Open Hula → Integrations → Gmail.",
  unavailable:
    "I couldn’t check Gmail right now. Your connection still appears active, so try again shortly.",
  noImportant:
    "I couldn’t find any recent emails that clearly look important.",
} as const;

// --- Classification (PURE) -----------------------------------------------

// A message must look email-shaped before any intent matches, so ordinary chat
// ("how are you", "thanks") never classifies as a Gmail request.
const EMAIL_KEYWORD_RE = /\b(?:e-?mails?|inbox|gmail)\b/i;

const IMPORTANT_RE = /\bimportant\b/i;
const UNREAD_RE = /\bunread\b/i;
const LATEST_RE = /\b(?:latest|recent|new|newest)\b/i;
const TODAY_RE = /\b(?:today|this morning|this afternoon|this evening|tonight)\b/i;

/**
 * PURE: classify an inbound message as a Gmail question (or `none`). Only clearly
 * email-shaped questions match. Order of precedence: important → today → unread →
 * latest, so "important emails today" resolves to the more specific `important`.
 */
export function classifyGmailQuestion(text: string | undefined): GmailIntent {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "none";
  if (!EMAIL_KEYWORD_RE.test(trimmed)) return "none";

  if (IMPORTANT_RE.test(trimmed)) return "important";
  if (TODAY_RE.test(trimmed)) return "today";
  if (UNREAD_RE.test(trimmed)) return "unread";
  if (LATEST_RE.test(trimmed)) return "latest";

  // A bare "do I have any emails?" defaults to the latest view.
  return "latest";
}

// --- Formatting (PURE) ---------------------------------------------------

/** Format a sender for display: prefer the name, else the address, else a stub. */
function senderLabel(msg: NormalizedGmailMessage): string {
  const name = (msg.fromName ?? "").trim();
  if (name) return name;
  const addr = (msg.fromAddress ?? "").trim();
  if (addr) return addr;
  return "Unknown sender";
}

function subjectLabel(msg: NormalizedGmailMessage): string {
  const s = (msg.subject ?? "").trim();
  return s.length > 0 ? s : "(no subject)";
}

/** Format a received time like "today at 10:42 AM" / "Mon at 9:03 AM". */
export function formatReceived(
  msg: NormalizedGmailMessage,
  tz: string | undefined,
  now: Date,
): string {
  if (!msg.receivedAt) return "";
  const when = new Date(msg.receivedAt);
  let clock = "";
  try {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    }).format(when);
  } catch {
    clock = "";
  }
  const sameDay = isSameLocalDay(when, now, tz);
  if (sameDay) return clock ? `Received today at ${clock}.` : "Received today.";
  let day = "";
  try {
    day = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(when);
  } catch {
    day = "";
  }
  const parts = [day, clock].filter(Boolean).join(" at ");
  return parts ? `Received ${parts}.` : "";
}

/** PURE: local Y-M-D of an instant in a timezone (UTC when tz is absent). */
function localDateKey(date: Date, tz: string | undefined): string {
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return dtf.format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** PURE: do two instants fall on the same local calendar day in a timezone? */
export function isSameLocalDay(a: Date, b: Date, tz: string | undefined): boolean {
  return localDateKey(a, tz) === localDateKey(b, tz);
}

/** PURE: filter messages to those received on `now`'s local calendar day. */
export function filterToday(
  messages: readonly NormalizedGmailMessage[],
  tz: string | undefined,
  now: Date,
): NormalizedGmailMessage[] {
  return messages.filter((m) => {
    if (!m.receivedAt) return false;
    return isSameLocalDay(new Date(m.receivedAt), now, tz);
  });
}

/** PURE: how many of the recent messages are unread. */
export function countUnread(messages: readonly NormalizedGmailMessage[]): number {
  return messages.reduce((n, m) => n + (m.unread ? 1 : 0), 0);
}

/** PURE: an iMessage-friendly numbered list of sender — subject lines. */
function numberedList(messages: readonly NormalizedGmailMessage[], limit: number): string {
  return messages
    .slice(0, limit)
    .map((m, i) => `${i + 1}. ${senderLabel(m)} — ${subjectLabel(m)}`)
    .join("\n");
}

/** PURE: format the "likely important" answer (hedged wording, never certain). */
export function formatImportantAnswer(
  important: readonly NormalizedGmailMessage[],
  tz: string | undefined,
  now: Date,
  limit = 5,
): string {
  if (important.length === 0) return GMAIL_REPLIES.noImportant;
  const shown = important.slice(0, limit);
  const count = shown.length;
  const noun = count === 1 ? "email" : "emails";
  const lines = shown.map((m, i) => {
    const received = formatReceived(m, tz, now);
    const unread = m.unread ? " Unread." : "";
    const meta = `${received}${unread}`.trim();
    return `${i + 1}. ${senderLabel(m)} — ${subjectLabel(m)}${meta ? `\n   ${meta}` : ""}`;
  });
  return `You have ${count} recent ${noun} that look important:\n${lines.join("\n")}`;
}

/** PURE: format the "latest emails" answer. */
export function formatLatestAnswer(
  messages: readonly NormalizedGmailMessage[],
  limit = 5,
): string {
  if (messages.length === 0) {
    return "I couldn’t find any recent emails in your inbox.";
  }
  return `Here are your latest emails:\n${numberedList(messages, limit)}`;
}

/** PURE: format the "today" answer. */
export function formatTodayAnswer(
  todays: readonly NormalizedGmailMessage[],
  limit = 8,
): string {
  if (todays.length === 0) {
    return "You haven’t received any emails today.";
  }
  return `Here’s what you’ve received today:\n${numberedList(todays, limit)}`;
}

/** PURE: format the "unread count" answer. */
export function formatUnreadAnswer(count: number): string {
  if (count === 0) return "You have no unread emails in your recent inbox.";
  const noun = count === 1 ? "email" : "emails";
  return `You have ${count} unread ${noun} in your recent inbox.`;
}

// --- Orchestrator (DB + network) -----------------------------------------

/** Result of attempting to answer a message as a Gmail question. */
export interface GmailQuestionResult {
  handled: boolean;
  reply?: string;
  intent?: GmailIntent;
}

/**
 * PURE: given the classified intent and the fetched messages, produce the reply.
 * Split out so the formatting is fully unit-testable without DB/network.
 */
export function buildGmailReply(
  intent: Exclude<GmailIntent, "none">,
  messages: NormalizedGmailMessage[],
  tz: string | undefined,
  now: Date,
): string {
  switch (intent) {
    case "important": {
      const important = selectLikelyImportant(messages, now).map((s) => s.message);
      return formatImportantAnswer(important, tz, now);
    }
    case "today":
      return formatTodayAnswer(filterToday(messages, tz, now));
    case "unread":
      return formatUnreadAnswer(countUnread(messages));
    case "latest":
    default:
      return formatLatestAnswer(messages);
  }
}

/**
 * Handle a Gmail question from an already-linked user. Returns `{ handled:false }`
 * for non-Gmail messages so the caller falls through to the normal Hula brain.
 * Never throws — provider/DB failures degrade to an honest reply. Read-only.
 */
export async function handleGmailQuestion(
  userId: string,
  text: string | undefined,
): Promise<GmailQuestionResult> {
  const intent = classifyGmailQuestion(text);
  if (intent === "none") return { handled: false };

  try {
    const now = new Date();
    const timezone = await getUserTimezone(userId);
    const messages = await fetchRecentGmailMessages(userId);
    return {
      handled: true,
      intent,
      reply: buildGmailReply(intent, messages, timezone, now),
    };
  } catch (err) {
    if (err instanceof GmailError) {
      if (err.reason === "not_connected") {
        return { handled: true, intent, reply: GMAIL_REPLIES.notConnected };
      }
      // Safe structured log — a coded reason only, never a token or raw body.
      logger.error("gmail.question failed", {
        provider: GMAIL_PROVIDER,
        operation: "gmail.question",
        errorCode: err.reason,
        httpStatus: err.httpStatus,
      });
      const reply = isReconnectReason(err.reason)
        ? GMAIL_REPLIES.reconnect
        : GMAIL_REPLIES.unavailable;
      return { handled: true, intent, reply };
    }
    // Non-provider failure (DB/timezone/etc.) — stay honest, never pretend.
    logger.error("gmail.question failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: true, intent, reply: GMAIL_REPLIES.unavailable };
  }
}
