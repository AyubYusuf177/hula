import { StatusBar } from 'expo-status-bar';
import { useWindowDimensions, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';

import { hula } from '@/constants/theme';
import { HulaSkiaScene } from './HulaSkiaScene';
import { OnboardingContent } from './OnboardingContent';
import { ReferenceOverlay } from './ReferenceOverlay';
import { useOnboardingProgress } from './useOnboardingProgress';

/**
 * Interactive Hula onboarding: a single Skia scene + native content layer,
 * both driven by one gesture-controlled progress value (hero → transition →
 * auth), with a fully reversible pull-down.
 */
export function HulaOnboarding() {
  const { width, height } = useWindowDimensions();
  const { progress, gesture } = useOnboardingProgress();

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ flex: 1, backgroundColor: hula.colors.voidBlack }}>
        <HulaSkiaScene progress={progress} width={width} height={height} />
        <OnboardingContent progress={progress} />
        <ReferenceOverlay progress={progress} />
        <StatusBar style="light" />
      </View>
    </GestureDetector>
  );
}
