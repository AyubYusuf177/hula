import {
  GmailError,
  getGmailConnection,
  gmailGetForConnection,
  gmailRequestForConnection,
} from "./client";
import type { FetchLike } from "./oauth";
import { parseFromHeader } from "./messages";
import { extractPlainText } from "./messageBody";
import {
  GMAIL_PROVIDER,
  type GmailReplyContext,
  type NormalizedGmailDraft,
  type RawGmailDraftDetail,
  type RawGmailDraftListResponse,
  type RawGmailDraftResponse,
  type RawGmailMessage,
  type RawGmailSendResponse,
} from "./types";

/**
 * Gmail draft + send provider layer (Section 16).
 *
 * The ONLY functions that mutate a user's Gmail — create a draft, send a message,
 * or (diagnostic-only) fetch/delete a temporary draft. Every Gmail API call stays
 * inside this provider layer (never in a webhook route or the executor). Each call
 * reuses the existing connection resolution + token refresh + one-retry policy
 * from `client.ts`, so nothing here touches a token directly. The raw MIME is
 * built by the pure `mime.ts` and passed in as an opaque base64url `raw` — this
 * layer never logs it.
 */

/** Resolve the connected connection id, or throw a safe `not_connected`. */
async function requireConnectionId(userId: string): Promise<string> {
  const connection = await getGmailConnection(userId);
  if (!connection || connection.status !== "connected") {
    throw new GmailError("not_connected", "Gmail is not connected");
  }
  return connection.id;
}

/** The safe result of creating a draft — Gmail-returned ids only. */
export interface CreatedGmailDraft {
  draftId: string;
  messageId: string;
  threadId: string;
}

/** The safe result of sending a message — Gmail-returned ids only. */
export interface SentGmailMessage {
  messageId: string;
  threadId: string;
}

/** The `raw` payload a draft/send request carries (from `mime.ts`). */
export interface GmailRawPayload {
  raw: string;
  threadId?: string;
}

/**
 * Create a real Gmail draft from a prepared `raw` MIME payload. Returns the
 * Gmail-issued draft/message/thread ids. The draft appears in the user's Drafts
 * folder. Never sends. Throws a classified `GmailError` on failure.
 */
export async function createGmailDraft(
  userId: string,
  payload: GmailRawPayload,
  fetchImpl?: FetchLike,
): Promise<CreatedGmailDraft> {
  const connectionId = await requireConnectionId(userId);
  const message: Record<string, string> = { raw: payload.raw };
  if (payload.threadId) message.threadId = payload.threadId;
  const res = await gmailRequestForConnection<RawGmailDraftResponse>(
    connectionId,
    "POST",
    "/users/me/drafts",
    { body: { message } },
    fetchImpl,
  );
  const draftId = typeof res.id === "string" ? res.id : "";
  const messageId = typeof res.message?.id === "string" ? res.message.id : "";
  const threadId = typeof res.message?.threadId === "string" ? res.message.threadId : "";
  if (!draftId || !messageId) {
    throw new GmailError(
      "malformed_provider_response",
      "Gmail did not return a draft id",
    );
  }
  return { draftId, messageId, threadId };
}

/**
 * Send a message from a prepared `raw` MIME payload. Returns the Gmail-issued
 * message/thread ids. For a reply, pass the reply's `threadId` so Gmail keeps it
 * in-thread. Throws a classified `GmailError` on failure — a thrown error means
 * NOTHING was sent that we can confirm, so the caller must not report success.
 */
export async function sendGmailMessage(
  userId: string,
  payload: GmailRawPayload,
  fetchImpl?: FetchLike,
): Promise<SentGmailMessage> {
  const connectionId = await requireConnectionId(userId);
  const body: Record<string, string> = { raw: payload.raw };
  if (payload.threadId) body.threadId = payload.threadId;
  const res = await gmailRequestForConnection<RawGmailSendResponse>(
    connectionId,
    "POST",
    "/users/me/messages/send",
    { body },
    fetchImpl,
  );
  const messageId = typeof res.id === "string" ? res.id : "";
  const threadId = typeof res.threadId === "string" ? res.threadId : "";
  if (!messageId) {
    throw new GmailError(
      "malformed_provider_response",
      "Gmail did not confirm the sent message",
    );
  }
  return { messageId, threadId };
}

