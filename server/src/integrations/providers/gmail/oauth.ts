import { env } from "../../../config/env";
import { getProvider } from "../../catalog";
import {
  GoogleOAuthConfigError,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkce,
  refreshAccessToken,
  type FetchLike,
  type GoogleOAuthConfig,
  type GoogleTokenResponse,
  type PkcePair,
} from "../googleCalendar/oauth";
import { GMAIL_PROVIDER, GMAIL_READONLY_SCOPE } from "./types";

/**
 * Gmail OAuth helpers (Section 14) — READ-ONLY.
 *
 * Gmail authorizes through the SAME Google OAuth 2.0 Authorization Code + PKCE
 * primitives as Google Calendar, but as a SEPARATE provider: its own redirect
 * URI (`GMAIL_OAUTH_REDIRECT_URI`), its own least-privilege scope
 * (`gmail.readonly`), its own connect + callback routes, and its own connection
 * record. It reuses ONLY the genuinely provider-agnostic, config-driven pieces
 * (`generatePkce`, `buildAuthorizationUrl`, `exchangeCodeForTokens`,
 * `refreshAccessToken`) — it never reads Calendar env or touches Calendar state.
 *
 * Hard rules:
 *   - Only the READ-ONLY `gmail.readonly` scope is ever requested. There is NO
 *     path here that can request gmail.modify / gmail.send / gmail.compose or
 *     the full-mailbox scope.
 *   - Client secret and tokens are NEVER logged or put into a thrown message.
 *   - Missing config surfaces as `GoogleOAuthConfigError`, never a crash.
 */

// Re-export the provider-agnostic primitives so the Gmail route/client import
// from one Gmail-local site (keeps Gmail's dependency surface explicit).
export {
  GoogleOAuthConfigError,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkce,
  refreshAccessToken,
};
export type { FetchLike, GoogleOAuthConfig, GoogleTokenResponse, PkcePair };

/** The catalog's least-privilege default scope, used when env omits scopes. */
function defaultScopes(): string[] {
  return getProvider(GMAIL_PROVIDER)?.defaultScopes ?? [GMAIL_READONLY_SCOPE];
}

/** True only when all required Gmail OAuth env values are present. */
export function isGmailOAuthConfigured(): boolean {
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID &&
      env.GOOGLE_OAUTH_CLIENT_SECRET &&
      env.GMAIL_OAUTH_REDIRECT_URI,
  );
}

/**
 * Resolve the Gmail OAuth config from env, or throw `GoogleOAuthConfigError`.
 *
 * Uses the SHARED Google client id/secret but Gmail's OWN redirect URI
 * (`GMAIL_OAUTH_REDIRECT_URI`). Scopes come from `GMAIL_SCOPES` (space-separated)
 * or fall back to the catalog's least-privilege `gmail.readonly`. This never
 * returns a write scope — the consent screen the user approves is read-only.
 */
export function getGmailOAuthConfig(): GoogleOAuthConfig {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.GMAIL_OAUTH_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleOAuthConfigError(
      "Gmail OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, " +
        "GOOGLE_OAUTH_CLIENT_SECRET, and GMAIL_OAUTH_REDIRECT_URI.",
    );
  }

  const scopes = (env.GMAIL_SCOPES ?? "")
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

/**
 * PURE: verify the Gmail read-only scope was granted, by MEMBERSHIP (not brittle
 * exact-string equality of the whole scope set). Google may return extra
 * identity scopes or reorder them; we only require that `gmail.readonly` is
 * present in the granted set.
 */
export function hasGmailReadonlyScope(grantedScopes: readonly string[]): boolean {
  return grantedScopes.some((s) => s.trim() === GMAIL_READONLY_SCOPE);
}
