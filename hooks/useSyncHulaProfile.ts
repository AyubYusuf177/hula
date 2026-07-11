import { useAuth, useUser } from '@clerk/clerk-expo';
import { useEffect } from 'react';

import { syncMyProfile } from '@/lib/hulaApi';
import { getHulaProfile } from '@/lib/hulaProfile';
import { resolveFirstName } from '@/lib/hulaUser';
import {
  buildProfileSyncPayload,
  hasSyncableFields,
  type ProfileSyncPayload,
} from '@/lib/hulaProfileSync';
import { getOnboardingAnswers } from '@/lib/onboardingAnswers';

/**
 * Silent, best-effort profile sync (Section 7).
 *
 * When a signed-in user opens Home, we quietly read their local onboarding
 * answers + display-name override, build a SAFE payload, and PUT it to the
 * backend so the Hula brain can be a little more personal in iMessage. There is
 * deliberately NO visible UI, popup, button, loading state, or user action — if
 * anything fails the app just carries on.
 *
 * A per-user, in-memory guard remembers the last payload that synced this
 * session, so re-renders and Home re-focuses don't spam the backend; a network
 * call only happens when the built payload actually changes.
 */

/** Last successfully-synced payload signature, keyed by Clerk user id. */
const lastSyncedByUser = new Map<string, string>();
/** Users with a sync currently in flight (avoids overlapping requests). */
const inFlight = new Set<string>();

/** Read the device timezone/locale/country via Intl, tolerating absence. */
function readDeviceLocale(): { timezone?: string; locale?: string; country?: string } {
  try {
    const opts = Intl.DateTimeFormat().resolvedOptions();
    const locale = opts.locale || undefined;
    // Derive a country from a region-tagged locale like "en-GB" → "GB".
    const region = locale?.split('-')[1];
    const country = region && region.length === 2 ? region.toUpperCase() : undefined;
    return { timezone: opts.timeZone || undefined, locale, country };
  } catch {
    return {};
  }
}

/**
 * Trigger the silent sync for the signed-in user. Runs once per meaningful
 * data change; never blocks rendering and swallows all errors (dev-only warn).
 */
export function useSyncHulaProfile(): void {
  const { userId, isSignedIn, getToken } = useAuth();
  const { user } = useUser();

  useEffect(() => {
    if (!isSignedIn || !userId) return;

    let cancelled = false;

    async function run(): Promise<void> {
      if (!userId || inFlight.has(userId)) return;

      const [answers, profile] = await Promise.all([
        getOnboardingAnswers(userId),
        getHulaProfile(userId),
      ]);
      if (cancelled) return;

      const device = readDeviceLocale();
      const payload: ProfileSyncPayload = buildProfileSyncPayload({
        answers,
        displayName: profile.displayName,
        firstName: resolveFirstName(user, profile.displayName),
        timezone: device.timezone,
        locale: device.locale,
        country: device.country,
      });

      // Nothing worth syncing yet (e.g. onboarding barely started).
      if (!hasSyncableFields(payload)) return;

      // Skip if this exact payload already synced this session.
      const signature = JSON.stringify(payload);
      if (lastSyncedByUser.get(userId) === signature) return;

      const token = await getToken();
      if (cancelled || !token) return;

      inFlight.add(userId);
      try {
        await syncMyProfile(token, payload);
        lastSyncedByUser.set(userId, signature);
      } catch (err) {
        // Best-effort: never surface anything to the user.
        if (__DEV__) console.warn('[useSyncHulaProfile] sync failed:', err);
      } finally {
        inFlight.delete(userId);
      }
    }

    // Fire and forget — this must never block Home.
    void run();

    return () => {
      cancelled = true;
    };
  }, [userId, isSignedIn, getToken, user]);
}
