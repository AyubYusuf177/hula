import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { HulaOptionCard } from '@/components/onboarding';
import { SettingsEditFrame } from '@/components/settings/SettingsEditFrame';
import { hula } from '@/constants/theme';
import { TONE_OPTIONS, type ToneValue } from '@/data/hulaOnboarding';
import { getOnboardingAnswers, setOnboardingAnswer } from '@/lib/onboardingAnswers';

/** Settings → Tone of Voice. Single-select from the shared onboarding options. */
export default function EditTone() {
  const router = useRouter();
  const { userId } = useAuth();

  const [selected, setSelected] = useState<ToneValue | undefined>(undefined);

  useEffect(() => {
    getOnboardingAnswers(userId).then((a) => setSelected(a.tone));
  }, [userId]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  };

  const onSave = async () => {
    if (selected) await setOnboardingAnswer(userId, { tone: selected });
    goBack();
  };

  return (
    <SettingsEditFrame title="Tone of Voice" onBack={goBack} onSave={onSave} saveDisabled={!selected}>
      <View style={styles.list}>
        {TONE_OPTIONS.map((opt) => (
          <HulaOptionCard
            key={opt.value}
            label={opt.label}
            selected={selected === opt.value}
            onPress={() => setSelected(opt.value)}
          />
        ))}
      </View>
    </SettingsEditFrame>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: hula.spacing.md,
  },
});
