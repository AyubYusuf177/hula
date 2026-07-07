import { useAuth } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HulaBottomButton, HulaLogoTile, HulaProgressBar } from '@/components/onboarding';
import { hula } from '@/constants/theme';
import { setOnboardingStage } from '@/lib/onboarding';
import { setOnboardingAnswer } from '@/lib/onboardingAnswers';

const font = hula.typography.fontFamily;

type PlanId = 'yearly' | 'monthly';

/**
 * Section 2 — paywall / plan selection.
 *
 * There is NO real payment, Restore Purchases, or Apple IAP here — this is a
 * placeholder that records the user's plan *intent* and moves on. Both
 * "Continue" and the "Close" (X) advance to the free-preview screen (stage
 * `free_preview`); Continue is not a purchase. The default selection is Yearly.
 */
export default function OnboardingPaywall() {
  const router = useRouter();
  const { userId } = useAuth();
  const [plan, setPlan] = useState<PlanId>('yearly');

  // Sheet-style entrance: slide up + fade in.
  const enter = useSharedValue(0);

  useEffect(() => {
    setOnboardingStage(userId, 'paywall');
    // Persist the default intent so it reflects what's shown even without a tap.
    setOnboardingAnswer(userId, { planIntent: 'yearly' });
    enter.value = withTiming(1, { duration: 380 });
  }, [userId, enter]);

  const sheetStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * 24 }],
  }));

  const selectPlan = (next: PlanId) => {
    setPlan(next);
    setOnboardingAnswer(userId, { planIntent: next });
  };

  const goToFreePreview = async () => {
    await setOnboardingStage(userId, 'free_preview');
    router.replace('/onboarding/free-preview');
  };

  return (
    <SafeAreaView style={styles.safe}>
      {/* Top bar: back · progress · close */}
      <View style={styles.header}>
        <CircleButton icon="chevron-back" onPress={() => router.back()} />
        <View style={styles.progressWrap}>
          <HulaProgressBar progress={1} />
        </View>
        <CircleButton icon="close" onPress={goToFreePreview} />
      </View>

      <Animated.View style={[styles.flex, sheetStyle]}>
        <ScrollView
          contentContainerStyle={styles.body}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.logo}>
            <HulaLogoTile size={84} />
          </View>

          <Text style={styles.title}>Your life on autopilot</Text>
          <Text style={styles.subtitle}>How members are using hula today</Text>

          {/* Chat preview */}
          <View style={styles.chatCard}>
            <View style={styles.userBubbleRow}>
              <View style={styles.userBubble}>
                <Text style={styles.userText}>
                  Remind me to pay rent Friday, draft a follow-up to James, and book a
                  barber for Saturday.
                </Text>
              </View>
            </View>

            <View style={styles.hulaBubbleRow}>
              <View style={styles.hulaAvatar}>
                <HulaLogoTile size={34} />
              </View>
              <View style={styles.hulaBubble}>
                <Text style={styles.hulaText}>
                  Done — reminder set, draft ready, and I found three barber slots near
                  you.
                </Text>
              </View>
            </View>
          </View>

          {/* Plans */}
          <PlanCard
            selected={plan === 'yearly'}
            onPress={() => selectPlan('yearly')}
            label="Yearly"
            price="£59.00/year"
            sub="£4.91/mo · SAVE 30%"
            badge="BEST VALUE"
            badgeHighlight
          />
          <PlanCard
            selected={plan === 'monthly'}
            onPress={() => selectPlan('monthly')}
            label="Monthly"
            price="£9.00/mo"
            badge="MOST FLEXIBLE"
          />

          <View style={styles.cta}>
            <HulaBottomButton label="Continue" onPress={goToFreePreview} />
          </View>

          <Text style={styles.cancel}>Cancel anytime.</Text>

          <View style={styles.legalRow}>
            <Pressable hitSlop={8}>
              <Text style={styles.legalLink}>Restore Purchases</Text>
            </Pressable>
            <Text style={styles.legalDivider}>|</Text>
            <Pressable hitSlop={8}>
              <Text style={styles.legalLink}>Terms</Text>
            </Pressable>
            <Text style={styles.legalDivider}>|</Text>
            <Pressable hitSlop={8}>
              <Text style={styles.legalLink}>Privacy</Text>
            </Pressable>
          </View>
        </ScrollView>
      </Animated.View>
    </SafeAreaView>
  );
}

