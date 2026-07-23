import { getPrisma } from "../../../db/prisma";
import { logger } from "../../../utils/logger";
import {
  readCredentialSecrets,
  storeCredentialSecrets,
  type CredentialSecrets,
} from "../../credentials";
import { TokenVaultConfigError } from "../../tokenVault";
import {
  getMicrosoftOAuthConfig,
  microsoftCapabilitiesFromScopes,
  refreshMicrosoftToken,
  type MicrosoftFetch,
  type MicrosoftOAuthConfig,
  MicrosoftOAuthError,
} from "./oauth";
import {
  MICROSOFT_GRAPH_BASE_URL,
  MICROSOFT_PROVIDER,
  type MicrosoftAccountIdentity,
} from "./types";

const EXPIRY_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;

export type MicrosoftConnectionErrorReason =
  | "not_connected"
  | "credential_decrypt_failed"
  | "reconnect_required"
  | "token_refresh_failed"
  | "identity_unavailable"
  | "malformed_identity"
  | "timeout"
  | "network_failure";

export class MicrosoftConnectionError extends Error {
  constructor(public readonly reason: MicrosoftConnectionErrorReason) {
    super(reason);
    this.name = "MicrosoftConnectionError";
  }
}

export interface MicrosoftConnectionRef {
  id: string;
  status: string;
  providerAccountEmail?: string | null;
  grantedScopes: string[];
  capabilities: string[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export async function getMicrosoftConnection(
  userId: string,
): Promise<MicrosoftConnectionRef | null> {
  const row = await getPrisma().integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: MICROSOFT_PROVIDER } },
    select: { id: true, status: true, providerAccountEmail: true, grantedScopes: true, capabilities: true },
  });
  return row
    ? {
        id: row.id,
        status: row.status,
        providerAccountEmail: row.providerAccountEmail,
        grantedScopes: stringArray(row.grantedScopes),
        capabilities: stringArray(row.capabilities),
      }
    : null;
}

async function setConnectionStatus(
  connectionId: string,
  status: "expired" | "error",
): Promise<void> {
  try {
    await getPrisma().integrationConnection.update({
      where: { id: connectionId },
      data: { status },
    });
  } catch {
    logger.error("microsoft.connection status update failed", { status });
  }
}

export type StoreMicrosoftCredential = (
  connectionId: string,
  secrets: CredentialSecrets,
) => Promise<void>;

export type UpdateMicrosoftGrant = (
  connectionId: string,
  scopes: string[],
  capabilities: string[],
) => Promise<void>;

/**
 * Refresh and rotate one Microsoft credential. The new refresh token replaces
 * the stored value when Microsoft supplies it; an omitted value preserves the
 * previous encrypted token through the shared credential store.
 */
export async function refreshMicrosoftConnectionCredential(input: {
  connectionId: string;
  refreshToken: string;
  grantedScopes: readonly string[];
  config?: MicrosoftOAuthConfig;
  fetchImpl?: MicrosoftFetch;
  storeCredential?: StoreMicrosoftCredential;
  updateGrant?: UpdateMicrosoftGrant;
  now?: Date;
}): Promise<string> {
  const tokens = await refreshMicrosoftToken({
    config: input.config ?? getMicrosoftOAuthConfig(),
    refreshToken: input.refreshToken,
    grantedScopes: input.grantedScopes,
    fetchImpl: input.fetchImpl,
  });
  const capabilities = microsoftCapabilitiesFromScopes(tokens.scopes);
  const expiresAt = tokens.expiresIn
    ? new Date((input.now ?? new Date()).getTime() + tokens.expiresIn * 1000)
    : null;
  const store = input.storeCredential ?? storeCredentialSecrets;
  await store(input.connectionId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: expiresAt,
    scopes: tokens.scopes,
  });
  const updateGrant = input.updateGrant ?? (async (connectionId, scopes, derived) => {
    await getPrisma().integrationConnection.update({
      where: { id: connectionId },
      data: { grantedScopes: scopes, capabilities: derived },
    });
  });
  await updateGrant(input.connectionId, tokens.scopes, capabilities);
  logger.info("microsoft.token refreshed", {
    scopeCount: tokens.scopes.length,
    capabilityCount: capabilities.length,
    refreshRotated: Boolean(tokens.refreshToken),
  });
  return tokens.accessToken;
}

const refreshes = new Map<string, Promise<string>>();

