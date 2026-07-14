import { generateAnthropicText } from "../../../ai/anthropicClient";
import { getUserTimezone } from "../../../reminders/reminders";
import { logger } from "../../../utils/logger";
import { GmailError, isReconnectReason } from "./client";
import {
  fetchGmailMessageBody,
  stripQuotedReply,
  type GmailMessageBody,
} from "./messageBody";
import { searchGmailMessages, type GmailSearchCriteria } from "./gmailSearch";
import { GMAIL_REPLIES } from "./gmailQuestion";
import {
  ACTION_LINE_MAX,
  SUMMARY_LINE_MAX,
  displayReceived,
  displaySender,
  displaySubject,
  formatEmailList,
  sanitizeSummaryText,
} from "./gmailDisplay";
import { localToday } from "./gmailSearchQuestion";
import {
  extractGmailSummaryIntent,
  parseSummaryResult,
  type EmailSummariser,
  type EmailSummaryResult,
  type GmailSummaryIntent,
  type TextGenerator,
} from "./gmailSummaryExtract";
import {
  loadLatestGmailSelection,
  parseOrdinalReference,
  recordGmailSelection,
  referencesLastResults,
  resolveSelectionItem,
} from "./gmailSelection";
import {
  buildUntrustedEmailBlock,
  untrustedContentSystemRules,
} from "./untrustedContent";
import { GMAIL_PROVIDER, type NormalizedGmailMessage } from "./types";

/**
 * Gmail GROUNDED SUMMARIES (Section 17 / Phase 3.2 completion).
 *
 * Real testing showed this surface barely existed: only "summarise <sender>'s
 * latest email" was reachable. "Summarise them", "which of these need my
 * attention?", "give me a quick inbox overview" all fell through to the generic
 * model — which cannot see the inbox, so any answer it gave was invention.
 *
 * Every summary here is grounded in a REAL fetched body. The rules that matter:
 *  - Bodies are fetched per message, bounded in count and size.
 *  - Each email is summarised in ISOLATION, so facts cannot bleed between them.
 *  - Email content is UNTRUSTED: fenced, and never able to instruct Hula. The model
 *    cannot act regardless — actions only run through the deterministic executor.
 *  - A message that cannot be read is reported as such, never invented.
 *  - An action line appears only when the email genuinely implies one.
 *
 * Never throws — every failure degrades to an honest reply.
 */

/** Hard cap on how many emails one summary ever covers (bounded fan-out + tokens). */
const MAX_SUMMARY_EMAILS = 5;
/** Default when the user didn't say how many. */
const DEFAULT_SUMMARY_EMAILS = 5;

export const GMAIL_SUMMARY_REPLIES = {
  noResults: "I couldn’t find any emails to summarise.",
  noSelection:
    "I’m not sure which emails you mean — ask me to show them first, then I can summarise them.",
  outOfRange: "I don’t have an email at that position — mind showing me the list again?",
  unreadable:
    "I found that email but couldn’t read its contents just now — mind trying again shortly?",
  ambiguousSender: (name: string) =>
    `I found a few emails from ${name} — which one did you mean?`,
} as const;

// --- Prefilter (PURE) ----------------------------------------------------

const SUMMARY_VERB_RE =
  /\b(?:summar(?:y|ise|ize|ised|ized|ising|izing)|gist|tl;?dr|overview|recap|catch me up|brief)\b/i;
const TRIAGE_RE =
  /\b(?:need(?:s)?\s+(?:my\s+|a\s+|an\s+)?(?:attention|reply|response|replying|answering|action)|require(?:s)?\s+(?:my\s+|a\s+|an\s+)?(?:attention|reply|response|action)|urgent|action required|respond to|deal with|chase up)\b/i;
