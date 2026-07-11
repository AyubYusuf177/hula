import { getPrisma } from "../db/prisma";
import {
  decryptToken,
  encryptToken,
  hashScopes,
} from "./tokenVault";

/**
 * Server-only integration credential store (Section 11).
 *
 * The single place provider access/refresh tokens are written to and read back
 * from `IntegrationCredential`. Every token is encrypted with the token vault
 * BEFORE it touches the database and only ever decrypted here on the server.
 *
 * Hard rules:
 *   - The mobile app never imports this module.
 *   - Decrypted token values are returned ONLY to other backend provider helpers
 *     (e.g. the Google Calendar client) — never to a route response.
 *   - Nothing here logs a token.
 */

/** Plaintext token material to persist. Encrypted before storage. */
export interface CredentialSecrets {
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  scopes?: string[];
}

/** Decrypted credential material, for server-side provider calls only. */
export interface DecryptedCredential {
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
}

/**
 * Encrypt and upsert a connection's tokens. A missing `refreshToken` is left
 * untouched on update (Google only returns a refresh token on first consent), so
 * a later refresh that omits it never wipes the stored one.
 */
export async function storeCredentialSecrets(
  connectionId: string,
  secrets: CredentialSecrets,
): Promise<void> {
  const encryptedAccessToken = encryptToken(secrets.accessToken);
  const encryptedRefreshToken =
    secrets.refreshToken && secrets.refreshToken.length > 0
      ? encryptToken(secrets.refreshToken)
      : undefined;
  const scopeHash = hashScopes(secrets.scopes) ?? undefined;

  await getPrisma().integrationCredential.upsert({
    where: { connectionId },
    create: {
      connectionId,
      tokenType: "oauth",
      encryptedAccessToken,
      encryptedRefreshToken: encryptedRefreshToken ?? null,
      accessTokenExpiresAt: secrets.accessTokenExpiresAt ?? null,
      scopeHash: scopeHash ?? null,
    },
    update: {
      encryptedAccessToken,
      // Only overwrite the refresh token when a new one is supplied.
      ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
      accessTokenExpiresAt: secrets.accessTokenExpiresAt ?? null,
      ...(scopeHash ? { scopeHash } : {}),
    },
  });
}

/** Update just the access token + expiry after a refresh (server-only). */
export async function updateAccessToken(
  connectionId: string,
  accessToken: string,
  accessTokenExpiresAt: Date | null,
): Promise<void> {
  await getPrisma().integrationCredential.update({
    where: { connectionId },
    data: {
      encryptedAccessToken: encryptToken(accessToken),
      accessTokenExpiresAt,
    },
  });
}

/**
 * Read and decrypt a connection's stored tokens. Returns nulls when no
 * credential row exists. SERVER-ONLY — the result must never leave the backend.
 */
export async function readCredentialSecrets(
  connectionId: string,
): Promise<DecryptedCredential | null> {
  const row = await getPrisma().integrationCredential.findUnique({
    where: { connectionId },
    select: {
      encryptedAccessToken: true,
      encryptedRefreshToken: true,
      accessTokenExpiresAt: true,
    },
  });
  if (!row) return null;
  return {
    accessToken: row.encryptedAccessToken ? decryptToken(row.encryptedAccessToken) : null,
    refreshToken: row.encryptedRefreshToken ? decryptToken(row.encryptedRefreshToken) : null,
    accessTokenExpiresAt: row.accessTokenExpiresAt ?? null,
  };
}
