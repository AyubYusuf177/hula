import { generateAnthropicText } from "../../../ai/anthropicClient";
import { getUserTimezone } from "../../../reminders/reminders";
import { logger } from "../../../utils/logger";
import { GmailError, isReconnectReason } from "./client";
import { fetchRecentGmailMessages } from "./messages";
import { fetchGmailMessageBody, type GmailMessageBody } from "./messageBody";
import {
  resolveReplyTarget,
  senderMatchesName,
  wantsLatest,
  cleanDisplaySubject,
} from "./gmailActions";
import { formatReceived, GMAIL_REPLIES } from "./gmailQuestion";
import {
  buildUntrustedEmailBlock,
  untrustedContentSystemRules,
} from "./untrustedContent";
import type { GmailAction } from "./gmailActionExtract";
import {
  GMAIL_PROVIDER,
  type GmailAttachmentMeta,
  type NormalizedGmailMessage,
} from "./types";

/**
 * Gmail READ-ONE / SUMMARISE-ONE routing (Section 16 / Fix 4) — READ-ONLY.
 *
 * Distinguishes a request to READ or SUMMARISE ONE specific email ("what does
 * Rob's latest email say?", "summarise Rob's most recent email") from a request to
 * LIST recent emails ("what are my latest emails?"). A content question must carry
 * a content/read/summarise signal AND a resolvable single target (a named sender,
 * or a singular "my … email"); otherwise this returns `{ handled:false }` and the
 * message falls through to the normal LIST handler unchanged.
 *
 * When it matches, it resolves the newest matching message via the SAME safe
 * sender/thread resolution the write flow uses, fetches that ONE message's real
 * body, and answers strictly from it — a summary is always grounded in the actual
 * retrieved text, never invented. It never drafts, sends, or changes anything.
 */

/** The classified read-one intent. */
export interface ReadOneIntent {
  mode: "read" | "summarise";
  /** The sender the user named, or null for "my latest email" (newest overall). */
  senderName: string | null;
}

export interface GmailReadOneResult {
  handled: boolean;
  reply?: string;
  mode?: "read" | "summarise";
}

// --- Classification (PURE) -----------------------------------------------

const EMAILISH_RE = /\b(?:e-?mails?|inbox|message|msg)\b/i;
// A content/read verb — what makes this a "read/summarise ONE" rather than a list.
const READ_VERB_RE = /\b(?:read|say|says|saying)\b/i;
const SUMMARISE_RE = /\b(?:summar(?:y|ise|ize|ised|ized|ising|izing)|gist|tl;?dr)\b/i;
const ABOUT_RE = /\babout\b/i;
const PLURAL_EMAILS_RE = /\bemails\b/i;
const SINGULAR_TARGET_RE = /\b(?:email|message|msg)\b/i;

/** Words that are never a person's name when pulled from a sender phrase. */
const SENDER_DROP = new Set([
  "it", "that", "this", "the", "my", "your", "his", "her", "their", "our",
  "what", "who", "whose", "here", "there", "a", "an", "and", "or", "me",
  "email", "emails", "message", "msg", "inbox", "latest", "recent", "newest",
  "most", "say", "says", "saying", "said", "about", "please", "tell", "read", "gist",
  "summarise", "summarize", "summary",
  // auxiliary / question verbs a greedy possessive capture may pull in
  "does", "do", "did", "is", "was", "are", "were", "be", "been", "has", "have",
  "had", "will", "can", "could", "would", "should", "may", "might", "show", "get",
]);

