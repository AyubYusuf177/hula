import { env } from "../../../config/env";
import { getProvider } from "../../catalog";
import { TODOIST_PROVIDER } from "./types";

/**
 * Todoist OAuth helpers (Section 19).
 *
 * Pure-ish helpers around Todoist's Authorization Code flow: resolve config from
 * env, build the authorization URL, exchange a code, and refresh. Network calls
 * take an injectable `fetchImpl` so tests never touch Todoist.
 *
 * WHERE TODOIST DIFFERS FROM GOOGLE (each of these has bitten integrations):
 *
 *  1. SCOPES ARE COMMA-SEPARATED. Google joins scopes with spaces; Todoist's
 *     documented `scope` parameter is comma-delimited. Sending a space-joined
 *     string yields `invalid_scope`, so the join lives in exactly one place here.
 *
 *  2. TOKENS EXPIRE, AND REFRESH TOKENS ROTATE. The commonly repeated claim that
 *     Todoist tokens are permanent is out of date. The current API returns
 *     `expires_in` (3600) plus a `refresh_token`, and the refresh token is
 *     ROTATED on every successful refresh — the returned one REPLACES the one
 *     just used. Failing to persist the rotated value breaks the connection on
 *     the following refresh.
 *
 *  3. REPLAY OF A CONSUMED REFRESH TOKEN IS DESTRUCTIVE. Reusing an already-spent
 *     refresh token within a 60s grace window is treated as a network retry (200,
 *     same access token, NO new refresh token). Outside that window it is treated
 *     as theft: Todoist revokes EVERY token and the user must reconnect. So a
 *     refresh is never fired speculatively or concurrently, and a response with no
 *     `refresh_token` must NOT be written as "no refresh token" — see
 *     `TodoistTokenResponse.refreshToken` being `null` meaning "unchanged".
 *
 *  4. LEGACY APPS GET NO REFRESH TOKEN. Applications without refresh enabled
 *     receive a long-lived access token (a ~10-year `expires_in`) and no
 *     `refresh_token`. That is a valid, fully-working connection — it must never
 *     be mistaken for a broken one.
 *
 * PKCE is deliberately NOT used: Todoist requires it for PUBLIC clients using the
 * Client ID Metadata Document flow, whereas Hula is a CONFIDENTIAL client holding
 * a real `client_secret` server-side. We follow the documented confidential-client
 * contract rather than bolting on a parameter Todoist does not document for it.
 * CSRF protection comes from the shared single-use `state` row, exactly as the
 * Google flows use it.
 *
 * Hard rules: the client secret, codes, and tokens are NEVER logged or placed in
 * a thrown message.
 */

/** Where the user approves the grant. Note: `app.todoist.com`, not `api.`. */
const TODOIST_AUTH_URL = "https://app.todoist.com/oauth/authorize";
/** Where codes/refresh tokens are exchanged. Note: `api.todoist.com`. */
const TODOIST_TOKEN_URL = "https://api.todoist.com/oauth/access_token";

/** Thrown when Todoist OAuth env is missing/invalid. Contains no secrets. */
export class TodoistOAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoistOAuthConfigError";
  }
}

/** Resolved, validated Todoist OAuth configuration. */
export interface TodoistOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

/** The catalog's least-privilege default scopes, used when env omits them. */
function defaultScopes(): string[] {
  return getProvider(TODOIST_PROVIDER)?.defaultScopes ?? ["data:read_write"];
}

/** True only when every required Todoist OAuth env value is present. */
export function isTodoistOAuthConfigured(): boolean {
  return Boolean(
    env.TODOIST_OAUTH_CLIENT_ID &&
      env.TODOIST_OAUTH_CLIENT_SECRET &&
      env.TODOIST_OAUTH_REDIRECT_URI,
  );
}

