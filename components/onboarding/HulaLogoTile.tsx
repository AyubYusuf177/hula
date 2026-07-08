import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';

import { hula } from '@/constants/theme';
import { images } from '@/constants/images';

type Props = {
  /** Outer tile size in px (default 92, matching the mockups). */
  size?: number;
};

/**
 * The glass "app icon" tile with Hula's glowing orb — the real project logo.
 *
 * `assets/images/hula-logo.png` is the actual Hula tile, but it ships on an
 * opaque white canvas (no alpha) with ~20% margin on each side. Rather than
 * approximate the orb with drawn shapes (which didn't match), we render the
 * real asset and crop the white border away: the image is scaled up inside an
 * `overflow: hidden` rounded container so only the dark tile interior + orb
 * remain, and the rounded corners clip any residual white. No new asset needed.
 *
 * If the image ever fails to load, we render a drawn orb/glyph fallback (never a
 * blank square) so the tile always shows *something* on brand.
 */
export function HulaLogoTile({ size = 92 }: Props) {
  const radius = size * 0.3;
  const [failed, setFailed] = useState(false);

  return (
    <View style={[styles.glowWrap, { borderRadius: radius }]}>
      <View
        style={[styles.clip, { width: size, height: size, borderRadius: radius }]}
      >
        {failed ? (
          <OrbFallback size={size} />
        ) : (
          <Image
            source={images.hulaLogo}
            style={{ width: size, height: size, transform: [{ scale: ZOOM }] }}
            resizeMode="cover"
            onError={() => setFailed(true)}
          />
        )}
      </View>
    </View>
  );
}

/** Drawn on-brand orb used when the logo image can't be displayed. */
function OrbFallback({ size }: { size: number }) {
  const orb = size * 0.62;
  return (
    <View style={styles.fallback}>
      <LinearGradient
        colors={[hula.orb.rimLeft, hula.glow.iris, hula.orb.rimRight]}
        start={{ x: 0.2, y: 0.1 }}
        end={{ x: 0.85, y: 0.95 }}
        style={{ width: orb, height: orb, borderRadius: orb / 2 }}
      />
    </View>
  );
}

// Show the central ~52% of the source image so the white margin (~20% a side)
// is pushed outside the clip and only the dark tile + orb are visible.
const ZOOM = 1.92;

const styles = StyleSheet.create({
  glowWrap: {
    ...Platform.select({
      ios: {
        shadowColor: hula.glow.purple,
        shadowOpacity: 0.5,
        shadowRadius: 22,
        shadowOffset: { width: 0, height: 0 },
      },
      default: {},
    }),
  },
  clip: {
    overflow: 'hidden',
    backgroundColor: hula.orb.coreOuter,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
