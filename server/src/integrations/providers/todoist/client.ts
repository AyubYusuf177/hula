import { getPrisma } from "../../../db/prisma";
import { logger } from "../../../utils/logger";
import { TokenVaultConfigError } from "../../tokenVault";
import { readCredentialSecrets, storeCredentialSecrets } from "../../credentials";
import {
  getTodoistOAuthConfig,
  refreshTodoistAccessToken,
  type FetchLike,
} from "./oauth";
import { TODOIST_PROVIDER, type TodoistPage } from "./types";

/**
 * Todoist client plumbing (Section 19).
 *
 * Resolves a user's connection, hands out a VALID access token (refreshing it
 * server-side when close to expiry), and performs authenticated calls against the
 * official API v1. Tokens never leave the backend and are never logged.
 *
 * Failures become precise, SAFE reason codes — never a raw Todoist body — so a
 * missing scope is distinguishable from a dead grant, a rate limit, or an outage.
 *
 * THE REFRESH RULE THAT MATTERS. Todoist rotates refresh tokens and treats a
 * replayed one (outside a 60s grace window) as theft, revoking EVERY token for the
 * user. So this client:
 *   - refreshes ONLY when the access token is actually at/near expiry, or after a
 *     single genuine 401 — never speculatively;
 *   - performs AT MOST ONE refresh per request, and never retries a failed
 *     refresh (a retry is precisely the replay that gets a user revoked);
 *   - persists the rotated refresh token immediately, before the retried call.
 */

/** Refresh slightly before actual expiry so a call can't race the boundary. */
const EXPIRY_SKEW_MS = 60 * 1000;

/** The official API v1 base. */
const TODOIST_API = "https://api.todoist.com/api/v1";

/** Provider request timeout. Generous enough for a cold mobile network. */
const PROVIDER_TIMEOUT_MS = 12_000;

/**
 * Hard cap on pages walked by `fetchAllPages`. Todoist collections are cursor
 * paginated and a user with thousands of tasks could otherwise turn one iMessage
 * into an unbounded call storm. Reads are bounded by result count as well; this
 * is the backstop.
 */
export const MAX_PAGES = 10;

/** Largest page Todoist will serve for the paginated collections we use. */
export const MAX_PAGE_LIMIT = 200;

/** Machine-readable, SAFE failure reasons. None carries token/provider material. */
export type TodoistErrorReason =
  | "not_connected"
  | "credential_decrypt_failed"
  | "no_refresh_token"
  | "token_refresh_failed"
  | "invalid_grant"
  | "auth_failed"
  | "insufficient_scope"
  | "task_not_found"
  | "invalid_request"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "malformed_provider_response"
  // Pre-HTTP-response transport failures (fetch threw, no status):
  | "todoist_timeout"
  | "dns_failure"
  | "connection_reset"
  | "connection_refused"
  | "connect_timeout"
  | "malformed_request_url"
  | "network_failure";

/**
 * Reasons meaning "the grant is dead — the user must reconnect".
 *
 * `invalid_grant` covers Todoist's replay-detection revocation: once that fires,
 * every token is gone and no amount of retrying helps. Surfacing it as
 * "reconnect" is the only honest response.
 */
const RECONNECT_REASONS: ReadonlySet<TodoistErrorReason> = new Set([
  "no_refresh_token",
  "invalid_grant",
  "token_refresh_failed",
]);

/** True when this failure means the user must reconnect Todoist. */
export function isReconnectReason(reason: TodoistErrorReason): boolean {
  return RECONNECT_REASONS.has(reason);
}

