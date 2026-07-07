import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { HulaBottomButton, HulaOnboardingFrame } from '@/components/onboarding';
import { hula } from '@/constants/theme';
import {
  clearOnboardingAnswers,
  getOnboardingAnswers,
  type OnboardingAnswers,
} from '@/lib/onboardingAnswers';

const font = hula.typography.fontFamily;
const DANGER = '#FF7A90';

/**
 * Temporary end of Section 1. This is a TESTING endpoint only — it does NOT
 * mark onboarding complete and does NOT route to /home. Later sections will
 * continue from here. In dev it shows the locally-saved answers so the flow can
 * be verified end-to-end.
 *
 * Layout: the body (incl. the dev JSON readout) scrolls; the bottom actions live
 * in the pinned frame footer so they never overlap the JSON on small screens.
 *
 * Action hierarchy:
 * - "Continue later"            → stays put (no-op). Routing to `/` would bounce
 *   a signed-in, not-yet-complete user back to the start of onboarding.
 * - "Sign out"                  → Clerk signOut() then back to the signed-out
 *   hero/auth flow (how testers reset Expo Go, since the session stays active).
 * - "Clear answers & restart"   → dev-only reset of onboarding_answers.
 */
export default function OnboardingSectionComplete() {
  const router = useRouter();
  const { userId, signOut } = useAuth();

  const onSignOut = async () => {
    try {
      await signOut();
    } finally {
      router.replace('/');
    }
  };

  const onReset = async () => {
    await clearOnboardingAnswers(userId);
    router.replace('/onboarding/legal');
  };

  return (
    <HulaOnboardingFrame
      progress={1}
      showLogo
      scroll
      title="Section 1 complete"
      subtitle="Your onboarding answers have been saved locally for this test build."
      footer={
        <View style={styles.actions}>
          <HulaBottomButton label="Continue later" onPress={() => {}} />
          <Pressable
            onPress={onSignOut}
            hitSlop={8}
            style={({ pressed }) => [styles.signOutBtn, pressed && styles.pressed]}
          >
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
          {__DEV__ ? (
            <Pressable
              onPress={onReset}
              hitSlop={8}
              style={({ pressed }) => [styles.resetBtn, pressed && styles.pressed]}
            >
              <Text style={styles.resetText}>Clear answers & restart flow</Text>
            </Pressable>
          ) : null}
        </View>
      }
    >
      {__DEV__ ? <AnswersDebug userId={userId} /> : null}
    </HulaOnboardingFrame>
  );
}

/** Dev-only readout of the saved answers. Scrolls with the page body. */
function AnswersDebug({ userId }: { userId: string | null | undefined }) {
  const [answers, setAnswers] = useState<OnboardingAnswers | null>(null);

  const refresh = useCallback(async () => {
    setAnswers(await getOnboardingAnswers(userId));
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <View style={styles.debug}>
      <Text style={styles.debugTitle}>DEBUG · onboarding_answers:{userId ?? '(none)'}</Text>
      <Text style={styles.debugJson}>{JSON.stringify(answers ?? {}, null, 2)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    width: '100%',
    gap: hula.spacing.md,
  },
  signOutBtn: {
    height: 52,
    borderRadius: hula.radius.pill,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    backgroundColor: hula.glass.tile,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signOutText: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.hint.fontSize,
    color: hula.colors.text.primary,
  },
  resetBtn: {
    alignSelf: 'center',
    paddingVertical: hula.spacing.sm,
    paddingHorizontal: hula.spacing.lg,
  },
  resetText: {
    fontFamily: font.medium,
    fontSize: hula.typography.legal.fontSize,
    color: DANGER,
  },
  pressed: {
    opacity: 0.7,
  },
  debug: {
    width: '100%',
    marginTop: hula.spacing['2xl'],
    padding: hula.spacing.lg,
    borderRadius: hula.radius.card,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    backgroundColor: hula.glass.tile,
  },
  debugTitle: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.legal.fontSize,
    color: hula.colors.text.tertiary,
    marginBottom: hula.spacing.sm,
  },
  debugJson: {
    fontFamily: font.regular,
    fontSize: hula.typography.legal.fontSize,
    lineHeight: hula.typography.legal.lineHeight,
    color: hula.colors.text.secondary,
  },
});
