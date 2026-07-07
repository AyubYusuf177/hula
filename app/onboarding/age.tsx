import { useAuth } from '@clerk/clerk-expo';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  HulaBottomButton,
  HulaOnboardingFrame,
  HulaWheelPicker,
  WHEEL_H,
  WHEEL_ITEM_H,
  WHEEL_PAD,
} from '@/components/onboarding';
import { hula } from '@/constants/theme';
import { getOnboardingStep, ONBOARDING_CTA } from '@/data/hulaOnboarding';
import { getOnboardingAnswers, setOnboardingAnswer } from '@/lib/onboardingAnswers';

const step = getOnboardingStep('age');

const START_YEAR = 1900;
const END_YEAR = new Date().getFullYear();

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));
const YEARS = Array.from({ length: END_YEAR - START_YEAR + 1 }, (_, i) => String(START_YEAR + i));
const DEFAULT_YEAR_INDEX = 2000 - START_YEAR;

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Onboarding page 3 — birthday. Three `HulaWheelPicker` columns (day · month ·
 * year) share one centered selection pill (Miora-style). Years run 1900 → the
 * current year and scroll freely with no boundary sticking. Each column reports
 * its centered index into a ref, so scrolling never re-renders the parent.
 * Saves an ISO `YYYY-MM-DD` string, clamping impossible dates (e.g. Feb 30 →
 * Feb 28/29), then advances to the tone page.
 */
export default function OnboardingAge() {
  const router = useRouter();
  const { userId } = useAuth();

  const dayRef = useRef(0);
  const monthRef = useRef(0);
  const yearRef = useRef(DEFAULT_YEAR_INDEX);
  const [initial, setInitial] = useState<{ d: number; m: number; y: number } | null>(null);

  useEffect(() => {
    getOnboardingAnswers(userId).then((a) => {
      let d = 0;
      let m = 0;
      let y = DEFAULT_YEAR_INDEX;
      if (a.birthday) {
        const [yy, mm, dd] = a.birthday.split('-').map(Number);
        if (yy && mm && dd) {
          y = clamp(yy - START_YEAR, YEARS.length - 1);
          m = clamp(mm - 1, 11);
          d = clamp(dd - 1, 30);
        }
      }
      dayRef.current = d;
      monthRef.current = m;
      yearRef.current = y;
      setInitial({ d, m, y });
    });
  }, [userId]);

  const onDay = useCallback((i: number) => {
    dayRef.current = i;
  }, []);
  const onMonth = useCallback((i: number) => {
    monthRef.current = i;
  }, []);
  const onYear = useCallback((i: number) => {
    yearRef.current = i;
  }, []);

  const onContinue = async () => {
    const year = START_YEAR + yearRef.current;
    const month = monthRef.current + 1;
    const maxDay = new Date(year, month, 0).getDate();
    const day = Math.min(dayRef.current + 1, maxDay);
    const iso = `${year}-${pad(month)}-${pad(day)}`;
    await setOnboardingAnswer(userId, { birthday: iso });
    router.push('/onboarding/tone');
  };

  return (
    <HulaOnboardingFrame
      progress={step.progress}
      onBack={() => router.back()}
      topMedia={
        <MaterialCommunityIcons
          name="cake-variant"
          size={44}
          color={hula.colors.text.primary}
        />
      }
      title={step.title}
      subtitle={step.subtitle}
      footer={<HulaBottomButton label={ONBOARDING_CTA.age} onPress={onContinue} />}
    >
      <View style={styles.pickerWrap}>
        <View pointerEvents="none" style={styles.centerPill} />
        {initial ? (
          <View style={styles.wheelRow}>
            <HulaWheelPicker items={DAYS} initialIndex={initial.d} onIndexChange={onDay} style={styles.day} />
            <HulaWheelPicker items={MONTHS} initialIndex={initial.m} onIndexChange={onMonth} style={styles.month} />
            <HulaWheelPicker items={YEARS} initialIndex={initial.y} onIndexChange={onYear} style={styles.year} />
          </View>
        ) : null}
      </View>
    </HulaOnboardingFrame>
  );
}

const styles = StyleSheet.create({
  pickerWrap: {
    width: '100%',
    height: WHEEL_H,
    marginTop: hula.spacing['2xl'],
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
  wheelRow: {
    flexDirection: 'row',
    height: WHEEL_H,
  },
  day: {
    flex: 1,
  },
  month: {
    flex: 1.7,
  },
  year: {
    flex: 1.2,
  },
});