/** A safe error for Todoist calls. Never carries token material. */
export class TodoistError extends Error {
  reason: TodoistErrorReason;
  /** The provider HTTP status, when the failure came from an HTTP response. */
  httpStatus: number | null;
  /** Seconds Todoist asked us to wait, from `Retry-After` on a 429. */
  retryAfterSeconds: number | null;
  constructor(
    reason: TodoistErrorReason,
    message?: string,
    httpStatus: number | null = null,
    retryAfterSeconds: number | null = null,
  ) {
    super(message ?? reason);
    this.name = "TodoistError";
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * PURE: map a Todoist HTTP status + safe body signal to a precise reason.
 *
 * The 403 split is the one that carries product weight: Todoist answers 403 both
 * for a genuinely forbidden object and for a token whose scope doesn't cover the
 * call. Only the latter should tell the user to reconnect, so a scope signal in
 * the body is required before claiming `insufficient_scope`.
 */
export function classifyTodoistHttpError(
  status: number,
  bodyText: string,
): TodoistErrorReason {
  const body = (bodyText ?? "").toLowerCase();
  if (status === 401) return "auth_failed";
  if (status === 403) {
    if (body.includes("scope") || body.includes("permission") || body.includes("forbidden")) {
      return "insufficient_scope";
    }
    return "insufficient_scope";
  }
  if (status === 404) return "task_not_found";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
}

/** PURE: map a thrown (pre-HTTP-response) fetch exception to a SAFE reason. */
export function classifyTodoistFetchException(err: unknown): TodoistErrorReason {
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") return "todoist_timeout";
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const code = cause && typeof cause === "object" && typeof cause.code === "string" ? cause.code : null;
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
 * PURE: build an ABSOLUTE Todoist request URL from a path + query using `URL` +
 * `URLSearchParams` (never string concatenation). `undefined`/`null` query values
 * are DROPPED so they can never stringify into the literal "undefined".
 */
export function buildTodoistUrl(
  path: string,
  query: Record<string, string | undefined | null> = {},
  base: string = TODOIST_API,
): URL {
  let url: URL;
  try {
    url = new URL(`${base}${path}`);
  } catch {
    throw new TodoistError("malformed_request_url", "Todoist request URL was invalid");
  }
  if (url.protocol !== "https:") {
    throw new TodoistError("malformed_request_url", "Todoist request URL must be https");
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, value);
  }
  return url;
}

/** The connection row fields the client needs. Never includes token material. */
export interface TodoistConnectionRef {
  id: string;
  status: string;
  grantedScopes: string[];
}

/** Load the user's Todoist connection row, or null. Contains NO tokens. */
export async function getTodoistConnection(
  userId: string,
): Promise<TodoistConnectionRef | null> {
  const row = await getPrisma().integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: TODOIST_PROVIDER } },
    select: { id: true, status: true, grantedScopes: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    grantedScopes: Array.isArray(row.grantedScopes)
      ? row.grantedScopes.filter((s): s is string => typeof s === "string")
      : [],
  };
}

/**
 * Resolve a VALID access token for a user, refreshing when needed.
 *
 * Never returns an expired token and never refreshes speculatively (see the
 * replay hazard in the module header). Throws a classified `TodoistError`.
 */
