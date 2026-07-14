import { getUserTimezone } from "../../../reminders/reminders";
import { logger } from "../../../utils/logger";
import { GmailError, isReconnectReason } from "./client";
import { GMAIL_REPLIES } from "./gmailQuestion";
import {
  displaySender,
  displaySubject,
  formatEmailList,
} from "./gmailDisplay";
import {
  isEmptyCriteria,
  searchGmailMessages,
  type GmailSearchCriteria,
} from "./gmailSearch";
import {
  extractGmailSearchIntent,
  type GmailSearchIntent,
  type TextGenerator,
} from "./gmailSearchExtract";
import { recordGmailSelection } from "./gmailSelection";
import { dedupeToThreads } from "./gmailThreads";
import { GMAIL_PROVIDER, type NormalizedGmailMessage } from "./types";

/**
 * Gmail SEARCH routing (Section 17) — READ-ONLY.
 *
 * Answers open-ended inbox questions ("find my latest email from Rob", "show me
 * unread emails from NatWest", "what did I get last week?") from REAL Gmail search
 * results. Section 14's handler could only serve four fixed intents over the last
 * 20 inbox messages; anything else fell through to the brain, which has no inbox
 * access and could only guess.
 *
 * Runs AFTER the existing fixed-intent handlers so their behaviour is untouched,
 * and only takes messages they declined. Never throws — every failure degrades to
 * an honest reply, and "nothing matched" is always reported as distinct from
 * "Gmail failed", so Hula never implies an empty inbox when the provider errored.
 */

/** How many results we show when the user didn't ask for a number. */
const DEFAULT_SHOWN = 5;
/** Hard cap on what we ever ask Gmail for (bounded fan-out). */
const MAX_FETCH = 10;
/** The window a bare "recent emails" request means. */
const DEFAULT_RECENCY_DAYS = 7;

/**
 * PURE: is this a plain recency request ("my 5 most recent emails", "show me my
 * latest emails")?
 *
 * Needed because such a request names a COUNT but no filter, so the criteria come
 * out empty — and empty criteria are otherwise refused as too vague (rightly: they
 * would search the entire mailbox). "Most recent" is a real, answerable constraint;
 * it just isn't a Gmail search operator, so it has to be recognised and turned into
 * a bounded time window.
 */
export function isRecencyRequest(text: string | undefined): boolean {
  return /\b(?:recent|latest|newest|last)\b/i.test((text ?? "").trim());
}

export const GMAIL_SEARCH_REPLIES = {
  noResults: "I couldn’t find any emails matching that.",
  tooVague:
    "I can search your email, but I need a bit more to go on — who it’s from, the subject, or roughly when.",
} as const;

// --- Prefilter (PURE) ----------------------------------------------------

const EMAILISH_RE = /\b(?:e-?mails?|inbox|gmail)\b/i;

/**
 * An explicit search verb. Deliberately EXCLUDES generic verbs like "check", "get",
 * and "any", because those belong to the Section 14 fixed intents ("check my
 * inbox", "do I have any emails?") which must keep their existing behaviour.
 */
