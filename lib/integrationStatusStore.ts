/**
 * Disk persistence + prefetch for the integration status cache (Integrations V2).
 *
 * The thin AsyncStorage/network layer on top of the pure, in-memory
 * `integrationStatusCache`. Kept separate so the pure cache stays testable
 * without a React Native runtime. Everything here is best-effort: a failure
 * NEVER clears valid cached state and NEVER manufactures a "disconnected"
 * result — the backend remains the source of truth, the cache only makes the
 * last known truth appear instantly.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { fetchUserIntegrations, type IntegrationStatus } from './hulaApi';
import {
  getIntegrationStatusCacheKey,
  getMemoryStatuses,
  sanitizeCachedStatuses,
  setMemoryStatuses,
} from './integrationStatusCache';

/**
 * Return the cached status for `userId`, preferring the in-memory copy and
 * falling back to AsyncStorage (which then warms memory). Returns null when
 * there is no user id, nothing stored, or the stored data is malformed.
 */
export async function loadCachedStatuses(
  userId: string | null | undefined,
): Promise<IntegrationStatus[] | null> {
  if (!userId) return null;

  const mem = getMemoryStatuses(userId);
  if (mem) return mem;

  try {
    const raw = await AsyncStorage.getItem(getIntegrationStatusCacheKey(userId));
    if (!raw) return null;
    const clean = sanitizeCachedStatuses(JSON.parse(raw));
    if (clean) setMemoryStatuses(userId, clean);
    return clean;
  } catch {
    // A read/parse failure keeps whatever is in memory; never throws upward.
    return null;
  }
}

/**
 * Persist a freshly fetched status list to memory + disk for `userId`. Called
 * only after a SUCCESSFUL backend read (or an optimistic local update), so the
 * cache only ever holds real, last-known-good truth.
 */
export async function persistStatuses(
  userId: string | null | undefined,
  statuses: IntegrationStatus[],
): Promise<void> {
  if (!userId) return;
  setMemoryStatuses(userId, statuses);
  try {
    await AsyncStorage.setItem(
      getIntegrationStatusCacheKey(userId),
      JSON.stringify(statuses),
    );
  } catch {
    // Non-fatal: the in-memory copy is still updated for this session.
  }
}

/**
 * Best-effort prefetch: read backend status and warm the cache. Used by Home so
 * the status is normally already available by the time Integrations opens.
 * A failure is swallowed and leaves any existing cache untouched.
 */
export async function prefetchIntegrationStatus(
  token: string | null | undefined,
  userId: string | null | undefined,
): Promise<void> {
  if (!token || !userId) return;
  try {
    const all = await fetchUserIntegrations(token);
    await persistStatuses(userId, all);
  } catch {
    // Keep the last known state on any network/ngrok failure.
  }
}
