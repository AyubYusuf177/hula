import { getPrisma } from "../../../db/prisma";
import { logger } from "../../../utils/logger";
import { TokenVaultConfigError } from "../../tokenVault";
import { readCredentialSecrets, storeRefreshedCredential } from "../../credentials";
import {
  getGoogleOAuthConfig,
  refreshAccessToken,
  type FetchLike,
} from "./oauth";
import { GOOGLE_CALENDAR_PROVIDER } from "./types";

/**
 * Google Calendar client plumbing (Section 11 / hardened Section 13) — READ-ONLY.
 *
 * Resolves a user's connection, hands out a VALID access token (refreshing it
 * server-side when it is close to expiry), and performs authenticated GET calls
 * against the Calendar API. Tokens never leave the backend and are never logged.
 *
 * Failures are classified into precise, SAFE reason codes (never the raw Google
 * body) so the developer can tell an API-not-enabled 403 apart from an expired
 * grant, an insufficient scope, or a rate limit. A single valid authentication
 * failure triggers exactly one refresh + retry — never an infinite loop.
 */

/** Refresh a little before the token actually expires to avoid edge failures. */
const EXPIRY_SKEW_MS = 60 * 1000;

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/**
 * Machine-readable, SAFE failure reasons. Every one is safe to log/return — none
 * carries token or raw-provider material.
 */
export type GoogleCalendarErrorReason =
  | "not_connected"
  | "credential_decrypt_failed"
  | "no_refresh_token"
  | "token_refresh_failed"
  | "invalid_grant"
  | "auth_failed"
  | "insufficient_scope"
  | "google_calendar_api_disabled"
  | "calendar_not_found"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "malformed_provider_response"
  // Precise pre-HTTP-response transport failures (fetch threw, no status):
  | "google_calendar_timeout"
  | "dns_failure"
  | "connection_reset"
  | "connection_refused"
  | "connect_timeout"
  | "malformed_request_url"
  | "invalid_request_headers"
  | "network_failure";

/** Reasons that mean "the user must reconnect" (grant is no longer usable). */
const RECONNECT_REASONS: ReadonlySet<GoogleCalendarErrorReason> = new Set([
  "no_refresh_token",
  "invalid_grant",
]);

/** A safe error for calendar reads. Never carries token material. */
export class GoogleCalendarError extends Error {
  reason: GoogleCalendarErrorReason;
  /** The provider HTTP status, when the failure came from an HTTP response. */
  httpStatus: number | null;
  /**
   * SAFE cause metadata when the failure was a thrown fetch exception (no HTTP
   * response). These are the exception's class name and its underlying cause
   * `code` (e.g. "TypeError", "ENOTFOUND") — never a token, header, or body.
   */
  safeCauseName: string | null;
  safeCauseCode: string | null;
  constructor(
    reason: GoogleCalendarErrorReason,
    message?: string,
    httpStatus: number | null = null,
    safeCause?: { name?: string | null; code?: string | null },
  ) {
    super(message ?? reason);
    this.name = "GoogleCalendarError";
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.safeCauseName = safeCause?.name ?? null;
    this.safeCauseCode = safeCause?.code ?? null;
  }
}

/**
 * PURE: map a Google Calendar API HTTP status + (lowercased-safe) body signal to
 * a precise reason. Deliberately never returns the body — only a coded reason.
 *
 * The distinctive 403 cases:
 *   - API disabled in the Cloud project → `google_calendar_api_disabled`
 *     (Google: "…API has not been used in project … before or it is disabled",
 *      reason `accessNotConfigured` / status `SERVICE_DISABLED`).
 *   - Missing/insufficient scope → `insufficient_scope`
 *     (Google: "insufficient authentication scopes", reason
 *      `ACCESS_TOKEN_SCOPE_INSUFFICIENT` / `insufficientPermissions`).
 */
export function classifyCalendarHttpError(
  status: number,
  bodyText: string,
): GoogleCalendarErrorReason {
  const body = (bodyText ?? "").toLowerCase();
  if (status === 401) return "auth_failed";
  if (status === 403) {
    if (
      body.includes("has not been used in project") ||
      body.includes("accessnotconfigured") ||
      body.includes("service_disabled") ||
      body.includes("it is disabled")
    ) {
      return "google_calendar_api_disabled";
    }
    if (
      body.includes("insufficient") ||
      body.includes("scope_insufficient") ||
      body.includes("insufficientpermissions")
    ) {
      return "insufficient_scope";
    }
    return "provider_unavailable";
  }
  if (status === 404) return "calendar_not_found";
  // 410 Gone — the event was already deleted; treat as "not found" for writes.
  if (status === 410) return "calendar_not_found";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
}

