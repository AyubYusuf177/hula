import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';

import { hula } from '@/constants/theme';

type Props = {
  progress: SharedValue<number>;
};

const CLAMP = Extrapolation.CLAMP;
const font = hula.typography.fontFamily;

/**
 * Real React Native text + buttons layered over the Skia scene. Each block
 * (hero / transition / auth) fades and shifts based on the shared progress
 * value so it stays perfectly in sync with the graphics.
 */
export function OnboardingContent({ progress }: Props) {
  const { width: W, height: H } = useWindowDimensions();
  const [interactive, setInteractive] = useState(false);

  // Only let the auth card receive touches once it is essentially on screen.
  useAnimatedReaction(
    () => progress.value > 0.85,
    (on, prev) => {
      if (on !== prev) runOnJS(setInteractive)(on);
    },
  );

  const headlineStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.5, 1], [1, 0.14, 0], CLAMP),
    transform: [
      { translateY: interpolate(progress.value, [0, 0.5], [0, -24], CLAMP) },
    ],
  }));

  const heroHintStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.3], [1, 0], CLAMP),
  }));

  const transitionStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      progress.value,
      [0.22, 0.5, 0.8],
      [0, 1, 0],
      CLAMP,
    ),
  }));

  const authStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.72, 1], [0, 1], CLAMP),
    transform: [
      { translateY: interpolate(progress.value, [0.72, 1], [26, 0], CLAMP) },
    ],
  }));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* ── Hero headline ── */}
      <Animated.View
        pointerEvents="none"
        style={[styles.centerBlock, { top: H * 0.19 }, headlineStyle]}
      >
        <Text style={styles.headline}>Super intelligence</Text>
        <Text style={styles.headline}>at your fingertips</Text>
      </Animated.View>

      {/* ── Hero swipe hint + double chevron ── */}
      <Animated.View
        pointerEvents="none"
        style={[styles.centerBlock, { top: H * 0.42 }, heroHintStyle]}
      >
        <Text style={styles.hint}>Swipe up to enter</Text>
        <View style={styles.doubleChevron}>
          <Ionicons name="chevron-up" size={26} color={hula.colors.text.hint} />
          <Ionicons
            name="chevron-up"
            size={26}
            color={hula.colors.text.hint}
            style={{ marginTop: -16 }}
          />
        </View>
      </Animated.View>

      {/* ── Transition: dots trail + single chevron + lower hint ── */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, transitionStyle]}
      >
        <View style={[styles.centerBlock, { top: H * 0.56 }]}>
          {[0, 1, 2, 3].map((i) => (
            <View
              key={i}
              style={[styles.dot, { opacity: 0.9 - i * 0.16, marginTop: i === 0 ? 0 : 14 }]}
            />
          ))}
          <Ionicons
            name="chevron-up"
            size={24}
            color={hula.colors.text.hint}
            style={{ marginTop: 16 }}
          />
        </View>
        <View style={[styles.centerBlock, { top: H * 0.82 }]}>
          <Text style={styles.hint}>Swipe up to enter</Text>
        </View>
      </Animated.View>

      {/* ── Auth: title + glass card + legal ── */}
      <Animated.View
        pointerEvents={interactive ? 'box-none' : 'none'}
        style={[StyleSheet.absoluteFill, authStyle]}
      >
        <View style={[styles.centerBlock, { top: H * 0.3 }]}>
          <Text style={styles.title}>Meet hula</Text>
        </View>

        <View
          style={{
            position: 'absolute',
            top: H * 0.46,
            left: W * 0.06,
            right: W * 0.06,
          }}
        >
          <BlurView
            intensity={hula.glass.blurIntensity}
            tint="dark"
            style={styles.card}
          >
            <SolidButton
              icon={<Ionicons name="logo-apple" size={24} color={hula.button.solidText} />}
              label="Continue with Apple"
            />
            <SolidButton
              icon={<GoogleG />}
              label="Continue with Google"
            />
            <EmailButton />

            <Text style={styles.legalText}>
              By continuing, you agree to our
            </Text>
            <Text style={[styles.legalText, { marginTop: 2 }]}>
              <Text style={styles.legalLink}>Privacy Policy</Text>
              <Text style={styles.legalMuted}> and </Text>
              <Text style={styles.legalLink}>Terms of Service</Text>
            </Text>
          </BlurView>
        </View>
      </Animated.View>
    </View>
  );
}

