import { StyleSheet, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';

/**
 * CALIBRATION ONLY — never production UI.
 *
 * When `SHOW_REFERENCE_OVERLAY` is true this fades the golden reference images
 * over the live native scene at 25% opacity so the layered Skia graphics can be
 * visually aligned to them. It is disabled by default and is the ONLY module in
 * the app allowed to import the reference PNGs.
 */
export const SHOW_REFERENCE_OVERLAY = false;

const CLAMP = Extrapolation.CLAMP;
const MAX_OPACITY = 0.25;

type Props = {
  progress: SharedValue<number>;
};

export function ReferenceOverlay({ progress }: Props) {
  const heroStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.5], [MAX_OPACITY, 0], CLAMP),
  }));
  const transitionStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      progress.value,
      [0.25, 0.5, 0.75],
      [0, MAX_OPACITY, 0],
      CLAMP,
    ),
  }));
  const authStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.5, 1], [0, MAX_OPACITY], CLAMP),
  }));

  // Guarded so the reference PNGs are only ever loaded/rendered for calibration.
  // (Metro still statically bundles the requires, but they are never evaluated
  // or shown while the flag is false.)
  if (!SHOW_REFERENCE_OVERLAY) return null;

  const references = {
    hero: require('@/prompt_material/hula-screen-references/onboarding-hero-reference.png'),
    transition: require('@/prompt_material/hula-screen-references/onboarding-transition-reference.png'),
    auth: require('@/prompt_material/hula-screen-references/onboarding-auth-reference.png'),
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Animated.Image
        source={references.hero}
        resizeMode="cover"
        style={[StyleSheet.absoluteFill, heroStyle]}
      />
      <Animated.Image
        source={references.transition}
        resizeMode="cover"
        style={[StyleSheet.absoluteFill, transitionStyle]}
      />
      <Animated.Image
        source={references.auth}
        resizeMode="cover"
        style={[StyleSheet.absoluteFill, authStyle]}
      />
    </View>
  );
}
