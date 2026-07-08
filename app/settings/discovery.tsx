import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { HulaOptionCard } from '@/components/onboarding';
import { SettingsEditFrame } from '@/components/settings/SettingsEditFrame';
import { hula } from '@/constants/theme';
import { DISCOVERY_OPTIONS, type DiscoverySourceId } from '@/data/hulaOnboarding';
import { getOnboardingAnswers, setOnboardingAnswer } from '@/lib/onboardingAnswers';

/** Settings → Discovery Source. Single-select from the shared onboarding options. */
export default function EditDiscovery() {
  const router = useRouter();
  const { userId } = useAuth();

  const [selected, setSelected] = useState<DiscoverySourceId | undefined>(undefined);

  useEffect(() => {
    getOnboardingAnswers(userId).then((a) => setSelected(a.discoverySource));
  }, [userId]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  };

  const onSave = async () => {
    if (selected) await setOnboardingAnswer(userId, { discoverySource: selected });
    goBack();
  };

  return (
    <SettingsEditFrame title="Discovery Source" onBack={goBack} onSave={onSave} saveDisabled={!selected}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.list}>
        {DISCOVERY_OPTIONS.map((opt) => (
          <HulaOptionCard
            key={opt.id}
            label={opt.label}
            icon={opt.icon}
            selected={selected === opt.id}
            onPress={() => setSelected(opt.id)}
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
