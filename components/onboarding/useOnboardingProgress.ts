import { useWindowDimensions } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import {
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';

import { hula } from '@/constants/theme';

export type OnboardingProgress = {
  /** 0 = hero, 0.5 = transition, 1 = auth. Drives Skia + content. */
  progress: SharedValue<number>;
  gesture: ReturnType<typeof Gesture.Pan>;
};

/**
 * Owns the single progress value that drives the whole onboarding scene and a
 * vertical pan gesture that maps swipe distance -> progress.
 *
 * - Swipe up from hero (0) advances toward auth (1), passing through the
 *   transition look at ~0.5.
 * - Release completes to auth when past a threshold or flung fast enough,
 *   otherwise springs back to the nearest resting state.
 * - On auth, pulling down reverses the exact same path back to hero.
 */
export function useOnboardingProgress(): OnboardingProgress {
  const { height } = useWindowDimensions();
  const progress = useSharedValue(0);
  const start = useSharedValue(0);

  const { swipeDistanceFrac, completeThreshold, velocityThreshold, spring } =
    hula.motion;
  const distance = height * swipeDistanceFrac;

  const gesture = Gesture.Pan()
    .onStart(() => {
      start.value = progress.value;
    })
    .onUpdate((e) => {
      // Upward drag (negative translationY) increases progress.
      const next = start.value - e.translationY / distance;
      progress.value = Math.min(1, Math.max(0, next));
    })
    .onEnd((e) => {
      const flungUp = e.velocityY < -velocityThreshold;
      const flungDown = e.velocityY > velocityThreshold;

      let target: number;
      if (flungUp) {
        target = 1;
      } else if (flungDown) {
        target = 0;
      } else if (start.value < 0.5) {
        // Started near hero: complete only if pushed past the threshold.
        target = progress.value > completeThreshold ? 1 : 0;
      } else {
        // Started near auth: fall back to hero only if pulled down enough.
        target = progress.value < 1 - completeThreshold ? 0 : 1;
      }

      progress.value = withSpring(target, {
        damping: spring.damping,
        stiffness: spring.stiffness,
        mass: spring.mass,
      });
    });

  return { progress, gesture };
}
