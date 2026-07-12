import { getPrisma } from "../../../db/prisma";
import { logger } from "../../../utils/logger";
import { TokenVaultConfigError } from "../../tokenVault";
import { readCredentialSecrets, updateAccessToken } from "../../credentials";
import { getGmailOAuthConfig, refreshAccessToken, type FetchLike } from "./oauth";
import { GMAIL_PROVIDER } from "./types";

/**
 * Gmail client plumbing (Section 14) — READ-ONLY.
 *
 * A SEPARATE provider client from Google Calendar. It resolves a user's Gmail
 * connection, hands out a VALID access token (refreshing it server-side when it
 * is close to expiry), and performs authenticated GET calls against the Gmail
 * API. Tokens never leave the backend and are never logged.
 *
 * Failures are classified into precise, SAFE reason codes (never the raw Gmail
 * body) so a disabled-API 403 is distinguishable from an expired grant, an
 * insufficient scope, or a rate limit. A single valid authentication failure
 * triggers exactly one refresh + retry — never an infinite loop.
 *
 * This client only ever issues GETs — there is no mutation path (no send, draft,
 * modify, trash, or label change) anywhere in it.
 */

/** Refresh a little before the token actually expires to avoid edge failures. */
const EXPIRY_SKEW_MS = 60 * 1000;

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

/** Provider request timeout. Generous enough for a cold mobile network. */
const PROVIDER_TIMEOUT_MS = 12_000;

/**
 * Machine-readable, SAFE failure reasons. Every one is safe to log/return — none
 * carries token or raw-provider material.
 */
export type GmailErrorReason =
  | "not_connected"
  | "credential_decrypt_failed"
  | "no_refresh_token"
  | "token_refresh_failed"
  | "invalid_grant"
  | "auth_failed"
  | "insufficient_scope"
  | "gmail_api_disabled"
  | "mailbox_not_found"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "malformed_provider_response"
  // Precise pre-HTTP-response transport failures (fetch threw, no status):
  | "gmail_timeout"
  | "dns_failure"
  | "connection_reset"
  | "connection_refused"
  | "connect_timeout"
  | "malformed_request_url"
  | "invalid_request_headers"
  | "network_failure";

/** Reasons that mean "the user must reconnect" (grant is no longer usable). */
const RECONNECT_REASONS: ReadonlySet<GmailErrorReason> = new Set([
  "no_refresh_token",
  "invalid_grant",
]);

/** A safe error for Gmail reads. Never carries token material. */
export class GmailError extends Error {
  reason: GmailErrorReason;
  /** The provider HTTP status, when the failure came from an HTTP response. */
  httpStatus: number | null;
  /** SAFE exception class name when a fetch threw (e.g. "TypeError"). */
  safeCauseName: string | null;
  /** SAFE underlying cause code when a fetch threw (e.g. "ENOTFOUND"). */
  safeCauseCode: string | null;
  constructor(
    reason: GmailErrorReason,
    message?: string,
    httpStatus: number | null = null,
    safeCause?: { name?: string | null; code?: string | null },
  ) {
    super(message ?? reason);
    this.name = "GmailError";
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.safeCauseName = safeCause?.name ?? null;
    this.safeCauseCode = safeCause?.code ?? null;
  }
}

/**
 * PURE: map a Gmail API HTTP status + (lowercased-safe) body signal to a precise
 * reason. Deliberately never returns the body — only a coded reason.
 *
 * The distinctive 403 cases:
 *   - API disabled in the Cloud project → `gmail_api_disabled`
 *     (Google: "…API has not been used in project … before or it is disabled",
 *      reason `accessNotConfigured` / status `SERVICE_DISABLED`).
 *   - Missing/insufficient scope → `insufficient_scope`
 *     (Google: "insufficient authentication scopes", reason
 *      `ACCESS_TOKEN_SCOPE_INSUFFICIENT` / `insufficientPermissions`).
 */
