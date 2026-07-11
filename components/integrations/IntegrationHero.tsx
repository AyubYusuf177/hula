import { Image } from 'expo-image';
import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';

import { images } from '@/constants/images';
import { hula } from '@/constants/theme';
import type { IntegrationProviderConfig } from '@/data/integrations';

/**
 * Ambient hero panel for the Integrations screen (Section 13).
 *
 * The real, transparent Hula mark (assets/images/hula-logo-transparent.png) sits
 * centred on the dark glass — NO white square wrapper. A restrained field of
 * orbital dots drifts around it, and each CONNECTED provider's real product icon
 * softly appears and slowly orbits the mark. Driven entirely by
 * `connectedProviders`, so it scales as more integrations connect.
 *
 * React Native Animated only (no native-only deps) → Expo Go compatible. All
 * motion is slow and subtle. The panel has a fixed height and clips its contents,
 * so loading never shifts the page layout.
 */

const PANEL_HEIGHT = 210;
const LOGO_SIZE = 78;
const ORBIT_RADIUS = 70;
const ICON_BADGE = 42;

/** Precomputed decorative dot field (two rings) around the centre. */
const DOTS = buildDots();

type Dot = { x: number; y: number; size: number; opacity: number };

function buildDots(): Dot[] {
  const dots: Dot[] = [];
  const rings = [
    { count: 14, radius: 50, size: 3, opacity: 0.5 },
    { count: 20, radius: 88, size: 2.5, opacity: 0.28 },
  ];
  for (const ring of rings) {
    for (let i = 0; i < ring.count; i += 1) {
      const angle = (i / ring.count) * Math.PI * 2 + ring.radius; // offset per ring
      dots.push({
        x: Math.cos(angle) * ring.radius,
        y: Math.sin(angle) * ring.radius,
        size: ring.size,
        opacity: ring.opacity,
      });
    }
  }
  return dots;
}

export function IntegrationHero({
  connectedProviders,
}: {
  connectedProviders: IntegrationProviderConfig[];
}) {
  // One slow, shared driver for the orbit and the dot drift.
  const spin = useRef(new Animated.Value(0)).current;
  // Gentle breathing of the whole dot field.
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const orbit = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 48000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 4200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 4200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    orbit.start();
    breathe.start();
    return () => {
      orbit.stop();
      breathe.stop();
    };
  }, [spin, pulse]);

  // Slow counter-drift for the dot field (opposite the orbit, even slower feel).
  const dotSpin = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '-24deg'],
  });
  const dotOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0.85] });
  const logoScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.99, 1.03] });

  const count = connectedProviders.length;

  return (
    <View style={styles.panel}>
      {/* Soft ambient bloom behind everything (clipped by the panel). */}
      <View pointerEvents="none" style={styles.bloom} />

      {/* Drifting dot field */}
      <Animated.View
        pointerEvents="none"
        style={[styles.centerLayer, { opacity: dotOpacity, transform: [{ rotate: dotSpin }] }]}
      >
        {DOTS.map((dot, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                width: dot.size,
                height: dot.size,
                borderRadius: dot.size / 2,
                opacity: dot.opacity,
                transform: [{ translateX: dot.x }, { translateY: dot.y }],
              },
            ]}
          />
        ))}
      </Animated.View>

      {/* Orbiting connected-provider icons (backend truth only) */}
      <View pointerEvents="none" style={styles.centerLayer}>
        {connectedProviders.map((provider, i) => (
          <OrbitIcon
            key={provider.id}
            provider={provider}
            spin={spin}
            baseAngle={count > 0 ? (i / count) * 360 : 0}
          />
        ))}
      </View>

      {/* Centre: soft glow + the real transparent Hula mark */}
      <Animated.View style={[styles.logoWrap, { transform: [{ scale: logoScale }] }]}>
        <View style={styles.logoGlow} />
        <Image
          source={images.hulaLogoTransparent}
          style={styles.logo}
          contentFit="contain"
          accessibilityLabel="Hula"
        />
      </Animated.View>
    </View>
  );
}

/** A single connected provider icon that orbits the mark and fades in on mount. */
function OrbitIcon({
  provider,
  spin,
  baseAngle,
}: {
  provider: IntegrationProviderConfig;
  spin: Animated.Value;
  baseAngle: number;
}) {
  const appear = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.timing(appear, {
      toValue: 1,
      duration: 700,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [appear]);

  // One driver, offset per provider: rotate base → base+360, and counter-rotate
  // the icon so the product mark stays upright while orbiting the centre.
  const rotate = useMemo(
    () =>
      spin.interpolate({
        inputRange: [0, 1],
        outputRange: [`${baseAngle}deg`, `${baseAngle + 360}deg`],
      }),
    [spin, baseAngle],
  );
  const counter = useMemo(
    () =>
      spin.interpolate({
        inputRange: [0, 1],
        outputRange: [`${-baseAngle}deg`, `${-baseAngle - 360}deg`],
      }),
    [spin, baseAngle],
  );
  const scale = appear.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });

  return (
    <Animated.View style={[styles.orbitAnchor, { transform: [{ rotate }] }]}>
      <View style={{ transform: [{ translateY: -ORBIT_RADIUS }] }}>
        <Animated.View
          style={[
            styles.iconBadge,
            { opacity: appear, transform: [{ rotate: counter }, { scale }] },
          ]}
        >
          <Image
            source={provider.iconImage}
            style={styles.iconImage}
            contentFit="contain"
            accessibilityLabel={provider.displayName}
          />
        </Animated.View>
      </View>
    </Animated.View>
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
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: 'rgba(123,77,255,0.10)',
    ...Platform.select({
      ios: { shadowColor: hula.glow.purple, shadowOpacity: 0.5, shadowRadius: 60, shadowOffset: { width: 0, height: 0 } },
      default: {},
    }),
  },
  // A zero-size layer at the panel centre; children position by transform.
  centerLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    position: 'absolute',
    backgroundColor: hula.glow.silver,
  },
  orbitAnchor: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBadge: {
    width: ICON_BADGE,
    height: ICON_BADGE,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 10, shadowOffset: { width: 0, height: 3 } },
      default: { elevation: 4 },
    }),
  },
  iconImage: {
    width: ICON_BADGE,
    height: ICON_BADGE,
  },
  logoWrap: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoGlow: {
    position: 'absolute',
    width: LOGO_SIZE + 24,
    height: LOGO_SIZE + 24,
    borderRadius: (LOGO_SIZE + 24) / 2,
    backgroundColor: 'rgba(123,77,255,0.18)',
    ...Platform.select({
      ios: { shadowColor: hula.glow.purple, shadowOpacity: 0.6, shadowRadius: 22, shadowOffset: { width: 0, height: 0 } },
      default: {},
    }),
  },
  logo: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
  },
});
