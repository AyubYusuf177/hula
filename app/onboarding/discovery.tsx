import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  HulaBottomButton,
  HulaOnboardingFrame,
  HulaOptionCard,
} from '@/components/onboarding';
import { hula } from '@/constants/theme';
import {
  DISCOVERY_OPTIONS,
  getOnboardingStep,
  ONBOARDING_CTA,
  type DiscoverySourceId,
} from '@/data/hulaOnboarding';
import { getOnboardingAnswers, setOnboardingAnswer } from '@/lib/onboardingAnswers';

const step = getOnboardingStep('discovery');

/**
 * Onboarding page 6 — where the user found hula. Single-select; saves
 * `discoverySource` and advances to the location page.
 */
export default function OnboardingDiscovery() {
  const router = useRouter();
  const { userId } = useAuth();
  const [source, setSource] = useState<DiscoverySourceId | undefined>();

  useEffect(() => {
    getOnboardingAnswers(userId).then((a) => setSource(a.discoverySource));
  }, [userId]);

  const onContinue = async () => {
    if (!source) return;
    await setOnboardingAnswer(userId, { discoverySource: source });
    router.push('/onboarding/location');
  };

  return (
    <HulaOnboardingFrame
      progress={step.progress}
      onBack={() => router.back()}
      scroll
      showLogo
      title={step.title}
      footer={
        <HulaBottomButton
          label={ONBOARDING_CTA.discovery}
          onPress={onContinue}
          disabled={!source}
        />
      }
    >
      <View style={styles.options}>
        {DISCOVERY_OPTIONS.map((opt) => (
          <HulaOptionCard
            key={opt.id}
            label={opt.label}
            icon={opt.icon}
            selected={source === opt.id}
            showCheck={false}
            onPress={() => setSource(opt.id)}
          />
        ))}
      </View>
    </HulaOnboardingFrame>
  );
}

const styles = StyleSheet.create({
  options: {
    width: '100%',
    marginTop: hula.spacing.xl,
    gap: hula.spacing.md,
  },
});