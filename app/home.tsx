import { useAuth } from '@clerk/clerk-expo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { hula } from '@/constants/theme';
import {
  clearLegacyOnboardingFlag,
  clearOnboardingComplete,
  LEGACY_ONBOARDING_KEY,
  onboardingKey,
} from '@/lib/onboarding';

const font = hula.typography.fontFamily;

/**
 * Placeholder home screen for signed-in + onboarded users. The sign-out link is
 * a temporary dev aid so the auth loop can be tested end-to-end.
 */
export default function Home() {
  const { signOut, userId } = useAuth();
  const router = useRouter();

  const onSignOut = async () => {
    // Sign out only. We do NOT clear onboarding flags here.
    await signOut();
    router.replace('/');
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.center}>
        <Text style={styles.title}>Welcome to Hula</Text>

        <Pressable onPress={onSignOut} hitSlop={12} style={styles.link}>
          <Text style={styles.linkText}>Sign out</Text>
        </Pressable>

        {__DEV__ ? <OnboardingDevTools userId={userId} /> : null}
      </View>
    </SafeAreaView>
  );
}

/** Dev-only readout + reset tools for the onboarding flag. */
function OnboardingDevTools({ userId }: { userId: string | null | undefined }) {
  const router = useRouter();
  const [value, setValue] = useState<string | null>(null);
  const key = userId ? onboardingKey(userId) : '(no userId yet)';

  const refresh = useCallback(async () => {
    if (!userId) {
      setValue(null);
      return;
    }
    setValue(await AsyncStorage.getItem(onboardingKey(userId)));
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const resetMine = async () => {
    if (!userId) return;
    await clearOnboardingComplete(userId);
    router.replace('/onboarding/legal');
  };

  const clearLegacy = async () => {
    await clearLegacyOnboardingFlag();
    await refresh();
  };

  return (
    <View style={styles.debug}>
      <Text style={styles.debugTitle}>DEBUG (onboarding)</Text>
      <Text style={styles.debugLine}>userId: {userId ?? '(none)'}</Text>
      <Text style={styles.debugLine}>key: {key}</Text>
      <Text style={styles.debugLine}>value: {value ?? '(missing)'}</Text>
      <Text style={styles.debugLine}>legacy key: {LEGACY_ONBOARDING_KEY}</Text>

      <Pressable onPress={resetMine} hitSlop={8} style={styles.debugBtn}>
        <Text style={styles.debugBtnText}>Reset my onboarding flag</Text>
      </Pressable>

      <Pressable onPress={clearLegacy} hitSlop={8} style={styles.debugBtn}>
        <Text style={styles.debugBtnText}>Clear legacy onboarding flag</Text>
      </Pressable>
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
    color: hula.colors.text.tertiary,
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
  debugBtn: {
    marginTop: hula.spacing.md,
    paddingVertical: hula.spacing.sm,
    paddingHorizontal: hula.spacing.md,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    alignItems: 'center',
  },
  debugBtnText: {
    fontFamily: font.medium,
    fontSize: hula.typography.legal.fontSize,
    color: hula.glow.purpleBright,
  },
});
