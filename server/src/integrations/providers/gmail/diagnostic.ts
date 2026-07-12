import { getConnectionForUserProvider } from "../../connections";
import { hasCredentialSecrets, readCredentialSecrets } from "../../credentials";
import {
  GmailError,
  getGmailConnection,
  gmailGetForConnection,
  type GmailErrorReason,
} from "./client";
import type { FetchLike } from "./oauth";
import { hasGmailReadonlyScope } from "./oauth";
import type { RawGmailListResponse, RawGmailMessage } from "./types";
import { GMAIL_PROVIDER } from "./types";

/**
 * Safe, current-user-only Gmail diagnostic (Section 14).
 *
 * Answers "why can't Hula read my Gmail?" WITHOUT exposing any secret. It runs
 * the read path ONE STAGE AT A TIME and reports booleans + the failing stage + a
 * single mapped `errorCode` (plus the SAFE exception name/cause code when a fetch
 * threw before any HTTP response). It NEVER returns a token, encrypted value, raw
 * Gmail payload, message id, sender, subject, snippet, or OAuth secret, and it
 * never throws — every failure becomes a stage + `errorCode`.
 *
 * An empty inbox is a SUCCESSFUL result.
 */

/** The stage at which the read path stopped (null when everything succeeded). */
export type GmailDiagnosticStage =
  | "connection"
  | "credential_loaded"
  | "credential_decrypted"
  | "access_token_valid"
  | "node_fetch_available"
  | "inbox_list_request"
  | "metadata_read_request";

/** SAFE reasons where the request DID reach Gmail (an HTTP response came back). */
const REACHED_PROVIDER_REASONS: ReadonlySet<GmailErrorReason> = new Set([
  "auth_failed",
  "insufficient_scope",
  "gmail_api_disabled",
  "mailbox_not_found",
  "provider_rate_limited",
  "provider_unavailable",
  "invalid_grant",
]);

/** The SAFE diagnostic shape. Booleans + stages + coded reasons only. */
export interface GmailDiagnostic {
  provider: typeof GMAIL_PROVIDER;
  connected: boolean;
  credentialPresent: boolean;
  credentialDecryptable: boolean;
  scopeGranted: boolean;
  accessTokenPresent: boolean;
  refreshTokenPresent: boolean;
  nodeFetchAvailable: boolean;
  gmailReachable: boolean;
  inboxListAccessible: boolean;
  metadataReadAccessible: boolean;
  safeMessageCount: number | null;
  errorStage: GmailDiagnosticStage | null;
  errorCode: GmailErrorReason | null;
  /** SAFE exception class name when a fetch threw (e.g. "TypeError"). */
  safeErrorName: string | null;
  /** SAFE underlying cause code when a fetch threw (e.g. "ENOTFOUND"). */
  safeCauseCode: string | null;
}

function baseResult(): GmailDiagnostic {
  return {
    provider: GMAIL_PROVIDER,
    connected: false,
    credentialPresent: false,
    credentialDecryptable: false,
    scopeGranted: false,
    accessTokenPresent: false,
    refreshTokenPresent: false,
    nodeFetchAvailable: typeof fetch === "function",
    gmailReachable: false,
    inboxListAccessible: false,
    metadataReadAccessible: false,
    safeMessageCount: null,
    errorStage: null,
    errorCode: null,
    safeErrorName: null,
    safeCauseCode: null,
  };
}

/** Coerce any thrown value into a safe reason code. */
function reasonOf(err: unknown): GmailErrorReason {
  return err instanceof GmailError ? err.reason : "network_failure";
}

/** Record the safe exception name/cause code onto the result (no token data). */
function recordSafeCause(result: GmailDiagnostic, err: unknown): void {
  if (err instanceof GmailError) {
    result.safeErrorName = err.safeCauseName;
    result.safeCauseCode = err.safeCauseCode;
  }
}

/**
 * Run the staged read-path diagnostic for a user. `fetchImpl` is injectable for
 * tests so this never has to hit real Gmail. Never throws.
 */
export async function runGmailDiagnostic(
  userId: string,
  fetchImpl?: FetchLike,
): Promise<GmailDiagnostic> {
  const result = baseResult();

  // Stage: connection ------------------------------------------------------
  const view = await getConnectionForUserProvider(userId, GMAIL_PROVIDER);
  result.connected = view?.status === "connected";
  result.scopeGranted = view ? hasGmailReadonlyScope(view.grantedScopes) : false;

  const conn = await getGmailConnection(userId);
  if (!conn) {
    result.errorStage = "connection";
    result.errorCode = "not_connected";
    return result;
  }

  // Stage: credential_loaded (presence only — no decryption) ---------------
  const creds = await hasCredentialSecrets(conn.id);
  result.credentialPresent = creds.credentialPresent;
  result.refreshTokenPresent = creds.refreshTokenPresent;
  if (!creds.credentialPresent) {
    result.errorStage = "credential_loaded";
    result.errorCode = "not_connected";
    return result;
  }

  if (conn.status !== "connected") {
    result.errorStage = "connection";
    result.errorCode = conn.status === "expired" ? "invalid_grant" : "not_connected";
    return result;
  }

  // Stage: credential_decrypted + access_token_valid -----------------------
  try {
    const secrets = await readCredentialSecrets(conn.id);
    result.credentialDecryptable = true;
    result.refreshTokenPresent = Boolean(secrets?.refreshToken);
    const accessToken = secrets?.accessToken ?? null;
    result.accessTokenPresent = typeof accessToken === "string" && accessToken.length > 0;
    if (!result.accessTokenPresent && !result.refreshTokenPresent) {
      result.errorStage = "access_token_valid";
      result.errorCode = "not_connected";
      return result;
    }
  } catch {
    result.errorStage = "credential_decrypted";
    result.errorCode = "credential_decrypt_failed";
    return result;
  }

  // Stage: node_fetch_available --------------------------------------------
  if (!result.nodeFetchAvailable) {
    result.errorStage = "node_fetch_available";
    result.errorCode = "network_failure";
    return result;
  }

  // Stage: inbox_list_request (proves reachability + list access). ----------
  let firstMessageId: string | null = null;
  try {
    const list = await gmailGetForConnection<RawGmailListResponse>(
      conn.id,
      "/users/me/messages",
      { labelIds: "INBOX", maxResults: "1", q: "newer_than:7d" },
      fetchImpl,
    );
    result.gmailReachable = true;
    result.inboxListAccessible = true;
    const first = Array.isArray(list.messages) ? list.messages[0] : undefined;
    firstMessageId = typeof first?.id === "string" ? first.id : null;
    // An empty inbox is a success: count is 0, metadata stage has nothing to read.
    result.safeMessageCount = Array.isArray(list.messages) ? list.messages.length : 0;
  } catch (err) {
    result.errorStage = "inbox_list_request";
    result.errorCode = reasonOf(err);
    recordSafeCause(result, err);
    result.gmailReachable = REACHED_PROVIDER_REASONS.has(result.errorCode);
    return result;
  }

  // Stage: metadata_read_request (proves the read scope actually works). -----
  // Only run if there is a message to read; an empty inbox is already a success.
  if (!firstMessageId) {
    result.metadataReadAccessible = true;
    return result;
  }
  try {
    await gmailGetForConnection<RawGmailMessage>(
      conn.id,
      `/users/me/messages/${encodeURIComponent(firstMessageId)}`,
      { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] },
      fetchImpl,
    );
    result.metadataReadAccessible = true;
  } catch (err) {
    result.errorStage = "metadata_read_request";
    result.errorCode = reasonOf(err);
    recordSafeCause(result, err);
    return result;
  }

  return result;
}
