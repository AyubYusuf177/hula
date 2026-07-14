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
import {
  GMAIL_COMPOSE_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_PROVIDER,
  GMAIL_READONLY_SCOPE,
} from "./types";

/**
 * Gmail OAuth helpers (Section 14 + Section 16).
 *
 * Gmail authorizes through the SAME Google OAuth 2.0 Authorization Code + PKCE
 * primitives as Google Calendar, but as a SEPARATE provider: its own redirect
 * URI (`GMAIL_OAUTH_REDIRECT_URI`), its own least-privilege scopes, its own
 * connect + callback routes, and its own connection record. It reuses ONLY the
 * genuinely provider-agnostic, config-driven pieces (`generatePkce`,
 * `buildAuthorizationUrl`, `exchangeCodeForTokens`, `refreshAccessToken`) — it
 * never reads Calendar env or touches Calendar state.
 *
 * Scopes: `gmail.readonly` (read) + `gmail.compose` (drafts + send, Section 16) +
 * `gmail.modify` (message management, Section 17). Scopes come from `GMAIL_SCOPES`
 * when set, else the catalog's defaults.
 *
 * Why `gmail.modify` is here: Google's per-method reference does NOT accept
 * `gmail.compose` for messages.modify/trash/untrash, so marking read, starring,
 * archiving, labelling, and trashing are impossible without it. It is ADDED, not a
 * replacement — readonly/compose still back their own capabilities, so partial
 * consent degrades one capability rather than all of them.
 *
 * Hard rules:
 *   - `https://mail.google.com/` is NEVER requested. It is the only scope that adds
 *     permanent deletion bypassing the trash, and Hula implements no such action.
 *   - Each scope is checked INDEPENDENTLY by membership (`hasGmail*Scope`), so a
 *     capability is claimed only when its own scope was actually granted.
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
 * or fall back to the catalog's defaults.
 *
 * NOTE: when `GMAIL_SCOPES` is set it WINS outright — the catalog default is not
 * merged in. So a deployment that pins `GMAIL_SCOPES` must add `gmail.modify` there
 * for Section 17's message management to be requested at all; otherwise those
 * actions correctly (and permanently) report reconnect-required.
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

/**
 * PURE: verify the Gmail COMPOSE (write) scope was granted, by MEMBERSHIP. This
 * is the scope Section 16's draft/send actions require; a connection lacking it
 * (e.g. a pre-Section-16 read-only grant) must be reconnected before writing.
 */
export function hasGmailComposeScope(grantedScopes: readonly string[]): boolean {
  return grantedScopes.some((s) => s.trim() === GMAIL_COMPOSE_SCOPE);
}

/**
 * PURE: verify the Gmail MODIFY scope was granted, by MEMBERSHIP. This is the scope
 * Section 17's message-management actions require (mark read/unread, star, archive,
 * label, trash, untrash). A connection lacking it — every pre-Section-17 grant, and
 * any user who declined it at partial consent — must be reconnected before those
 * actions can run, and is told so honestly rather than silently failing.
 *
 * Checked INDEPENDENTLY of readonly/compose: partial consent is real, and a user who
 * grants read + compose but not modify must keep search, drafts, and sending.
 */
export function hasGmailModifyScope(grantedScopes: readonly string[]): boolean {
  return grantedScopes.some((s) => s.trim() === GMAIL_MODIFY_SCOPE);
}
