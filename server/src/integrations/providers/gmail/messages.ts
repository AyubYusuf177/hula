import {
  GmailError,
  getGmailConnection,
  gmailGet,
  gmailGetForConnection,
} from "./client";
import type { FetchLike } from "./oauth";
import {
  GMAIL_PROVIDER,
  SAFE_GMAIL_LABELS,
  type NormalizedGmailMessage,
  type RawGmailListResponse,
  type RawGmailMessage,
} from "./types";

/**
 * Gmail message reads (Section 14) — READ-ONLY.
 *
 * Pure helpers (header parsing, normalization) plus one DB+network orchestrator
 * (`fetchRecentGmailMessages`). Normalization is STRICT: only whitelisted
 * metadata fields plus Gmail's own short snippet survive, so bodies, raw MIME,
 * payload parts, attachments, and the full header collection are never stored or
 * returned.
 *
 * By construction the reads request only `format=metadata` with exactly the
 * From/Subject/Date headers — there is no `format=full`, `format=raw`, body, or
 * attachment request path anywhere here.
 */

/** Cap on inbox message IDs listed for the initial milestone. */
const LIST_MAX_RESULTS = 20;
/** Cap on how many of those we fetch metadata for (bounded fan-out). */
const METADATA_FETCH_CAP = 20;
/** The only headers we ever request. */
const METADATA_HEADERS = ["From", "Subject", "Date"] as const;

/** PURE: parse a raw From header into a display name + address. */
export function parseFromHeader(
  raw: string | null | undefined,
): { name: string | null; address: string | null } {
  const value = (raw ?? "").trim();
  if (!value) return { name: null, address: null };

  // Prefer the `Display Name <addr@host>` form.
  const angled = /^(.*?)<([^>]+)>\s*$/.exec(value);
  if (angled) {
    const name = (angled[1] ?? "")
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    const address = (angled[2] ?? "").trim();
    return { name: name.length > 0 ? name : null, address: address.length > 0 ? address : null };
  }

  // A bare address with no display name.
  if (/@/.test(value)) {
    return { name: null, address: value.replace(/^"(.*)"$/, "$1").trim() };
  }

  // A name-only From (rare) — keep the name, no address.
  return { name: value.replace(/^"(.*)"$/, "$1").trim(), address: null };
}

/** PURE: find one header value (case-insensitive) from the metadata headers. */
function headerValue(
  headers: { name?: string; value?: string }[] | undefined,
  name: string,
): string | null {
  if (!Array.isArray(headers)) return null;
  const target = name.toLowerCase();
  for (const h of headers) {
    if (typeof h?.name === "string" && h.name.toLowerCase() === target) {
      return typeof h.value === "string" ? h.value : null;
    }
  }
  return null;
}

/** PURE: convert Gmail's `internalDate` (epoch ms string) to an ISO timestamp. */
export function internalDateToIso(internalDate: string | undefined): string | null {
  if (!internalDate) return null;
  const ms = Number(internalDate);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/**
 * PURE: normalize one raw Gmail metadata message into the safe, app-facing shape.
 * Only whitelisted fields are kept — the body, raw MIME, payload parts, and any
 * non-whitelisted header are deliberately dropped. Only system/category labels
 * survive (never user-defined label names).
 */
export function normalizeGmailMessage(raw: RawGmailMessage): NormalizedGmailMessage {
  const labelIds = Array.isArray(raw.labelIds)
    ? raw.labelIds.filter((l): l is string => typeof l === "string")
    : [];
  const headers = raw.payload?.headers;
  const from = parseFromHeader(headerValue(headers, "From"));
  const subject = headerValue(headers, "Subject");

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    threadId: typeof raw.threadId === "string" ? raw.threadId : "",
    fromName: from.name,
    fromAddress: from.address,
    subject: typeof subject === "string" ? subject : null,
    receivedAt: internalDateToIso(raw.internalDate),
    unread: labelIds.includes("UNREAD"),
    important: labelIds.includes("IMPORTANT"),
    labels: labelIds.filter((l) => SAFE_GMAIL_LABELS.has(l)),
    snippet: typeof raw.snippet === "string" ? raw.snippet : null,
    source: GMAIL_PROVIDER,
  };
}

