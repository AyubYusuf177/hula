import { createHash, randomBytes } from "node:crypto";

import { env } from "../../../config/env";
import { getProvider } from "../../catalog";
import {
  MICROSOFT_AUTHORITY,
  MICROSOFT_CALLBACK_PATH,
  MICROSOFT_PROVIDER,
  type MicrosoftCapability,
} from "./types";

export const MICROSOFT_AUTHORIZE_URL = `${MICROSOFT_AUTHORITY}/authorize`;
export const MICROSOFT_TOKEN_URL = `${MICROSOFT_AUTHORITY}/token`;

export class MicrosoftOAuthConfigError extends Error {
  constructor(message = "Microsoft OAuth is not configured") {
    super(message);
    this.name = "MicrosoftOAuthConfigError";
  }
}

export type MicrosoftOAuthErrorReason =
  | "invalid_client"
  | "invalid_grant"
  | "invalid_request"
  | "invalid_scope"
  | "temporarily_unavailable"
  | "unauthorized_client"
  | "oauth_rejected"
  | "malformed_response"
  | "timeout"
  | "network_failure";

export type MicrosoftAadstsCode = `AADSTS${string}`;

/** Safe provider error: it never carries raw response bodies or secrets. */
export class MicrosoftOAuthError extends Error {
  constructor(
    public readonly reason: MicrosoftOAuthErrorReason,
    public readonly status: number | null = null,
    public readonly aadstsCode: MicrosoftAadstsCode | null = null,
  ) {
    super(reason === "invalid_grant" ? "Microsoft authorization must be renewed" : "Microsoft OAuth request failed");
    this.name = "MicrosoftOAuthError";
  }
}

function normalizeAadstsDigits(value: unknown): MicrosoftAadstsCode | null {
  const digits =
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : typeof value === "string" && /^[0-9]+$/.test(value)
        ? value
        : null;
  return digits && /^[0-9]{4,10}$/.test(digits)
    ? `AADSTS${digits}`
    : null;
}

/** Extract only Microsoft's bounded machine-readable AADSTS identifier. */
function extractAadstsCode(body: Record<string, unknown>): MicrosoftAadstsCode | null {
  if (Array.isArray(body.error_codes)) {
    for (const value of body.error_codes) {
      const code = normalizeAadstsDigits(value);
      if (code) return code;
    }
  }
  if (typeof body.error_description !== "string") return null;
  const match = /\bAADSTS([0-9]{4,10})\b/i.exec(body.error_description);
  return match?.[1] ? `AADSTS${match[1]}` : null;
}

export interface MicrosoftOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface MicrosoftPkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

export interface MicrosoftTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scopes: string[];
}

export type MicrosoftFetch = (
  url: string,
  init: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const REQUEST_TIMEOUT_MS = 12_000;

function defaultScopes(): string[] {
  return [...(getProvider(MICROSOFT_PROVIDER)?.defaultScopes ?? [])];
}

export function isMicrosoftOAuthConfigured(): boolean {
  return Boolean(
    env.MICROSOFT_OAUTH_CLIENT_ID &&
      env.MICROSOFT_OAUTH_CLIENT_SECRET &&
      env.MICROSOFT_OAUTH_REDIRECT_URI &&
      env.INTEGRATION_TOKEN_ENCRYPTION_KEY,
  );
}

/** Validate the configured backend callback exactly; no query/hash variations. */
export function validateMicrosoftRedirectUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MicrosoftOAuthConfigError("Microsoft OAuth redirect URI is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== MICROSOFT_CALLBACK_PATH
  ) {
    throw new MicrosoftOAuthConfigError(
      `Microsoft OAuth redirect URI must be an HTTPS URL ending exactly in ${MICROSOFT_CALLBACK_PATH}`,
    );
  }
  return parsed.toString();
}

export function getMicrosoftOAuthConfig(): MicrosoftOAuthConfig {
  const clientId = env.MICROSOFT_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.MICROSOFT_OAUTH_CLIENT_SECRET?.trim();
  const redirectValue = env.MICROSOFT_OAUTH_REDIRECT_URI?.trim();
  const encryptionKey = env.INTEGRATION_TOKEN_ENCRYPTION_KEY?.trim();
  if (!clientId || !clientSecret || !redirectValue || !encryptionKey) {
    throw new MicrosoftOAuthConfigError(
      "Microsoft OAuth is not configured. Set MICROSOFT_OAUTH_CLIENT_ID, " +
        "MICROSOFT_OAUTH_CLIENT_SECRET, MICROSOFT_OAUTH_REDIRECT_URI, and " +
        "INTEGRATION_TOKEN_ENCRYPTION_KEY.",
    );
  }
  const scopes = defaultScopes();
  if (scopes.length === 0) {
    throw new MicrosoftOAuthConfigError("Microsoft OAuth scopes are not configured");
  }
  return {
    clientId,
    clientSecret,
    redirectUri: validateMicrosoftRedirectUri(redirectValue),
    scopes,
  };
}