async function refreshConnectionAccessToken(input: {
  connection: MicrosoftConnectionRef;
  refreshToken: string;
  fetchImpl?: MicrosoftFetch;
}): Promise<string> {
  const active = refreshes.get(input.connection.id);
  if (active) return active;
  const pending = refreshMicrosoftConnectionCredential({
    connectionId: input.connection.id,
    refreshToken: input.refreshToken,
    grantedScopes: input.connection.grantedScopes,
    fetchImpl: input.fetchImpl,
  })
    .catch(async (error) => {
      const failure = classifyMicrosoftRefreshFailure(error);
      await setConnectionStatus(input.connection.id, failure.status);
      logger.info("microsoft.token refresh failed", {
        errorCode:
          error instanceof Error && "reason" in error
            ? String((error as { reason: unknown }).reason)
            : "refresh_failed",
        connectionStatus: failure.status,
      });
      throw new MicrosoftConnectionError(failure.reason);
    })
    .finally(() => {
      refreshes.delete(input.connection.id);
    });
  refreshes.set(input.connection.id, pending);
  return pending;
}

export function classifyMicrosoftRefreshFailure(error: unknown): {
  status: "expired" | "error";
  reason: "reconnect_required" | "token_refresh_failed";
} {
  return error instanceof MicrosoftOAuthError && error.reason === "invalid_grant"
    ? { status: "expired", reason: "reconnect_required" }
    : { status: "error", reason: "token_refresh_failed" };
}

/** Return a valid backend-only access token, refreshing once when near expiry. */
export async function getMicrosoftAccessToken(
  userId: string,
  fetchImpl?: MicrosoftFetch,
): Promise<string> {
  const connection = await getMicrosoftConnection(userId);
  if (!connection || connection.status !== "connected") {
    throw new MicrosoftConnectionError("not_connected");
  }
  let credentials;
  try {
    credentials = await readCredentialSecrets(connection.id);
  } catch (error) {
    if (error instanceof TokenVaultConfigError) {
      throw new MicrosoftConnectionError("credential_decrypt_failed");
    }
    throw error;
  }
  if (!credentials?.accessToken) {
    await setConnectionStatus(connection.id, "expired");
    throw new MicrosoftConnectionError("reconnect_required");
  }
  if (
    !credentials.accessTokenExpiresAt ||
    credentials.accessTokenExpiresAt.getTime() > Date.now() + EXPIRY_SKEW_MS
  ) {
    return credentials.accessToken;
  }
  if (!credentials.refreshToken) {
    await setConnectionStatus(connection.id, "expired");
    throw new MicrosoftConnectionError("reconnect_required");
  }

  return refreshConnectionAccessToken({ connection, refreshToken: credentials.refreshToken, fetchImpl });
}

/** Force one refresh after Graph rejects an otherwise-current access token. */
export async function refreshMicrosoftAccessToken(
  userId: string,
  fetchImpl?: MicrosoftFetch,
): Promise<string> {
  const connection = await getMicrosoftConnection(userId);
  if (!connection || connection.status !== "connected") {
    throw new MicrosoftConnectionError("not_connected");
  }
  let credentials;
  try {
    credentials = await readCredentialSecrets(connection.id);
  } catch (error) {
    if (error instanceof TokenVaultConfigError) {
      throw new MicrosoftConnectionError("credential_decrypt_failed");
    }
    throw error;
  }
  if (!credentials?.refreshToken) {
    await setConnectionStatus(connection.id, "expired");
    throw new MicrosoftConnectionError("reconnect_required");
  }
  return refreshConnectionAccessToken({ connection, refreshToken: credentials.refreshToken, fetchImpl });
}

export async function fetchMicrosoftIdentity(
  accessToken: string,
  fetchImpl: MicrosoftFetch = fetch as unknown as MicrosoftFetch,
): Promise<MicrosoftAccountIdentity> {
  const url = new URL(`${MICROSOFT_GRAPH_BASE_URL}/me`);
  url.searchParams.set("$select", "id,displayName,mail,userPrincipalName");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Awaited<ReturnType<MicrosoftFetch>>;
    try {
      response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw new MicrosoftConnectionError(
        error instanceof Error && error.name === "AbortError" ? "timeout" : "network_failure",
      );
    }
    const raw = await response.text();
    if (!response.ok) throw new MicrosoftConnectionError("identity_unavailable");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new MicrosoftConnectionError("malformed_identity");
    }
    if (typeof body.id !== "string" || !body.id) {
      throw new MicrosoftConnectionError("malformed_identity");
    }
    return {
      id: body.id,
      displayName:
        typeof body.displayName === "string" && body.displayName
          ? body.displayName
          : null,
      email:
        typeof body.mail === "string" && body.mail
          ? body.mail
          : typeof body.userPrincipalName === "string" && body.userPrincipalName
            ? body.userPrincipalName
            : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
