import { randomBytes } from "node:crypto";

import { getPrisma } from "../db/prisma";

/**
 * Short-lived OAuth authorization-attempt store (Section 11).
 *
 * This is the ONLY place `IntegrationOAuthState` rows are created and consumed.
 * A row exists purely to (a) give CSRF protection — the unguessable `state` we
 * send to the provider must come back unchanged — and (b) carry the PKCE
 * `codeVerifier` between the connect request and the provider's callback.
 *
 * Rows hold NO tokens. They are single-use: a successful callback marks the row
 * `consumed`, and a mismatched / expired / already-consumed state is rejected.
 */

/** How long a pending OAuth state stays valid before it must be restarted. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** A freshly created OAuth state (safe to expose the `state` + expiry only). */
export interface CreatedOAuthState {
  state: string;
  expiresAt: Date;
}

/** The server-only view of a consumed state (includes the PKCE verifier). */
export interface ConsumedOAuthState {
  userId: string;
  provider: string;
  redirectUri: string;
  scopes: string[];
  codeVerifier: string | null;
  /** Validated app deep-link to return to Hula, or null. Never trusted raw. */
  appReturnUrl: string | null;
}

/** Generate an unguessable, URL-safe state token. */
export function generateStateToken(): string {
  return randomBytes(32).toString("base64url");
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Create a pending OAuth state for a user starting a connect flow. Returns only
 * the `state` token and its expiry — never the PKCE verifier.
 */
export async function createOAuthState(input: {
  userId: string;
  provider: string;
  redirectUri: string;
  scopes: string[];
  codeVerifier: string | null;
  /** Pre-validated app return URL (already passed `isSafeAppReturnUrl`) or null. */
  appReturnUrl?: string | null;
}): Promise<CreatedOAuthState> {
  const state = generateStateToken();
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
  await getPrisma().integrationOAuthState.create({
    data: {
      userId: input.userId,
      provider: input.provider,
      state,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
      appReturnUrl: input.appReturnUrl ?? null,
      scopes: input.scopes,
      status: "pending",
      expiresAt,
    },
  });
  return { state, expiresAt };
}

/**
 * Atomically consume a pending OAuth state by its `state` token for a provider.
 *
 * Returns the server-only details (incl. the PKCE verifier) when the state is
 * valid — pending, not expired, and matching the provider. Returns `null` for a
 * missing / already-consumed / expired / provider-mismatched state. An expired
 * pending row is flipped to `expired` as a side effect. Single-use: a second call
 * with the same state returns `null`.
 */
export async function consumeOAuthState(
  state: string,
  provider: string,
): Promise<ConsumedOAuthState | null> {
  const prisma = getPrisma();
  const row = await prisma.integrationOAuthState.findUnique({ where: { state } });
  if (!row || row.provider !== provider || row.status !== "pending") return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    await prisma.integrationOAuthState.update({
      where: { id: row.id },
      data: { status: "expired" },
    });
    return null;
  }

  // Flip to consumed only if still pending — guards against a double callback.
  const claimed = await prisma.integrationOAuthState.updateMany({
    where: { id: row.id, status: "pending" },
    data: { status: "consumed", consumedAt: new Date() },
  });
  if (claimed.count === 0) return null;

  return {
    userId: row.userId,
    provider: row.provider,
    redirectUri: row.redirectUri,
    scopes: toStringArray(row.scopes),
    codeVerifier: row.codeVerifier,
    appReturnUrl: row.appReturnUrl ?? null,
  };
}
