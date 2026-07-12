/**
 * Gmail provider types (Section 14) — READ-ONLY.
 *
 * These describe the small, SAFE surface Hula keeps from Gmail: a normalized
 * message shape with only whitelisted metadata fields plus the short snippet
 * Gmail itself supplies. Raw Gmail payloads — bodies, MIME parts, attachments,
 * full header collections — are NEVER stored or returned; only the fields below
 * survive normalization (see `messages.ts`).
 *
 * Gmail is a SEPARATE provider from Google Calendar: a different slug, different
 * connection record, credentials, scopes, status, and diagnostics. A Calendar
 * connection never counts as a Gmail connection and vice-versa.
 */

/** The stable provider slug for Gmail (matches the catalog). */
export const GMAIL_PROVIDER = "gmail" as const;

/** The single READ-ONLY scope Hula ever requests for Gmail. */
export const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly" as const;

/**
 * A normalized, app-safe Gmail message. Deliberately omits the body, raw MIME,
 * payload parts, attachment data, and the full header collection. Only the safe
 * metadata below plus Gmail's own short `snippet` survive normalization.
 */
export interface NormalizedGmailMessage {
  /** Internal Gmail message id. */
  id: string;
  /** Internal Gmail thread id. */
  threadId: string;
  /** Sender display name, when the From header supplied one. */
  fromName: string | null;
  /** Sender email address parsed from the From header. */
  fromAddress: string | null;
  /** Subject line (may be empty for no-subject messages). */
  subject: string | null;
  /** Received time (ISO 8601), derived from Gmail's `internalDate`. */
  receivedAt: string | null;
  /** True when the message still carries Gmail's UNREAD label. */
  unread: boolean;
  /** True when Gmail applied its IMPORTANT label. */
  important: boolean;
  /** Useful category/system labels only (CATEGORY_*, STARRED, …), whitelisted. */
  labels: string[];
  /** Gmail's own short snippet (never the full body). */
  snippet: string | null;
  /** Always the Gmail provider slug — marks the safe source. */
  source: typeof GMAIL_PROVIDER;
}

/** The raw shape (subset) of a Gmail `messages.list` response we read. */
export interface RawGmailListResponse {
  messages?: { id?: string; threadId?: string }[];
  resultSizeEstimate?: number;
}

/** The raw shape (subset) of a Gmail `messages.get` (format=metadata) item. */
export interface RawGmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: { name?: string; value?: string }[];
  };
}

/** System/category labels safe to surface (never user-defined label names). */
export const SAFE_GMAIL_LABELS: ReadonlySet<string> = new Set([
  "INBOX",
  "UNREAD",
  "IMPORTANT",
  "STARRED",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);
