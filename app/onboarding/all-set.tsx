import { useAuth } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { HulaBottomButton, HulaOnboardingFrame } from '@/components/onboarding';
import { hula } from '@/constants/theme';
import { setOnboardingStage } from '@/lib/onboarding';

const font = hula.typography.fontFamily;

/**
 * Section 2 — "You're all set!" confirmation. On entry we assert the `all_set`
 * stage; "Get Started" advances the stage to `what_happens_next` and pushes on.
 * The white checkmark circle scales + fades in for a small moment of delight.
 */
export default function OnboardingAllSet() {
  const router = useRouter();
  const { userId } = useAuth();

  const scale = useSharedValue(0.6);
  const opacity = useSharedValue(0);

  useEffect(() => {
    setOnboardingStage(userId, 'all_set');
    opacity.value = withDelay(120, withTiming(1, { duration: 320 }));
    scale.value = withDelay(120, withSpring(1, { damping: 12, stiffness: 140 }));
  }, [userId, opacity, scale]);

  const checkStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  const onGetStarted = async () => {
    await setOnboardingStage(userId, 'what_happens_next');
    router.push('/onboarding/what-happens-next');
  };

  return (
    <HulaOnboardingFrame
      progress={0.7}
      onBack={() => router.back()}
      showLogo
      footer={<HulaBottomButton label="Get Started" onPress={onGetStarted} />}
    >
      <View style={styles.center}>
        <Animated.View style={[styles.checkCircle, checkStyle]}>
          <Ionicons name="checkmark" size={44} color={hula.button.solidText} />
        </Animated.View>
        <Text style={styles.title}>You&apos;re all set!</Text>
        <Text style={styles.subtitle}>
          Your setup is complete and you&apos;re ready to unlock hula.
        </Text>
      </View>
    </HulaOnboardingFrame>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: hula.button.solidBg,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: hula.glow.purple,
        shadowOpacity: 0.6,
        shadowRadius: 26,
        shadowOffset: { width: 0, height: 0 },
      },
      default: {},
    }),
  },
  title: {
    marginTop: hula.spacing['2xl'],
    fontFamily: font.bold,
    fontSize: 30,
    lineHeight: 36,
    color: hula.colors.text.primary,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: hula.spacing.md,
    fontFamily: font.regular,
    fontSize: hula.typography.hint.fontSize,
    lineHeight: 23,
    color: hula.colors.text.tertiary,
    textAlign: 'center',
    paddingHorizontal: hula.spacing.xl,
  },
});
