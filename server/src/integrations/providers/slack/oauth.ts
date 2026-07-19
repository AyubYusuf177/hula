import { env } from "../../../config/env";
import type { SlackCredentials, SlackTokenType } from "./types";

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const REVOKE_URL = "https://slack.com/api/auth.revoke";

export const DEFAULT_BOT_SCOPES = [
  "app_mentions:read",
  "bookmarks:read",
  "bookmarks:write",
  "channels:history",
  "channels:join",
  "channels:manage",
  "channels:read",
  "chat:write",
  "emoji:read",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "pins:read",
  "pins:write",
  "reactions:read",
  "reactions:write",
  "team:read",
  "usergroups:read",
  "usergroups:write",
  "users.profile:read",
  "users:read",
  "users:read.email",
] as const;

// Slack search methods require a user token. This is ordinary OAuth's
// `user_scope`, not Sign in with Slack identity scopes.
// Slack requires a user token (not a bot token) to read threads in public and
// private channels. DMs/MPIMs continue to use the bot token.
export const DEFAULT_USER_SCOPES = ["channels:history", "groups:history", "search:read"] as const;

const SUPPORTED_BOT_SCOPES = new Set(DEFAULT_BOT_SCOPES);
const SUPPORTED_USER_SCOPES = new Set(DEFAULT_USER_SCOPES);

export class SlackOAuthError extends Error {
  constructor(message: string, readonly code = "slack_oauth_error") {
    super(message);
    this.name = "SlackOAuthError";
  }
}

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  botScopes: string[];
  userScopes: string[];
  developmentTeamId?: string;
}

export type SlackOAuthFetch = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface SlackRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[];
  tokenType: SlackTokenType;
}

export function parseSlackScopes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(/[ ,]+/).map((scope) => scope.trim()).filter(Boolean))].sort();
}

function configuredScopes(value: string | undefined, defaults: readonly string[]): string[] {
  return parseSlackScopes(value ?? defaults.join(","));
}

export function validateSlackScopes(botScopes: readonly string[], userScopes: readonly string[]): void {
  const unsupportedBot = botScopes.filter((scope) => !SUPPORTED_BOT_SCOPES.has(scope as typeof DEFAULT_BOT_SCOPES[number]));
  const unsupportedUser = userScopes.filter((scope) => !SUPPORTED_USER_SCOPES.has(scope as typeof DEFAULT_USER_SCOPES[number]));
  if (unsupportedBot.length > 0 || unsupportedUser.length > 0) {
    throw new SlackOAuthError("Slack scope configuration contains unsupported scopes", "invalid_scope_configuration");
  }
  if (!botScopes.includes("channels:read")) {
    throw new SlackOAuthError("Slack requires channels:read", "missing_required_scope_configuration");
  }
}

export function getSlackOAuthConfig(): SlackOAuthConfig {
  const clientId = env.SLACK_CLIENT_ID?.trim();
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim();
  const redirectUri = env.SLACK_REDIRECT_URI?.trim();
  const developmentTeamId = env.SLACK_DEVELOPMENT_TEAM_ID?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new SlackOAuthError("Slack OAuth is not configured", "slack_not_configured");
  }
  const parsed = new URL(redirectUri);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new SlackOAuthError("Slack redirect URI must use HTTPS", "invalid_redirect_uri");
  }
  if (developmentTeamId && !/^T[A-Z0-9]+$/i.test(developmentTeamId)) {
    throw new SlackOAuthError("Slack development team ID must start with T", "invalid_development_team_id");
  }
  const botScopes = configuredScopes(env.SLACK_BOT_SCOPES, DEFAULT_BOT_SCOPES);
  const userScopes = configuredScopes(env.SLACK_USER_SCOPES, DEFAULT_USER_SCOPES);
  validateSlackScopes(botScopes, userScopes);
  return {
    clientId,
    clientSecret,
    redirectUri,
    botScopes,
    userScopes,
    ...(developmentTeamId ? { developmentTeamId } : {}),
  };
}

export function buildSlackAuthorizationUrl(config: SlackOAuthConfig, state: string): string {
  const query = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.botScopes.join(","),
    state,
  });
  if (config.userScopes.length > 0) query.set("user_scope", config.userScopes.join(","));
  if (config.developmentTeamId) query.set("team", config.developmentTeamId);
  return `${AUTHORIZE_URL}?${query.toString()}`;
}

async function oauthCall(
  url: string,
  config: SlackOAuthConfig,
  params: Record<string, string>,
  fetchImpl: SlackOAuthFetch = fetch,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...params,
  });
  let response: Awaited<ReturnType<SlackOAuthFetch>>;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SlackOAuthError("Slack OAuth network request failed", "network_error");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await response.text());
  } catch {
    throw new SlackOAuthError("Malformed Slack OAuth response", "malformed_response");
  }
  const envelope = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!response.ok || !envelope || envelope.ok !== true) {
    throw new SlackOAuthError(
      "Slack OAuth request failed",
      typeof envelope?.error === "string" ? envelope.error : `http_${response.status}`,
    );
  }
  return envelope;
}

