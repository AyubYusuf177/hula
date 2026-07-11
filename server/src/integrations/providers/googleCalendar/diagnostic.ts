import { getConnectionForUserProvider } from "../../connections";
import { hasCredentialSecrets, readCredentialSecrets } from "../../credentials";
import {
  GoogleCalendarError,
  getGoogleCalendarConnection,
  googleCalendarGetForConnection,
  type GoogleCalendarErrorReason,
} from "./client";
import type { FetchLike } from "./oauth";
import { GOOGLE_CALENDAR_PROVIDER } from "./types";

/**
 * Safe, current-user-only Google Calendar diagnostic (Section 13).
 *
 * Answers "why can't Hula read my calendar?" WITHOUT exposing any secret. It
 * runs the read path ONE STAGE AT A TIME and reports booleans + the failing
 * stage + a single mapped `errorCode` (plus the SAFE exception name/cause code
 * when a fetch threw before any HTTP response). It NEVER returns a token,
 * encrypted value, raw Google payload, or OAuth secret, and it never throws —
 * every failure becomes a stage + `errorCode`.
 *
 * The two most common real-world causes it now pinpoints:
 *   - the Calendar API is disabled in the OAuth client's Cloud project (consent
 *     succeeds but every call 403s) → `google_calendar_api_disabled`;
 *   - the request threw BEFORE an HTTP response (transport/URL/header/timeout) →
 *     `errorStage` = "primary_calendar_request" with a precise transport code.
 */

const READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

/** The stage at which the read path stopped (null when everything succeeded). */
export type GoogleCalendarDiagnosticStage =
  | "connection"
  | "credential_loaded"
  | "credential_decrypted"
  | "access_token_valid"
  | "node_fetch_available"
  | "primary_calendar_request"
  | "event_list_request";

/** SAFE reasons where the request DID reach Google (an HTTP response came back). */
const REACHED_PROVIDER_REASONS: ReadonlySet<GoogleCalendarErrorReason> = new Set([
  "auth_failed",
  "insufficient_scope",
  "google_calendar_api_disabled",
  "calendar_not_found",
  "provider_rate_limited",
  "provider_unavailable",
  "invalid_grant",
]);

/** The SAFE diagnostic shape. Booleans + stages + coded reasons only. */
export interface GoogleCalendarDiagnostic {
  provider: typeof GOOGLE_CALENDAR_PROVIDER;
  connected: boolean;
  credentialPresent: boolean;
  credentialDecryptable: boolean;
  scopeGranted: boolean;
  accessTokenPresent: boolean;
  refreshTokenPresent: boolean;
  nodeFetchAvailable: boolean;
  googleReachable: boolean;
  /** Kept for backward compatibility with existing clients (== googleReachable). */
  calendarApiReachable: boolean;
  primaryCalendarAccessible: boolean;
  eventReadAccessible: boolean;
  eventCount: number | null;
  errorStage: GoogleCalendarDiagnosticStage | null;
  errorCode: GoogleCalendarErrorReason | null;
  /** SAFE exception class name when a fetch threw (e.g. "TypeError"). */
  safeErrorName: string | null;
  /** SAFE underlying cause code when a fetch threw (e.g. "ENOTFOUND"). */
  safeCauseCode: string | null;
}

function baseResult(): GoogleCalendarDiagnostic {
  return {
    provider: GOOGLE_CALENDAR_PROVIDER,
    connected: false,
    credentialPresent: false,
    credentialDecryptable: false,
    scopeGranted: false,
    accessTokenPresent: false,
    refreshTokenPresent: false,
    nodeFetchAvailable: typeof fetch === "function",
    googleReachable: false,
    calendarApiReachable: false,
    primaryCalendarAccessible: false,
    eventReadAccessible: false,
    eventCount: null,
    errorStage: null,
    errorCode: null,
    safeErrorName: null,
    safeCauseCode: null,
  };
}

/** Coerce any thrown value into a safe reason code. */
function reasonOf(err: unknown): GoogleCalendarErrorReason {
  return err instanceof GoogleCalendarError ? err.reason : "network_failure";
}

/** Record the safe exception name/cause code onto the result (no token data). */
function recordSafeCause(result: GoogleCalendarDiagnostic, err: unknown): void {
  if (err instanceof GoogleCalendarError) {
    result.safeErrorName = err.safeCauseName;
    result.safeCauseCode = err.safeCauseCode;
  }
}

/**
 * Run the staged read-path diagnostic for a user. `fetchImpl` is injectable for
 * tests so this never has to hit real Google. Never throws.
 */
export async function runGoogleCalendarDiagnostic(
  userId: string,
  fetchImpl?: FetchLike,
): Promise<GoogleCalendarDiagnostic> {
  const result = baseResult();

  // Stage: connection ------------------------------------------------------
  const view = await getConnectionForUserProvider(userId, GOOGLE_CALENDAR_PROVIDER);
  result.connected = view?.status === "connected";
  result.scopeGranted = Boolean(view?.grantedScopes.includes(READONLY_SCOPE));

  const conn = await getGoogleCalendarConnection(userId);
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
  // Server-only decryption; token VALUES are never logged or returned.
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
    // Any failure reading/decrypting the stored credential is a decrypt failure.
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

  // Stage: primary_calendar_request (proves reachability + calendar access).
  // A valid token is refreshed inside the call if the local one is stale.
  try {
    await googleCalendarGetForConnection<{ id?: string }>(
      conn.id,
      "/calendars/primary",
      {},
      fetchImpl,
    );
    result.googleReachable = true;
    result.calendarApiReachable = true;
    result.primaryCalendarAccessible = true;
  } catch (err) {
    result.errorStage = "primary_calendar_request";
    result.errorCode = reasonOf(err);
    recordSafeCause(result, err);
    // We reached Google iff it returned an HTTP response (transport errors did not).
    result.googleReachable = REACHED_PROVIDER_REASONS.has(result.errorCode);
    result.calendarApiReachable = result.googleReachable;
    return result;
  }

  // Stage: event_list_request (proves the read scope actually works) --------
  try {
    const data = await googleCalendarGetForConnection<{ items?: unknown[] }>(
      conn.id,
      "/calendars/primary/events",
      {
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "1",
        timeMin: new Date().toISOString(),
      },
      fetchImpl,
    );
    result.eventReadAccessible = true;
    result.eventCount = Array.isArray(data.items) ? data.items.length : 0;
  } catch (err) {
    result.errorStage = "event_list_request";
    result.errorCode = reasonOf(err);
    recordSafeCause(result, err);
    return result;
  }

  return result;
}
