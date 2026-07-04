import { useAuth } from '@clerk/clerk-expo';
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { HulaOnboarding } from '@/components/onboarding';
import { hula } from '@/constants/theme';
import { getOnboardingComplete } from '@/lib/onboarding';

/**
 * Auth-aware entry gate.
 *
 * - signed out                        → the Hula launch/auth experience
 * - signed in + onboarding incomplete → /onboarding/legal
 * - signed in + onboarding complete   → /home
 *
 * The onboarding flag is scoped to the current Clerk `userId`, so a
 * deleted-then-recreated account (new userId) is correctly treated as new.
 *
 * While Clerk is resolving the session (or we are reading the local onboarding
 * flag) we render a plain void-black view so there is no flash before routing.
 */
export default function Index() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);

  useEffect(() => {
    // Only decide once Clerk has resolved a signed-in user with a real userId.
    if (!isSignedIn || !userId) {
      setOnboardingComplete(null);
      return;
    }
    let active = true;
    setOnboardingComplete(null);
    getOnboardingComplete(userId).then((complete) => {
      if (active) setOnboardingComplete(complete);
    });
    return () => {
      active = false;
    };
  }, [isSignedIn, userId]);

  // Waiting on Clerk, or on the onboarding flag for a signed-in user.
  if (!isLoaded || (isSignedIn && (!userId || onboardingComplete === null))) {
    return <View style={{ flex: 1, backgroundColor: hula.colors.voidBlack }} />;
  }

  if (isSignedIn) {
    return <Redirect href={onboardingComplete ? '/home' : '/onboarding/legal'} />;
  }

  return <HulaOnboarding />;
}