/**
 * PURE: split a configured/returned scope string into clean scope names.
 *
 * Accepts BOTH comma and whitespace delimiters on purpose. We always SEND commas
 * (Todoist's documented contract), but the `scope` field coming back is a
 * provider-controlled string, and being liberal in what we accept here costs
 * nothing while guarding against a delimiter surprise silently emptying the
 * granted-scope set — which would present a working connection as scopeless.
 */
export function parseTodoistScopes(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve Todoist OAuth config from env, or throw `TodoistOAuthConfigError`.
 * Scopes come from `TODOIST_SCOPES` or fall back to the catalog default, so the
 * scopes requested always match the consent screen the user approves.
 */
export function getTodoistOAuthConfig(): TodoistOAuthConfig {
  const clientId = env.TODOIST_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.TODOIST_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.TODOIST_OAUTH_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new TodoistOAuthConfigError(
      "Todoist OAuth is not configured. Set TODOIST_OAUTH_CLIENT_ID, " +
        "TODOIST_OAUTH_CLIENT_SECRET, and TODOIST_OAUTH_REDIRECT_URI.",
    );
  }

  const scopes = parseTodoistScopes(env.TODOIST_SCOPES);
  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes: scopes.length > 0 ? scopes : defaultScopes(),
  };
}

/**
 * Build the Todoist authorization URL.
 *
 * `scope` is COMMA-joined per Todoist's contract (see the header note). `state`
 * is the shared single-use anti-CSRF token. `redirect_uri` is always sent
 * explicitly — it is only strictly required for apps with multiple configured
 * URIs, but sending it makes the token exchange's `redirect_uri` match
 * unambiguous.
 */
export function buildTodoistAuthorizationUrl(input: {
  config: TodoistOAuthConfig;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    scope: input.config.scopes.join(","),
    state: input.state,
    redirect_uri: input.config.redirectUri,
    response_type: "code",
  });
  return `${TODOIST_AUTH_URL}?${params.toString()}`;
}

/** The normalized result of a token exchange or refresh. */
export interface TodoistTokenResponse {
  accessToken: string;
  /**
   * The rotated refresh token, or null.
   *
   * `null` means "Todoist did not return one" — which is NOT the same as "this
   * connection has no refresh token". It legitimately happens for a legacy app
   * (refresh disabled) AND for a 60s-grace-window retry. Callers must therefore
   * treat null as LEAVE THE STORED VALUE ALONE, never as "clear it".
   */
  refreshToken: string | null;
  /** Seconds until the access token expires, when Todoist reports it. */
  expiresIn: number | null;
  /** Granted scopes, split from Todoist's `scope` field. */
  scopes: string[];
}

/**
 * Minimal fetch signature so tests can inject a fake. Mirrors the Google helper
 * so both providers share one testing idiom. `body` must be omitted for GET.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** How long a token call may take before we abort it. */
const TOKEN_TIMEOUT_MS = 12_000;

/** PURE: parse Todoist's token JSON into our normalized shape (no secrets logged). */
export function parseTodoistTokenBody(raw: string): TodoistTokenResponse {
  let body: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new Error("Todoist token response was not valid JSON");
  }
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    // Never echo the body — it may carry the client secret back in an error.
    throw new Error("Todoist token response missing access_token");
  }
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" && body.refresh_token.length > 0
        ? body.refresh_token
        : null,
    expiresIn:
      typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
        ? body.expires_in
        : null,
    scopes: parseTodoistScopes(typeof body.scope === "string" ? body.scope : null),
  };
}

/** Read a redacted, bounded error snippet from a failed token response. */
async function tokenErrorDetail(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "<unreadable body>";
  }
}