/* ── Buttons ──────────────────────────────────────────────────── */

function SolidButton({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.solidButton, pressed && styles.pressed]}
    >
      <View style={styles.buttonIcon}>{icon}</View>
      <Text style={styles.solidLabel}>{label}</Text>
    </Pressable>
  );
}

function EmailButton() {
  return (
    <Pressable
      style={({ pressed }) => [{ marginTop: hula.spacing.lg }, pressed && styles.pressed]}
    >
      <LinearGradient
        colors={[...hula.button.gradientBorder]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.emailBorder}
      >
        <View style={styles.emailInner}>
          <View style={styles.buttonIcon}>
            <Ionicons name="mail-outline" size={22} color={hula.button.outlineText} />
          </View>
          <Text style={styles.outlineLabel}>Sign in with Email</Text>
        </View>
      </LinearGradient>
    </Pressable>
  );
}

/** Minimal multi-color Google "G" built from tinted layers. */
function GoogleG() {
  return (
    <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="logo-google" size={22} color="#4285F4" />
    </View>
  );
}

const styles = StyleSheet.create({
  centerBlock: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  headline: {
    fontFamily: font.bold,
    fontSize: hula.typography.hero.fontSize,
    lineHeight: hula.typography.hero.lineHeight,
    color: hula.colors.text.primary,
    textAlign: 'center',
    textShadowColor: 'rgba(120,110,255,0.35)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  title: {
    fontFamily: font.bold,
    fontSize: hula.typography.title.fontSize,
    lineHeight: hula.typography.title.lineHeight,
    color: hula.colors.text.primary,
    textAlign: 'center',
    textShadowColor: 'rgba(120,110,255,0.3)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },
  hint: {
    fontFamily: font.medium,
    fontSize: hula.typography.hint.fontSize,
    lineHeight: hula.typography.hint.lineHeight,
    color: hula.colors.text.hint,
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  doubleChevron: {
    marginTop: 14,
    alignItems: 'center',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: hula.colors.text.hint,
  },
  card: {
    borderRadius: hula.radius.card,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    paddingHorizontal: hula.spacing.xl,
    paddingTop: hula.spacing.xl,
    paddingBottom: hula.spacing.xl,
    overflow: 'hidden',
    backgroundColor: hula.glass.card,
  },
  solidButton: {
    height: hula.button.height,
    borderRadius: hula.button.radius,
    backgroundColor: hula.button.solidBg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: hula.spacing.lg,
  },
  buttonIcon: {
    marginRight: hula.spacing.md,
  },
  solidLabel: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.button.fontSize,
    color: hula.button.solidText,
  },
  emailBorder: {
    borderRadius: hula.button.radius,
    padding: 1.5,
  },
  emailInner: {
    height: hula.button.height - 3,
    borderRadius: hula.button.radius - 1.5,
    backgroundColor: 'rgba(10,12,24,0.9)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineLabel: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.button.fontSize,
    color: hula.button.outlineText,
  },
  pressed: {
    opacity: 0.85,
  },
  legalText: {
    fontFamily: font.regular,
    fontSize: hula.typography.legal.fontSize,
    lineHeight: hula.typography.legal.lineHeight,
    color: hula.colors.text.tertiary,
    textAlign: 'center',
    marginTop: hula.spacing.lg,
  },
  legalMuted: {
    color: hula.colors.text.tertiary,
  },
  legalLink: {
    fontFamily: font.medium,
    color: hula.glow.purpleBright,
  },
});