/** Provider request timeout. Generous enough for a cold mobile network. */
const PROVIDER_TIMEOUT_MS = 12_000;

/** SAFE cause metadata read off a thrown fetch error (undici sets `.cause`). */
export interface SafeFetchCause {
  /** The exception class name, e.g. "TypeError" / "AbortError". */
  name: string | null;
  /** The underlying cause `code`, e.g. "ENOTFOUND" / "ECONNRESET". */
  code: string | null;
  /** The underlying cause message (host-level, never a token/header/body). */
  message: string | null;
}

/**
 * PURE: extract SAFE cause metadata from a thrown fetch exception. Node's fetch
 * wraps transport errors as `TypeError("fetch failed")` with a `.cause` carrying
 * the real `code`/`message` (e.g. "getaddrinfo ENOTFOUND www.googleapis.com").
 * None of these values contain token, header, or body material.
 */
export function safeFetchCause(err: unknown): SafeFetchCause {
  const name = err instanceof Error && typeof err.name === "string" ? err.name : null;
  const cause = (err as { cause?: unknown } | null)?.cause;
  let code: string | null = null;
  let message: string | null = null;
  if (cause && typeof cause === "object") {
    const c = cause as { code?: unknown; message?: unknown };
    if (typeof c.code === "string") code = c.code;
    if (typeof c.message === "string") message = c.message;
  }
  return { name, code, message };
}

/**
 * PURE: map a thrown (pre-HTTP-response) fetch exception to a precise SAFE
 * reason. Timeouts/aborts, DNS, reset/refused, and connect timeouts each get
 * their own code; anything else stays the generic `network_failure` (with the
 * safe cause still carried on the error for diagnostics).
 */
export function classifyFetchException(err: unknown): GoogleCalendarErrorReason {
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") return "google_calendar_timeout";
  const { code } = safeFetchCause(err);
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "dns_failure";
    case "ECONNRESET":
      return "connection_reset";
    case "ECONNREFUSED":
      return "connection_refused";
    case "UND_ERR_CONNECT_TIMEOUT":
      return "connect_timeout";
    default:
      return "network_failure";
  }
}

/**
 * PURE: build the ABSOLUTE Google Calendar request URL from a path + query using
 * `URL` + `URLSearchParams` (never string concatenation). `undefined`/`null`
 * query values are DROPPED so they can never stringify into "undefined". A path
 * that can't form a valid absolute URL throws `malformed_request_url`. `base` is
 * injectable for tests; production always uses the real Calendar API base.
 */
export function buildGoogleCalendarUrl(
  path: string,
  query: Record<string, string>,
  base: string = GOOGLE_CALENDAR_API,
): URL {
  let url: URL;
  try {
    url = new URL(`${base}${path}`);
  } catch {
    throw new GoogleCalendarError("malformed_request_url", "Google Calendar request URL was invalid");
  }
  if (url.protocol !== "https:") {
    throw new GoogleCalendarError("malformed_request_url", "Google Calendar request URL must be https");
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, value);
  }
  return url;
}

/** SAFE log for a thrown fetch exception (no token/header/body/query values). */
function logFetchException(input: {
  operation: string;
  err: unknown;
  requestHost: string;
  requestPath: string;
  mappedErrorCode: GoogleCalendarErrorReason;
  connectionId?: string;
}): void {
  const cause = safeFetchCause(input.err);
  logger.error("googleCalendar.fetch exception", {
    provider: GOOGLE_CALENDAR_PROVIDER,
    operation: input.operation,
    errorName: input.err instanceof Error ? input.err.name : "UnknownError",
    errorMessage: input.err instanceof Error ? input.err.message : "unknown error",
    safeCauseCode: cause.code,
    safeCauseMessage: cause.message,
    requestHost: input.requestHost,
    requestPath: input.requestPath,
    mappedErrorCode: input.mappedErrorCode,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
  });
}

/** SAFE structured provider-error log: only codes, never tokens/headers/body. */
function logProviderError(
  operation: string,
  err: unknown,
  connectionId?: string,
): void {
  if (err instanceof GoogleCalendarError) {
    logger.error("googleCalendar.provider error", {
      provider: GOOGLE_CALENDAR_PROVIDER,
      operation,
      httpStatus: err.httpStatus,
      errorCode: err.reason,
      ...(connectionId ? { connectionId } : {}),
    });
  } else {
    logger.error("googleCalendar.provider error", {
      provider: GOOGLE_CALENDAR_PROVIDER,
      operation,
      errorCode: "network_failure",
      ...(connectionId ? { connectionId } : {}),
    });
  }
}