function CircleButton({
  icon,
  onPress,
}: {
  icon: 'chevron-back' | 'close';
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => [styles.circleBtn, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={20} color={hula.colors.text.primary} />
    </Pressable>
  );
}

type PlanCardProps = {
  selected: boolean;
  onPress: () => void;
  label: string;
  price: string;
  sub?: string;
  badge: string;
  badgeHighlight?: boolean;
};

function PlanCard({
  selected,
  onPress,
  label,
  price,
  sub,
  badge,
  badgeHighlight = false,
}: PlanCardProps) {
  const inner = (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.plan,
        selected ? styles.planSelected : styles.planUnselected,
        pressed && styles.pressed,
      ]}
    >
      {/* Badge sits inside the card (top-right) so it can never clip. */}
      <View style={styles.badgeRow}>
        <View
          style={[styles.badge, badgeHighlight ? styles.badgeHighlight : styles.badgeMuted]}
        >
          {badgeHighlight ? (
            <LinearGradient
              colors={[hula.glow.purple, hula.glow.blue]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          ) : null}
          <Text style={styles.badgeText} numberOfLines={1}>
            {badge}
          </Text>
        </View>
      </View>

      <View style={styles.mainRow}>
        <View style={styles.radioCol}>
          <View style={[styles.radio, selected && styles.radioOn]}>
            {selected ? (
              <Ionicons name="checkmark" size={14} color={hula.button.solidText} />
            ) : null}
          </View>
          <Text style={styles.planLabel}>{label}</Text>
        </View>

        <View style={styles.priceCol}>
          <Text style={styles.planPrice}>{price}</Text>
          {sub ? <Text style={styles.planSub}>{sub}</Text> : null}
        </View>
      </View>
    </Pressable>
  );

  // Selected card gets a purple→blue gradient border like the mockup.
  if (selected) {
    return (
      <LinearGradient
        colors={[hula.glow.purple, hula.glow.blue]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.planBorder}
      >
        {inner}
      </LinearGradient>
    );
  }
  return <View style={styles.planBorderPlain}>{inner}</View>;
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: hula.colors.voidBlack,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: hula.spacing.xl,
    marginTop: hula.spacing.sm,
    marginBottom: hula.spacing.lg,
  },
  progressWrap: {
    flex: 1,
    marginHorizontal: hula.spacing.lg,
  },
  circleBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    paddingHorizontal: hula.spacing.xl,
    paddingBottom: hula.spacing['2xl'],
    alignItems: 'center',
  },
  logo: {
    alignItems: 'center',
    marginBottom: hula.spacing.lg,
  },
  title: {
    fontFamily: font.bold,
    fontSize: 30,
    lineHeight: 36,
    color: hula.colors.text.primary,
    textAlign: 'center',
  },
  subtitle: {
    fontFamily: font.regular,
    fontSize: hula.typography.hint.fontSize,
    color: hula.colors.text.tertiary,
    textAlign: 'center',
    marginTop: hula.spacing.sm,
    marginBottom: hula.spacing.xl,
  },
  chatCard: {
    width: '100%',
    borderRadius: hula.radius.card,
    backgroundColor: hula.glass.card,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    padding: hula.spacing.lg,
    gap: hula.spacing.md,
    marginBottom: hula.spacing.xl,
  },
  userBubbleRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  userBubble: {
    maxWidth: '82%',
    backgroundColor: hula.colors.purpleUndertone,
    borderRadius: 18,
    paddingHorizontal: hula.spacing.lg,
    paddingVertical: hula.spacing.md,
  },
  userText: {
    fontFamily: font.regular,
    fontSize: hula.typography.hint.fontSize,
    lineHeight: 22,
    color: hula.colors.text.primary,
  },
  hulaBubbleRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: hula.spacing.sm,
  },
  hulaAvatar: {
    marginBottom: 2,
  },
  hulaBubble: {
    flex: 1,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    borderRadius: 18,
    paddingHorizontal: hula.spacing.lg,
    paddingVertical: hula.spacing.md,
  },
  hulaText: {
    fontFamily: font.regular,
    fontSize: hula.typography.hint.fontSize,
    lineHeight: 22,
    color: hula.colors.text.secondary,
  },
  planBorder: {
    width: '100%',
    borderRadius: hula.radius.card,
    padding: 1.5,
    marginBottom: hula.spacing.lg,
  },
  planBorderPlain: {
    width: '100%',
    marginBottom: hula.spacing.lg,
  },
  plan: {
    borderRadius: hula.radius.card - 1,
    paddingHorizontal: hula.spacing.xl,
    paddingTop: hula.spacing.md,
    paddingBottom: hula.spacing.xl,
  },
  badgeRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: hula.spacing.md,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  planSelected: {
    backgroundColor: '#140F2E',
  },
  planUnselected: {
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    borderRadius: hula.radius.card,
  },
  radioCol: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  radio: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: hula.spacing.md,
  },
  radioOn: {
    backgroundColor: hula.glow.purple,
    borderColor: hula.glow.purple,
  },
  planLabel: {
    fontFamily: font.semiBold,
    fontSize: 19,
    color: hula.colors.text.primary,
  },
  priceCol: {
    alignItems: 'flex-end',
  },
  planPrice: {
    fontFamily: font.semiBold,
    fontSize: 18,
    color: hula.colors.text.primary,
  },
  planSub: {
    fontFamily: font.regular,
    fontSize: hula.typography.legal.fontSize,
    color: hula.colors.text.tertiary,
    marginTop: 2,
  },
  badge: {
    height: 24,
    paddingHorizontal: hula.spacing.md,
    borderRadius: hula.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  badgeHighlight: {
    backgroundColor: hula.glow.purple,
  },
  badgeMuted: {
    backgroundColor: '#1B2036',
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
  },
  badgeText: {
    fontFamily: font.semiBold,
    fontSize: 11,
    letterSpacing: 0.5,
    color: hula.colors.text.primary,
  },
  cta: {
    width: '100%',
    marginTop: hula.spacing.sm,
  },
  cancel: {
    fontFamily: font.regular,
    fontSize: hula.typography.hint.fontSize,
    color: hula.colors.text.tertiary,
    textAlign: 'center',
    marginTop: hula.spacing.lg,
  },
  legalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: hula.spacing.md,
    marginTop: hula.spacing.md,
  },
  legalLink: {
    fontFamily: font.regular,
    fontSize: hula.typography.legal.fontSize,
    color: hula.colors.text.faint,
  },
  legalDivider: {
    fontFamily: font.regular,
    fontSize: hula.typography.legal.fontSize,
    color: hula.colors.text.faint,
  },
  pressed: {
    opacity: 0.85,
  },
});
