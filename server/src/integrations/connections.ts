import type { Prisma } from "@prisma/client";

import { getPrisma } from "../db/prisma";
import { env } from "../config/env";
import {
  getProvider,
  isKnownProvider,
  listIntegrationCatalog,
  type ProviderAuthType,
  type ProviderCategory,
  type ProviderStatus,
} from "./catalog";

/**
 * DB-backed integration connection helpers (Section 10).
 *
 * These are the ONLY way the rest of the backend reads/writes integration
 * connection state. Every value returned from here is SAFE for the mobile app:
 * connection status, scopes, and audit metadata only — NEVER a token (tokens
 * live in `IntegrationCredential` and are handled solely by `tokenVault`, which
 * these helpers deliberately never join or return).
 *
 * No real provider is connected here, no provider API is called, and no data is
 * synced. `upsertIntegrationConnection` exists for the manual script/tests and
 * for future OAuth callbacks to write into — not for a live connect flow yet.
 */

/** Lifecycle status mirrored from the Prisma enum (kept local to avoid coupling). */
export type IntegrationConnectionStatusValue =
  | "disconnected"
  | "connected"
  | "expired"
  | "revoked"
  | "error";

/** A safe, app-facing view of one connection. Contains NO token material. */
export interface IntegrationConnectionView {
  provider: string;
  status: IntegrationConnectionStatusValue;
  displayName: string | null;
  providerAccountEmail: string | null;
  grantedScopes: string[];
  capabilities: string[];
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastSyncedAt: string | null;
  updatedAt: string;
}

/** Catalog metadata + the user's current connection status, merged. */
export interface IntegrationStatusItem {
  provider: string;
  displayName: string;
  category: ProviderCategory;
  catalogStatus: ProviderStatus;
  authType: ProviderAuthType;
  connectionStatus: IntegrationConnectionStatusValue;
  connected: boolean;
  providerAccountEmail: string | null;
  connectedAccountName: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  configured?: boolean;
}

/** Re-export so callers/endpoints have one import site for the catalog. */
export { listIntegrationCatalog };

/** Coerce a Prisma Json value we control into a clean string[]. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

const CONNECTION_SELECT = {
  provider: true,
  status: true,
  displayName: true,
  providerAccountEmail: true,
  grantedScopes: true,
  capabilities: true,
  connectedAt: true,
  disconnectedAt: true,
  lastSyncedAt: true,
  updatedAt: true,
} as const;

interface ConnectionRow {
  provider: string;
  status: IntegrationConnectionStatusValue;
  displayName: string | null;
  providerAccountEmail: string | null;
  grantedScopes: unknown;
  capabilities: unknown;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  lastSyncedAt: Date | null;
  updatedAt: Date;
}

function toConnectionView(row: ConnectionRow): IntegrationConnectionView {
  return {
    provider: row.provider,
    status: row.status,
    displayName: row.displayName,
    providerAccountEmail: row.providerAccountEmail,
    grantedScopes: toStringArray(row.grantedScopes),
    capabilities: toStringArray(row.capabilities),
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
    disconnectedAt: row.disconnectedAt ? row.disconnectedAt.toISOString() : null,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** List a user's stored integration connections (safe views, no tokens). */
export async function listUserIntegrationConnections(
  userId: string,
): Promise<IntegrationConnectionView[]> {
  const rows = await getPrisma().integrationConnection.findMany({
    where: { userId },
    orderBy: { provider: "asc" },
    select: CONNECTION_SELECT,
  });
  return rows.map((r) => toConnectionView(r as ConnectionRow));
}

/** Get one connection for a user+provider, or null. Safe view, no tokens. */
export async function getConnectionForUserProvider(
  userId: string,
  provider: string,
): Promise<IntegrationConnectionView | null> {
  const row = await getPrisma().integrationConnection.findUnique({
    where: { userId_provider: { userId, provider } },
    select: CONNECTION_SELECT,
  });
  return row ? toConnectionView(row as ConnectionRow) : null;
}

/**
 * Merge the provider catalog with the user's stored connections into one status
 * list. The internal `generic` stub provider is excluded from user-facing status.
 * Every entry defaults to `disconnected` when the user has no row for it.
 */
/**
 * Merge one catalog entry with the user's connection (if any) into the SAFE,
 * app-facing status item. Pure and side-effect free so it can be unit-tested:
 * it intentionally reads ONLY non-secret fields off the connection view, so no
 * token or credential material can ever reach this shape. See
 * `scripts/integrations.test.ts`.
 */
export function toIntegrationStatusItem(
  entry: {
    provider: string;
    displayName: string;
    category: ProviderCategory;
    status: ProviderStatus;
    authType: ProviderAuthType;
  },
  conn: IntegrationConnectionView | undefined,
  configured = true,
): IntegrationStatusItem {
  const status = conn?.status ?? "disconnected";
  return {
    provider: entry.provider,
    displayName: entry.displayName,
    category: entry.category,
    catalogStatus: entry.status,
    authType: entry.authType,
    connectionStatus: status,
    connected: status === "connected",
    providerAccountEmail: conn?.providerAccountEmail ?? null,
    connectedAccountName: conn?.displayName ?? null,
    connectedAt: conn?.connectedAt ?? null,
    lastSyncedAt: conn?.lastSyncedAt ?? null,
    ...(configured ? {} : { configured: false }),
  };
}

