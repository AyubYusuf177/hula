import { useAuth } from '@clerk/clerk-expo';
import { useEffect, useRef } from 'react';

import { prefetchIntegrationStatus } from '@/lib/integrationStatusStore';

/**
 * Warm the shared integration-status cache once Clerk has resolved a signed-in
 * user, so opening the Integrations screen renders instantly from cache instead
 * of showing a ~2s skeleton while `GET /v1/me/integrations` resolves.
 *
 * Best-effort and non-blocking: it never gates navigation and never surfaces an
 * error. Runs once per user per mount (guarded so Clerk handing back a new
 * `getToken` each render can't cause repeat fetches). Intended for the
 * authenticated app shell / Home screen.
 */
export function useIntegrationStatusPrefetch(): void {
  const { getToken, userId, isLoaded, isSignedIn } = useAuth();

  // Keep the latest getToken without depending on its (unstable) identity.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const prefetchedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    if (prefetchedFor.current === userId) return;
    prefetchedFor.current = userId;

    (async () => {
      const token = await getTokenRef.current();
      await prefetchIntegrationStatus(token, userId);
    })().catch(() => {
      // Best-effort: allow a later attempt for this user if the token failed.
      if (prefetchedFor.current === userId) prefetchedFor.current = null;
    });
  }, [isLoaded, isSignedIn, userId]);
}
