import { useAuth } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  HulaBottomButton,
  HulaLogoTile,
  HulaOnboardingFrame,
  HulaOptionCard,
} from '@/components/onboarding';
import { hula } from '@/constants/theme';
import {
  getOnboardingStep,
  ONBOARDING_CTA,
  SEX_OPTIONS,
  type SexValue,
} from '@/data/hulaOnboarding';
import { getOnboardingAnswers, setOnboardingAnswer } from '@/lib/onboardingAnswers';

const step = getOnboardingStep('sex');

/** Onboarding page 2 — sex. Saves `sex` and advances to the age page. */
export default function OnboardingSex() {
  const router = useRouter();
  const { userId } = useAuth();
  const [sex, setSex] = useState<SexValue | undefined>();

  useEffect(() => {
    getOnboardingAnswers(userId).then((a) => setSex(a.sex));
  }, [userId]);

  const onContinue = async () => {
    if (!sex) return;
    await setOnboardingAnswer(userId, { sex });
    router.push('/onboarding/age');
  };

  return (
    <HulaOnboardingFrame
      progress={step.progress}
      onBack={() => router.back()}
      topMedia={
        <View style={styles.media}>
          <HulaLogoTile />
          <Ionicons
            name="man"
            size={44}
            color={hula.colors.text.primary}
            style={styles.glyph}
          />
        </View>
      }
      title={step.title}
      subtitle={step.subtitle}
      footer={
        <HulaBottomButton label={ONBOARDING_CTA.sex} onPress={onContinue} disabled={!sex} />
      }
    >
      <View style={styles.options}>
        {SEX_OPTIONS.map((opt) => (
          <HulaOptionCard
            key={opt.value}
            label={opt.label}
            selected={sex === opt.value}
            onPress={() => setSex(opt.value)}
          />
        ))}
      </View>
    </HulaOnboardingFrame>
  );
}

const styles = StyleSheet.create({
  media: {
    alignItems: 'center',
  },
  glyph: {
    marginTop: hula.spacing.xl,
  },
  options: {
    width: '100%',
    marginTop: hula.spacing.xl,
    gap: hula.spacing.lg,
  },
});