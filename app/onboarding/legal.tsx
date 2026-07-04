import { useAuth } from '@clerk/clerk-expo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { hula } from '@/constants/theme';
import { onboardingKey, setOnboardingComplete } from '@/lib/onboarding';

const font = hula.typography.fontFamily;

/**
 * Placeholder onboarding entry screen. The real flow is not built yet — this
 * only exists so signed-in + not-yet-onboarded users have somewhere to land.
 * The temporary "Continue" marks onboarding complete for the current Clerk
 * userId, then routes to /home.
 */
export default function OnboardingLegal() {
  const router = useRouter();
  const { userId } = useAuth();

  const finish = async () => {
    if (!userId) return;
    await setOnboardingComplete(userId);
    router.replace('/home');
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.center}>
        <Text style={styles.title}>Onboarding starts here</Text>

        <Pressable onPress={finish} hitSlop={12} disabled={!userId} style={styles.link}>
          <Text style={styles.linkText}>Continue →</Text>
        </Pressable>

        {__DEV__ ? <OnboardingDebug userId={userId} /> : null}
      </View>
    </SafeAreaView>
  );
}

/** Dev-only readout of the exact key/value driving onboarding routing. */
function OnboardingDebug({ userId }: { userId: string | null | undefined }) {
  const [value, setValue] = useState<string | null>(null);
  const key = userId ? onboardingKey(userId) : '(no userId yet)';

  useEffect(() => {
    if (!userId) return;
    let active = true;
    AsyncStorage.getItem(onboardingKey(userId)).then((v) => {
      if (active) setValue(v);
    });
    return () => {
      active = false;
    };
  }, [userId]);

  return (
    <View style={styles.debug}>
      <Text style={styles.debugTitle}>DEBUG (onboarding)</Text>
      <Text style={styles.debugLine}>userId: {userId ?? '(none)'}</Text>
      <Text style={styles.debugLine}>key: {key}</Text>
      <Text style={styles.debugLine}>value: {value ?? '(missing)'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: hula.colors.voidBlack,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: hula.spacing.xl,
  },
  title: {
    fontFamily: font.bold,
    fontSize: hula.typography.hero.fontSize,
    lineHeight: hula.typography.hero.lineHeight,
    color: hula.colors.text.primary,
    textAlign: 'center',
  },
  link: {
    marginTop: hula.spacing['2xl'],
  },
  linkText: {
    fontFamily: font.medium,
    fontSize: hula.typography.hint.fontSize,
    color: hula.glow.purpleBright,
  },
  debug: {
    marginTop: hula.spacing['2xl'],
    padding: hula.spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    backgroundColor: hula.glass.tile,
    alignSelf: 'stretch',
  },
  debugTitle: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.legal.fontSize,
    color: hula.colors.text.tertiary,
    marginBottom: hula.spacing.xs,
  },
  debugLine: {
    fontFamily: font.regular,
    fontSize: hula.typography.legal.fontSize,
    lineHeight: hula.typography.legal.lineHeight,
    color: hula.colors.text.tertiary,
  },
});
