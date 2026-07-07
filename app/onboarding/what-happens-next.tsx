import { useAuth } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { HulaBottomButton, HulaOnboardingFrame } from '@/components/onboarding';
import { hula } from '@/constants/theme';
import { setOnboardingStage } from '@/lib/onboarding';
import type { IoniconName } from '@/data/hulaOnboarding';

const font = hula.typography.fontFamily;

type TimelineItem = { icon: IoniconName; when: string; body: string };

/** The three-step "what happens next" timeline (spec copy). */
const TIMELINE: readonly TimelineItem[] = [
  {
    icon: 'calendar-clear-outline',
    when: 'Today',
    body: 'Start using hula for reminders, planning, research, messages, and daily tasks.',
  },
  {
    icon: 'bulb-outline',
    when: 'In the first week',
    body: 'hula learns your preferences and helps you set up the workflows you use most.',
  },
  {
    icon: 'stats-chart-outline',
    when: 'In 7 days',
    body: 'Your subscription begins unless cancelled before the end of your trial.',
  },
] as const;

/**
 * Section 2 CHECKPOINT — "What happens next".
 *
 * This is the resume anchor: reaching this screen sets the `what_happens_next`
 * stage, so a user who signs out here and signs back in returns to this screen
 * (not `/onboarding/legal`). "Continue" advances the stage to `paywall`.
 */
export default function OnboardingWhatHappensNext() {
  const router = useRouter();
  const { userId } = useAuth();

  useEffect(() => {
    setOnboardingStage(userId, 'what_happens_next');
  }, [userId]);

  const onContinue = async () => {
    await setOnboardingStage(userId, 'paywall');
    router.push('/onboarding/paywall');
  };

  return (
    <HulaOnboardingFrame
      progress={0.85}
      onBack={() => router.back()}
      showLogo
      scroll
      footer={<HulaBottomButton label="Continue" onPress={onContinue} />}
    >
      <View style={styles.content}>
        <Text style={styles.heading}>What happens next</Text>

        <View style={styles.timeline}>
          {TIMELINE.map((item, i) => (
            <Row key={item.when} item={item} isLast={i === TIMELINE.length - 1} />
          ))}
        </View>
      </View>
    </HulaOnboardingFrame>
  );
}

function Row({ item, isLast }: { item: TimelineItem; isLast: boolean }) {
  return (
    <View style={styles.row}>
      <View style={styles.rail}>
        <View style={styles.iconCircle}>
          <Ionicons name={item.icon} size={22} color={hula.glow.purpleBright} />
        </View>
        {!isLast ? <View style={styles.connector} /> : null}
      </View>

      <View style={styles.rowBody}>
        <Text style={styles.when}>{item.when}</Text>
        <Text style={styles.bodyText}>{item.body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    width: '100%',
    alignItems: 'flex-start',
  },
  heading: {
    fontFamily: font.bold,
    fontSize: 34,
    lineHeight: 40,
    color: hula.colors.text.primary,
    textAlign: 'left',
    marginBottom: hula.spacing['2xl'],
  },
  timeline: {
    width: '100%',
  },
  row: {
    flexDirection: 'row',
  },
  rail: {
    width: 52,
    alignItems: 'center',
  },
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connector: {
    flex: 1,
    width: 1.5,
    backgroundColor: hula.glass.tileBorder,
    marginVertical: hula.spacing.xs,
  },
  rowBody: {
    flex: 1,
    marginLeft: hula.spacing.lg,
    paddingBottom: hula.spacing['2xl'],
  },
  when: {
    fontFamily: font.semiBold,
    fontSize: 20,
    lineHeight: 26,
    color: hula.colors.text.primary,
    marginBottom: hula.spacing.xs,
  },
  bodyText: {
    fontFamily: font.regular,
    fontSize: hula.typography.hint.fontSize,
    lineHeight: 24,
    color: hula.colors.text.tertiary,
  },
});