/**
 * Send an EXISTING Gmail draft the user already has (Section 16 draft follow-up).
 *
 * Uses Gmail's `drafts.send` operation — POST /users/me/drafts/send with the draft
 * id — so the ACTUAL draft the user reviewed is sent, not a reconstructed copy.
 * `gmail.compose` is sufficient for this; no broader mailbox scope is needed.
 * Returns the Gmail-issued message/thread ids. Throws a classified `GmailError` on
 * failure — a thrown error means we cannot confirm a send, so the caller must not
 * report success. Never logs the draft id, MIME, or any token.
 */
export async function sendGmailDraft(
  userId: string,
  draftId: string,
  fetchImpl?: FetchLike,
): Promise<SentGmailMessage> {
  const connectionId = await requireConnectionId(userId);
  const res = await gmailRequestForConnection<RawGmailSendResponse>(
    connectionId,
    "POST",
    "/users/me/drafts/send",
    { body: { id: draftId } },
    fetchImpl,
  );
  const messageId = typeof res.id === "string" ? res.id : "";
  const threadId = typeof res.threadId === "string" ? res.threadId : "";
  if (!messageId) {
    throw new GmailError(
      "malformed_provider_response",
      "Gmail did not confirm the sent draft",
    );
  }
  return { messageId, threadId };
}

/** PURE: find one metadata header value (case-insensitive). */
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

/**
 * PURE: derive the reply context (threading headers + reply recipient) from a raw
 * metadata message. `Reply-To` wins over `From` for where a reply goes; the
 * existing `References` chain is preserved. Split out for unit testing.
 */
export function buildReplyContext(raw: RawGmailMessage): GmailReplyContext {
  const headers = raw.payload?.headers;
  const messageIdHeader = headerValue(headers, "Message-ID") ?? headerValue(headers, "Message-Id");
  const references = headerValue(headers, "References");
  const replyTo = headerValue(headers, "Reply-To");
  const from = headerValue(headers, "From");
  const subject = headerValue(headers, "Subject");

  // Prefer Reply-To; fall back to the actual sender (From). Never reply-all.
  const target = parseFromHeader(replyTo ?? from);

  return {
    threadId: typeof raw.threadId === "string" ? raw.threadId : "",
    messageIdHeader: messageIdHeader && messageIdHeader.trim() ? messageIdHeader.trim() : null,
    references: references && references.trim() ? references.trim() : null,
    replyToAddress: target.address,
    replyToName: target.name,
    subject: typeof subject === "string" ? subject : null,
  };
}

/**
 * Fetch the reply context for ONE message (metadata only — the threading headers,
 * From/Reply-To, and Subject). Never reads or returns the body. Used to build a
 * correct reply draft/send. Throws a classified `GmailError` on failure.
 */
export async function fetchGmailReplyContext(
  userId: string,
  messageId: string,
  fetchImpl?: FetchLike,
): Promise<GmailReplyContext> {
  const connectionId = await requireConnectionId(userId);
  const raw = await gmailGetForConnection<RawGmailMessage>(
    connectionId,
    `/users/me/messages/${encodeURIComponent(messageId)}`,
    {
      format: "metadata",
      metadataHeaders: ["Message-ID", "References", "Reply-To", "From", "Subject"],
    },
    fetchImpl,
  );
  return buildReplyContext(raw);
}

// --- Draft lifecycle (Section 17) ----------------------------------------

/**
 * Every draft operation below is authorised by the SAME `gmail.compose` scope
 * Section 16 already requests (verified against Google's per-method reference for
 * drafts.list/get/update/delete). So the complete lifecycle works on existing Gmail
 * connections with NO reconnect, and no broader scope — notably not `gmail.modify`
 * or `https://mail.google.com/` — is introduced.
 */

/** Cap on drafts listed in one request (bounded fan-out). */
const DRAFT_LIST_CAP = 10;

