import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { HulaBottomButton, HulaOnboardingFrame } from '@/components/onboarding';
import { hula } from '@/constants/theme';
import { setOnboardingComplete, setOnboardingStage } from '@/lib/onboarding';
import { setOnboardingAnswer } from '@/lib/onboardingAnswers';
import { startHulaPreview, type HulaPreviewType } from '@/lib/hulaPreview';

const font = hula.typography.fontFamily;

/**
 * Section 2 — free access choice. This is the ONLY screen in the Section 2 flow
 * that marks onboarding complete.
 *
 * Either option starts a local access window (24h preview or 7d trial), records
 * the plan intent, flips the stage to `preview_active`, sets
 * `onboarding_complete`, and lands the user on /home. No card, no real payment.
 */
export default function OnboardingFreePreview() {
  const router = useRouter();
  const { userId } = useAuth();
  const [busy, setBusy] = useState<HulaPreviewType | null>(null);

  useEffect(() => {
    setOnboardingStage(userId, 'free_preview');
  }, [userId]);

  const start = async (type: HulaPreviewType) => {
    if (busy) return;
    setBusy(type);
    const intent = type; // planIntent shares the preview_24h / trial_7d values.
    await setOnboardingAnswer(userId, { planIntent: intent });
    await startHulaPreview(userId, type);
    await setOnboardingStage(userId, 'preview_active');
    if (userId) await setOnboardingComplete(userId);
    router.replace('/home');
  };

  return (
    <HulaOnboardingFrame
      progress={1}
      onBack={() => router.back()}
      showLogo
      title="Try hula free"
      subtitle="Get 24 hours of full access before deciding — no card required."
      footer={
        <View style={styles.actions}>
          <HulaBottomButton
            label="Start 24 hour preview"
            onPress={() => start('preview_24h')}
            loading={busy === 'preview_24h'}
            disabled={busy !== null}
          />
          <Pressable
            onPress={() => start('trial_7d')}
            hitSlop={8}
            disabled={busy !== null}
            style={({ pressed }) => [styles.trialBtn, pressed && styles.pressed]}
          >
            <Text style={styles.trialText}>Start 1 week free trial</Text>
          </Pressable>
        </View>
      }
    >
      <View style={styles.spacer} />
    </HulaOnboardingFrame>
  );
}

const styles = StyleSheet.create({
  spacer: {
    flex: 1,
  },
  actions: {
    width: '100%',
    gap: hula.spacing.lg,
  },
  trialBtn: {
    alignSelf: 'center',
    paddingVertical: hula.spacing.sm,
    paddingHorizontal: hula.spacing.lg,
  },
  trialText: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.hint.fontSize,
    color: hula.glow.purpleBright,
  },
  pressed: {
    opacity: 0.7,
  },
});