export function generateMicrosoftPkce(): MicrosoftPkcePair {
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** Microsoft treats scope names case-insensitively; retain first-seen spelling. */
export function normalizeMicrosoftScopes(
  scopes: readonly string[] | string | null | undefined,
): string[] {
  const values = typeof scopes === "string"
    ? scopes.split(/\s+/)
    : scopes
      ? [...scopes]
      : [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of values) {
    const scope = raw.trim();
    const key = scope.toLowerCase();
    if (!scope || seen.has(key)) continue;
    seen.add(key);
    normalized.push(scope);
  }
  return normalized;
}

export function buildMicrosoftAuthorizationUrl(input: {
  config: MicrosoftOAuthConfig;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    response_type: "code",
    redirect_uri: input.config.redirectUri,
    response_mode: "query",
    scope: normalizeMicrosoftScopes(input.config.scopes).join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${MICROSOFT_AUTHORIZE_URL}?${params.toString()}`;
}

function hasAnyScope(granted: Set<string>, candidates: readonly string[]): boolean {
  return candidates.some((scope) => granted.has(scope.toLowerCase()));
}

/** Derive capabilities only from the token endpoint's actual granted scopes. */
export function microsoftCapabilitiesFromScopes(
  scopes: readonly string[],
): MicrosoftCapability[] {
  const granted = new Set(normalizeMicrosoftScopes(scopes).map((scope) => scope.toLowerCase()));
  const capabilities: MicrosoftCapability[] = [];
  if (granted.has("user.read")) capabilities.push("microsoft.identity");
  if (hasAnyScope(granted, ["Mail.ReadBasic", "Mail.Read", "Mail.ReadWrite"])) {
    capabilities.push("outlook_mail.read");
  }
  if (granted.has("mail.readwrite")) capabilities.push("outlook_mail.write");
  if (granted.has("mail.send")) capabilities.push("outlook_mail.send");
  if (hasAnyScope(granted, ["Calendars.ReadBasic", "Calendars.Read", "Calendars.ReadWrite"])) {
    capabilities.push("outlook_calendar.read");
  }
  if (granted.has("calendars.readwrite")) capabilities.push("outlook_calendar.write");
  if (hasAnyScope(granted, ["Files.Read", "Files.Read.All", "Files.ReadWrite", "Files.ReadWrite.All"])) {
    capabilities.push("onedrive.read");
  }
  if (hasAnyScope(granted, ["Files.ReadWrite", "Files.ReadWrite.All"])) {
    capabilities.push("onedrive.write");
  }

  // Foundation only. None of these scopes are requested in Phase 1.
  if (hasAnyScope(granted, ["Team.ReadBasic.All", "Channel.ReadBasic.All"])) {
    capabilities.push("teams.discovery");
  }
  if (hasAnyScope(granted, ["Chat.Read", "Chat.ReadWrite", "ChannelMessage.Read.All"])) {
    capabilities.push("teams.read");
  }
  if (hasAnyScope(granted, ["Chat.ReadWrite", "ChatMessage.Send", "ChannelMessage.Send"])) {
    capabilities.push("teams.send");
  }
  return capabilities;
}

function parseTokenResponse(raw: string): MicrosoftTokenResponse {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new MicrosoftOAuthError("malformed_response");
  }
  const scopes = normalizeMicrosoftScopes(
    typeof body.scope === "string" ? body.scope : null,
  );
  if (typeof body.access_token !== "string" || !body.access_token || scopes.length === 0) {
    throw new MicrosoftOAuthError("malformed_response");
  }
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" && body.refresh_token
        ? body.refresh_token
        : null,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
    scopes,
  };
}

async function tokenRequest(input: {
  config: MicrosoftOAuthConfig;
  params: URLSearchParams;
  fetchImpl?: MicrosoftFetch;
}): Promise<MicrosoftTokenResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Awaited<ReturnType<MicrosoftFetch>>;
    try {
      response = await (input.fetchImpl ?? (fetch as unknown as MicrosoftFetch))(
        MICROSOFT_TOKEN_URL,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: input.params.toString(),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new MicrosoftOAuthError(
        error instanceof Error && error.name === "AbortError" ? "timeout" : "network_failure",
      );
    }
    const raw = await response.text();
    if (!response.ok) {
      let errorBody: Record<string, unknown> = {};
      try {
        errorBody = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // A malformed provider error remains a generic, secret-safe rejection.
      }
      const code = errorBody.error;
      const safeReason: MicrosoftOAuthErrorReason =
        code === "invalid_client" ||
        code === "invalid_grant" ||
        code === "invalid_request" ||
        code === "invalid_scope" ||
        code === "temporarily_unavailable" ||
        code === "unauthorized_client"
          ? code
          : "oauth_rejected";
      throw new MicrosoftOAuthError(
        safeReason,
        response.status,
        extractAadstsCode(errorBody),
      );
    }
    return parseTokenResponse(raw);
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangeMicrosoftCode(input: {
  config: MicrosoftOAuthConfig;
  code: string;
  codeVerifier: string;
  fetchImpl?: MicrosoftFetch;
}): Promise<MicrosoftTokenResponse> {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.config.redirectUri,
    code_verifier: input.codeVerifier,
    scope: normalizeMicrosoftScopes(input.config.scopes).join(" "),
  });
  return tokenRequest({ config: input.config, params, fetchImpl: input.fetchImpl });
}

export async function refreshMicrosoftToken(input: {
  config: MicrosoftOAuthConfig;
  refreshToken: string;
  grantedScopes: readonly string[];
  fetchImpl?: MicrosoftFetch;
}): Promise<MicrosoftTokenResponse> {
  const refreshScopes = normalizeMicrosoftScopes([
    ...input.grantedScopes,
    "offline_access",
  ]);
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    scope: refreshScopes.join(" "),
  });
  return tokenRequest({ config: input.config, params, fetchImpl: input.fetchImpl });
}

export function assertMicrosoftCallbackRedirect(
  storedRedirectUri: string,
  configuredRedirectUri: string,
): void {
  if (storedRedirectUri !== configuredRedirectUri) {
    throw new MicrosoftOAuthConfigError("Microsoft OAuth redirect URI changed during authorization");
  }
}