/** PURE: normalize one raw draft detail into the safe, app-facing shape. */
export function normalizeGmailDraft(raw: RawGmailDraftDetail): NormalizedGmailDraft {
  const headers = raw.message?.payload?.headers;
  const to = parseFromHeader(headerValue(headers, "To"));
  const subject = headerValue(headers, "Subject");
  return {
    draftId: typeof raw.id === "string" ? raw.id : "",
    messageId: typeof raw.message?.id === "string" ? raw.message.id : null,
    threadId: typeof raw.message?.threadId === "string" ? raw.message.threadId : null,
    to: to.address,
    toName: to.name,
    subject: typeof subject === "string" ? subject : null,
    snippet: typeof raw.message?.snippet === "string" ? raw.message.snippet : null,
    source: GMAIL_PROVIDER,
  };
}

/**
 * List the user's Gmail drafts, normalized, newest-first as Gmail returns them.
 *
 * Two bounded stages, like every other read here: list ids, then fetch metadata for
 * at most `DRAFT_LIST_CAP`. `drafts.list` returns only ids, so the per-draft
 * metadata fetch is required to show a recipient/subject at all. An HTTP-200 list
 * with no `drafts` array is a SUCCESSFUL empty result (`[]`), never an error.
 */
export async function listGmailDrafts(
  userId: string,
  options: { maxResults?: number; fetchImpl?: FetchLike } = {},
): Promise<NormalizedGmailDraft[]> {
  const connectionId = await requireConnectionId(userId);
  const cap = Math.min(Math.max(1, options.maxResults ?? DRAFT_LIST_CAP), DRAFT_LIST_CAP);

  const list = await gmailGetForConnection<RawGmailDraftListResponse>(
    connectionId,
    "/users/me/drafts",
    { maxResults: String(cap) },
    options.fetchImpl,
  );

  const ids = Array.isArray(list.drafts)
    ? list.drafts
        .map((d) => (typeof d?.id === "string" ? d.id : null))
        .filter((id): id is string => Boolean(id))
        .slice(0, cap)
    : [];
  if (ids.length === 0) return [];

  const drafts: NormalizedGmailDraft[] = [];
  for (const id of ids) {
    try {
      const raw = await gmailGetForConnection<RawGmailDraftDetail>(
        connectionId,
        `/users/me/drafts/${encodeURIComponent(id)}`,
        { format: "metadata" },
        options.fetchImpl,
      );
      const normalized = normalizeGmailDraft(raw);
      if (normalized.draftId) drafts.push(normalized);
    } catch (err) {
      // A dead grant / scope failure applies to the whole batch — surface it. One
      // malformed draft is skipped, not fatal.
      if (err instanceof GmailError && err.reason !== "malformed_provider_response") {
        throw err;
      }
    }
  }
  return drafts;
}

/** One draft's metadata plus its real body text (for an explicit inspect). */
export interface GmailDraftDetail {
  draft: NormalizedGmailDraft;
  /** The draft's plain-text body (best-effort), or "" when none could be read. */
  body: string;
  /**
   * The draft's existing `In-Reply-To` header, when it is a reply.
   *
   * Load-bearing for edits: Gmail's draft update REPLACES the whole message, so the
   * rebuilt MIME must carry these headers forward or an edited reply silently
   * detaches from its thread and arrives as a stray new email.
   */
  inReplyTo: string | null;
  /** The draft's existing `References` chain, when it is a reply. */
  references: string | null;
}

/**
 * Fetch ONE draft in full, including its body, for an explicit inspect/edit.
 *
 * This is the RE-FETCH the edit and send paths depend on: it reads the draft's
 * CURRENT state straight from Gmail rather than trusting a stored reference that
 * may be stale (the user may have edited or deleted it in the Gmail UI since).
 * Throws a classified `GmailError` — notably `mailbox_not_found` when the draft is
 * gone — so the caller degrades honestly instead of acting on a dead id.
 */
