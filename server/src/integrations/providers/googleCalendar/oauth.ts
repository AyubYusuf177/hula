import { createHash, randomBytes } from "node:crypto";

import { env } from "../../../config/env";
import { getProvider } from "../../catalog";
import { GOOGLE_CALENDAR_PROVIDER } from "./types";

/**
 * Google Calendar OAuth helpers (Section 11) — READ-ONLY.
 *
 * Pure-ish helpers around the OAuth 2.0 Authorization Code + PKCE flow: resolve
 * config from env, build the authorization URL, and exchange/refresh tokens with
 * Google. Network calls (`exchangeCodeForTokens`, `refreshAccessToken`) take an
 * injectable `fetchImpl` so tests never hit the real Google endpoints.
 *
 * Hard rules:
 *   - Only READ-ONLY scopes are ever requested. There is no write scope path.
 *   - Client secret and tokens are NEVER logged or put into a thrown message.
 *   - Missing config surfaces as `GoogleOAuthConfigError`, never a crash.
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Thrown when Google OAuth env is missing/invalid. Contains no secrets. */
export class GoogleOAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleOAuthConfigError";
  }
}

/** Resolved, validated Google OAuth configuration. */
export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

/** The catalog's least-privilege default scope, used when env omits scopes. */
function defaultScopes(): string[] {
  return getProvider(GOOGLE_CALENDAR_PROVIDER)?.defaultScopes ?? [
    "https://www.googleapis.com/auth/calendar.readonly",
  ];
}

/** True only when all required Google OAuth env values are present. */
export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID &&
      env.GOOGLE_OAUTH_CLIENT_SECRET &&
      env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

/**
 * Resolve the Google OAuth config from env, or throw `GoogleOAuthConfigError`.
 * Scopes come from `GOOGLE_CALENDAR_SCOPES` (space-separated) or fall back to the
 * catalog default. This never returns a write scope — the env is expected to be
 * read-only, matching the consent screen the user approves.
 */
export function getGoogleOAuthConfig(): GoogleOAuthConfig {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleOAuthConfigError(
      "Google Calendar OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, " +
        "GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI.",
    );
  }

  const scopes = (env.GOOGLE_CALENDAR_SCOPES ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes: scopes.length > 0 ? scopes : defaultScopes(),
  };
}

/** A generated PKCE pair. The verifier is stored server-side with the state. */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** Generate a PKCE code verifier + S256 challenge (RFC 7636). */
export function generatePkce(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/**
 * Build the Google OAuth authorization URL. `access_type=offline` + `prompt=
 * consent` ensure we receive a refresh token in dev. Includes the PKCE challenge
 * and the anti-CSRF state.
 */
export function buildAuthorizationUrl(input: {
  config: GoogleOAuthConfig;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    redirect_uri: input.config.redirectUri,
    response_type: "code",
    scope: input.config.scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** The normalized result of a token exchange or refresh. */
export interface GoogleTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds until the access token expires. */
  expiresIn: number | null;
  /** Space-separated granted scopes, split into an array. */
  scopes: string[];
}

/** Minimal fetch signature so tests can inject a fake. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Parse Google's token JSON into our normalized shape (no secrets logged). */
function parseTokenBody(raw: string): GoogleTokenResponse {
  const body = JSON.parse(raw) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!body.access_token) {
    throw new Error("Google token response missing access_token");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
    scopes: (body.scope ?? "").split(/\s+/).filter(Boolean),
  };
}

/** Read a redacted, bounded error snippet from a failed token response. */
async function tokenErrorDetail(res: {
  status: number;
  text: () => Promise<string>;
}): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "<unreadable body>";
  }
}

/**
 * Exchange an authorization `code` for tokens using PKCE. Throws a redacted error
 * on failure (never includes the client secret or tokens).
 */
export async function exchangeCodeForTokens(input: {
  config: GoogleOAuthConfig;
  code: string;
  codeVerifier: string | null;
  fetchImpl?: FetchLike;
}): Promise<GoogleTokenResponse> {
  const doFetch = (input.fetchImpl ?? (fetch as unknown as FetchLike));
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.config.redirectUri,
    grant_type: "authorization_code",
    code: input.code,
  });
  if (input.codeVerifier) params.set("code_verifier", input.codeVerifier);

  const res = await doFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await tokenErrorDetail(res)}`);
  }
  return parseTokenBody(await res.text());
}

/**
 * Refresh an access token with a stored refresh token. Throws a redacted error on
 * failure so the caller can mark the connection expired.
 */
export async function refreshAccessToken(input: {
  config: GoogleOAuthConfig;
  refreshToken: string;
  fetchImpl?: FetchLike;
}): Promise<GoogleTokenResponse> {
  const doFetch = (input.fetchImpl ?? (fetch as unknown as FetchLike));
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });

  const res = await doFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status}): ${await tokenErrorDetail(res)}`);
  }
  return parseTokenBody(await res.text());
}