export async function getUserIntegrationStatus(
  userId: string,
): Promise<IntegrationStatusItem[]> {
  const connections = await listUserIntegrationConnections(userId);
  const byProvider = new Map(connections.map((c) => [c.provider, c]));

  return listIntegrationCatalog()
    .filter((entry) => entry.provider !== "generic")
    .map((entry) => {
      const configured = entry.provider === "notion"
        ? Boolean(
            env.NOTION_OAUTH_CLIENT_ID && env.NOTION_OAUTH_CLIENT_SECRET &&
            env.NOTION_OAUTH_REDIRECT_URI && env.NOTION_API_VERSION &&
            env.INTEGRATION_TOKEN_ENCRYPTION_KEY,
          )
        : entry.provider === "slack"
          ? Boolean(
              env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET &&
              env.SLACK_REDIRECT_URI && env.INTEGRATION_TOKEN_ENCRYPTION_KEY,
            )
          : entry.provider === "google_drive"
            ? Boolean(
                env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET &&
                env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI &&
                env.INTEGRATION_TOKEN_ENCRYPTION_KEY,
              )
            : true;
      return toIntegrationStatusItem(entry,byProvider.get(entry.provider),configured);
    });
}

/** Connected provider DISPLAY names only — safe, for optional brain context. */
export async function listConnectedProviderNames(
  userId: string,
): Promise<string[]> {
  const status = await getUserIntegrationStatus(userId);
  return status.filter((s) => s.connected).map((s) => s.displayName);
}

/** Fields an upsert may set. `provider` must be a known catalog slug. */
export interface UpsertConnectionInput {
  provider: string;
  status?: IntegrationConnectionStatusValue;
  providerAccountId?: string | null;
  providerAccountEmail?: string | null;
  displayName?: string | null;
  grantedScopes?: string[];
  requestedScopes?: string[];
  capabilities?: string[];
}

/**
 * Create or update a user's connection for a provider. When moving to
 * `connected`, stamps `connectedAt`. Rejects unknown providers. This never
 * writes tokens — credential storage is handled separately by the token vault.
 */
export async function upsertIntegrationConnection(
  userId: string,
  input: UpsertConnectionInput,
): Promise<IntegrationConnectionView> {
  if (!isKnownProvider(input.provider)) {
    throw new Error(`unknown_provider:${input.provider}`);
  }
  const status = input.status ?? "connected";
  const nowConnected = status === "connected";

  const data = {
    status,
    providerAccountId: input.providerAccountId ?? null,
    providerAccountEmail: input.providerAccountEmail ?? null,
    displayName: input.displayName ?? getProvider(input.provider)?.displayName ?? null,
    grantedScopes: input.grantedScopes ?? undefined,
    requestedScopes: input.requestedScopes ?? undefined,
    capabilities: input.capabilities ?? undefined,
    connectedAt: nowConnected ? new Date() : null,
    disconnectedAt: null,
  };

  const row = await getPrisma().integrationConnection.upsert({
    where: { userId_provider: { userId, provider: input.provider } },
    create: { userId, provider: input.provider, ...data },
    update: data,
    select: CONNECTION_SELECT,
  });
  return toConnectionView(row as ConnectionRow);
}

/**
 * Mark a user's connection `disconnected` and deactivate any stored credential.
 * Audit rows (events, action logs) are intentionally PRESERVED. Returns true if
 * a connection row was updated. Never deletes history.
 */
export async function disconnectIntegrationConnection(
  userId: string,
  provider: string,
): Promise<boolean> {
  const prisma = getPrisma();
  const existing = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { id: true },
  });
  if (!existing) return false;

  await prisma.integrationConnection.update({
    where: { id: existing.id },
    data: { status: "disconnected", disconnectedAt: new Date(), connectedAt: null },
  });

  // Clear encrypted token material (does not delete the audit trail).
  await prisma.integrationCredential.deleteMany({
    where: { connectionId: existing.id },
  });

  return true;
}

/** Record a safe, redacted integration event (audit). Returns the new row id. */
export async function recordIntegrationEvent(input: {
  userId: string;
  provider: string;
  eventType: string;
  connectionId?: string | null;
  resourceType?: string | null;
  providerEventId?: string | null;
  safeSummary?: Record<string, unknown> | null;
}): Promise<string> {
  const row = await getPrisma().integrationEvent.create({
    data: {
      userId: input.userId,
      provider: input.provider,
      eventType: input.eventType,
      connectionId: input.connectionId ?? null,
      resourceType: input.resourceType ?? null,
      providerEventId: input.providerEventId ?? null,
      safeSummaryJson: (input.safeSummary ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
    },
    select: { id: true },
  });
  return row.id;
}

/** Record a safe, redacted integration action attempt (audit). Returns row id. */
export async function recordIntegrationAction(input: {
  userId: string;
  provider: string;
  actionType: string;
  status: string;
  connectionId?: string | null;
  requestSummary?: Record<string, unknown> | null;
  resultSummary?: Record<string, unknown> | null;
  errorMessage?: string | null;
}): Promise<string> {
  const row = await getPrisma().integrationActionLog.create({
    data: {
      userId: input.userId,
      provider: input.provider,
      actionType: input.actionType,
      status: input.status,
      connectionId: input.connectionId ?? null,
      requestSummaryJson: (input.requestSummary ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
      resultSummaryJson: (input.resultSummary ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
      errorMessage: input.errorMessage ?? null,
    },
    select: { id: true },
  });
  return row.id;
}