export function classifyGmailHttpError(
  status: number,
  bodyText: string,
): GmailErrorReason {
  const body = (bodyText ?? "").toLowerCase();
  if (status === 401) return "auth_failed";
  if (status === 403) {
    if (
      body.includes("has not been used in project") ||
      body.includes("accessnotconfigured") ||
      body.includes("service_disabled") ||
      body.includes("it is disabled")
    ) {
      return "gmail_api_disabled";
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
  if (status === 404) return "mailbox_not_found";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
}

/** SAFE cause metadata read off a thrown fetch error (undici sets `.cause`). */
export interface SafeFetchCause {
  name: string | null;
  code: string | null;
  message: string | null;
}

/**
 * PURE: extract SAFE cause metadata from a thrown fetch exception. Node's fetch
 * wraps transport errors as `TypeError("fetch failed")` with a `.cause` carrying
 * the real `code`/`message`. None of these values contain token, header, or body
 * material.
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
 * their own code; anything else stays the generic `network_failure`.
 */
export function classifyFetchException(err: unknown): GmailErrorReason {
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") return "gmail_timeout";
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

/** A query map whose values may repeat (Gmail's `metadataHeaders` needs this). */
export type GmailQuery = Record<string, string | string[]>;

/**
 * PURE: build the ABSOLUTE Gmail request URL from a path + query using `URL` +
 * `URLSearchParams` (never string concatenation). Array values are APPENDED once
 * per entry (so `metadataHeaders=From&metadataHeaders=Subject` is expressible).
 * `undefined`/`null` values are DROPPED so they can never stringify into
 * "undefined". A path that can't form a valid https URL throws
 * `malformed_request_url`. `base` is injectable for tests.
 */
export function buildGmailUrl(
  path: string,
  query: GmailQuery,
  base: string = GMAIL_API,
): URL {
  let url: URL;
  try {
    url = new URL(`${base}${path}`);
  } catch {
    throw new GmailError("malformed_request_url", "Gmail request URL was invalid");
  }
  if (url.protocol !== "https:") {
    throw new GmailError("malformed_request_url", "Gmail request URL must be https");
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v === undefined || v === null) continue;
        url.searchParams.append(key, v);
      }
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

/** SAFE log for a thrown fetch exception (no token/header/body/query values). */
function logFetchException(input: {
  operation: string;
  err: unknown;
  requestHost: string;
  requestPath: string;
  mappedErrorCode: GmailErrorReason;
  connectionId?: string;
}): void {
  const cause = safeFetchCause(input.err);
  logger.error("gmail.fetch exception", {
    provider: GMAIL_PROVIDER,
    operation: input.operation,
    errorName: input.err instanceof Error ? input.err.name : "UnknownError",
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
  if (err instanceof GmailError) {
    logger.error("gmail.provider error", {
      provider: GMAIL_PROVIDER,
      operation,
      httpStatus: err.httpStatus,
      errorCode: err.reason,
      ...(connectionId ? { connectionId } : {}),
    });
  } else {
    logger.error("gmail.provider error", {
      provider: GMAIL_PROVIDER,
      operation,
      errorCode: "network_failure",
      ...(connectionId ? { connectionId } : {}),
    });
  }
}

/** A connected Gmail connection for a user (id + status only). */
export interface GmailConnectionRef {
  id: string;
  status: string;
}

/** Find a user's Gmail connection row, or null. No tokens read. */
export async function getGmailConnection(
  userId: string,
): Promise<GmailConnectionRef | null> {
  const row = await getPrisma().integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: GMAIL_PROVIDER } },
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
    logger.error("gmail.markConnection failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}

/**
 * Refresh a connection's access token from its stored refresh token and persist
 * the new (encrypted) access token. Throws a classified `GmailError`:
 *   - `no_refresh_token` when there is nothing to refresh with,
 *   - `invalid_grant` when Google rejects the refresh token (must reconnect),
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
    throw new GmailError(
      "no_refresh_token",
      "Access token expired and no refresh token is stored",
    );
  }
  try {
    const config = getGmailOAuthConfig();
    const refreshed = await refreshAccessToken({ config, refreshToken, fetchImpl });
    const newExpiry = refreshed.expiresIn
      ? new Date(Date.now() + refreshed.expiresIn * 1000)
      : null;
    await updateAccessToken(connectionId, refreshed.accessToken, newExpiry);
    return refreshed.accessToken;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    const isInvalidGrant = /invalid_grant/i.test(message);
    const reason: GmailErrorReason = isInvalidGrant
      ? "invalid_grant"
      : "token_refresh_failed";
    await markConnection(connectionId, "expired");
    // Redacted — never surface the underlying token/secret detail.
    logProviderError("token.refresh", new GmailError(reason), connectionId);
    throw new GmailError(reason, "Failed to refresh Gmail access token");
  }
}

/**
 * Return a currently-valid access token for a connection, refreshing it if it is
 * missing/expired. SERVER-ONLY — the returned token must never leave the backend.
 */
export async function getValidGmailAccessToken(
  connectionId: string,
  fetchImpl?: FetchLike,
): Promise<string> {
  let secrets;
  try {
    secrets = await readCredentialSecrets(connectionId);
  } catch (err) {
    if (err instanceof TokenVaultConfigError) {
      logProviderError("credential.decrypt", new GmailError("credential_decrypt_failed"), connectionId);
      throw new GmailError(
        "credential_decrypt_failed",
        "Stored Gmail credentials could not be decrypted",
      );
    }
    throw err;
  }

  if (!secrets || (!secrets.accessToken && !secrets.refreshToken)) {
    throw new GmailError("not_connected", "No stored Gmail credentials");
  }

  const expiresAt = secrets.accessTokenExpiresAt?.getTime() ?? 0;
  const stillValid = secrets.accessToken && expiresAt > Date.now() + EXPIRY_SKEW_MS;
  if (stillValid && secrets.accessToken) return secrets.accessToken;

  return refreshConnectionAccessToken(connectionId, secrets.refreshToken, fetchImpl);
}

/** Force a refresh regardless of local expiry (used after a live 401). */
async function forceRefreshGmailAccessToken(
  connectionId: string,
  fetchImpl?: FetchLike,
): Promise<string> {
  const secrets = await readCredentialSecrets(connectionId);
  return refreshConnectionAccessToken(connectionId, secrets?.refreshToken ?? null, fetchImpl);
}

/**
 * Authenticated GET against the Gmail API. Returns parsed JSON. Throws a
 * classified `GmailError` on failure — the raw provider body is NEVER put into
 * the thrown message (only a coded reason + HTTP status). `fetchImpl` is
 * injectable for tests.
 */
export async function gmailGet<T>(
  accessToken: string,
  path: string,
  query: GmailQuery,
  fetchImpl?: FetchLike,
  connectionId?: string,
): Promise<T> {
  const doFetch = fetchImpl ?? (fetch as unknown as FetchLike);

  const url = buildGmailUrl(path, query);

  // The access token must be a plain, non-empty ASCII string. Guards against an
  // object/JSON payload being passed as the token and against a header value
  // fetch would reject (which would otherwise throw an opaque TypeError).
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    // eslint-disable-next-line no-control-regex
    /[^\x20-\x7e]/.test(accessToken)
  ) {
    throw new GmailError(
      "invalid_request_headers",
      "Gmail access token is not a valid Authorization header value",
    );
  }

  // A FRESH AbortController + timer per attempt (retries call this again → new
  // controller). The signal is not aborted before the request starts.
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
    throw new GmailError(
      reason,
      "Network request to Gmail failed before an HTTP response",
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
    const reason = classifyGmailHttpError(res.status, body);
    throw new GmailError(reason, `Gmail request failed (${res.status})`, res.status);
  }

  try {
    return JSON.parse(await res.text()) as T;
  } catch {
    throw new GmailError(
      "malformed_provider_response",
      "Gmail returned an unparseable response",
    );
  }
}

/**
 * PURE, injectable core of the "one refresh + retry on a single 401" policy.
 *
 * Runs `doGet(token)` with the current token; on a single `auth_failed` it calls
 * `refresh()` ONCE and retries `doGet` ONCE. If the retry still `auth_failed`s,
 * the grant is dead → `onInvalidGrant()` runs and an `invalid_grant` error
 * throws. Any non-auth error propagates unchanged. Never retries more than once.
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
    if (!(err instanceof GmailError) || err.reason !== "auth_failed") {
      throw err;
    }
    const fresh = await opts.refresh();
    try {
      return await opts.doGet(fresh);
    } catch (retryErr) {
      if (retryErr instanceof GmailError && retryErr.reason === "auth_failed") {
        await opts.onInvalidGrant?.();
        throw new GmailError(
          "invalid_grant",
          "Gmail rejected the credentials after a refresh",
          retryErr.httpStatus,
        );
      }
      throw retryErr;
    }
  }
}

/**
 * Connection-aware Gmail GET with exactly ONE refresh + retry on a single valid
 * authentication failure (HTTP 401). If the retry still 401s, the connection is
 * marked `expired` and an `invalid_grant` error is thrown.
 */
export async function gmailGetForConnection<T>(
  connectionId: string,
  path: string,
  query: GmailQuery,
  fetchImpl?: FetchLike,
): Promise<T> {
  try {
    return await requestWithAuthRetry<T>({
      getAccessToken: () => getValidGmailAccessToken(connectionId, fetchImpl),
      refresh: () => forceRefreshGmailAccessToken(connectionId, fetchImpl),
      doGet: (token) => gmailGet<T>(token, path, query, fetchImpl, connectionId),
      onInvalidGrant: () => markConnection(connectionId, "expired"),
    });
  } catch (err) {
    logProviderError(`GET ${path}`, err, connectionId);
    throw err;
  }
}

/** Whether a reason means the user must reconnect (grant no longer usable). */
export function isReconnectReason(reason: GmailErrorReason): boolean {
  return RECONNECT_REASONS.has(reason);
}
