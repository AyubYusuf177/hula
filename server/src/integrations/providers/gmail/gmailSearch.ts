import {
  GmailError,
  getGmailConnection,
  gmailGetForConnection,
} from "./client";
import type { FetchLike } from "./oauth";
import { normalizeGmailMessage } from "./messages";
import {
  type NormalizedGmailMessage,
  type RawGmailListResponse,
  type RawGmailMessage,
} from "./types";

/**
 * Gmail SEARCH (Section 17) — READ-ONLY.
 *
 * Section 14 could only ever read the last 20 INBOX messages from the past 7 days
 * (`fetchRecentGmailMessages`), so anything older or outside the inbox was simply
 * unreachable. This adds real, bounded Gmail search.
 *
 * The security property that matters here: Gmail's `q` parameter is a search DSL,
 * not a plain string. Interpolating user text into it raw would let an extracted
 * value like `foo OR from:ceo@corp.com` silently widen the search past what the
 * user asked for. So NO caller ever supplies a query fragment — callers supply a
 * typed `GmailSearchCriteria`, and `buildGmailQuery` is the ONLY place a `q` string
 * is ever constructed. Every free-text value is sanitised and phrase-quoted, which
 * makes Gmail treat embedded operators as literal text; every enum is checked
 * against an allowlist; every date is format-validated.
 *
 * Reads stay metadata-only (From/Subject/Date) exactly like the Section 14 path —
 * no bodies, no attachments, no raw payloads — and fan-out stays bounded.
 */

/** Where to search. Maps to Gmail's `in:` operator via an allowlist. */
export type GmailSearchScope = "inbox" | "sent" | "drafts" | "anywhere";

/** Gmail's own inbox categories. Allowlisted — never free text. */
export type GmailSearchCategory =
  | "personal"
  | "social"
  | "promotions"
  | "updates"
  | "forums";

/**
 * A typed, already-validated search intent. Every field is optional; the builder
 * emits only the operators that are actually present. This is deliberately a
 * STRUCTURED shape rather than a query string — see the file header.
 */
export interface GmailSearchCriteria {
  /** Sender name or address ("Rob", "rob@x.com"). */
  from?: string | null;
  /** Recipient name or address. */
  to?: string | null;
  /** Words that must appear in the subject. */
  subject?: string | null;
  /** Free-text words matched anywhere in the message. */
  keywords?: string | null;
  unread?: boolean | null;
  starred?: boolean | null;
  hasAttachment?: boolean | null;
  /** Inclusive lower date bound, `YYYY-MM-DD`. */
  after?: string | null;
  /** Exclusive upper date bound, `YYYY-MM-DD`. */
  before?: string | null;
  /** Relative window in days (1–365). */
  newerThanDays?: number | null;
  scope?: GmailSearchScope | null;
  category?: GmailSearchCategory | null;
  /** An EXISTING user label name. Phrase-quoted; never created. */
  label?: string | null;
}

const SCOPES: ReadonlySet<string> = new Set(["inbox", "sent", "drafts", "anywhere"]);
const CATEGORIES: ReadonlySet<string> = new Set([
  "personal",
  "social",
  "promotions",
  "updates",
  "forums",
]);

