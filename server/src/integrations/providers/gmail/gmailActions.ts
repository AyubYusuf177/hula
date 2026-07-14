import { getConnectionForUserProvider } from "../../connections";
import {
  createActionProposal,
  type CreateProposalInput,
} from "../../../actions/proposals";
import { executeAction } from "../../../actions/executor";
import { getUserTimezone } from "../../../reminders/reminders";
import { logger } from "../../../utils/logger";
import { GmailError, isReconnectReason } from "./client";
import { fetchRecentGmailMessages } from "./messages";
import { fetchGmailReplyContext, getGmailDraft, sendGmailDraft } from "./drafts";
import {
  claimLastDraft,
  classifyDraftSend,
  draftRecipientMatches,
  loadRecentLastDrafts,
  markLastDraftSent,
  parseDraftRecipientHint,
  recordLastDraft,
  releaseLastDraft,
  type LastDraftData,
  type LoadedLastDraft,
} from "./gmailDraftContext";
import { formatReceived } from "./gmailQuestion";
import {
  loadLatestGmailSelection,
  parseOrdinalReference,
  resolveSelectionItem,
} from "./gmailSelection";
import { buildReplySubject, isValidEmailAddress } from "./mime";
import { ensureSignature } from "./signature";
import { getUserDisplayName } from "../../../users/profile";
import {
  extractGmailAction,
  type GmailAction,
  type TextGenerator,
} from "./gmailActionExtract";
import {
  createReplyClarification,
  expireReplyClarification,
  loadReplyClarification,
  markClarificationResolved,
  parseClarificationSelection,
  type PendingClarification,
  type ReplyClarificationData,
} from "./gmailClarification";
import {
  GMAIL_COMPOSE_SCOPE,
  GMAIL_PROVIDER,
  type GmailReplyContext,
  type NormalizedGmailMessage,
} from "./types";

/**
 * Gmail WRITE routing (Section 16) — draft / reply-draft / send / send-reply.
 *
 * Mirrors the Calendar-write handler: a deterministic prefilter, a strictly
 * validated model extraction, then a DETERMINISTIC backend that resolves the real
 * recipient/thread from the user's actual Gmail, guards safety (never invents an
 * address, never guesses between people or threads), and either creates a draft
 * IMMEDIATELY or — for an actual send — creates a persisted Section 12 proposal
 * that only a subsequent "yes" executes. The model never touches Gmail. Never
 * throws — every failure degrades to an honest reply.
 */

/** The persisted action id for a send (existing registry id — kept stable). */
export const GMAIL_SEND_ACTION_ID = "email.sendDraft";
/** The registry id for an immediate draft. */
export const GMAIL_DRAFT_ACTION_ID = "email.createDraft";

/** How many candidate senders/threads to show when a request is ambiguous. */
const MAX_AMBIGUOUS_SHOWN = 4;

/** Fixed, honest replies matching the codebase voice. */
export const GMAIL_WRITE_REPLIES = {
  notConnected:
    "Your Gmail isn’t connected yet. Connect it from Hula → Integrations → Gmail and I’ll be able to draft and send email for you.",
  reconnect:
    "I can read your Gmail but I don’t have permission to draft or send yet. Reconnect Gmail in Hula → Integrations → Gmail to let me compose email.",
  unavailable:
    "I couldn’t reach Gmail just now — mind trying again in a bit?",
  needRecipient:
    "Who should I send this to? Share their email address and I’ll take care of it.",
  needSubject: "What should the subject line be?",
  needBody: "What would you like the email to say?",
  noReplyRecipient:
    "I couldn’t work out who to reply to from that email — mind giving me their email address?",
  threadNotFound:
    "I couldn’t find a recent email from them to reply to. Want me to send a new email instead?",
  selectionOutOfRange:
    "I don’t have an email at that position — mind showing me the list again?",
  noSelection:
    "I’m not sure which email you mean — search for it first and then tell me which one.",
  clarifyExpired:
    "That choice has expired — mind sending your reply request again?",
  clarifyAlreadyDone:
    "I’ve already handled that one.",
} as const;

// --- Prefilter (PURE) ----------------------------------------------------

// Read/question openers — these are never a write command.
const READ_OPENER_RE =
  /^(?:what|which|when|who|whom|whose|how|do i|does|did i|is there|are there|any\b|show me|list|check|read)\b/i;
// "send me / us / over the latest email" = asking to be shown mail = a READ.
const SEND_TO_SELF_RE = /\bsend (?:me|us|over|it over|through|across)\b/i;

const REPLY_VERB_RE = /\b(?:reply|respond)\b/i;
const DRAFT_VERB_RE = /\bdraft\b/i;
const SEND_VERB_RE = /\b(?:send|shoot|fire off|compose|write|email)\b/i;
const EMAILISH_RE = /\b(?:e-?mails?|inbox|gmail|message)\b/i;

/**
 * PURE: a fast, cheap gate deciding whether a message is worth extracting as a
 * Gmail write. It must NOT swallow read requests ("send me the latest email",
 * "what emails do I have") — those fall through to the Gmail READ handler. A
 * false positive only costs one extraction that returns `not_gmail_write`.
 */
