import { Image } from 'expo-image';
import { Platform, StyleSheet, View } from 'react-native';

import { images } from '@/constants/images';
import { hula } from '@/constants/theme';

/**
 * Integrations hero (Integrations V2).
 *
 * A premium glass panel with the Hula mark centred on a soft purple bloom.
 * Deliberately STATIC — no orbit, no drifting dots, no floating provider icons,
 * no text under the logo. A smaller footprint than before so the connected
 * cards sit higher on the screen. Fixed height + clipped so nothing shifts on
 * load.
 */

const PANEL_HEIGHT = 176;
const LOGO_SIZE = 108;

export function IntegrationHero() {
  return (
    <View style={styles.panel}>
      <View pointerEvents="none" style={styles.bloom} />
      <View style={styles.logoWrap}>
        <View style={styles.logoGlow} />
        <Image
          source={images.hulaLogoTransparent}
          style={styles.logo}
          contentFit="contain"
          accessibilityLabel="Hula"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    height: PANEL_HEIGHT,
    borderRadius: hula.radius.card,
    backgroundColor: hula.glass.card,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bloom: {
    position: 'absolute',
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: 'rgba(123,77,255,0.12)',
    ...Platform.select({
      ios: {
        shadowColor: hula.glow.purple,
        shadowOpacity: 0.5,
        shadowRadius: 60,
        shadowOffset: { width: 0, height: 0 },
      },
      default: {},
    }),
  },
  logoWrap: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoGlow: {
    position: 'absolute',
    width: LOGO_SIZE + 28,
    height: LOGO_SIZE + 28,
    borderRadius: (LOGO_SIZE + 28) / 2,
    backgroundColor: 'rgba(123,77,255,0.16)',
    ...Platform.select({
      ios: {
        shadowColor: hula.glow.purple,
        shadowOpacity: 0.55,
        shadowRadius: 26,
        shadowOffset: { width: 0, height: 0 },
      },
      default: {},
    }),
  },
  logo: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
  },
});
