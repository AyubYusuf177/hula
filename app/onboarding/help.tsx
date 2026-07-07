import { useAuth } from '@clerk/clerk-expo';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
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
  getOnboardingStep,
  HELP_OPTIONS,
  ONBOARDING_CTA,
  type HelpOptionId,
} from '@/data/hulaOnboarding';
import { getOnboardingAnswers, setOnboardingAnswer } from '@/lib/onboardingAnswers';

const step = getOnboardingStep('help');

/**
 * Onboarding page 5 — what hula should help with. Multi-select; saves
 * `helpMost` as an array of option ids and advances to the discovery page.
 */
export default function OnboardingHelp() {
  const router = useRouter();
  const { userId } = useAuth();
  const [selected, setSelected] = useState<HelpOptionId[]>([]);

  useEffect(() => {
    getOnboardingAnswers(userId).then((a) => {
      if (a.helpMost) setSelected(a.helpMost);
    });
  }, [userId]);

  const toggle = (id: HelpOptionId) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const onContinue = async () => {
    await setOnboardingAnswer(userId, { helpMost: selected });
    router.push('/onboarding/discovery');
  };

  return (
    <HulaOnboardingFrame
      progress={step.progress}
      onBack={() => router.back()}
      scroll
      topMedia={
        <MaterialCommunityIcons
          name="bullseye-arrow"
          size={46}
          color={hula.colors.text.primary}
        />
      }
      title={step.title}
      subtitle={step.subtitle}
      footer={
        <HulaBottomButton
          label={ONBOARDING_CTA.help}
          onPress={onContinue}
          disabled={selected.length === 0}
        />
      }
    >
      <View style={styles.options}>
        {HELP_OPTIONS.map((opt) => (
          <HulaOptionCard
            key={opt.id}
            label={opt.label}
            icon={opt.icon}
            selected={selected.includes(opt.id)}
            onPress={() => toggle(opt.id)}
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