export function looksLikeGmailWrite(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  // Never intercept a read/question, or a "send me …" (show-me) request.
  if (READ_OPENER_RE.test(t)) return false;
  if (SEND_TO_SELF_RE.test(t)) return false;
  // reply/respond/draft strongly imply an email write even without "email".
  if (REPLY_VERB_RE.test(t) || DRAFT_VERB_RE.test(t)) return true;
  // Otherwise require a send-ish verb plus an email cue.
  return SEND_VERB_RE.test(t) && EMAILISH_RE.test(t);
}

// --- Recency intent (PURE) -----------------------------------------------

// ONLY explicit recency phrasing. Bare "last" is intentionally excluded so
// "last week", "last month's email", "last meeting" never auto-select a thread.
const WANTS_LATEST_RE = /\b(?:latest|most recent|newest)\b/i;

/**
 * PURE: does the user's ORIGINAL text explicitly ask for the newest match
 * ("latest" / "most recent" / "newest")? Derived deterministically from the
 * user's words — never from the model — so recency selection is never guessed.
 */
export function wantsLatest(text: string | undefined): boolean {
  return WANTS_LATEST_RE.test(text ?? "");
}

// --- Recipient / thread matching (PURE) ----------------------------------

const NAME_STOPWORDS = new Set([
  "a", "an", "the", "to", "an", "email", "e-mail", "mail", "message", "reply",
  "send", "draft", "and", "of", "for", "with", "my", "his", "her", "their",
]);

function significantTokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return words.filter((w) => w.length >= 2 && !NAME_STOPWORDS.has(w));
}

/** PURE: does a message's sender plausibly match the requested person name? */
export function senderMatchesName(msg: NormalizedGmailMessage, name: string): boolean {
  const q = significantTokens(name);
  if (q.length === 0) return false;
  const nameTokens = new Set(significantTokens(msg.fromName ?? ""));
  const localPart = (msg.fromAddress ?? "").split("@")[0]?.toLowerCase() ?? "";
  return q.some((token) => nameTokens.has(token) || (token.length >= 3 && localPart.includes(token)));
}

/** A resolved recipient: a single address (+ optional display name). */
export interface ResolvedRecipient {
  address: string;
  name: string | null;
}

export type RecipientResolution =
  | { kind: "one"; recipient: ResolvedRecipient }
  | { kind: "none" }
  | { kind: "many"; candidates: ResolvedRecipient[] };

/**
 * PURE: resolve the recipient of a NEW email. A literal, valid address wins
 * immediately. Otherwise a name is matched against recent senders: exactly one
 * distinct address → resolved; zero → ask for the address; several → clarify.
 * Never invents an address.
 */
export function resolveNewRecipient(
  action: GmailAction,
  messages: readonly NormalizedGmailMessage[],
): RecipientResolution {
  const literal = (action.recipientEmail ?? "").trim();
  if (literal && isValidEmailAddress(literal)) {
    return { kind: "one", recipient: { address: literal, name: action.recipientName ?? null } };
  }
  const name = (action.recipientName ?? "").trim();
  if (!name) return { kind: "none" };

  const byAddress = new Map<string, ResolvedRecipient>();
  for (const msg of messages) {
    const addr = (msg.fromAddress ?? "").trim().toLowerCase();
    if (!addr || !isValidEmailAddress(addr)) continue;
    if (!senderMatchesName(msg, name)) continue;
    if (!byAddress.has(addr)) {
      byAddress.set(addr, { address: msg.fromAddress!.trim(), name: msg.fromName ?? null });
    }
  }
  const candidates = [...byAddress.values()];
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "one", recipient: candidates[0]! };
  return { kind: "many", candidates: candidates.slice(0, MAX_AMBIGUOUS_SHOWN) };
}

export type ThreadResolution =
  | { kind: "one"; message: NormalizedGmailMessage }
  | { kind: "none" }
  | { kind: "many"; candidates: NormalizedGmailMessage[] };

/** Options controlling reply-target resolution. */
export interface ResolveReplyOptions {
  /**
   * When true AND more than one thread matches, select the NEWEST thread instead
   * of clarifying. Set only when the user explicitly asked for the latest (see
   * `wantsLatest`). `messages` must be newest-first for this to be correct.
   */
  preferLatest?: boolean;
}

/**
 * PURE: resolve which message to REPLY to. A literal address matches by sender
 * address; otherwise a name is matched. Matches are grouped by thread: exactly
 * one distinct thread → the newest matching message in it; zero → not found;
 * several distinct threads → clarify (or, when `preferLatest`, auto-select the
 * newest). `messages` must be newest-first.
 */
export function resolveReplyTarget(
  action: GmailAction,
  messages: readonly NormalizedGmailMessage[],
  options: ResolveReplyOptions = {},
): ThreadResolution {
  const literal = (action.recipientEmail ?? "").trim().toLowerCase();
  const name = (action.recipientName ?? "").trim();

  const matches = messages.filter((msg) => {
    if (literal) return (msg.fromAddress ?? "").trim().toLowerCase() === literal;
    if (name) return senderMatchesName(msg, name);
    return false;
  });
  if (matches.length === 0) return { kind: "none" };

  // One representative (newest) message per distinct thread. Because `matches`
  // preserves the newest-first order, the FIRST thread is the newest thread.
  const byThread = new Map<string, NormalizedGmailMessage>();
  for (const msg of matches) {
    const key = msg.threadId || msg.id;
    if (!byThread.has(key)) byThread.set(key, msg);
  }
  const threads = [...byThread.values()];
  if (threads.length === 1) return { kind: "one", message: threads[0]! };
  // Explicit "latest/most recent/newest" collapses ambiguity to the newest thread.
  if (options.preferLatest) return { kind: "one", message: threads[0]! };
  return { kind: "many", candidates: threads.slice(0, MAX_AMBIGUOUS_SHOWN) };
}