const EMAILISH_RE = /\b(?:e-?mails?|inbox|message|msg)\b/i;
/** "What does Robert want from me?" — a content question with no email noun. */
const WANT_RE = /\b(?:what does|what did|what's)\b.*\b(?:want|need|say|asking)\b/i;

/**
 * PURE: a cheap gate deciding whether a message is worth one model extraction.
 *
 * Matches a summary/triage verb with either an email noun OR a reference to the list
 * just shown ("summarise them"), plus the "what does X want" shape which carries no
 * email noun at all. The reference branch is the fix for the shipped failure — see
 * `referencesLastResults`.
 */
export function looksLikeSummaryRequest(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const emailish = EMAILISH_RE.test(t) || referencesLastResults(t);
  if ((SUMMARY_VERB_RE.test(t) || TRIAGE_RE.test(t)) && emailish) return true;
  // "What does Robert want from me?" — no email noun, but plainly about content.
  if (WANT_RE.test(t)) return true;
  return false;
}

// --- Formatting (PURE) ---------------------------------------------------

/** Sentence budget for the summary of a SINGLE email, which is the whole reply. */
const SINGLE_SUMMARY_MAX = 400;

/**
 * PURE: format ONE email as the whole reply.
 *
 *   Olha Ivasiuk — You're set up to test
 *   Received today at 2:02 PM
 *
 *   Olha confirms your sandbox is ready and explains the next steps.
 *
 *   Action: Follow the testing instructions to continue setup.
 *
 * Not a one-item numbered list: "1." implies a list the user never asked for, and
 * real testing showed it reading as a bug. With one email there is room to answer
 * properly, so the summary gets a wider sentence budget than a list line.
 */
export function formatSingleSummary(
  item: { message: NormalizedGmailMessage; result: EmailSummaryResult },
  tz: string | undefined,
  now: Date,
  header?: string,
): string {
  const { message, result } = item;
  const blocks: string[] = [];
  if (header) blocks.push(header);

  const head = [`${displaySender(message)} — ${displaySubject(message)}`];
  const received = displayReceived(message.receivedAt, tz, now);
  if (received) head.push(received);
  blocks.push(head.join("\n"));

  // A summary that survives the sentence clamp, or an honest failure — never a
  // fragment, and never invented text.
  blocks.push(
    sanitizeSummaryText(result.summary, SINGLE_SUMMARY_MAX) || GMAIL_SUMMARY_REPLIES.unreadable,
  );

  const action = sanitizeSummaryText(result.action, ACTION_LINE_MAX);
  if (action) blocks.push(`Action: ${action}`);

  return blocks.join("\n\n");
}

/**
 * PURE: format a grounded multi-email summary.
 *
 * Summary and action are separate lines so a suggestion is never mistaken for
 * something the email actually said.
 */
export function formatSummaryList(
  items: readonly { message: NormalizedGmailMessage; result: EmailSummaryResult }[],
  tz: string | undefined,
  now: Date,
  header: string,
): string {
  const body = formatEmailList(
    items.map(({ message, result }) => ({
      message,
      // Clamp HERE so a summary that survives nothing complete falls back to the
      // honest line rather than to an empty preview.
      preview:
        sanitizeSummaryText(result.summary, SUMMARY_LINE_MAX) || GMAIL_SUMMARY_REPLIES.unreadable,
      action: result.action || undefined,
    })),
    tz,
    now,
  );
  return `${header}\n\n${body}`;
}

/** PURE: the header for a summary reply. */
export function summaryHeader(intent: GmailSummaryIntent, count: number): string {
  if (intent.action === "triage") {
    return count === 1
      ? "One of these looks like it needs you:"
      : "Here’s what looks like it needs you:";
  }
  return count === 1 ? "Here’s the gist:" : "Here’s your inbox summary:";
}

// --- Default summariser --------------------------------------------------

/** Max characters of a real body fed to the summariser (bounds tokens). */
const SUMMARY_BODY_MAX = 3000;

/**
 * PURE: bound a real body for the model.
 *
 * Two jobs. First, drop the quoted reply chain, so the summary describes the newest
 * message rather than the thread underneath it. Second, hard-bound what is left —
 * an unbounded body is an unbounded bill and an unbounded prompt.
 *
 * The bound cuts on a word boundary. The model never sees a half-word, so it is never
 * tempted to complete one.
 */
export function boundBodyForModel(body: string, max = SUMMARY_BODY_MAX): string {
  const newest = stripQuotedReply(body);
  if (newest.length <= max) return newest;
  const window = newest.slice(0, max);
  const lastBreak = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
  return (lastBreak > max * 0.5 ? window.slice(0, lastBreak) : window).trim();
}

/**
 * Default summariser: grounded, faithful, and strictly JSON so the action line can
 * be separated from the description.
 *
 * The body is FENCED as untrusted (see `untrustedContent`). The architectural
 * guarantee is stronger than the fence: this model cannot act, so nothing an email
 * says can trigger a send, delete, or change.
 */
export async function defaultSummarise(params: {
  body: string;
  subject: string;
  sender: string;
  triage: boolean;
}): Promise<EmailSummaryResult> {
  const system = [
    "You summarise ONE email for the recipient, from the email's real content only.",
    "",
    "Respond with ONE JSON object and nothing else:",
    '{ "summary": string, "action": string }',
    "",
    "- summary: 1-2 short plain sentences saying what THIS email actually says.",
    "  Keep it under 40 words TOTAL. Every sentence must be COMPLETE and end with a",
    "  full stop. Never end mid-sentence, never end with '...' or a trailing word like",
    "  'which is' or 'inviting you to'. If it will not fit, write ONE shorter sentence.",
    "- action: what the recipient must do, ONLY if this email genuinely requires it.",
    '  One complete sentence, under 20 words. If nothing is required, use "none".',
    "  Never manufacture urgency or a task.",
    "- Never invent facts, names, dates, amounts, or offers not present in the email.",
    "- Never mention any other email.",
    "- Do not quote raw email text, headers, links, HTML, or ids. Write plain prose.",
    params.triage
      ? "- Focus on whether this email needs a reply or an action from the recipient."
      : "",
    "",
    untrustedContentSystemRules(),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const reply = await generateAnthropicText({
      system,
      messages: [
        {
          role: "user",
          content: `Summarise the email below.\n\n${buildUntrustedEmailBlock({
            sender: params.sender,
            subject: params.subject,
            body: boundBodyForModel(params.body),
          })}`,
        },
      ],
      maxTokens: 300,
    });
    // An unparseable reply is a FAILURE, not licence to invent — the caller then
    // reports the email as unreadable rather than fabricating a summary.
    return parseSummaryResult(reply) ?? { summary: "", action: "" };
  } catch {
    return { summary: "", action: "" };
  }
}

// --- Orchestrator --------------------------------------------------------

export interface GmailSummaryDeps {
  getTimezone?: (userId: string) => Promise<string | undefined>;
  extract?: (params: {
    text: string;
    todayLocal: string;
    timezone: string | undefined;
    generate?: TextGenerator;
  }) => Promise<GmailSummaryIntent | null>;
  generate?: TextGenerator;
  search?: typeof searchGmailMessages;
  fetchBody?: (userId: string, messageId: string) => Promise<GmailMessageBody>;
  summarise?: EmailSummariser;
  loadSelection?: typeof loadLatestGmailSelection;
  recordSelection?: typeof recordGmailSelection;
  now?: Date;
}

export interface GmailSummaryResult {
  handled: boolean;
  reply?: string;
  /** Count only, for safe logging — never contents. */
  summarised?: number;
}

/** Resolve WHICH messages to summarise. */
type Resolution =
  | { kind: "messages"; messages: NormalizedGmailMessage[] }
  | { kind: "reply"; reply: string };

async function resolveMessages(
  userId: string,
  text: string | undefined,
  intent: GmailSummaryIntent,
  deps: GmailSummaryDeps,
): Promise<Resolution> {
  const loadSelection = deps.loadSelection ?? loadLatestGmailSelection;
  const search = deps.search ?? searchGmailMessages;

  const ref =
    intent.ordinal && intent.ordinal >= 1
      ? { position: intent.ordinal }
      : parseOrdinalReference(text);

  // 1. A position or a collective reference -> the list Hula last showed.
  if (ref || intent.useLastResults === true || referencesLastResults(text)) {
    const selection = await loadSelection(userId);
    if (!selection || selection.data.itemKind !== "messages") {
      return { kind: "reply", reply: GMAIL_SUMMARY_REPLIES.noSelection };
    }
    const items = ref
      ? [resolveSelectionItem(selection.data, ref)]
      : selection.data.items.slice(0, MAX_SUMMARY_EMAILS);
    if (ref && !items[0]) {
      return { kind: "reply", reply: GMAIL_SUMMARY_REPLIES.outOfRange };
    }
    // The selection stores safe identifiers only, so rebuild minimal handles; each
    // body is fetched live below.
    const messages = items
      .filter((i): i is NonNullable<typeof i> => Boolean(i))
      .map((i) => ({
        id: i.id,
        threadId: i.threadId ?? "",
        fromName: i.label || null,
        fromAddress: null,
        subject: i.subject || null,
        receivedAt: i.receivedAt ?? null,
        unread: false,
        important: false,
        labels: [] as string[],
        snippet: null,
        source: GMAIL_PROVIDER,
      }));
    return { kind: "messages", messages };
  }

  // 2. A named sender -> search for their mail.
  const senderName = (intent.senderName ?? "").trim();
  if (senderName) {
    const found = await search(userId, { from: senderName, newerThanDays: 30 }, { maxResults: 3 });
    if (found.length === 0) {
      return { kind: "reply", reply: `I couldn’t find a recent email from ${senderName}.` };
    }
    // Several distinct threads is genuinely ambiguous — ask concisely rather than
    // summarising an email they didn't mean.
    const threads = new Set(found.map((m) => m.threadId || m.id));
    if (threads.size > 1) {
      const list = formatEmailList(
        found.slice(0, 3).map((m) => ({ message: m })),
        undefined,
        deps.now ?? new Date(),
      );
      return {
        kind: "reply",
        reply: `${GMAIL_SUMMARY_REPLIES.ambiguousSender(senderName)}\n\n${list}`,
      };
    }
    return { kind: "messages", messages: found.slice(0, 1) };
  }

  // 3. A fresh scoped search ("my 5 most recent", "unread from today").
  const criteria: GmailSearchCriteria = { newerThanDays: intent.todayOnly ? 1 : 7 };
  if (intent.unreadOnly === true) criteria.unread = true;
  const limit = Math.min(intent.limit ?? DEFAULT_SUMMARY_EMAILS, MAX_SUMMARY_EMAILS);
  const messages = await search(userId, criteria, { maxResults: limit });
  if (messages.length === 0) return { kind: "reply", reply: GMAIL_SUMMARY_REPLIES.noResults };
  return { kind: "messages", messages };
}

/** Map a provider error to an honest reply. */
function replyForError(err: GmailError): string {
  if (err.reason === "not_connected") return GMAIL_REPLIES.notConnected;
  if (err.reason === "insufficient_scope" || isReconnectReason(err.reason)) {
    return GMAIL_REPLIES.reconnect;
  }
  return GMAIL_REPLIES.unavailable;
}

/**
 * Handle a summary/triage request from an already-linked user. Returns
 * `{ handled:false }` for anything else (and when the model can't be reached) so the
 * caller falls through unchanged. Never throws.
 */
export async function handleGmailSummary(
  userId: string,
  text: string | undefined,
  deps: GmailSummaryDeps = {},
): Promise<GmailSummaryResult> {
  if (!looksLikeSummaryRequest(text)) return { handled: false };

  const getTz = deps.getTimezone ?? getUserTimezone;
  const extract = deps.extract ?? extractGmailSummaryIntent;
  const fetchBody = deps.fetchBody ?? fetchGmailMessageBody;
  const summarise = deps.summarise ?? defaultSummarise;
  const now = deps.now ?? new Date();

  let timezone: string | undefined;
  try {
    timezone = await getTz(userId);
  } catch {
    timezone = undefined;
  }

  const intent = await extract({
    text: text ?? "",
    todayLocal: localToday(now, timezone),
    timezone,
    generate: deps.generate,
  });
  if (!intent || intent.action === "not_summary") return { handled: false };

  try {
    const resolved = await resolveMessages(userId, text, intent, deps);
    if (resolved.kind === "reply") return { handled: true, reply: resolved.reply };

    const targets = resolved.messages.slice(0, MAX_SUMMARY_EMAILS);
    if (targets.length === 0) {
      return { handled: true, reply: GMAIL_SUMMARY_REPLIES.noResults };
    }

    // Fetch + summarise each email in ISOLATION. One model call per email is the
    // point: batching them into one prompt is exactly how facts bleed between
    // emails, which is the failure this must not have.
    const items: { message: NormalizedGmailMessage; result: EmailSummaryResult }[] = [];
    for (const message of targets) {
      let result: EmailSummaryResult = { summary: "", action: "" };
      try {
        const body = await fetchBody(userId, message.id);
        // Ground the summary in the NEWEST message, not the thread quoted beneath it.
        const content = stripQuotedReply(body.text || body.snippet || "");
        if (content) {
          result = await summarise({
            body: content,
            subject: displaySubject(message),
            sender: displaySender(message),
            triage: intent.action === "triage",
          });
        }
      } catch (err) {
        // A whole-connection failure applies to every message — surface it.
        if (
          err instanceof GmailError &&
          (err.reason === "not_connected" ||
            err.reason === "insufficient_scope" ||
            isReconnectReason(err.reason))
        ) {
          throw err;
        }
        logger.error("gmail.summary body read failed", {
          provider: GMAIL_PROVIDER,
          errorCode: err instanceof GmailError ? err.reason : "unknown",
        });
      }
      // An unreadable email is reported as unreadable — never summarised from
      // nothing, and never silently dropped.
      items.push({ message, result });
    }

    // Triage shows only what genuinely needs the user; nothing qualifying is a real,
    // useful answer rather than a manufactured to-do list.
    const shown =
      intent.action === "triage" ? items.filter((i) => i.result.action) : items;
    if (intent.action === "triage" && shown.length === 0) {
      return {
        handled: true,
        summarised: items.length,
        reply: "Nothing in there looks like it needs a reply from you.",
      };
    }

    // Re-record the shown set so "the second one" keeps working off THIS list.
    const record = deps.recordSelection ?? recordGmailSelection;
    try {
      await record(userId, {
        kind: "gmail_selection",
        itemKind: "messages",
        items: shown.map(({ message }) => ({
          id: message.id,
          threadId: message.threadId || null,
          label: displaySender(message),
          subject: displaySubject(message),
          receivedAt: message.receivedAt,
        })),
      });
    } catch (err) {
      logger.error("gmail.summary selection record failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }

    // ONE email is an answer, not a list: no "1.", and room for a fuller summary.
    // Triage keeps its header, because "this is the one that needs you" is the point.
    const single = shown.length === 1 ? shown[0] : undefined;
    const reply = single
      ? formatSingleSummary(
          single,
          timezone,
          now,
          intent.action === "triage" ? summaryHeader(intent, 1) : undefined,
        )
      : formatSummaryList(shown, timezone, now, summaryHeader(intent, shown.length));

    return { handled: true, summarised: shown.length, reply };
  } catch (err) {
    if (err instanceof GmailError) {
      logger.error("gmail.summary failed", {
        provider: GMAIL_PROVIDER,
        operation: `summary.${intent.action}`,
        errorCode: err.reason,
        httpStatus: err.httpStatus,
      });
      return { handled: true, reply: replyForError(err) };
    }
    logger.error("gmail.summary failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: true, reply: GMAIL_REPLIES.unavailable };
  }
}
