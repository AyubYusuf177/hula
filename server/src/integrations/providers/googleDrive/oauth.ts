import { env } from "../../../config/env";
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
  DRIVE_FILE_SCOPE,
  DRIVE_READONLY_SCOPE,
  type DriveCapability,
} from "./types";

export {
  GoogleOAuthConfigError,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkce,
  refreshAccessToken,
};
export type { FetchLike, GoogleOAuthConfig, GoogleTokenResponse, PkcePair };

export function isGoogleDriveOAuthConfigured(): boolean {
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID &&
      env.GOOGLE_OAUTH_CLIENT_SECRET &&
      env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI,
  );
}

export function getGoogleDriveOAuthConfig(): GoogleOAuthConfig {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleOAuthConfigError(
      "Google Drive OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, " +
        "GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_DRIVE_OAUTH_REDIRECT_URI.",
    );
  }
  // Drive authorization is intentionally frozen to the exact Section 23 pair.
  // GOOGLE_DRIVE_SCOPES remains in the env schema for deployment compatibility,
  // but cannot narrow or broaden the grant.
  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes: [DRIVE_READONLY_SCOPE, DRIVE_FILE_SCOPE],
  };
}

export function hasDriveReadonlyScope(scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope.trim() === DRIVE_READONLY_SCOPE);
}

export function hasDriveFileScope(scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope.trim() === DRIVE_FILE_SCOPE);
}

/** Derive only Drive capabilities; incremental Google scope unions are ignored. */
export function driveCapabilitiesFromScopes(
  scopes: readonly string[],
): DriveCapability[] {
  const capabilities: DriveCapability[] = [];
  if (hasDriveReadonlyScope(scopes)) {
    capabilities.push("drive.files.read", "drive.content.read");
  }
  if (hasDriveFileScope(scopes)) capabilities.push("drive.files.create");
  return capabilities;
}
