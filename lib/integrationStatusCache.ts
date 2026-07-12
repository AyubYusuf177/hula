/**
 * Shared, user-scoped cache of integration status (Integrations V2).
 *
 * PURE + in-memory only — deliberately free of AsyncStorage/React so it is
 * trivially testable and safe to import anywhere. Disk persistence + prefetch
 * live in `integrationStatusStore.ts`, which builds on these helpers.
 *
 * The in-memory record is a module singleton, so the latest status survives
 * navigating away from and back to the Integrations screen within one app
 * session — returning renders instantly with no skeleton. It is ALWAYS scoped to
 * one Clerk user id; a different (or missing) user id can never read it.
 */

import type { IntegrationStatus } from './hulaApi';

/** Versioned cache key namespace (bump the suffix to invalidate old shapes). */
const CACHE_VERSION = 'integration_status_v1';

/** The AsyncStorage key holding one user's cached integration status. */
export function getIntegrationStatusCacheKey(userId: string): string {
  return `${CACHE_VERSION}:${userId}`;
}

/** The latest status for exactly one user. Null until the first successful read. */
let memory: { userId: string; statuses: IntegrationStatus[] } | null = null;

/**
 * The cached status for `userId`, or null when nothing is cached for THIS user.
 * Returns null for a missing user id or when the cache belongs to another user —
 * one Clerk user can never see another's cached status.
 */
export function getMemoryStatuses(
  userId: string | null | undefined,
): IntegrationStatus[] | null {
  if (!userId || !memory || memory.userId !== userId) return null;
  return memory.statuses;
}

/** Replace the in-memory cache for `userId` (a no-op without a user id). */
export function setMemoryStatuses(
  userId: string | null | undefined,
  statuses: IntegrationStatus[],
): void {
  if (!userId) return;
  memory = { userId, statuses };
}

/** Drop the in-memory cache entirely (used by tests and hard resets). */
export function clearMemoryStatuses(): void {
  memory = null;
}

/** True when a value is a safe, minimally-shaped integration status. */
function isStatusLike(v: unknown): v is IntegrationStatus {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.provider === 'string' &&
    typeof s.connectionStatus === 'string' &&
    typeof s.connected === 'boolean'
  );
}

/**
 * Parse/validate cached JSON into a clean status array. Returns:
 *  - a clean array (possibly empty — an empty backend result is valid truth),
 *  - or null when the data is missing/malformed.
 * Never throws and never returns junk, so a corrupted cache is simply ignored.
 */
export function sanitizeCachedStatuses(raw: unknown): IntegrationStatus[] | null {
  if (!Array.isArray(raw)) return null;
  const clean = raw.filter(isStatusLike);
  // A legit empty list stays []; a non-empty list that yields nothing usable is
  // treated as corrupt (null) rather than silently rendered as "all disconnected".
  if (clean.length === 0 && raw.length > 0) return null;
  return clean;
}

/**
 * Optimistic, PURE update: flip exactly ONE provider to disconnected, leaving
 * every other provider's status untouched. Used so a disconnect reflects
 * immediately in the cache before the confirming backend refresh lands.
 */
export function markProviderDisconnected(
  statuses: IntegrationStatus[],
  provider: string,
): IntegrationStatus[] {
  return statuses.map((s) =>
    s.provider === provider
      ? {
          ...s,
          connectionStatus: 'disconnected',
          connected: false,
          providerAccountEmail: null,
          connectedAt: null,
        }
      : s,
  );
}