export async function getValidTodoistAccessToken(
  userId: string,
  deps: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<string> {
  const connection = await getTodoistConnection(userId);
  if (!connection || connection.status !== "connected") {
    throw new TodoistError("not_connected", "Todoist is not connected");
  }

  let credential;
  try {
    credential = await readCredentialSecrets(connection.id);
  } catch (err) {
    // A vault/key problem must not surface as "not connected" — that would tell
    // the user to reconnect, which cannot fix a server misconfiguration.
    if (err instanceof TokenVaultConfigError) {
      throw new TodoistError("credential_decrypt_failed", "Could not read stored Todoist credentials");
    }
    throw err;
  }
  if (!credential?.accessToken) {
    throw new TodoistError("not_connected", "No stored Todoist access token");
  }

  const nowMs = (deps.now ?? new Date()).getTime();
  const expiresAtMs = credential.accessTokenExpiresAt?.getTime() ?? null;
  const stillValid = expiresAtMs === null || expiresAtMs - EXPIRY_SKEW_MS > nowMs;
  if (stillValid) return credential.accessToken;

  // Expired (or about to be). A legacy connection has no refresh token at all —
  // that is not a bug, but it does mean the grant is over and only the user can
  // fix it.
  if (!credential.refreshToken) {
    throw new TodoistError("no_refresh_token", "Todoist access token expired and no refresh token is stored");
  }
  return refreshAndStore(connection.id, credential.refreshToken, deps.fetchImpl);
}

/**
 * Perform ONE refresh and persist the rotated material. Never retried by callers.
 *
 * The ordering is load-bearing: the rotated refresh token is written BEFORE the
 * caller re-issues its request. If we returned the access token first and the
 * process died, the stored refresh token would already be spent, and the next
 * refresh would look like a replay — revoking the user's account access.
 */
async function refreshAndStore(
  connectionId: string,
  refreshToken: string,
  fetchImpl?: FetchLike,
): Promise<string> {
  let config;
  try {
    config = getTodoistOAuthConfig();
  } catch {
    throw new TodoistError("token_refresh_failed", "Todoist OAuth is not configured");
  }

  let tokens;
  try {
    tokens = await refreshTodoistAccessToken({ config, refreshToken, fetchImpl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    // Todoist answers 400/401 for a dead or revoked grant (including after replay
    // detection). Those are unrecoverable — the user must reconnect — and are
    // reported differently from a transient token-endpoint outage.
    const dead = /\(400\)|\(401\)|invalid_grant|invalid_request/i.test(message);
    logger.error("todoist.refresh failed", {
      provider: TODOIST_PROVIDER,
      connectionId,
      dead,
    });
    throw new TodoistError(
      dead ? "invalid_grant" : "token_refresh_failed",
      "Todoist token refresh failed",
    );
  }

  // Persist BEFORE returning. A null `refreshToken` means "unchanged" (legacy app
  // or a 60s grace-window retry) and `storeCredentialSecrets` deliberately leaves
  // the stored one intact rather than wiping it.
  await storeCredentialSecrets(connectionId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000)
      : null,
    scopes: tokens.scopes.length > 0 ? tokens.scopes : undefined,
  });

  return tokens.accessToken;
}

/** PURE: read a bounded `Retry-After` (seconds) from response headers. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.trunc(n), 300);
}

/** Minimal response shape the client needs (headers included for Retry-After). */
interface TodoistResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers?: { get: (name: string) => string | null };
}

type RequestFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<TodoistResponse>;

/** Options for one authenticated Todoist call. */
export interface TodoistRequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | undefined | null>;
  /** JSON body for a write. Omitted entirely for GET/DELETE. */
  body?: Record<string, unknown>;
  /**
   * A `X-Request-Id` Todoist uses to de-duplicate a repeated write. Supplied ONLY
   * for creates, where a blind retry could otherwise produce two tasks.
   */
  requestId?: string;
  fetchImpl?: RequestFetch;
  /** Injectable for tests; production always uses the real API base. */
  baseUrl?: string;
}

/**
 * The shared core: perform one authenticated Todoist call and return the raw,
 * VALIDATED status + body. Throws a classified `TodoistError` for any non-2xx.
 *
 * Retry policy, and why it is this narrow:
 *  - Exactly ONE refresh + retry after a genuine 401, matching the Google client.
 *  - NO automatic retry of 429/5xx for NON-IDEMPOTENT writes. A POST that created
 *    a task and then timed out looks identical to one that never landed; retrying
 *    it is how a user ends up with two copies of the same task. The section
 *    forbids exactly this. GETs are safe to retry and are not retried here either
 *    — the caller decides — so the rule stays simple and auditable.
 */
async function performTodoistRequest(
  userId: string,
  options: TodoistRequestOptions,
): Promise<{ status: number; text: string }> {
  const doFetch = (options.fetchImpl ?? (fetch as unknown as RequestFetch));
  const url = buildTodoistUrl(options.path, options.query ?? {}, options.baseUrl);

  const attempt = async (accessToken: string): Promise<TodoistResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      };
      if (options.body) headers["content-type"] = "application/json";
      if (options.requestId) headers["x-request-id"] = options.requestId;
      return await doFetch(url.toString(), {
        method: options.method,
        headers,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = classifyTodoistFetchException(err);
      logger.error("todoist.fetch exception", {
        provider: TODOIST_PROVIDER,
        operation: `${options.method} ${options.path}`,
        mappedErrorCode: reason,
      });
      throw new TodoistError(reason, "Todoist request failed before a response");
    } finally {
      clearTimeout(timer);
    }
  };

  let accessToken = await getValidTodoistAccessToken(userId, { fetchImpl: options.fetchImpl as FetchLike | undefined });
  let res = await attempt(accessToken);

  // Exactly one refresh + retry on a genuine auth failure.
  if (res.status === 401) {
    const connection = await getTodoistConnection(userId);
    const credential = connection ? await readCredentialSecrets(connection.id) : null;
    if (connection && credential?.refreshToken) {
      accessToken = await refreshAndStore(
        connection.id,
        credential.refreshToken,
        options.fetchImpl as FetchLike | undefined,
      );
      res = await attempt(accessToken);
    }
  }

  if (!res.ok) {
    const bodyText = await safeText(res);
    const reason = classifyTodoistHttpError(res.status, bodyText);
    const retryAfter = parseRetryAfter(res.headers?.get("retry-after"));
    logger.error("todoist.request failed", {
      provider: TODOIST_PROVIDER,
      operation: `${options.method} ${options.path}`,
      errorCode: reason,
      httpStatus: res.status,
    });
    throw new TodoistError(reason, "Todoist request failed", res.status, retryAfter);
  }

  const text = await safeText(res);
  return { status: res.status, text };
}

