import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { HulaLogoTile, HulaOnboardingFrame } from '@/components/onboarding';
import { hula } from '@/constants/theme';
import { setOnboardingStage } from '@/lib/onboarding';

const font = hula.typography.fontFamily;

/** How long the fake subscription check lingers before advancing. */
const CHECK_DELAY_MS = 1500;

/**
 * Section 2 bridge — a fake "checking subscription status" gate.
 *
 * There is NO real billing check yet. On mount we (re)assert the
 * `checking_subscription` stage, wait ~1.5s so the spinner reads as real work,
 * then advance the stage to `all_set` and replace to that screen. The frame's
 * mount fade handles the subtle text fade-in.
 */
export default function OnboardingCheckingSubscription() {
  const router = useRouter();
  const { userId } = useAuth();

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      await setOnboardingStage(userId, 'checking_subscription');
      timer = setTimeout(async () => {
        await setOnboardingStage(userId, 'all_set');
        if (active) router.replace('/onboarding/all-set');
      }, CHECK_DELAY_MS);
    })();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [userId, router]);

  return (
    <HulaOnboardingFrame progress={0.55} onBack={() => router.back()}>
      <View style={styles.center}>
        <HulaLogoTile size={120} />
        <ActivityIndicator
          size="large"
          color={hula.glow.purpleBright}
          style={styles.spinner}
        />
        <Text style={styles.status}>Checking subscription status...</Text>
      </View>
    </HulaOnboardingFrame>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinner: {
    marginTop: hula.spacing['3xl'],
  },
  status: {
    marginTop: hula.spacing.xl,
    fontFamily: font.medium,
    fontSize: hula.typography.hint.fontSize,
    color: hula.colors.text.secondary,
    textAlign: 'center',
  },
});