/** PURE: clean a captured sender phrase down to a plausible name (or null). */
function cleanSenderCandidate(raw: string): string | null {
  const words = (raw.toLowerCase().match(/[a-z][a-z.'’-]*/g) ?? [])
    .map((w) => w.replace(/^['’.-]+|['’.-]+$/g, ""))
    .filter(Boolean);
  while (words.length > 0 && SENDER_DROP.has(words[0]!)) words.shift();
  while (words.length > 0 && SENDER_DROP.has(words[words.length - 1]!)) words.pop();
  if (words.length === 0) return null;
  return words.join(" ");
}

/**
 * PURE: extract the sender the user named, from a possessive ("Rob's email") or a
 * "from X" phrase. Returns null when no plausible name is present — so "my latest
 * email" (no sender) resolves to the newest overall message instead.
 */
export function extractReadSender(text: string | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;

  const possessive = /\b([a-z][a-z.'’-]*(?:\s+[a-z][a-z.'’-]*){0,2})['’]s\b/i.exec(t);
  if (possessive) {
    const cand = cleanSenderCandidate(possessive[1]!);
    if (cand) return cand;
  }
  const from = /\bfrom\s+([a-z][a-z.'’-]*(?:\s+[a-z][a-z.'’-]*){0,2})/i.exec(t);
  if (from) {
    const cand = cleanSenderCandidate(from[1]!);
    if (cand) return cand;
  }
  return null;
}

/**
 * PURE: classify a message as a read-one / summarise-one request, or null.
 *
 * Requires the message to be email-shaped AND to carry a content signal
 * (read/say/about/summarise) AND to name a single target (a sender, or a singular
 * "email"/"message" with no plural "emails" listing cue). A plain list query
 * ("what are my latest emails?") has no content verb and returns null.
 */
export function classifyReadOne(text: string | undefined): ReadOneIntent | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (!EMAILISH_RE.test(t)) return null;

  const wantsSummary = SUMMARISE_RE.test(t) || ABOUT_RE.test(t);
  const wantsRead = READ_VERB_RE.test(t);
  if (!wantsSummary && !wantsRead) return null;

  const sender = extractReadSender(t);
  const singular = SINGULAR_TARGET_RE.test(t) && !PLURAL_EMAILS_RE.test(t);
  if (!sender && !singular) return null;

  return { mode: wantsSummary ? "summarise" : "read", senderName: sender };
}

// --- Formatting (PURE) ---------------------------------------------------

/** Max characters of a real body we ever include verbatim in an iMessage read. */
const READ_EXCERPT_MAX = 1400;

function senderDisplay(msg: NormalizedGmailMessage): string {
  const name = (msg.fromName ?? "").trim();
  if (name) return name;
  return (msg.fromAddress ?? "").trim() || "the sender";
}

/** PURE: a header phrase like: Rob Stone’s email (“ICTS Job Offer”, received today at 11:59 AM). */
function readHeader(
  msg: NormalizedGmailMessage,
  tz: string | undefined,
  now: Date,
): string {
  const who = senderDisplay(msg);
  const subject = cleanDisplaySubject(msg.subject);
  const received = formatReceived(msg, tz, now).replace(/\.$/, "");
  const meta = received ? `“${subject}”, ${received.toLowerCase()}` : `“${subject}”`;
  return `${who}’s email (${meta})`;
}

/** PURE: trim a real body to a safe iMessage length, marking any truncation. */
export function excerptBody(content: string): string {
  const s = content.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (s.length <= READ_EXCERPT_MAX) return s;
  return `${s.slice(0, READ_EXCERPT_MAX).trimEnd()}…\n\n(That’s the start — the full email is longer.)`;
}

/**
 * PURE: a one-line attachment report (Section 17 / Phase 3.6), or "" when there are
 * none.
 *
 * Metadata ONLY — filename, type, size. Hula never downloads or reads attachment
 * content, so this reports what is attached and stops there. Filenames arrive
 * already sanitised from `extractAttachments`, because they are chosen by the
 * sender and are untrusted input like any other part of the mail.
 */
export function formatAttachments(attachments: readonly GmailAttachmentMeta[]): string {
  if (attachments.length === 0) return "";
  const noun = attachments.length === 1 ? "attachment" : "attachments";
  const lines = attachments.map((a) => {
    const size = a.sizeBytes !== null ? ` — ${formatBytes(a.sizeBytes)}` : "";
    return `• ${a.filename} (${a.mimeType})${size}`;
  });
  return `\n\n${attachments.length} ${noun}:\n${lines.join("\n")}\n(I can see these are attached, but I can’t open them yet.)`;
}

/** PURE: a compact human size. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** PURE: the verbatim-read answer, grounded in the real body. */
export function formatReadAnswer(
  msg: NormalizedGmailMessage,
  content: string,
  tz: string | undefined,
  now: Date,
  attachments: readonly GmailAttachmentMeta[] = [],
): string {
  return `${readHeader(msg, tz, now)} says:\n\n${excerptBody(content)}${formatAttachments(attachments)}`;
}

/** PURE: the summary answer, grounded in the real body. */
export function formatSummaryAnswer(
  msg: NormalizedGmailMessage,
  summary: string,
  tz: string | undefined,
  now: Date,
  attachments: readonly GmailAttachmentMeta[] = [],
): string {
  return `Here’s the gist of ${readHeader(msg, tz, now)}:\n\n${summary.trim()}${formatAttachments(attachments)}`;
}

/** PURE: a read clarification (never persisted — reads are safe/non-destructive). */
export function formatReadClarification(
  candidates: readonly NormalizedGmailMessage[],
  tz: string | undefined,
  now: Date,
): string {
  const who = senderDisplay(candidates[0]!);
  const lines = candidates.map((m, i) => {
    const received = formatReceived(m, tz, now);
    const meta = received ? ` — ${received}` : "";
    return `${i + 1}. ${cleanDisplaySubject(m.subject)}${meta}`;
  });
  return [
    `I found ${candidates.length} emails from ${who}. Which do you mean?`,
    "",
    lines.join("\n"),
    "",
    "Say “the latest one” for the most recent, or name the subject.",
  ].join("\n");
}

// --- Summariser (network, injectable) ------------------------------------

/** Summarise ONE email faithfully. Injectable so tests never hit Anthropic. */
export type EmailSummariser = (params: {
  body: string;
  subject: string;
  sender: string;
}) => Promise<string>;

/** Default summariser: grounded, faithful, 1–3 sentences. Returns "" on failure. */
async function defaultSummarise(params: {
  body: string;
  subject: string;
  sender: string;
}): Promise<string> {
  const system = [
    "You summarise ONE email for the recipient. Summarise ONLY what the email actually says.",
    "Never invent facts, names, dates, or offers that are not in the email.",
    "Reply in 1–3 short plain-text sentences. No preamble, no markdown.",
    "",
    // Section 17: the body is attacker-controlled, so it is fenced and declared
    // untrusted rather than pasted in as if it were context we vouch for.
    untrustedContentSystemRules(),
  ].join("\n");
  try {
    const text = await generateAnthropicText({
      system,
      messages: [
        {
          role: "user",
          // `buildUntrustedEmailBlock` owns the length bound (UNTRUSTED_BODY_MAX),
          // so the model context stays capped in exactly one place.
          content: `Summarise the email below.\n\n${buildUntrustedEmailBlock({
            sender: params.sender,
            subject: params.subject,
            body: params.body,
          })}`,
        },
      ],
      maxTokens: 250,
    });
    return text.trim();
  } catch {
    return "";
  }
}

// --- Orchestrator --------------------------------------------------------

export interface GmailReadOneDeps {
  fetchMessages?: (userId: string) => Promise<NormalizedGmailMessage[]>;
  fetchBody?: (userId: string, messageId: string) => Promise<GmailMessageBody>;
  summarise?: EmailSummariser;
  getTimezone?: (userId: string) => Promise<string | undefined>;
}

async function safeTimezone(
  userId: string,
  getTz: ((userId: string) => Promise<string | undefined>) | undefined,
): Promise<string | undefined> {
  try {
    return await (getTz ?? getUserTimezone)(userId);
  } catch {
    return undefined;
  }
}

/**
 * Handle a read-one / summarise-one request from an already-linked user. Returns
 * `{ handled:false }` for anything that isn't a specific read (so the LIST handler
 * still answers "what are my latest emails?"). Never throws — provider/DB failures
 * degrade to an honest reply. Read-only; a summary is always grounded in the real
 * fetched body and never hallucinated.
 */
export async function handleGmailReadOne(
  userId: string,
  text: string | undefined,
  deps: GmailReadOneDeps = {},
): Promise<GmailReadOneResult> {
  const intent = classifyReadOne(text);
  if (!intent) return { handled: false };

  const fetchMessages = deps.fetchMessages ?? fetchRecentGmailMessages;
  const fetchBody = deps.fetchBody ?? fetchGmailMessageBody;
  const summarise = deps.summarise ?? defaultSummarise;

  try {
    const now = new Date();
    const tz = await safeTimezone(userId, deps.getTimezone);
    const messages = await fetchMessages(userId);
    if (messages.length === 0) {
      return { handled: true, mode: intent.mode, reply: "I couldn’t find any recent emails in your inbox." };
    }

    // Resolve the ONE target message.
    let target: NormalizedGmailMessage;
    if (intent.senderName) {
      const resolution = resolveReplyTarget(
        { action: "create_reply_draft", recipientName: intent.senderName } as GmailAction,
        messages,
        { preferLatest: wantsLatest(text) },
      );
      if (resolution.kind === "none") {
        return {
          handled: true,
          mode: intent.mode,
          reply: `I couldn’t find a recent email from ${intent.senderName} in your inbox.`,
        };
      }
      if (resolution.kind === "many") {
        return {
          handled: true,
          mode: intent.mode,
          reply: formatReadClarification(resolution.candidates, tz, now),
        };
      }
      target = resolution.message;
    } else {
      // No sender named ("my latest email") — the newest overall message.
      target = messages[0]!;
    }

    // Fetch the ONE message body and answer strictly from it.
    const body = await fetchBody(userId, target.id);
    const content = (body.text || body.snippet || "").trim();
    if (!content) {
      return {
        handled: true,
        mode: intent.mode,
        reply: "I found the email but couldn’t read its contents just now — mind trying again shortly?",
      };
    }

    if (intent.mode === "summarise") {
      const summary = await summarise({
        body: content,
        subject: (target.subject ?? "").trim(),
        sender: senderDisplay(target),
      });
      if (summary) {
        return {
          handled: true,
          mode: intent.mode,
          reply: formatSummaryAnswer(target, summary, tz, now, body.attachments),
        };
      }
      // Grounded fallback: show the real excerpt rather than invent a summary.
      return {
        handled: true,
        mode: intent.mode,
        reply: formatReadAnswer(target, content, tz, now, body.attachments),
      };
    }

    return {
      handled: true,
      mode: intent.mode,
      reply: formatReadAnswer(target, content, tz, now, body.attachments),
    };
  } catch (err) {
    if (err instanceof GmailError) {
      if (err.reason === "not_connected") {
        return { handled: true, mode: intent.mode, reply: GMAIL_REPLIES.notConnected };
      }
      logger.error("gmail.readOne failed", {
        provider: GMAIL_PROVIDER,
        operation: "gmail.readOne",
        errorCode: err.reason,
        httpStatus: err.httpStatus,
      });
      const reply = isReconnectReason(err.reason)
        ? GMAIL_REPLIES.reconnect
        : GMAIL_REPLIES.unavailable;
      return { handled: true, mode: intent.mode, reply };
    }
    logger.error("gmail.readOne failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: true, mode: intent.mode, reply: GMAIL_REPLIES.unavailable };
  }
}
