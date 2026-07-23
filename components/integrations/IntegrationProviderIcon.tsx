import { Image } from 'expo-image';
import { View } from 'react-native';

import type { IntegrationProviderConfig } from '@/data/integrations';

/** Product mark renderer shared by cards, sheets and connect buttons. */
export function IntegrationProviderIcon({
  provider,
  size,
  dimmed = false,
}: {
  provider: IntegrationProviderConfig;
  size: number;
  dimmed?: boolean;
}) {
  if (provider.brandMark === 'microsoft') {
    const gap = Math.max(1, Math.round(size * 0.08));
    const square = (size - gap) / 2;
    return (
      <View
        accessibilityLabel={provider.displayName}
        style={{
          width: size,
          height: size,
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap,
          opacity: dimmed ? 0.42 : 1,
        }}
      >
        <View style={{ width: square, height: square, backgroundColor: '#F25022' }} />
        <View style={{ width: square, height: square, backgroundColor: '#7FBA00' }} />
        <View style={{ width: square, height: square, backgroundColor: '#00A4EF' }} />
        <View style={{ width: square, height: square, backgroundColor: '#FFB900' }} />
      </View>
    );
  }

  if (!provider.iconImage) return null;
  return (
    <Image
      source={provider.iconImage}
      style={{ width: size, height: size, opacity: dimmed ? 0.42 : 1 }}
      contentFit="contain"
      accessibilityLabel={provider.displayName}
    />
  );
}
