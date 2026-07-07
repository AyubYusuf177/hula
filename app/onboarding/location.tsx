import { useAuth } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import { HulaBottomButton, HulaOnboardingFrame } from '@/components/onboarding';
import { hula } from '@/constants/theme';
import { getOnboardingStep, ONBOARDING_CTA } from '@/data/hulaOnboarding';
import {
  setOnboardingAnswer,
  type LocationPermissionStatus,
} from '@/lib/onboardingAnswers';

const font = hula.typography.fontFamily;
const step = getOnboardingStep('location');

/**
 * Onboarding page 7 — location access.
 *
 * MVP placeholder: it does NOT request a real OS permission. "Allow Location"
 * records `allowed_placeholder` and "Skip" records `skipped`; both advance to
 * the feedback page.
 */
export default function OnboardingLocation() {
  const router = useRouter();
  const { userId } = useAuth();

  const finish = async (status: LocationPermissionStatus) => {
    await setOnboardingAnswer(userId, { locationPermissionStatus: status });
    router.push('/onboarding/feedback');
  };

  return (
    <HulaOnboardingFrame
      progress={step.progress}
      onBack={() => router.back()}
      onSkip={() => finish('skipped')}
      topMedia={
        <Ionicons name="navigate" size={46} color={hula.colors.text.primary} />
      }
      title={step.title}
      subtitle={step.subtitle}
      footer={
        <HulaBottomButton
          label={ONBOARDING_CTA.location}
          onPress={() => finish('allowed_placeholder')}
        />
      }
    >
      <Text style={styles.body}>
        We request “Always” access so hula’s messages stay accurate when you’re on
        the move.
      </Text>
    </HulaOnboardingFrame>
  );
}

const styles = StyleSheet.create({
  body: {
    marginTop: hula.spacing.xl,
    fontFamily: font.regular,
    fontSize: hula.typography.hint.fontSize,
    lineHeight: 23,
    color: hula.colors.text.tertiary,
    textAlign: 'center',
    paddingHorizontal: hula.spacing.md,
  },
});