const SEARCH_VERB_RE = /\b(?:find|search|look up|pull up|dig out|show me|where(?:'s| is))\b/i;

/**
 * A narrowing qualifier — a sender, subject, label, or time range. This is what
 * distinguishes a real search from the fixed intents, which are all unqualified
 * ("any unread emails?"). Deliberately EXCLUDES `unread`, `important`, `latest`,
 * and `today`: those ARE the fixed intents, and matching them here would hijack
 * them.
 */
const QUALIFIER_RE =
  /\b(?:from|about|subject|labell?ed|label|starred|attachments?|sent|last (?:week|month|night)|yesterday|before|after|since)\b/i;

/**
 * PURE: a cheap gate deciding whether a message is worth one model extraction.
 *
 * Requires an email noun AND either an explicit search verb or a narrowing
 * qualifier. The exclusions above are load-bearing: this handler runs BEFORE the
 * Section 14 fixed-intent handler, so anything it matches is taken away from that
 * handler. `gmailSearch.test.ts` pins every existing Section 14 phrase against this
 * returning false. A false positive costs one extraction returning
 * `not_email_search`; the extractor is the real classifier.
 */
export function looksLikeGmailSearch(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (!EMAILISH_RE.test(t)) return false;
  return SEARCH_VERB_RE.test(t) || QUALIFIER_RE.test(t);
}

// --- Intent -> criteria (PURE) -------------------------------------------

/**
 * PURE: map a validated model intent onto typed search criteria.
 *
 * A straight field copy — deliberately NOT a place where anything is inferred or
 * defaulted. `buildGmailQuery` validates every value again and drops what it can't
 * express safely, so this stays a dumb translation with no judgement of its own.
 */
export function intentToCriteria(intent: GmailSearchIntent): GmailSearchCriteria {
  return {
    from: intent.from ?? null,
    to: intent.to ?? null,
    subject: intent.subject ?? null,
    keywords: intent.keywords ?? null,
    unread: intent.unread ?? null,
    starred: intent.starred ?? null,
    hasAttachment: intent.hasAttachment ?? null,
    after: intent.after ?? null,
    before: intent.before ?? null,
    newerThanDays: intent.newerThanDays ?? null,
    scope: intent.scope ?? null,
    category: intent.category ?? null,
    label: intent.label ?? null,
  };
}

// --- Formatting (PURE) ---------------------------------------------------

/**
 * PURE: is this a plain "recent emails" request rather than a filtered search?
 * Decides the wording only — "Here are your 5 most recent emails" vs "Here are 3
 * emails matching that".
 */
function isRecencyOnly(criteria: GmailSearchCriteria): boolean {
  return (
    !criteria.from &&
    !criteria.to &&
    !criteria.subject &&
    !criteria.keywords &&
    !criteria.label &&
    !criteria.category
  );
}

/**
 * PURE: the header line.
 *
 * Reports ONLY what is shown. The shipped version said "I found 10 emails (showing
 * the first 5)" for a request for five — exposing an internal fan-out bound the
 * user never asked about and turning a clean answer into a puzzle. The fetch bound
 * is an implementation detail and stays one.
 */
export function formatResultHeader(
  shownCount: number,
  criteria: GmailSearchCriteria,
): string {
  const noun = shownCount === 1 ? "email" : "emails";
  if (isRecencyOnly(criteria)) {
    return `Here ${shownCount === 1 ? "is" : "are"} your ${shownCount} most recent ${noun}:`;
  }
  return `Here ${shownCount === 1 ? "is" : "are"} ${shownCount} ${noun} matching that:`;
}

/**
 * PURE: collapse results to unique CONVERSATIONS, newest first, bounded to `limit`.
 *
 * Real testing showed four messages of one Robert Ellis thread listed as four
 * separate results — Gmail's own UI would have shown one row. The user is pointing
 * at conversations, so "the first one" must mean the first conversation.
 */
export function uniqueConversations(
  messages: readonly NormalizedGmailMessage[],
  limit: number,
): NormalizedGmailMessage[] {
  return dedupeToThreads(messages)
    .slice(0, Math.max(1, limit))
    .map((t) => t.latest);
}

/**
 * PURE: format search results as a concise, numbered, iMessage-friendly list.
 *
 * Shows AT MOST `limit` — the number the user asked for, or our default. Never a
 * full body, never an id, never a raw snippet (see `gmailDisplay`, which decodes the
 * HTML entities Gmail escapes into its snippets).
 *
 * The numbering IS addressable: the orchestrator records this exact list (see
 * `recordGmailSelection`), so "star the first one" resolves to the email at that
 * position. Keep the numbering and the recorded order in lockstep — showing one
 * order and remembering another would act on the wrong email.
 */
export function formatSearchResults(
  messages: readonly NormalizedGmailMessage[],
  tz: string | undefined,
  now: Date,
  limit = DEFAULT_SHOWN,
  criteria: GmailSearchCriteria = {},
): string {
  if (messages.length === 0) return GMAIL_SEARCH_REPLIES.noResults;
  const shown = uniqueConversations(messages, limit);
  const body = formatEmailList(
    shown.map((m) => ({ message: m })),
    tz,
    now,
  );
  return `${formatResultHeader(shown.length, criteria)}\n\n${body}`;
}

/** PURE: today's local date as `YYYY-MM-DD`, for the extraction prompt. */
export function localToday(now: Date, tz: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// --- Orchestrator --------------------------------------------------------

export interface GmailSearchDeps {
  getTimezone?: (userId: string) => Promise<string | undefined>;
  extract?: (params: {
    text: string;
    todayLocal: string;
    timezone: string | undefined;
    generate?: TextGenerator;
  }) => Promise<GmailSearchIntent | null>;
  generate?: TextGenerator;
  search?: typeof searchGmailMessages;
  /** Remembers the shown list so positional follow-ups resolve. */
  recordSelection?: typeof recordGmailSelection;
  now?: Date;
}

export interface GmailSearchResult {
  handled: boolean;
  reply?: string;
  /** Number of results found, for safe logging (never contents). */
  resultCount?: number;
}

/**
 * Handle an open-ended Gmail search from an already-linked user. Returns
 * `{ handled:false }` for non-search messages (and when the model can't be reached)
 * so the caller falls through unchanged. Never throws.
 */
export async function handleGmailSearch(
  userId: string,
  text: string | undefined,
  deps: GmailSearchDeps = {},
): Promise<GmailSearchResult> {
  if (!looksLikeGmailSearch(text)) return { handled: false };

  const getTz = deps.getTimezone ?? getUserTimezone;
  const extract = deps.extract ?? extractGmailSearchIntent;
  const search = deps.search ?? searchGmailMessages;
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
  // Model unavailable or off-schema -> fall through rather than guess.
  if (!intent || intent.action === "not_email_search") return { handled: false };

  const criteria = intentToCriteria(intent);

  // A bare recency request states a count and/or "most recent" but no filter, so its
  // criteria are empty. That is NOT the same as being vague — bound it to a recent
  // window and answer it. Without this, "show me my 5 most recent emails" is refused
  // as too vague, which is exactly the sort of thing that reads as broken.
  if (isEmptyCriteria(criteria) && (intent.limit || isRecencyRequest(text))) {
    criteria.newerThanDays = DEFAULT_RECENCY_DAYS;
  }

  // Still nothing usable ("find an email") would search the whole mailbox. Ask.
  if (isEmptyCriteria(criteria)) {
    return { handled: true, reply: GMAIL_SEARCH_REPLIES.tooVague };
  }

  // Honour the count the user actually asked for. When they didn't ask, use our
  // default. Either way we fetch EXACTLY what we intend to show — fetching more and
  // slicing is what produced "I found 10 emails (showing the first 5)".
  const requested = intent.limit && intent.limit >= 1 ? Math.min(intent.limit, MAX_FETCH) : DEFAULT_SHOWN;

  try {
    // Fetch a wider candidate window than we show, because several messages of ONE
    // conversation collapse into ONE result: asking Gmail for exactly 5 messages
    // could leave 2 conversations to show. Still hard-bounded by MAX_FETCH.
    const messages = await search(userId, criteria, {
      maxResults: Math.min(requested * 3, MAX_FETCH),
    });
    // The CONVERSATIONS actually shown. Everything downstream — the reply, the
    // remembered list, and the count we report — is derived from this one set, so
    // they can never disagree with each other.
    const shown = uniqueConversations(messages, requested);
    const reply = formatSearchResults(messages, timezone, now, requested, criteria);

    // Remember EXACTLY the list we showed, in the order shown, so a positional
    // follow-up ("star the first one", "summarise the second one") resolves to the
    // same conversation the user is looking at rather than re-running the search.
    // This MUST be the deduplicated set: showing conversations while remembering
    // raw messages would make "the second one" point at a row that isn't there.
    if (shown.length > 0) {
      const record = deps.recordSelection ?? recordGmailSelection;
      try {
        await record(userId, {
          kind: "gmail_selection",
          itemKind: "messages",
          items: shown.map((m) => ({
            id: m.id,
            threadId: m.threadId || null,
            label: displaySender(m),
            subject: displaySubject(m),
            receivedAt: m.receivedAt,
          })),
        });
      } catch (err) {
        // Best-effort: losing the selection only costs the "second one" shortcut,
        // so it must never turn a successful search into an error reply.
        logger.error("gmail.search selection record failed", {
          reason: err instanceof Error ? err.message : "unknown error",
        });
      }
    }

    // The count describes what the user was SHOWN — conversations — not how many
    // raw messages we happened to fetch to build them.
    return { handled: true, resultCount: shown.length, reply };
  } catch (err) {
    if (err instanceof GmailError) {
      if (err.reason === "not_connected") {
        return { handled: true, reply: GMAIL_REPLIES.notConnected };
      }
      logger.error("gmail.search failed", {
        provider: GMAIL_PROVIDER,
        operation: "gmail.search",
        errorCode: err.reason,
        httpStatus: err.httpStatus,
      });
      // A provider failure is NEVER reported as "no results" — that would imply
      // the user's inbox is empty when we simply couldn't look.
      const reply =
        err.reason === "insufficient_scope" || isReconnectReason(err.reason)
          ? GMAIL_REPLIES.reconnect
          : GMAIL_REPLIES.unavailable;
      return { handled: true, reply };
    }
    logger.error("gmail.search failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: true, reply: GMAIL_REPLIES.unavailable };
  }
}
