import {
  GmailError,
  getGmailConnection,
  gmailGetForConnection,
  gmailRequestForConnection,
} from "./client";
import type { FetchLike } from "./oauth";
import { parseFromHeader } from "./messages";
import {
  type GmailReplyContext,
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

// --- Diagnostic-only helpers (never wired into the iMessage flow) --------

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
 * Delete a draft by id. NOT part of the product flow — used ONLY by the manual
 * write diagnostic to clean up its temporary draft. `gmail.compose` permits draft
 * deletion, and this narrow, internal use never touches a real user's mail.
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