/** The safe Gmail account identity we may store (email address only). */
export interface GmailIdentity {
  email: string | null;
}

/**
 * Read the user's Gmail profile to capture a safe account identity (the account
 * email address). Read-only. Never throws token data. Only `emailAddress` is
 * kept — message counts and history ids are discarded.
 */
export async function fetchGmailIdentity(
  accessToken: string,
  fetchImpl?: FetchLike,
): Promise<GmailIdentity> {
  const profile = await gmailGet<{ emailAddress?: string }>(
    accessToken,
    "/users/me/profile",
    {},
    fetchImpl,
  );
  return { email: typeof profile.emailAddress === "string" ? profile.emailAddress : null };
}

/** Options for fetching recent inbox messages. */
export interface FetchMessagesOptions {
  /** Max metadata messages to return (bounded to METADATA_FETCH_CAP). */
  maxResults?: number;
  fetchImpl?: FetchLike;
}

/**
 * Fetch recent INBOX messages for a user's connected Gmail, normalized.
 *
 * Resolves the connection (throwing `not_connected` when there is none or it is
 * not currently connected), lists at most `LIST_MAX_RESULTS` recent inbox
 * message IDs constrained to `newer_than:7d`, then fetches METADATA ONLY (From,
 * Subject, Date) for the bounded selected set and returns only normalized
 * messages. Raw payloads, bodies, and attachments are never returned or stored.
 *
 * An HTTP-200 list with no `messages` array is a SUCCESSFUL empty inbox — it
 * returns `[]` here and never becomes a provider error.
 */
export async function fetchRecentGmailMessages(
  userId: string,
  options: FetchMessagesOptions = {},
): Promise<NormalizedGmailMessage[]> {
  const connection = await getGmailConnection(userId);
  if (!connection || connection.status !== "connected") {
    throw new GmailError("not_connected", "Gmail is not connected");
  }

  const cap = Math.min(
    Math.max(1, options.maxResults ?? METADATA_FETCH_CAP),
    METADATA_FETCH_CAP,
  );

  // Stage 1: list bounded, recent inbox message IDs (constrained query).
  const list = await gmailGetForConnection<RawGmailListResponse>(
    connection.id,
    "/users/me/messages",
    {
      labelIds: "INBOX",
      maxResults: String(LIST_MAX_RESULTS),
      q: "newer_than:7d",
    },
    options.fetchImpl,
  );

  const ids = Array.isArray(list.messages)
    ? list.messages
        .map((m) => (typeof m?.id === "string" ? m.id : null))
        .filter((id): id is string => Boolean(id))
        .slice(0, cap)
    : [];
  if (ids.length === 0) return [];

  // Stage 2: metadata-only fetch for the bounded selected set. Sequential to
  // keep fan-out small and predictable; one bad message never fails the batch.
  const messages: NormalizedGmailMessage[] = [];
  for (const id of ids) {
    try {
      const raw = await gmailGetForConnection<RawGmailMessage>(
        connection.id,
        `/users/me/messages/${encodeURIComponent(id)}`,
        {
          format: "metadata",
          metadataHeaders: [...METADATA_HEADERS],
        },
        options.fetchImpl,
      );
      messages.push(normalizeGmailMessage(raw));
    } catch (err) {
      // A dead grant / scope / disabled-API failure applies to the whole batch —
      // surface it. A one-off malformed message is skipped, not fatal.
      if (err instanceof GmailError && err.reason !== "malformed_provider_response") {
        throw err;
      }
    }
  }

  // Newest first by received time (Gmail list order is already recency-ish).
  messages.sort((a, b) => {
    const ta = a.receivedAt ? Date.parse(a.receivedAt) : 0;
    const tb = b.receivedAt ? Date.parse(b.receivedAt) : 0;
    return tb - ta;
  });
  return messages;
}
