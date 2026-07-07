import { useAuth } from '@clerk/clerk-expo';
import { Redirect, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { HulaOnboarding } from '@/components/onboarding';
import { hula } from '@/constants/theme';
import {
  getOnboardingComplete,
  getOnboardingStage,
  type OnboardingStage,
} from '@/lib/onboarding';

/**
 * Auth-aware entry gate.
 *
 * - signed out                        → the Hula launch/auth experience
 * - signed in + onboarding complete   → /home
 * - signed in + a saved stage         → the matching Section 2 screen
 * - signed in + nothing saved         → /onboarding/legal
 *
 * Both flags are scoped to the current Clerk `userId`, so a deleted-then-
 * recreated account (new userId) is correctly treated as new. The stage lets a
 * user who reached, say, "what happens next" sign out and back in and resume
 * there rather than restarting the questions.
 *
 * While Clerk is resolving the session (or we are reading the local flags) we
 * render a plain void-black view so there is no flash before routing.
 */
export default function Index() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const [route, setRoute] = useState<{ complete: boolean; stage: OnboardingStage | null } | null>(
    null,
  );

  useEffect(() => {
    // Only decide once Clerk has resolved a signed-in user with a real userId.
    if (!isSignedIn || !userId) {
      setRoute(null);
      return;
    }
    let active = true;
    setRoute(null);
    Promise.all([getOnboardingComplete(userId), getOnboardingStage(userId)]).then(
      ([complete, stage]) => {
        if (active) setRoute({ complete, stage });
      },
    );
    return () => {
      active = false;
    };
  }, [isSignedIn, userId]);

  // Waiting on Clerk, or on the local flags for a signed-in user.
  if (!isLoaded || (isSignedIn && (!userId || route === null))) {
    return <View style={{ flex: 1, backgroundColor: hula.colors.voidBlack }} />;
  }

  if (isSignedIn && route) {
    return <Redirect href={resolveOnboardingHref(route.complete, route.stage)} />;
  }

  return <HulaOnboarding />;
}

/** Maps the local onboarding state to the screen a signed-in user should land on. */
function resolveOnboardingHref(complete: boolean, stage: OnboardingStage | null): Href {
  // Completion always wins — a finished user goes straight home.
  if (complete) return '/home';

  switch (stage) {
    case 'checking_subscription':
      return '/onboarding/checking-subscription';
    case 'all_set':
      return '/onboarding/all-set';
    case 'what_happens_next':
      return '/onboarding/what-happens-next';
    case 'paywall':
      return '/onboarding/paywall';
    case 'free_preview':
      return '/onboarding/free-preview';
    case 'preview_active':
    case 'complete':
      // These stages imply the flow finished; treat like a completed user.
      return '/home';
    default:
      // No stage (or still answering questions) → start of the flow.
      return '/onboarding/legal';
  }
}
