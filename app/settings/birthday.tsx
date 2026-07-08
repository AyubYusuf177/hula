import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  HulaWheelPicker,
  WHEEL_H,
  WHEEL_ITEM_H,
  WHEEL_PAD,
} from '@/components/onboarding';
import { SettingsEditFrame } from '@/components/settings/SettingsEditFrame';
import { hula } from '@/constants/theme';
import { getOnboardingAnswers, setOnboardingAnswer } from '@/lib/onboardingAnswers';

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
 * Settings → Date of Birth. Mirrors the onboarding age screen (three shared-pill
 * wheel columns) but saves back into `onboarding_answers.birthday` as
 * `YYYY-MM-DD`, then returns to Account Overview.
 */
export default function EditBirthday() {
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

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  };

  const onSave = async () => {
    const year = START_YEAR + yearRef.current;
    const month = monthRef.current + 1;
    const maxDay = new Date(year, month, 0).getDate();
    const day = Math.min(dayRef.current + 1, maxDay);
    const iso = `${year}-${pad(month)}-${pad(day)}`;
    await setOnboardingAnswer(userId, { birthday: iso });
    goBack();
  };

  return (
    <SettingsEditFrame title="Date of Birth" onBack={goBack} onSave={onSave}>
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
    </SettingsEditFrame>
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