/** POST form-encoded params to Todoist's token endpoint with a bounded timeout. */
async function postToken(
  params: URLSearchParams,
  fetchImpl: FetchLike | undefined,
  operation: string,
): Promise<TodoistTokenResponse> {
  const doFetch = fetchImpl ?? (fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const res = await doFetch(TODOIST_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Todoist ${operation} failed (${res.status}): ${await tokenErrorDetail(res)}`,
      );
    }
    return parseTodoistTokenBody(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchange an authorization `code` for tokens. Throws a redacted error on failure
 * (never includes the client secret, the code, or a token).
 */
export async function exchangeTodoistCodeForTokens(input: {
  config: TodoistOAuthConfig;
  code: string;
  fetchImpl?: FetchLike;
}): Promise<TodoistTokenResponse> {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code: input.code,
    redirect_uri: input.config.redirectUri,
    grant_type: "authorization_code",
  });
  return postToken(params, input.fetchImpl, "token exchange");
}

/**
 * Refresh an access token with a stored refresh token.
 *
 * The returned `refreshToken` ROTATES and must replace the stored one. A null
 * `refreshToken` in the response means "unchanged" (grace-window retry or a
 * legacy app) and must never wipe what is stored — `storeCredentialSecrets`
 * already implements exactly that rule.
 */
export async function refreshTodoistAccessToken(input: {
  config: TodoistOAuthConfig;
  refreshToken: string;
  fetchImpl?: FetchLike;
}): Promise<TodoistTokenResponse> {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  return postToken(params, input.fetchImpl, "token refresh");
}

// --- Capability derivation (PURE) ----------------------------------------

/** The exact scope names Todoist documents. Used for validation, never guessed. */
export const TODOIST_SCOPE = {
  read: "data:read",
  readWrite: "data:read_write",
  delete: "data:delete",
  taskAdd: "task:add",
} as const;

/** Capability slugs Hula derives from a Todoist grant. */
export const TODOIST_CAPABILITY = {
  read: "tasks.read",
  write: "tasks.write",
  delete: "tasks.delete",
} as const;

/**
 * PURE: derive Hula capabilities from the scopes Todoist actually granted.
 *
 * This is the function that makes partial consent behave correctly, and each rule
 * encodes a real Todoist scope relationship rather than a guess:
 *
 *  - `data:read_write` IMPLIES read. A grant of read_write alone must yield BOTH
 *    `tasks.read` and `tasks.write`, or every read would refuse on a perfectly
 *    good connection.
 *  - `data:delete` is INDEPENDENT and optional. Its absence removes ONLY
 *    `tasks.delete`; the section is explicit that missing delete access must not
 *    be presented as a disconnected integration.
 *  - `task:add` is a narrow add-only scope. It grants `tasks.write` but NOT
 *    `tasks.read` — it cannot list anything. It is not in our default request,
 *    but a user could hold a grant containing it, so it is mapped honestly.
 *
 * Derived from the GRANTED scopes, never the requested ones: what we asked for is
 * not evidence of what the user approved.
 */
export function capabilitiesFromScopes(grantedScopes: readonly string[]): string[] {
  const granted = new Set(grantedScopes.map((s) => s.trim()).filter(Boolean));
  const capabilities = new Set<string>();

  if (granted.has(TODOIST_SCOPE.read) || granted.has(TODOIST_SCOPE.readWrite)) {
    capabilities.add(TODOIST_CAPABILITY.read);
  }
  if (granted.has(TODOIST_SCOPE.readWrite) || granted.has(TODOIST_SCOPE.taskAdd)) {
    capabilities.add(TODOIST_CAPABILITY.write);
  }
  if (granted.has(TODOIST_SCOPE.delete)) {
    capabilities.add(TODOIST_CAPABILITY.delete);
  }
  return [...capabilities];
}

/**
 * PURE: is this grant usable at all?
 *
 * A connection with neither read nor write can do literally nothing, so it is the
 * one case that genuinely is not a connection. Anything else — including
 * read_write without delete — is a real, working integration.
 */
export function isUsableTodoistGrant(grantedScopes: readonly string[]): boolean {
  const caps = capabilitiesFromScopes(grantedScopes);
  return caps.includes(TODOIST_CAPABILITY.read) || caps.includes(TODOIST_CAPABILITY.write);
}
