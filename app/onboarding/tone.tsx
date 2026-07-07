import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  HulaBottomButton,
  HulaLogoTile,
  HulaOnboardingFrame,
  HulaWheelPicker,
  WHEEL_H,
  WHEEL_ITEM_H,
  WHEEL_PAD,
} from '@/components/onboarding';
import { hula } from '@/constants/theme';
import {
  getOnboardingStep,
  ONBOARDING_CTA,
  TONE_OPTIONS,
  TONE_PREVIEW_TIME,
} from '@/data/hulaOnboarding';
import { getOnboardingAnswers, setOnboardingAnswer } from '@/lib/onboardingAnswers';

const font = hula.typography.fontFamily;
const step = getOnboardingStep('tone');

/** Wheel row labels — the suggested tone is flagged inline. */
const TONE_LABELS = TONE_OPTIONS.map((o) => (o.suggested ? `${o.label} · suggested` : o.label));
const DEFAULT_TONE_INDEX = Math.max(0, TONE_OPTIONS.findIndex((o) => o.value === 'witty'));

/**
 * Onboarding page 4 — hula's tone of voice. A 3-item wheel (same primitive as
 * the birthday picker) with the suggested "Witty & Bold" centered by default.
 * The Daily Brief preview updates the instant the centered tone changes, so
 * scrolling the wheel live-previews how hula speaks. Saves `tone` and advances
 * to the help page.
 */
export default function OnboardingTone() {
  const router = useRouter();
  const { userId } = useAuth();
  const [initialIndex, setInitialIndex] = useState<number | null>(null);
  const [index, setIndex] = useState(DEFAULT_TONE_INDEX);
  const indexRef = useRef(DEFAULT_TONE_INDEX);

  useEffect(() => {
    getOnboardingAnswers(userId).then((a) => {
      const saved = a.tone ? TONE_OPTIONS.findIndex((o) => o.value === a.tone) : -1;
      const start = saved >= 0 ? saved : DEFAULT_TONE_INDEX;
      indexRef.current = start;
      setIndex(start);
      setInitialIndex(start);
    });
  }, [userId]);

  const onIndexChange = useCallback((i: number) => {
    indexRef.current = i;
    setIndex(i);
  }, []);

  const onContinue = async () => {
    await setOnboardingAnswer(userId, { tone: TONE_OPTIONS[indexRef.current].value });
    router.push('/onboarding/help');
  };

  const preview = TONE_OPTIONS[index].preview;

  return (
    <HulaOnboardingFrame
      progress={step.progress}
      onBack={() => router.back()}
      showLogo
      title={step.title}
      footer={<HulaBottomButton label={ONBOARDING_CTA.tone} onPress={onContinue} />}
    >
      <View style={styles.pickerWrap}>
        <View pointerEvents="none" style={styles.centerPill} />
        {initialIndex !== null ? (
          <HulaWheelPicker
            items={TONE_LABELS}
            initialIndex={initialIndex}
            onIndexChange={onIndexChange}
            fontSize={17}
          />
        ) : null}
      </View>

      <View style={styles.previewCard}>
        <HulaLogoTile size={40} />
        <View style={styles.previewBody}>
          <View style={styles.previewHeader}>
            <Text style={styles.previewTitle}>{preview.title}</Text>
            <Text style={styles.previewTime}>{TONE_PREVIEW_TIME}</Text>
          </View>
          <Text style={styles.previewText}>{preview.message}</Text>
        </View>
      </View>
    </HulaOnboardingFrame>
  );
}

const styles = StyleSheet.create({
  pickerWrap: {
    width: '100%',
    height: WHEEL_H,
    marginTop: hula.spacing.xl,
    justifyContent: 'center',
  },
  centerPill: {
    position: 'absolute',
    top: WHEEL_PAD,
    left: 0,
    right: 0,
    height: WHEEL_ITEM_H,
    borderRadius: hula.radius.pill,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
  },
  previewCard: {
    width: '100%',
    marginTop: hula.spacing['2xl'],
    flexDirection: 'row',
    borderRadius: hula.radius.card,
    backgroundColor: hula.glass.card,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    padding: hula.spacing.lg,
  },
  previewBody: {
    flex: 1,
    marginLeft: hula.spacing.lg,
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: hula.spacing.xs,
  },
  previewTitle: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.hint.fontSize,
    color: hula.colors.text.primary,
  },
  previewTime: {
    fontFamily: font.regular,
    fontSize: hula.typography.legal.fontSize,
    color: hula.colors.text.tertiary,
  },
  previewText: {
    fontFamily: font.regular,
    fontSize: hula.typography.legal.fontSize + 1,
    lineHeight: 20,
    color: hula.colors.text.secondary,
  },
});