function expiresAt(expiresIn: unknown, now: Date): string | null {
  return typeof expiresIn === "number"
    ? new Date(now.getTime() + expiresIn * 1_000).toISOString()
    : null;
}

export function parseSlackCredentials(
  envelope: Record<string, unknown>,
  now = new Date(),
): SlackCredentials {
  const team = envelope.team && typeof envelope.team === "object"
    ? envelope.team as Record<string, unknown>
    : null;
  const enterprise = envelope.enterprise && typeof envelope.enterprise === "object"
    ? envelope.enterprise as Record<string, unknown>
    : null;
  const authedUser = envelope.authed_user && typeof envelope.authed_user === "object"
    ? envelope.authed_user as Record<string, unknown>
    : null;
  if (
    typeof envelope.access_token !== "string" ||
    typeof envelope.app_id !== "string" ||
    typeof envelope.bot_user_id !== "string" ||
    typeof team?.id !== "string"
  ) {
    throw new SlackOAuthError("Malformed Slack token response", "malformed_response");
  }
  return {
    botAccessToken: envelope.access_token,
    botRefreshToken: typeof envelope.refresh_token === "string" ? envelope.refresh_token : null,
    botExpiresAt: expiresAt(envelope.expires_in, now),
    userAccessToken: typeof authedUser?.access_token === "string" ? authedUser.access_token : null,
    userRefreshToken: typeof authedUser?.refresh_token === "string" ? authedUser.refresh_token : null,
    userExpiresAt: expiresAt(authedUser?.expires_in, now),
    teamId: team.id,
    teamName: typeof team.name === "string" ? team.name : "Slack workspace",
    enterpriseId: typeof enterprise?.id === "string" ? enterprise.id : null,
    appId: envelope.app_id,
    botUserId: envelope.bot_user_id,
    botScopes: parseSlackScopes(envelope.scope),
    userScopes: parseSlackScopes(authedUser?.scope),
  };
}

export function parseSlackRefresh(
  envelope: Record<string, unknown>,
  tokenType: SlackTokenType,
  now = new Date(),
): SlackRefreshResult {
  if (
    typeof envelope.access_token !== "string" ||
    typeof envelope.refresh_token !== "string" ||
    typeof envelope.expires_in !== "number"
  ) {
    throw new SlackOAuthError("Malformed Slack refresh response", "malformed_response");
  }
  return {
    accessToken: envelope.access_token,
    refreshToken: envelope.refresh_token,
    expiresAt: new Date(now.getTime() + envelope.expires_in * 1_000).toISOString(),
    scopes: parseSlackScopes(envelope.scope),
    tokenType,
  };
}

export async function exchangeSlackCode(
  config: SlackOAuthConfig,
  code: string,
  fetchImpl?: SlackOAuthFetch,
): Promise<SlackCredentials> {
  return parseSlackCredentials(await oauthCall(TOKEN_URL, config, {
    code,
    redirect_uri: config.redirectUri,
  }, fetchImpl));
}

export async function refreshSlackToken(
  config: SlackOAuthConfig,
  refreshToken: string,
  tokenType: SlackTokenType,
  fetchImpl?: SlackOAuthFetch,
): Promise<SlackRefreshResult> {
  return parseSlackRefresh(await oauthCall(TOKEN_URL, config, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }, fetchImpl), tokenType);
}

export async function revokeSlackToken(
  config: SlackOAuthConfig,
  token: string,
  fetchImpl?: SlackOAuthFetch,
): Promise<void> {
  await oauthCall(REVOKE_URL, config, { token }, fetchImpl);
}

export async function revokeSlackCredentials(
  config: SlackOAuthConfig,
  credentials: SlackCredentials,
  fetchImpl?: SlackOAuthFetch,
): Promise<{ attempted: number; failed: number }> {
  const tokens = [...new Set([
    credentials.userRefreshToken,
    credentials.userAccessToken,
    credentials.botRefreshToken,
    credentials.botAccessToken,
  ].filter((token): token is string => Boolean(token)))];
  let failed = 0;
  for (const token of tokens) {
    try {
      await revokeSlackToken(config, token, fetchImpl);
    } catch {
      failed += 1;
    }
  }
  return { attempted: tokens.length, failed };
}

export function slackCapabilities(botScopes: readonly string[], userScopes: readonly string[]): string[] {
  const bot = new Set(botScopes);
  const user = new Set(userScopes);
  const capabilities = new Set<string>();
  if ([...bot].some((scope) => scope.endsWith(":read") || scope.endsWith(":history"))) {
    capabilities.add("slack.read");
  }
  if (bot.has("chat:write")) capabilities.add("slack.messages.write");
  if (bot.has("channels:manage")) capabilities.add("slack.channels.manage");
  if (bot.has("reactions:write")) capabilities.add("slack.reactions.write");
  if (bot.has("pins:write")) capabilities.add("slack.pins.write");
  if (bot.has("bookmarks:write")) capabilities.add("slack.bookmarks.write");
  if (bot.has("usergroups:write")) capabilities.add("slack.usergroups.write");
  if (user.has("search:read")) capabilities.add("slack.search");
  return [...capabilities];
}