/** Longest free-text value we will ever put in a query. */
const MAX_TERM_LENGTH = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * PURE: make one free-text value safe to embed as a QUOTED Gmail phrase.
 *
 * Strips the characters that could terminate the quoted phrase or introduce
 * grouping/negation (`"`, `\`, parens, braces), plus control characters and
 * newlines. Collapses whitespace and bounds the length. The result is always
 * wrapped in quotes by `term()`, so any surviving operator-looking text (`OR`,
 * `from:`) is matched literally by Gmail rather than executed as an operator.
 *
 * Returns "" when nothing usable survives, which callers treat as "omit".
 */
export function sanitizeSearchTerm(value: string | null | undefined): string {
  const raw = (value ?? "").normalize("NFC");
  const stripped = raw
    // Control characters / newlines (a newline could split the query).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    // Characters that could close the quoted phrase or add grouping/negation.
    .replace(/["\\(){}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, MAX_TERM_LENGTH).trim();
}

/** PURE: one `operator:"value"` clause, or "" when the value is unusable. */
function term(operator: string, value: string | null | undefined): string {
  const safe = sanitizeSearchTerm(value);
  if (!safe) return "";
  return `${operator}:"${safe}"`;
}

/** PURE: `YYYY-MM-DD` -> Gmail's `YYYY/MM/DD`, or "" when malformed. */
export function toGmailDate(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!DATE_RE.test(v)) return "";
  // Reject impossible dates (e.g. 2026-13-45) rather than pass them to Gmail.
  const [y, m, d] = v.split("-").map(Number);
  const probe = new Date(Date.UTC(y!, m! - 1, d!));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m! - 1 ||
    probe.getUTCDate() !== d
  ) {
    return "";
  }
  return v.replace(/-/g, "/");
}

/**
 * PURE: build a safe Gmail `q` string from typed criteria.
 *
 * This is the ONLY place a Gmail query is constructed. Unknown enums, malformed
 * dates, out-of-range windows, and empty terms are DROPPED rather than passed
 * through — a criterion we cannot express safely is never approximated, because
 * silently widening a search is worse than not applying the filter. Returns ""
 * when no criterion survives; the caller decides what to do with that.
 */
export function buildGmailQuery(criteria: GmailSearchCriteria): string {
  const parts: string[] = [];

  const from = term("from", criteria.from);
  if (from) parts.push(from);
  const to = term("to", criteria.to);
  if (to) parts.push(to);
  const subject = term("subject", criteria.subject);
  if (subject) parts.push(subject);

  // Free keywords carry no operator — quoted so they stay a literal phrase.
  const keywords = sanitizeSearchTerm(criteria.keywords);
  if (keywords) parts.push(`"${keywords}"`);

  if (criteria.unread === true) parts.push("is:unread");
  if (criteria.unread === false) parts.push("is:read");
  if (criteria.starred === true) parts.push("is:starred");
  if (criteria.hasAttachment === true) parts.push("has:attachment");

  const after = toGmailDate(criteria.after);
  if (after) parts.push(`after:${after}`);
  const before = toGmailDate(criteria.before);
  if (before) parts.push(`before:${before}`);

  const days = criteria.newerThanDays;
  if (typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 365) {
    parts.push(`newer_than:${days}d`);
  }

  if (criteria.scope && SCOPES.has(criteria.scope)) parts.push(`in:${criteria.scope}`);
  if (criteria.category && CATEGORIES.has(criteria.category)) {
    parts.push(`category:${criteria.category}`);
  }

  const label = term("label", criteria.label);
  if (label) parts.push(label);

  return parts.join(" ");
}

/** PURE: true when no criterion would produce a query. */
export function isEmptyCriteria(criteria: GmailSearchCriteria): boolean {
  return buildGmailQuery(criteria).length === 0;
}

// --- Provider search (DB + network) --------------------------------------

/** Hard cap on ids listed from Gmail, regardless of what a caller asks for. */
const SEARCH_LIST_CAP = 25;
/** Hard cap on metadata fetches — the real fan-out bound. */
const SEARCH_FETCH_CAP = 10;
/** The only headers search ever requests. */
const SEARCH_HEADERS = ["From", "Subject", "Date"] as const;

export interface GmailSearchOptions {
  /** Requested result count, clamped to `SEARCH_FETCH_CAP`. */
  maxResults?: number;
  fetchImpl?: FetchLike;
}

/**
 * Search a user's connected Gmail with typed criteria, returning normalized,
 * metadata-only messages (newest first).
 *
 * Two bounded stages, mirroring the Section 14 read path: list ids for the query,
 * then fetch metadata for at most `SEARCH_FETCH_CAP` of them. An HTTP-200 list with
 * no `messages` array is a SUCCESSFUL empty result (`[]`) — never an error, so the
 * caller can always tell "nothing matched" apart from "Gmail failed". A provider
 * failure throws a classified `GmailError` and is never returned as no-results.
 */
export async function searchGmailMessages(
  userId: string,
  criteria: GmailSearchCriteria,
  options: GmailSearchOptions = {},
): Promise<NormalizedGmailMessage[]> {
  const connection = await getGmailConnection(userId);
  if (!connection || connection.status !== "connected") {
    throw new GmailError("not_connected", "Gmail is not connected");
  }

  const q = buildGmailQuery(criteria);
  if (!q) {
    // Defensive invariant: empty criteria would search the ENTIRE mailbox. Callers
    // are expected to guard with `isEmptyCriteria` and ask the user to narrow it
    // down; reaching here is a programming error, not a provider failure, so it is
    // deliberately NOT a `GmailError` (that taxonomy describes Gmail's behaviour,
    // and a caller bug must not be mistaken for one).
    throw new Error("gmailSearch: refusing to run an unbounded search");
  }

  const cap = Math.min(Math.max(1, options.maxResults ?? SEARCH_FETCH_CAP), SEARCH_FETCH_CAP);

  const list = await gmailGetForConnection<RawGmailListResponse>(
    connection.id,
    "/users/me/messages",
    { q, maxResults: String(SEARCH_LIST_CAP) },
    options.fetchImpl,
  );

  const ids = Array.isArray(list.messages)
    ? list.messages
        .map((m) => (typeof m?.id === "string" ? m.id : null))
        .filter((id): id is string => Boolean(id))
        .slice(0, cap)
    : [];
  if (ids.length === 0) return [];

  const messages: NormalizedGmailMessage[] = [];
  for (const id of ids) {
    try {
      const raw = await gmailGetForConnection<RawGmailMessage>(
        connection.id,
        `/users/me/messages/${encodeURIComponent(id)}`,
        { format: "metadata", metadataHeaders: [...SEARCH_HEADERS] },
        options.fetchImpl,
      );
      messages.push(normalizeGmailMessage(raw));
    } catch (err) {
      // A dead grant / scope / disabled-API failure applies to the whole batch —
      // surface it. A single malformed message is skipped, not fatal.
      if (err instanceof GmailError && err.reason !== "malformed_provider_response") {
        throw err;
      }
    }
  }

  messages.sort((a, b) => {
    const ta = a.receivedAt ? Date.parse(a.receivedAt) : 0;
    const tb = b.receivedAt ? Date.parse(b.receivedAt) : 0;
    return tb - ta;
  });
  return messages;
}
