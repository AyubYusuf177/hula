import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { hula } from '@/constants/theme';

type Props = {
  /** 0..1 fill fraction for the current step. */
  progress: number;
};

/**
 * Top-of-screen onboarding progress bar: a rounded dark track with a
 * purple→blue gradient fill that animates its width whenever `progress`
 * changes, matching the mockups.
 */
export function HulaProgressBar({ progress }: Props) {
  const clamped = Math.min(1, Math.max(0, progress));
  const width = useSharedValue(clamped);

  useEffect(() => {
    width.value = withTiming(clamped, { duration: 320 });
  }, [clamped, width]);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${width.value * 100}%`,
  }));

  return (
    <View style={styles.track}>
      <Animated.View style={[styles.fill, fillStyle]}>
        <LinearGradient
          colors={[hula.glow.purple, hula.glow.blueBright]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 4,
    borderRadius: hula.radius.pill,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: hula.radius.pill,
    overflow: 'hidden',
  },
});