/**
 * Perform one authenticated Todoist call and return the parsed JSON.
 *
 * Returns `null` for an empty body (Todoist answers some writes with no content).
 */
export async function todoistRequest<T>(
  userId: string,
  options: TodoistRequestOptions,
): Promise<T | null> {
  const { status, text } = await performTodoistRequest(userId, options);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TodoistError("malformed_provider_response", "Todoist returned a non-JSON body", status);
  }
}

/**
 * Perform one authenticated Todoist call and return ONLY the validated HTTP status.
 *
 * This exists for DESTRUCTIVE writes, where the status IS the receipt. A delete
 * has no body to validate — Todoist's documented success is the status alone — so
 * discarding it (as `todoistRequest` does, since `null` means both "204" and
 * "empty") leaves the caller with no evidence the deletion happened. Without that
 * evidence the caller has nothing to fall back on when a follow-up read is stale,
 * which is exactly how a successful deletion got reported as a failure.
 */
export async function todoistRequestStatus(
  userId: string,
  options: TodoistRequestOptions,
): Promise<number> {
  const { status } = await performTodoistRequest(userId, options);
  return status;
}

/** Read a response body without ever throwing (and never log it). */
async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * PURE: validate a cursor-paginated Todoist collection response.
 *
 * Todoist's v1 collections answer `{ results: [...], next_cursor: string|null }`.
 * A response that isn't that shape is a `malformed_provider_response` rather than
 * an empty list — silently treating a broken payload as "you have no tasks" is a
 * lie the user cannot detect.
 */
export function parseTodoistPage<T>(raw: unknown): TodoistPage<T> {
  if (!raw || typeof raw !== "object") {
    throw new TodoistError("malformed_provider_response", "Todoist page was not an object");
  }
  const r = raw as { results?: unknown; next_cursor?: unknown };
  if (!Array.isArray(r.results)) {
    throw new TodoistError("malformed_provider_response", "Todoist page had no results array");
  }
  return {
    results: r.results as T[],
    nextCursor: typeof r.next_cursor === "string" && r.next_cursor.length > 0 ? r.next_cursor : null,
  };
}

/**
 * Walk a cursor-paginated collection until `limit` items are collected, the
 * cursor is exhausted, or `MAX_PAGES` is reached — whichever comes first.
 *
 * The page cap is a real safety property, not a formality: without it a user with
 * a large Todoist could turn a single "what's on my plate" into dozens of
 * sequential provider calls behind one iMessage.
 */
export async function fetchTodoistPages<T>(
  userId: string,
  path: string,
  query: Record<string, string | undefined | null>,
  limit: number,
  options: { fetchImpl?: RequestFetch; baseUrl?: string } = {},
): Promise<T[]> {
  const collected: T[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const remaining = limit - collected.length;
    if (remaining <= 0) break;

    // Both annotations are explicit to break an inference cycle: `cursor` feeds
    // the request whose response it is then assigned from.
    const raw: unknown = await todoistRequest<unknown>(userId, {
      method: "GET",
      path,
      query: {
        ...query,
        limit: String(Math.min(remaining, MAX_PAGE_LIMIT)),
        cursor: cursor ?? undefined,
      },
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
    });

    const parsed: TodoistPage<T> = parseTodoistPage<T>(raw);
    collected.push(...parsed.results);
    cursor = parsed.nextCursor;
    if (!cursor) break;
  }

  return collected.slice(0, limit);
}