export async function getGmailDraftDetail(
  userId: string,
  draftId: string,
  fetchImpl?: FetchLike,
): Promise<GmailDraftDetail> {
  const connectionId = await requireConnectionId(userId);
  const raw = await gmailGetForConnection<RawGmailDraftDetail>(
    connectionId,
    `/users/me/drafts/${encodeURIComponent(draftId)}`,
    { format: "full" },
    fetchImpl,
  );
  const draft = normalizeGmailDraft(raw);
  if (!draft.draftId) {
    throw new GmailError("malformed_provider_response", "Gmail did not return a draft id");
  }
  // The nested message is an ordinary message resource, so the existing body
  // extractor (text/plain -> stripped text/html -> top-level) applies unchanged.
  const body = raw.message ? extractPlainText(raw.message as never) : "";
  const headers = raw.message?.payload?.headers;
  const inReplyTo = headerValue(headers, "In-Reply-To");
  const references = headerValue(headers, "References");
  return {
    draft,
    body,
    inReplyTo: inReplyTo && inReplyTo.trim() ? inReplyTo.trim() : null,
    references: references && references.trim() ? references.trim() : null,
  };
}

/**
 * Replace an EXISTING draft's content (PUT /users/me/drafts/{id}).
 *
 * Gmail's update is a full REPLACE, not a patch: the supplied `raw` becomes the
 * draft's entire new message. That is why the edit flow re-fetches the draft, edits
 * the real body, and rebuilds the complete MIME — a partial payload here would
 * silently discard the rest of the draft. Passing the original `threadId` keeps a
 * reply draft in its thread. Returns the Gmail-issued ids; a response without a
 * draft id is not a confirmed update and throws.
 */
export async function updateGmailDraft(
  userId: string,
  draftId: string,
  payload: GmailRawPayload,
  fetchImpl?: FetchLike,
): Promise<CreatedGmailDraft> {
  const connectionId = await requireConnectionId(userId);
  const message: Record<string, string> = { raw: payload.raw };
  if (payload.threadId) message.threadId = payload.threadId;
  const res = await gmailRequestForConnection<RawGmailDraftResponse>(
    connectionId,
    "PUT",
    `/users/me/drafts/${encodeURIComponent(draftId)}`,
    { body: { id: draftId, message } },
    fetchImpl,
  );
  const id = typeof res.id === "string" ? res.id : "";
  const messageId = typeof res.message?.id === "string" ? res.message.id : "";
  const threadId = typeof res.message?.threadId === "string" ? res.message.threadId : "";
  if (!id || !messageId) {
    throw new GmailError(
      "malformed_provider_response",
      "Gmail did not confirm the updated draft",
    );
  }
  if (id !== draftId) {
    // Gmail confirming a DIFFERENT draft than the one we targeted must never be
    // reported as the requested edit succeeding.
    throw new GmailError(
      "malformed_provider_response",
      "Gmail confirmed a different draft than requested",
    );
  }
  return { draftId: id, messageId, threadId };
}

/** Fetch a draft's ids to verify it exists (diagnostic use only). */
export async function getGmailDraft(
  userId: string,
  draftId: string,
  fetchImpl?: FetchLike,
): Promise<RawGmailDraftResponse> {
  const connectionId = await requireConnectionId(userId);
  return gmailGetForConnection<RawGmailDraftResponse>(
    connectionId,
    `/users/me/drafts/${encodeURIComponent(draftId)}`,
    { format: "metadata" },
    fetchImpl,
  );
}

/**
 * Delete a draft by id (DELETE /users/me/drafts/{id}).
 *
 * DESTRUCTIVE and irreversible — Gmail does not trash a deleted draft, it removes
 * it. Section 17 wires this into the product flow behind an explicit confirmation
 * (`email.deleteDraft`); before that it was diagnostic-only. Success is Gmail's own
 * 2xx: the client throws a classified error on anything else, so returning normally
 * is the only basis on which a caller may report a deletion.
 */
export async function deleteGmailDraft(
  userId: string,
  draftId: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const connectionId = await requireConnectionId(userId);
  await gmailRequestForConnection<Record<string, never>>(
    connectionId,
    "DELETE",
    `/users/me/drafts/${encodeURIComponent(draftId)}`,
    {},
    fetchImpl,
  );
}
