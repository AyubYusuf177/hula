import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { HulaOptionCard } from '@/components/onboarding';
import { SettingsEditFrame } from '@/components/settings/SettingsEditFrame';
import { hula } from '@/constants/theme';
import { HELP_OPTIONS, type HelpOptionId } from '@/data/hulaOnboarding';
import { getOnboardingAnswers, setOnboardingAnswer } from '@/lib/onboardingAnswers';

/** Settings → What hula helps with. Multi-select from the shared onboarding options. */
export default function EditHelp() {
  const router = useRouter();
  const { userId } = useAuth();

  const [selected, setSelected] = useState<HelpOptionId[]>([]);

  useEffect(() => {
    getOnboardingAnswers(userId).then((a) => setSelected(a.helpMost ?? []));
  }, [userId]);

  const toggle = (id: HelpOptionId) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  };

  const onSave = async () => {
    await setOnboardingAnswer(userId, { helpMost: selected });
    goBack();
  };

  return (
    <SettingsEditFrame title="What hula helps with" onBack={goBack} onSave={onSave}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.list}>
        {HELP_OPTIONS.map((opt) => (
          <HulaOptionCard
            key={opt.id}
            label={opt.label}
            icon={opt.icon}
            selected={selected.includes(opt.id)}
            onPress={() => toggle(opt.id)}
          />
        ))}
      </ScrollView>
    </SettingsEditFrame>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: hula.spacing.md,
    paddingBottom: hula.spacing.xl,
  },
});