// --- Formatting (PURE) ---------------------------------------------------

/** A recipient's display label: "Name <addr>", or the bare address. */
export function recipientLabel(recipient: ResolvedRecipient): string {
  const name = (recipient.name ?? "").trim();
  return name ? `${name} <${recipient.address}>` : recipient.address;
}

function senderDisplay(msg: NormalizedGmailMessage): string {
  const name = (msg.fromName ?? "").trim();
  if (name) return name;
  return (msg.fromAddress ?? "").trim() || "Unknown sender";
}

export function formatAmbiguousRecipients(candidates: readonly ResolvedRecipient[]): string {
  const lines = candidates.map((c, i) => `${i + 1}. ${recipientLabel(c)}`);
  return `I found a few people that could match. Who did you mean?\n${lines.join("\n")}`;
}

/** Max characters of a Gmail snippet shown in a clarification line. */
const SNIPPET_MAX = 80;

/**
 * PURE: collapse an immediately-repeated IDENTICAL reply/forward prefix for
 * DISPLAY only ("Re: Re: X" → "Re: X"). It never rewrites a different prefix and
 * is never used to build the actual reply subject (that derives from the real
 * thread subject), so threading is unaffected.
 */
export function cleanDisplaySubject(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  if (!s) return "(no subject)";
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^(re|fwd|fw)\s*:\s*(?=\1\s*:)/i, "");
  } while (s !== prev);
  return s;
}