/** A connected Google Calendar connection for a user (id + status only). */
export interface GoogleCalendarConnectionRef {
  id: string;
  status: string;
}

/** Find a user's Google Calendar connection row, or null. No tokens read. */
export async function getGoogleCalendarConnection(
  userId: string,
): Promise<GoogleCalendarConnectionRef | null> {
  const row = await getPrisma().integrationConnection.findUnique({
    where: {
      userId_provider: { userId, provider: GOOGLE_CALENDAR_PROVIDER },
    },
    select: { id: true, status: true },
  });
  return row ?? null;
}

/** Mark a connection unhealthy (expired/error) after a token failure. */
async function markConnection(
  connectionId: string,
  status: "expired" | "error",
): Promise<void> {
  try {
    await getPrisma().integrationConnection.update({
      where: { id: connectionId },
      data: { status },
    });
  } catch (err) {
    logger.error("googleCalendar.markConnection failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}

/**
 * Refresh a connection's access token from its stored refresh token and persist
 * the new (encrypted) access token. Throws a classified `GoogleCalendarError`:
 *   - `no_refresh_token` when there is nothing to refresh with,
 *   - `invalid_grant` when Google rejects the refresh token (user must reconnect),
 *   - `token_refresh_failed` for any other refresh failure.
 * On a reconnect-class failure the connection is marked `expired`.
 */
async function refreshConnectionAccessToken(
  connectionId: string,
  refreshToken: string | null,
  fetchImpl?: FetchLike,
): Promise<string> {
  if (!refreshToken) {
    await markConnection(connectionId, "expired");
    throw new GoogleCalendarError(
      "no_refresh_token",
      "Access token expired and no refresh token is stored",
    );
  }
  try {
    const config = getGoogleOAuthConfig();
    const refreshed = await refreshAccessToken({ config, refreshToken, fetchImpl });
    await storeRefreshedCredential(connectionId, refreshed);
    return refreshed.accessToken;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    const isInvalidGrant = /invalid_grant/i.test(message);
    const reason: GoogleCalendarErrorReason = isInvalidGrant
      ? "invalid_grant"
      : "token_refresh_failed";
    if (isInvalidGrant) await markConnection(connectionId, "expired");
    // Redacted — never surface the underlying token/secret detail.
    logProviderError("token.refresh", new GoogleCalendarError(reason), connectionId);
    throw new GoogleCalendarError(reason, "Failed to refresh Google access token");
  }
}

/**
 * Return a currently-valid access token for a connection, refreshing it if it is
 * missing/expired. SERVER-ONLY — the returned token must never leave the backend.
 *
 * Decryption failures surface as `credential_decrypt_failed` (never the raw crypto
 * error). A refresh failure marks the connection `expired` and throws a classified
 * `GoogleCalendarError`.
 */
export async function getValidGoogleCalendarAccessToken(
  connectionId: string,
  fetchImpl?: FetchLike,
): Promise<string> {
  let secrets;
  try {
    secrets = await readCredentialSecrets(connectionId);
  } catch (err) {
    if (err instanceof TokenVaultConfigError) {
      logProviderError("credential.decrypt", new GoogleCalendarError("credential_decrypt_failed"), connectionId);
      throw new GoogleCalendarError(
        "credential_decrypt_failed",
        "Stored Google credentials could not be decrypted",
      );
    }
    throw err;
  }

  if (!secrets || (!secrets.accessToken && !secrets.refreshToken)) {
    throw new GoogleCalendarError("not_connected", "No stored Google credentials");
  }

  const expiresAt = secrets.accessTokenExpiresAt?.getTime() ?? 0;
  const stillValid =
    secrets.accessToken && expiresAt > Date.now() + EXPIRY_SKEW_MS;
  if (stillValid && secrets.accessToken) return secrets.accessToken;

  return refreshConnectionAccessToken(connectionId, secrets.refreshToken, fetchImpl);
}

/** Force a refresh regardless of local expiry (used after a live 401). */
async function forceRefreshGoogleCalendarAccessToken(
  connectionId: string,
  fetchImpl?: FetchLike,
): Promise<string> {
  const secrets = await readCredentialSecrets(connectionId);
  return refreshConnectionAccessToken(connectionId, secrets?.refreshToken ?? null, fetchImpl);
}

/**
 * Authenticated GET against the Google Calendar API. Returns parsed JSON. Throws a
 * classified `GoogleCalendarError` on failure — the raw provider body is NEVER put
 * into the thrown message (only a coded reason + HTTP status). `fetchImpl` is
 * injectable for tests.
 */
export async function googleCalendarGet<T>(
  accessToken: string,
  path: string,
  query: Record<string, string>,
  fetchImpl?: FetchLike,
  connectionId?: string,
): Promise<T> {
  const doFetch = fetchImpl ?? (fetch as unknown as FetchLike);

  // Build an ABSOLUTE URL with URL + URLSearchParams (never string concat).
  const url = buildGoogleCalendarUrl(path, query);

  // The access token must be a plain, non-empty ASCII string. Guards against an
  // object/JSON payload being passed as the token and against a header value
  // that fetch would reject (which would otherwise throw an opaque TypeError).
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    // eslint-disable-next-line no-control-regex
    /[^\x20-\x7e]/.test(accessToken)
  ) {
    throw new GoogleCalendarError(
      "invalid_request_headers",
      "Google access token is not a valid Authorization header value",
    );
  }

  // A FRESH AbortController + timer per attempt (retries call this again → new
  // controller). The signal is not aborted before the request starts; the timer
  // only fires after PROVIDER_TIMEOUT_MS and is always cleared in `finally`.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  let res: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    // NOTE: GET must NOT carry a body — undici throws synchronously otherwise.
    res = await doFetch(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } catch (err) {
    // A thrown fetch is a transport-level failure with NO HTTP response. Map it
    // to a precise reason and log the SAFE cause (never token/header/body).
    const reason = classifyFetchException(err);
    logFetchException({
      operation: `GET ${url.pathname}`,
      err,
      requestHost: url.host,
      requestPath: url.pathname,
      mappedErrorCode: reason,
      connectionId,
    });
    const cause = safeFetchCause(err);
    throw new GoogleCalendarError(
      reason,
      "Network request to Google failed before an HTTP response",
      null,
      { name: cause.name, code: cause.code },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 500);
    } catch {
      body = "";
    }
    const reason = classifyCalendarHttpError(res.status, body);
    throw new GoogleCalendarError(reason, `Google Calendar request failed (${res.status})`, res.status);
  }

  try {
    return JSON.parse(await res.text()) as T;
  } catch {
    throw new GoogleCalendarError(
      "malformed_provider_response",
      "Google Calendar returned an unparseable response",
    );
  }
}

/**
 * PURE, injectable core of the "one refresh + retry on a single 401" policy.
 *
 * Runs `doGet(token)` with the current token; on a single `auth_failed` it calls
 * `refresh()` ONCE and retries `doGet` ONCE. If the retry still `auth_failed`s,
 * the grant is dead → `onInvalidGrant()` runs and an `invalid_grant` error throws.
 * Any non-auth error propagates unchanged. It can never retry more than once.
 *
 * Kept free of DB/network so the retry behaviour is unit-testable with fakes.
 */
export async function requestWithAuthRetry<T>(opts: {
  getAccessToken: () => Promise<string>;
  refresh: () => Promise<string>;
  doGet: (token: string) => Promise<T>;
  onInvalidGrant?: () => Promise<void>;
}): Promise<T> {
  const token = await opts.getAccessToken();
  try {
    return await opts.doGet(token);
  } catch (err) {
    if (!(err instanceof GoogleCalendarError) || err.reason !== "auth_failed") {
      throw err;
    }
    // One valid auth failure → refresh once and retry exactly once.
    const fresh = await opts.refresh();
    try {
      return await opts.doGet(fresh);
    } catch (retryErr) {
      if (
        retryErr instanceof GoogleCalendarError &&
        retryErr.reason === "auth_failed"
      ) {
        await opts.onInvalidGrant?.();
        throw new GoogleCalendarError(
          "invalid_grant",
          "Google rejected the credentials after a refresh",
          retryErr.httpStatus,
        );
      }
      throw retryErr;
    }
  }
}

/**
 * Connection-aware Calendar GET with exactly ONE refresh + retry on a single valid
 * authentication failure (HTTP 401). If the retry still 401s, the connection is
 * marked `expired` and an `invalid_grant` error is thrown.
 */
export async function googleCalendarGetForConnection<T>(
  connectionId: string,
  path: string,
  query: Record<string, string>,
  fetchImpl?: FetchLike,
): Promise<T> {
  try {
    return await requestWithAuthRetry<T>({
      getAccessToken: () => getValidGoogleCalendarAccessToken(connectionId, fetchImpl),
      refresh: () => forceRefreshGoogleCalendarAccessToken(connectionId, fetchImpl),
      doGet: (token) => googleCalendarGet<T>(token, path, query, fetchImpl, connectionId),
      onInvalidGrant: () => markConnection(connectionId, "expired"),
    });
  } catch (err) {
    logProviderError(`GET ${path}`, err, connectionId);
    throw err;
  }
}

/** Whether a reason means the user must reconnect (grant no longer usable). */
export function isReconnectReason(reason: GoogleCalendarErrorReason): boolean {
  return RECONNECT_REASONS.has(reason);
}

// --- Write-capable requests (Section 15) ---------------------------------

/** HTTP methods a Calendar WRITE may use. GET stays on `googleCalendarGet`. */
export type GoogleCalendarWriteMethod = "POST" | "PATCH" | "DELETE";

/**
 * Authenticated write (POST/PATCH/DELETE) against the Google Calendar API.
 *
 * Mirrors `googleCalendarGet`'s SAFETY exactly — the same absolute-URL building,
 * token-shape guard, per-attempt abort timeout, precise fetch-exception mapping,
 * and classified HTTP-error mapping (the raw provider body is NEVER thrown). The
 * only differences from the GET path are the method and a JSON body: unlike GET,
 * a write MAY carry a body, so the undici "GET must not have a body" guard does
 * not apply here. A `204 No Content` (typical for DELETE) returns `{}` as `T`.
 * `fetchImpl` is injectable for tests.
 */
export async function googleCalendarRequest<T>(
  accessToken: string,
  method: GoogleCalendarWriteMethod,
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
  fetchImpl?: FetchLike,
  connectionId?: string,
): Promise<T> {
  const doFetch = fetchImpl ?? (fetch as unknown as FetchLike);

  // Build an ABSOLUTE URL with URL + URLSearchParams (never string concat).
  const url = buildGoogleCalendarUrl(path, options.query ?? {});

  // The access token must be a plain, non-empty ASCII string (same guard as GET).
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    // eslint-disable-next-line no-control-regex
    /[^\x20-\x7e]/.test(accessToken)
  ) {
    throw new GoogleCalendarError(
      "invalid_request_headers",
      "Google access token is not a valid Authorization header value",
    );
  }

  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  const hasBody = options.body !== undefined && method !== "DELETE";
  const body = hasBody ? JSON.stringify(options.body) : undefined;
  if (hasBody) headers["content-type"] = "application/json";

  // A FRESH AbortController + timer per attempt (retries call this again).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  let res: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    res = await doFetch(url.toString(), {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = classifyFetchException(err);
    logFetchException({
      operation: `${method} ${url.pathname}`,
      err,
      requestHost: url.host,
      requestPath: url.pathname,
      mappedErrorCode: reason,
      connectionId,
    });
    const cause = safeFetchCause(err);
    throw new GoogleCalendarError(
      reason,
      "Network request to Google failed before an HTTP response",
      null,
      { name: cause.name, code: cause.code },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let errBody = "";
    try {
      errBody = (await res.text()).slice(0, 500);
    } catch {
      errBody = "";
    }
    const reason = classifyCalendarHttpError(res.status, errBody);
    throw new GoogleCalendarError(reason, `Google Calendar request failed (${res.status})`, res.status);
  }

  // A successful write may return an empty body (204 for DELETE). Treat empty as
  // an empty object so callers get a consistent, safe shape.
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  if (text.trim().length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GoogleCalendarError(
      "malformed_provider_response",
      "Google Calendar returned an unparseable response",
    );
  }
}

/**
 * Connection-aware Calendar WRITE with exactly ONE refresh + retry on a single
 * valid authentication failure (HTTP 401) — the same policy the read path uses.
 * If the retry still 401s, the connection is marked `expired` and an
 * `invalid_grant` error is thrown. Reuses the existing token store/refresh.
 */
export async function googleCalendarRequestForConnection<T>(
  connectionId: string,
  method: GoogleCalendarWriteMethod,
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
  fetchImpl?: FetchLike,
): Promise<T> {
  try {
    return await requestWithAuthRetry<T>({
      getAccessToken: () => getValidGoogleCalendarAccessToken(connectionId, fetchImpl),
      refresh: () => forceRefreshGoogleCalendarAccessToken(connectionId, fetchImpl),
      doGet: (token) =>
        googleCalendarRequest<T>(token, method, path, options, fetchImpl, connectionId),
      onInvalidGrant: () => markConnection(connectionId, "expired"),
    });
  } catch (err) {
    logProviderError(`${method} ${path}`, err, connectionId);
    throw err;
  }
}
