import { Ionicons } from '@expo/vector-icons';
import { useEffect, type ReactNode } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { hula } from '@/constants/theme';
import { HulaLogoTile } from './HulaLogoTile';
import { HulaProgressBar } from './HulaProgressBar';

const font = hula.typography.fontFamily;

type Props = {
  /** 0..1 progress bar value for this step. */
  progress: number;
  /** Show + wire the top-left circular back button. */
  onBack?: () => void;
  /** Show + wire the top-right "Skip" pill. */
  onSkip?: () => void;
  /** Render the default glass Hula logo tile above the title. */
  showLogo?: boolean;
  /** Custom top media (e.g. a page-specific glyph) — overrides `showLogo`. */
  topMedia?: ReactNode;
  title?: string;
  subtitle?: string;
  /** Main page content (option cards, pickers, etc.). */
  children?: ReactNode;
  /** Bottom area, typically the CTA + legal text. Pinned to the bottom. */
  footer?: ReactNode;
  /** Scroll the body when content can exceed the screen (long option lists). */
  scroll?: boolean;
};

/**
 * Shared scaffold for every Hula onboarding page: safe area, ambient glow,
 * top progress bar with optional back/skip, an optional logo/glyph, centered
 * title/subtitle, page content, and a pinned bottom footer.
 *
 * Content fades + lifts in on mount for a subtle, consistent entrance. Pages
 * pass their specifics via props and keep their own logic thin.
 */
export function HulaOnboardingFrame({
  progress,
  onBack,
  onSkip,
  showLogo = false,
  topMedia,
  title,
  subtitle,
  children,
  footer,
  scroll = false,
}: Props) {
  const anim = useSharedValue(0);

  useEffect(() => {
    anim.value = withTiming(1, { duration: 420 });
  }, [anim]);

  const contentStyle = useAnimatedStyle(() => ({
    opacity: anim.value,
    transform: [{ translateY: (1 - anim.value) * 12 }],
  }));

  const media = topMedia ?? (showLogo ? <HulaLogoTile /> : null);

  const body = (
    <>
      {media ? <View style={styles.media}>{media}</View> : null}
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      {children}
    </>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <AmbientGlow />

      {/* ── Top bar: back · progress · skip ── */}
      <View style={styles.header}>
        <View style={styles.headerSide}>
          {onBack ? (
            <Pressable
              onPress={onBack}
              hitSlop={10}
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            >
              <Ionicons name="chevron-back" size={22} color={hula.colors.text.primary} />
            </Pressable>
          ) : null}
        </View>

        <View style={styles.progressWrap}>
          <HulaProgressBar progress={progress} />
        </View>

        <View style={styles.headerSideRight}>
          {onSkip ? (
            <Pressable
              onPress={onSkip}
              hitSlop={10}
              style={({ pressed }) => [styles.skipButton, pressed && styles.pressed]}
            >
              <Text style={styles.skipText} numberOfLines={1} allowFontScaling={false}>
                Skip
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* ── Animated body ── */}
      <Animated.View style={[styles.content, contentStyle]}>
        {scroll ? (
          <ScrollView
            contentContainerStyle={styles.scrollBody}
            showsVerticalScrollIndicator={false}
          >
            {body}
          </ScrollView>
        ) : (
          <View style={styles.body}>{body}</View>
        )}
      </Animated.View>

      {/* ── Pinned footer (CTA) ── */}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}

/**
 * Soft purple/blue ambient bloom behind the page. Kept low-opacity and clipped
 * so it never causes horizontal scroll. The iOS shadow adds an extra glow;
 * Android shows the faint discs alone.
 */
function AmbientGlow() {
  return (
    <View pointerEvents="none" style={styles.glowLayer}>
      <View style={[styles.glow, styles.glowPurple]} />
      <View style={[styles.glow, styles.glowBlue]} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: hula.colors.voidBlack,
  },
  glowLayer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    width: 320,
    height: 320,
    borderRadius: 160,
    ...Platform.select({
      ios: { shadowOpacity: 0.6, shadowRadius: 90, shadowOffset: { width: 0, height: 0 } },
      default: {},
    }),
  },
  glowPurple: {
    left: -150,
    top: '26%',
    backgroundColor: 'rgba(123,77,255,0.14)',
    shadowColor: hula.glow.purple,
  },
  glowBlue: {
    right: -150,
    bottom: '8%',
    backgroundColor: 'rgba(62,123,255,0.12)',
    shadowColor: hula.glow.blue,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: hula.spacing.xl,
    marginTop: hula.spacing.sm,
    marginBottom: hula.spacing.lg,
  },
  headerSide: {
    width: 44,
    height: 44,
    justifyContent: 'center',
  },
  headerSideRight: {
    minWidth: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressWrap: {
    flex: 1,
    marginHorizontal: hula.spacing.lg,
  },
  skipButton: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    minWidth: 64,
    paddingHorizontal: hula.spacing.lg,
    height: 40,
    borderRadius: hula.radius.pill,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipText: {
    flexShrink: 0,
    fontFamily: font.medium,
    fontSize: hula.typography.hint.fontSize,
    lineHeight: 20,
    color: hula.colors.text.primary,
    textAlign: 'center',
  },
  content: {
    flex: 1,
  },
  body: {
    flex: 1,
    paddingHorizontal: hula.spacing.xl,
    paddingTop: hula.spacing.xl,
    alignItems: 'center',
  },
  scrollBody: {
    paddingHorizontal: hula.spacing.xl,
    paddingTop: hula.spacing.xl,
    paddingBottom: hula.spacing.xl,
    alignItems: 'center',
  },
  media: {
    marginBottom: hula.spacing.xl,
    alignItems: 'center',
  },
  title: {
    fontFamily: font.bold,
    fontSize: 28,
    lineHeight: 34,
    color: hula.colors.text.primary,
    textAlign: 'center',
    textShadowColor: 'rgba(120,110,255,0.28)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },
  subtitle: {
    fontFamily: font.regular,
    fontSize: hula.typography.hint.fontSize,
    lineHeight: 23,
    color: hula.colors.text.tertiary,
    textAlign: 'center',
    marginTop: hula.spacing.md,
  },
  footer: {
    paddingHorizontal: hula.spacing.xl,
    paddingBottom: hula.spacing.sm,
    paddingTop: hula.spacing.md,
  },
  pressed: {
    opacity: 0.7,
  },
});