/** PURE: a single-line, truncated Gmail snippet safe for iMessage (never a body). */
export function truncateSnippet(snippet: string | null | undefined): string {
  const s = (snippet ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length <= SNIPPET_MAX ? s : `${s.slice(0, SNIPPET_MAX).trimEnd()}…`;
}

/**
 * PURE: render the numbered, distinguishable list of candidate reply threads.
 * Each option shows the sender (in the header when uniform), the cleaned subject,
 * the received time, and a truncated snippet — enough to tell them apart. It
 * never exposes the full email body.
 */
export function formatAmbiguousThreads(
  candidates: readonly NormalizedGmailMessage[],
  tz?: string,
  now: Date = new Date(),
): string {
  const senders = new Set(candidates.map((m) => senderDisplay(m)));
  const uniformSender = senders.size === 1 ? [...senders][0]! : null;

  const header = uniformSender
    ? `I found ${candidates.length} emails from ${uniformSender}. Which one should I reply to?`
    : "I found a few emails that could match. Which one should I reply to?";

  const blocks = candidates.map((m, i) => {
    const who = uniformSender ? "" : `${senderDisplay(m)} — `;
    const lines = [`${i + 1}. ${who}${cleanDisplaySubject(m.subject)}`];
    const received = formatReceived(m, tz, now);
    if (received) lines.push(`   ${received}`);
    const snippet = truncateSnippet(m.snippet);
    if (snippet) lines.push(`   “${snippet}”`);
    return lines.join("\n");
  });

  const footer =
    candidates.length === 2
      ? "Reply with 1 or 2."
      : `Reply with a number from 1 to ${candidates.length}.`;
  return [header, "", blocks.join("\n\n"), "", footer].join("\n");
}

/** The send confirmation preview (Section 12/16). Shows the FULL body. */
export function formatSendPreview(input: {
  to: string;
  toName: string | null;
  subject: string;
  body: string;
  isReply: boolean;
  threadSubject?: string | null;
}): string {
  const label = input.toName ? `${input.toName} <${input.to}>` : input.to;
  const lines = ["Ready to send:", ""];
  if (input.isReply) {
    const thread = (input.threadSubject ?? "").trim() || input.subject;
    lines.push(`This is a reply in “${thread}”.`, "");
  }
  lines.push(`To: ${label}`, `Subject: ${input.subject}`, "", "Body:", input.body, "", "Reply ‘send it’ to continue or ‘cancel’ to stop.");
  return lines.join("\n");
}

// --- Write-capability check ----------------------------------------------

export type WriteCapability = "not_connected" | "connected_readonly" | "connected_write";

/** Default capability check: connected + holds the `gmail.compose` scope. */
async function defaultWriteCapability(userId: string): Promise<WriteCapability> {
  const conn = await getConnectionForUserProvider(userId, GMAIL_PROVIDER);
  if (!conn || conn.status !== "connected") return "not_connected";
  return conn.grantedScopes.includes(GMAIL_COMPOSE_SCOPE)
    ? "connected_write"
    : "connected_readonly";
}

/** PURE: build a References header value (existing chain + the message id). */
export function buildReferences(
  existing: string | null | undefined,
  messageIdHeader: string | null | undefined,
): string | undefined {
  const chain = (existing ?? "").trim();
  const id = (messageIdHeader ?? "").trim();
  if (chain && id) return `${chain} ${id}`;
  if (id) return id;
  if (chain) return chain;
  return undefined;
}

// --- Orchestrator --------------------------------------------------------

/** The structured send/draft fields passed to the executor (safe, no tokens). */
export interface GmailMessageInput {
  to: string;
  toName: string | null;
  subject: string;
  body: string;
  isReply: boolean;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  threadSubject?: string | null;
}

/** Injectable dependencies so the whole flow runs with NO DB / network in tests. */
export interface GmailWriteDeps {
  writeCapability?: (userId: string) => Promise<WriteCapability>;
  extract?: (params: { text: string; generate?: TextGenerator }) => Promise<GmailAction | null>;
  generate?: TextGenerator;
  fetchMessages?: (userId: string) => Promise<NormalizedGmailMessage[]>;
  fetchReplyContext?: (userId: string, messageId: string) => Promise<GmailReplyContext>;
  /** Loads the list Hula last showed, for positional replies ("the second one"). */
  loadSelection?: typeof loadLatestGmailSelection;
  /** Runs an immediate action (draft) through the executor. */
  execute?: (
    userId: string,
    actionId: string,
    input: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    userMessage: string;
    receipt?: { draftId?: string; messageId?: string; threadId?: string };
  }>;
  /** Persists a reference to a just-created draft (for a later "send the draft"). */
  recordLastDraft?: (userId: string, data: LastDraftData) => Promise<{ id: string }>;
  /** Persists a send proposal (Section 12 runtime). */
  createProposal?: (userId: string, input: CreateProposalInput) => Promise<{ id: string }>;
  /** Persists a pending reply-target clarification (reuses the proposal store). */
  createClarification?: (
    userId: string,
    data: ReplyClarificationData,
    previewText: string,
  ) => Promise<{ id: string }>;
  /** Resolve the user's timezone (best-effort) for formatting received times. */
  getTimezone?: (userId: string) => Promise<string | undefined>;
  /** Resolve the user's real display name (best-effort) for signing generated email. */
  getDisplayName?: (userId: string) => Promise<string | null>;
}

export interface GmailWriteResult {
  handled: boolean;
  reply?: string;
  action?: GmailAction["action"];
}

/** Map a provider error to an honest reply (reconnect vs transient). */
function replyForProviderError(err: GmailError): string {
  if (err.reason === "not_connected") return GMAIL_WRITE_REPLIES.notConnected;
  if (isReconnectReason(err.reason)) return GMAIL_WRITE_REPLIES.reconnect;
  if (err.reason === "insufficient_scope") return GMAIL_WRITE_REPLIES.reconnect;
  return GMAIL_WRITE_REPLIES.unavailable;
}

function isSendAction(action: GmailAction["action"]): boolean {
  return action === "send_new_email" || action === "send_reply";
}
function isReplyAction(action: GmailAction["action"]): boolean {
  return action === "create_reply_draft" || action === "send_reply";
}
function isDraftAction(action: GmailAction["action"]): boolean {
  return action === "create_new_draft" || action === "create_reply_draft";
}

/** Best-effort timezone lookup — never throws, so formatting is optional. */
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

/** Best-effort display-name lookup — never throws, so signing is optional. */
async function safeDisplayName(
  userId: string,
  getName: ((userId: string) => Promise<string | null>) | undefined,
): Promise<string | null> {
  try {
    return await (getName ?? getUserDisplayName)(userId);
  } catch {
    return null;
  }
}

/**
 * Handle a Gmail draft/send request from an already-linked user. Returns
 * `{ handled: false }` for non-Gmail-write messages (and when the model can't be
 * reached) so the caller falls through to the normal flow. Never throws.
 */
export async function handleGmailWrite(
  userId: string,
  text: string | undefined,
  deps: GmailWriteDeps = {},
): Promise<GmailWriteResult> {
  if (!looksLikeGmailWrite(text)) return { handled: false };

  const extract = deps.extract ?? extractGmailAction;

  // Extract FIRST so we only surface a connect/reconnect message for a genuine
  // Gmail-write request (a prefilter false positive stays silent).
  const action = await extract({ text: text ?? "", generate: deps.generate });
  if (!action || action.action === "not_gmail_write") return { handled: false };

  const capability = deps.writeCapability
    ? await deps.writeCapability(userId)
    : await defaultWriteCapability(userId);
  if (capability === "not_connected") {
    return { handled: true, action: action.action, reply: GMAIL_WRITE_REPLIES.notConnected };
  }
  if (capability === "connected_readonly") {
    return { handled: true, action: action.action, reply: GMAIL_WRITE_REPLIES.reconnect };
  }

  try {
    return isReplyAction(action.action)
      ? await runReply(userId, action, deps, text ?? "")
      : await runNew(userId, action, deps);
  } catch (err) {
    if (err instanceof GmailError) {
      logger.error("gmail.write failed", {
        provider: GMAIL_PROVIDER,
        operation: `gmail.${action.action}`,
        errorCode: err.reason,
        httpStatus: err.httpStatus,
      });
      return { handled: true, action: action.action, reply: replyForProviderError(err) };
    }
    logger.error("gmail.write failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: true, action: action.action, reply: GMAIL_WRITE_REPLIES.unavailable };
  }
}

/** Run a NEW draft or send (create_new_draft / send_new_email). */
async function runNew(
  userId: string,
  action: GmailAction,
  deps: GmailWriteDeps,
): Promise<GmailWriteResult> {
  const body = (action.body ?? "").trim();
  if (!body) return { handled: true, action: action.action, reply: GMAIL_WRITE_REPLIES.needBody };
  const subject = (action.subject ?? "").trim();
  if (!subject) return { handled: true, action: action.action, reply: GMAIL_WRITE_REPLIES.needSubject };

  // Resolve the recipient. A literal address needs no Gmail read.
  let resolution: RecipientResolution;
  const literal = (action.recipientEmail ?? "").trim();
  if (literal && isValidEmailAddress(literal)) {
    resolution = { kind: "one", recipient: { address: literal, name: action.recipientName ?? null } };
  } else {
    const fetchMessages = deps.fetchMessages ?? fetchRecentGmailMessages;
    const messages = await fetchMessages(userId);
    resolution = resolveNewRecipient(action, messages);
  }
  if (resolution.kind === "none") {
    return { handled: true, action: action.action, reply: GMAIL_WRITE_REPLIES.needRecipient };
  }
  if (resolution.kind === "many") {
    return {
      handled: true,
      action: action.action,
      reply: formatAmbiguousRecipients(resolution.candidates),
    };
  }

  const input: GmailMessageInput = {
    to: resolution.recipient.address,
    toName: resolution.recipient.name,
    subject,
    body,
    isReply: false,
  };
  return finish(userId, action.action, input, deps);
}

/** Run a REPLY draft or send (create_reply_draft / send_reply). */
async function runReply(
  userId: string,
  action: GmailAction,
  deps: GmailWriteDeps,
  originalText: string,
): Promise<GmailWriteResult> {
  const body = (action.body ?? "").trim();
  if (!body) return { handled: true, action: action.action, reply: GMAIL_WRITE_REPLIES.needBody };

  // Section 17 — POSITIONAL reference ("reply to the second one saying …").
  //
  // Resolved FIRST, and against the EXACT list Hula last showed rather than a fresh
  // fetch: re-fetching could return a different order (new mail arrives), so
  // "the second one" would silently reply to a different thread than the one the
  // user is looking at. Falls through to sender matching when no position is named.
  const ordinal = parseOrdinalReference(originalText);
  if (ordinal) {
    const loadSelection = deps.loadSelection ?? loadLatestGmailSelection;
    const selection = await loadSelection(userId);
    if (selection && selection.data.itemKind === "messages") {
      const item = resolveSelectionItem(selection.data, ordinal);
      if (!item) {
        return {
          handled: true,
          action: action.action,
          reply: GMAIL_WRITE_REPLIES.selectionOutOfRange,
        };
      }
      return await replyToMessageId(userId, action, item.id, body, deps);
    }
    // A position with no remembered list can't be resolved safely — ask rather
    // than fall back to sender matching, which would pick a different email.
    return {
      handled: true,
      action: action.action,
      reply: GMAIL_WRITE_REPLIES.noSelection,
    };
  }

  const fetchMessages = deps.fetchMessages ?? fetchRecentGmailMessages;
  const messages = await fetchMessages(userId);
  // Recency preference is derived from the user's OWN words, never the model.
  const preferLatest = wantsLatest(originalText);
  const target = resolveReplyTarget(action, messages, { preferLatest });
  if (target.kind === "none") {
    return { handled: true, action: action.action, reply: GMAIL_WRITE_REPLIES.threadNotFound };
  }
  if (target.kind === "many") {
    // Show a distinguishable numbered list AND persist it so the next message
    // ("2", "the second one", "actually 2") resolves against the exact thread.
    const tz = await safeTimezone(userId, deps.getTimezone);
    const preview = formatAmbiguousThreads(target.candidates, tz, new Date());
    const data: ReplyClarificationData = {
      kind: "gmail_reply_clarification",
      action: action.action,
      body,
      candidates: target.candidates.map((m, i) => ({
        index: i + 1,
        messageId: m.id,
        threadId: m.threadId,
        sender: senderDisplay(m),
        subject: (m.subject ?? "").trim(),
      })),
      resolvedIndex: null,
    };
    const create = deps.createClarification ?? createReplyClarification;
    await create(userId, data, preview);
    return { handled: true, action: action.action, reply: preview };
  }

  return await replyToMessageId(userId, action, target.message.id, body, deps, target.message.threadId);
}

/**
 * Build and finish a reply to ONE already-resolved message id.
 *
 * Shared by both resolution routes (positional and sender-matched) so threading is
 * derived identically no matter how the target was chosen: the reply context is
 * always re-fetched from Gmail for that exact message, and In-Reply-To/References
 * always come from the real headers.
 */
async function replyToMessageId(
  userId: string,
  action: GmailAction,
  messageId: string,
  body: string,
  deps: GmailWriteDeps,
  fallbackThreadId?: string,
): Promise<GmailWriteResult> {
  const fetchReplyContext = deps.fetchReplyContext ?? fetchGmailReplyContext;
  const ctx = await fetchReplyContext(userId, messageId);
  const to = (ctx.replyToAddress ?? "").trim();
  if (!isValidEmailAddress(to)) {
    return { handled: true, action: action.action, reply: GMAIL_WRITE_REPLIES.noReplyRecipient };
  }

  const subject = buildReplySubject(ctx.subject);
  const input: GmailMessageInput = {
    to,
    toName: ctx.replyToName,
    subject,
    body,
    isReply: true,
    threadId: ctx.threadId || fallbackThreadId || undefined,
    inReplyTo: ctx.messageIdHeader ?? undefined,
    references: buildReferences(ctx.references, ctx.messageIdHeader),
    threadSubject: ctx.subject,
  };
  return finish(userId, action.action, input, deps);
}

/**
 * Finish a resolved write: a DRAFT executes immediately through the executor; a
 * SEND creates a persisted proposal and returns the full preview (never sends).
 */
async function finish(
  userId: string,
  action: GmailAction["action"],
  input: GmailMessageInput,
  deps: GmailWriteDeps,
): Promise<GmailWriteResult> {
  // Fix 3: complete a generated professional closing with the user's REAL name.
  // Done once, here, so drafts, sends, the send preview, and clarification-resolved
  // replies ALL carry the identical signed body. Never invents a name.
  const displayName = await safeDisplayName(userId, deps.getDisplayName);
  const signedBody = ensureSignature(input.body, displayName);
  const signed: GmailMessageInput =
    signedBody === input.body ? input : { ...input, body: signedBody };
  const asRecord = signed as unknown as Record<string, unknown>;

  if (isSendAction(action)) {
    const preview = formatSendPreview(signed);
    const createProposal = deps.createProposal ?? createActionProposal;
    await createProposal(userId, {
      provider: GMAIL_PROVIDER,
      actionId: GMAIL_SEND_ACTION_ID,
      riskLevel: "send",
      confirmationRequired: true,
      input: asRecord,
      previewText: preview,
    });
    return { handled: true, action, reply: preview };
  }

  // Draft: run immediately through the executor (no confirmation needed).
  const execute =
    deps.execute ??
    (async (u: string, a: string, i: Record<string, unknown>) => {
      const r = await executeAction(u, a, { input: i });
      return { ok: r.ok, userMessage: r.userMessage, receipt: r.receipt };
    });
  const result = await execute(userId, GMAIL_DRAFT_ACTION_ID, asRecord);

  // Remember the REAL draft (Gmail-issued ids only) so a follow-up "send the
  // draft" can send the ACTUAL draft. Persisted ONLY from a validated receipt and
  // strictly best-effort — a failure here never blocks the "draft created" reply.
  if (result.ok && result.receipt?.draftId) {
    const remember = deps.recordLastDraft ?? recordLastDraft;
    try {
      await remember(userId, {
        kind: "gmail_last_draft",
        draftId: result.receipt.draftId,
        messageId: result.receipt.messageId ?? null,
        threadId: result.receipt.threadId ?? signed.threadId ?? null,
        to: signed.to,
        toName: signed.toName,
        subject: signed.subject,
        isReply: signed.isReply,
        action,
      });
    } catch (err) {
      logger.error("gmail.recordLastDraft failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return { handled: true, action, reply: result.userMessage };
}

// --- Pending clarification resolution ------------------------------------

export interface GmailClarificationResult {
  handled: boolean;
  reply?: string;
  action?: GmailAction["action"];
}

/** Injectable deps for the clarification handler (extends the write deps). */
export interface GmailClarificationDeps extends GmailWriteDeps {
  loadClarification?: (userId: string) => Promise<PendingClarification | null>;
  markResolved?: (
    userId: string,
    id: string,
    data: ReplyClarificationData,
    resolvedIndex: number,
  ) => Promise<void>;
  expireClarification?: (userId: string, id: string) => Promise<void>;
}

/**
 * Resolve a user's numbered reply to a pending Gmail reply-target clarification.
 *
 * Runs ONLY when a valid (unexpired) clarification exists AND the message reads as
 * a selection/correction ("2", "option 2", "the second one", "actually 2") —
 * otherwise it returns `{ handled: false }` and the message falls through
 * unchanged, so ordinary numbers and unrelated text are never intercepted. On a
 * valid pick it resolves the EXACT chosen thread and drafts (immediately) or
 * proposes (a send) via the shared `finish` path. Never throws.
 */
export async function handleGmailClarification(
  userId: string,
  text: string | undefined,
  deps: GmailClarificationDeps = {},
): Promise<GmailClarificationResult> {
  const load = deps.loadClarification ?? ((u: string) => loadReplyClarification(u));

  let pending: PendingClarification | null;
  try {
    pending = await load(userId);
  } catch (err) {
    logger.error("gmail.clarification load failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: false };
  }
  // No pending clarification → this handler is inert (fall through unchanged).
  if (!pending) return { handled: false };

  // A pending clarification exists, but this message isn't a choice → don't
  // intercept it; let the normal pipeline handle it.
  const selection = parseClarificationSelection(text);
  if (!selection) return { handled: false };

  // The clarification lapsed before they answered — ask them to start over.
  if (pending.expired) {
    const expire =
      deps.expireClarification ?? ((u: string, id: string) => expireReplyClarification(u, id));
    try {
      await expire(userId, pending.id);
    } catch {
      /* best-effort */
    }
    return { handled: true, reply: GMAIL_WRITE_REPLIES.clarifyExpired };
  }

  const data = pending.data;
  const n = data.candidates.length;
  if (selection.index < 1 || selection.index > n) {
    return {
      handled: true,
      action: data.action,
      reply:
        n === 2
          ? "That’s not one of the options — reply with 1 or 2."
          : `That’s not one of the options — reply with a number from 1 to ${n}.`,
    };
  }

  // The exact same choice again (e.g. a duplicate delivery) must not act twice.
  if (data.resolvedIndex === selection.index) {
    return { handled: true, action: data.action, reply: GMAIL_WRITE_REPLIES.clarifyAlreadyDone };
  }

  const candidate = data.candidates[selection.index - 1]!;

  // Re-check write capability — the scope could have changed since the list.
  const capability = deps.writeCapability
    ? await deps.writeCapability(userId)
    : await defaultWriteCapability(userId);
  if (capability === "not_connected") {
    return { handled: true, action: data.action, reply: GMAIL_WRITE_REPLIES.notConnected };
  }
  if (capability === "connected_readonly") {
    return { handled: true, action: data.action, reply: GMAIL_WRITE_REPLIES.reconnect };
  }

  const wasCorrection = data.resolvedIndex !== null;
  try {
    const fetchReplyContext = deps.fetchReplyContext ?? fetchGmailReplyContext;
    const ctx = await fetchReplyContext(userId, candidate.messageId);
    const to = (ctx.replyToAddress ?? "").trim();
    if (!isValidEmailAddress(to)) {
      return { handled: true, action: data.action, reply: GMAIL_WRITE_REPLIES.noReplyRecipient };
    }

    const input: GmailMessageInput = {
      to,
      toName: ctx.replyToName,
      subject: buildReplySubject(ctx.subject),
      body: data.body,
      isReply: true,
      threadId: ctx.threadId || candidate.threadId || undefined,
      inReplyTo: ctx.messageIdHeader ?? undefined,
      references: buildReferences(ctx.references, ctx.messageIdHeader),
      threadSubject: ctx.subject,
    };
    const result = await finish(userId, data.action, input, deps);

    // Record which option we acted on so a repeat is idempotent and a later
    // correction knows an earlier draft may already exist.
    const mark =
      deps.markResolved ??
      ((u: string, id: string, d: ReplyClarificationData, idx: number) =>
        markClarificationResolved(u, id, d, idx));
    try {
      await mark(userId, pending.id, data, selection.index);
    } catch {
      /* best-effort */
    }

    let reply = result.reply ?? "";
    // A correction after a draft was already created: keep it honest and
    // non-destructive — make the new draft, but say the earlier one still exists.
    if (wasCorrection && isDraftAction(data.action)) {
      reply = `${reply}\n\nHeads up: the draft I made for your earlier pick is still in your Gmail drafts — delete it there if you don’t want it.`;
    }
    return { handled: true, action: data.action, reply };
  } catch (err) {
    if (err instanceof GmailError) {
      logger.error("gmail.clarification failed", {
        provider: GMAIL_PROVIDER,
        operation: `gmail.${data.action}`,
        errorCode: err.reason,
        httpStatus: err.httpStatus,
      });
      return { handled: true, action: data.action, reply: replyForProviderError(err) };
    }
    logger.error("gmail.clarification failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: true, action: data.action, reply: GMAIL_WRITE_REPLIES.unavailable };
  }
}

// --- "Send the draft" follow-up ------------------------------------------

/** Honest, fixed replies for the draft-send follow-up (matches the codebase voice). */
export const GMAIL_DRAFT_SEND_REPLIES = {
  noDraft:
    "I couldn’t find a recent Hula-created draft to send. Please create the draft again.",
  alreadySent: "That draft was already sent.",
  multiple: "I found a few recent drafts. Which one should I send?",
  sendUnconfirmed:
    "I couldn’t confirm that Gmail sent the draft, so I haven’t marked it as sent.",
  draftGone:
    "I couldn’t find that draft in Gmail anymore — it may already have been sent or deleted. Want me to create it again?",
} as const;

/** PURE: an honest reply when a named recipient matches none of the pending drafts. */
export function noMatchingRecipientReply(hint: string): string {
  const who = hint.trim();
  return `I don’t have a recent draft addressed to ${who}. Want me to draft one?`;
}

export interface GmailDraftFollowupResult {
  handled: boolean;
  reply?: string;
}

/** Injectable deps so the whole follow-up runs with NO DB / network in tests. */
export interface GmailDraftFollowupDeps {
  writeCapability?: (userId: string) => Promise<WriteCapability>;
  loadDrafts?: (userId: string) => Promise<LoadedLastDraft[]>;
  claim?: (userId: string, id: string) => Promise<boolean>;
  markSent?: (userId: string, id: string) => Promise<void>;
  release?: (userId: string, id: string) => Promise<void>;
  /** Re-fetch to confirm the draft still exists in Gmail before sending. */
  verifyDraft?: (userId: string, draftId: string) => Promise<boolean>;
  /** Send an EXISTING Gmail draft via the provider's draft-send operation. */
  sendDraft?: (userId: string, draftId: string) => Promise<{ messageId: string; threadId: string }>;
}

/** Default: re-fetch the draft; a 404 means it's gone, any other error propagates. */
async function defaultVerifyDraft(userId: string, draftId: string): Promise<boolean> {
  try {
    const draft = await getGmailDraft(userId, draftId);
    return typeof draft?.id === "string" && draft.id.length > 0;
  } catch (err) {
    if (err instanceof GmailError && err.reason === "mailbox_not_found") return false;
    throw err;
  }
}

/**
 * Resolve and send the user's OWN recent Hula-created Gmail draft in response to a
 * natural follow-up ("send the draft", "send it", "send the draft to Rob").
 *
 * Runs ONLY when the message reads as a draft-send follow-up (see
 * `classifyDraftSend`). It resolves the exact user-scoped draft reference (never a
 * guessed draft id, never another user's draft), re-fetches the real draft to
 * confirm it still exists, and sends the ACTUAL draft via Gmail's draft-send
 * operation. Success is claimed ONLY from a validated Gmail message id; a failed,
 * malformed, or unconfirmed result is reported honestly and the draft is NOT marked
 * sent. An atomic claim prevents a repeat/duplicate "send it" from sending twice.
 * Never throws — every failure degrades to an honest reply or a clean fall-through.
 */
export async function handleGmailDraftFollowup(
  userId: string,
  text: string | undefined,
  deps: GmailDraftFollowupDeps = {},
): Promise<GmailDraftFollowupResult> {
  const match = classifyDraftSend(text);
  if (match === "none") return { handled: false };

  const load = deps.loadDrafts ?? loadRecentLastDrafts;
  let recent: LoadedLastDraft[];
  try {
    recent = await load(userId);
  } catch (err) {
    // A lookup failure must never fabricate a send — fall through safely.
    logger.error("gmail.draftFollowup load failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: false };
  }

  const pending = recent.filter((d) => d.status === "proposed" && !d.expired);
  const resolvedRecently = recent.some(
    (d) => d.status === "executed" || d.status === "confirmed",
  );

  // A "to <name>" hint narrows the candidates so "send the draft to Rob" resolves
  // Rob's draft — and never silently sends an unrelated one.
  const hint = parseDraftRecipientHint(text);
  let candidates = pending;
  if (hint) {
    const filtered = pending.filter((d) => draftRecipientMatches(d.data, hint));
    if (filtered.length === 0 && pending.length > 0) {
      return { handled: true, reply: noMatchingRecipientReply(hint) };
    }
    candidates = filtered;
  }

  if (candidates.length === 0) {
    if (resolvedRecently) {
      return { handled: true, reply: GMAIL_DRAFT_SEND_REPLIES.alreadySent };
    }
    // Explicit "send the draft" deserves an honest answer; a bare "send it" with
    // nothing to send falls through so it's never hijacked from normal chat.
    if (match === "explicit") {
      return { handled: true, reply: GMAIL_DRAFT_SEND_REPLIES.noDraft };
    }
    return { handled: false };
  }
  if (candidates.length > 1) {
    return { handled: true, reply: GMAIL_DRAFT_SEND_REPLIES.multiple };
  }

  const chosen = candidates[0]!;

  // Re-check write capability — the scope could have changed since the draft.
  const capability = deps.writeCapability
    ? await deps.writeCapability(userId)
    : await defaultWriteCapability(userId);
  if (capability === "not_connected") {
    return { handled: true, reply: GMAIL_WRITE_REPLIES.notConnected };
  }
  if (capability === "connected_readonly") {
    return { handled: true, reply: GMAIL_WRITE_REPLIES.reconnect };
  }

  // Atomically claim so a concurrent/repeat "send it" can never send twice.
  const claim = deps.claim ?? claimLastDraft;
  const claimed = await claim(userId, chosen.id);
  if (!claimed) {
    return { handled: true, reply: GMAIL_DRAFT_SEND_REPLIES.alreadySent };
  }

  const release = deps.release ?? releaseLastDraft;
  const markSent = deps.markSent ?? markLastDraftSent;
  const label = recipientLabel({ address: chosen.data.to, name: chosen.data.toName });

  try {
    // Re-fetch the real draft to confirm it still exists before sending.
    const verify = deps.verifyDraft ?? defaultVerifyDraft;
    const exists = await verify(userId, chosen.data.draftId);
    if (!exists) {
      await release(userId, chosen.id);
      return { handled: true, reply: GMAIL_DRAFT_SEND_REPLIES.draftGone };
    }

    const send = deps.sendDraft ?? sendGmailDraft;
    const sent = await send(userId, chosen.data.draftId);
    // Success ONLY from a validated Gmail message id — never a bare 2xx.
    if (!sent || !sent.messageId) {
      await release(userId, chosen.id);
      return { handled: true, reply: GMAIL_DRAFT_SEND_REPLIES.sendUnconfirmed };
    }

    await markSent(userId, chosen.id);
    return { handled: true, reply: `Draft sent to ${label}.` };
  } catch (err) {
    // Never mark sent on failure; release the claim so a retry is safe (no dup).
    try {
      await release(userId, chosen.id);
    } catch {
      /* best-effort */
    }
    if (err instanceof GmailError) {
      logger.error("gmail.draftSend failed", {
        provider: GMAIL_PROVIDER,
        operation: "gmail.draftSend",
        errorCode: err.reason,
        httpStatus: err.httpStatus,
      });
      if (err.reason === "not_connected") {
        return { handled: true, reply: GMAIL_WRITE_REPLIES.notConnected };
      }
      if (isReconnectReason(err.reason) || err.reason === "insufficient_scope") {
        return { handled: true, reply: GMAIL_WRITE_REPLIES.reconnect };
      }
      return { handled: true, reply: GMAIL_DRAFT_SEND_REPLIES.sendUnconfirmed };
    }
    logger.error("gmail.draftSend failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: true, reply: GMAIL_DRAFT_SEND_REPLIES.sendUnconfirmed };
  }
}
