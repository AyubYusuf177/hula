import {
  BlurMask,
  Canvas,
  Circle,
  Fill,
  Group,
  LinearGradient,
  Oval,
  RadialGradient,
  Rect,
  RoundedRect,
  SweepGradient,
  vec,
} from '@shopify/react-native-skia';
import { StyleSheet } from 'react-native';
import {
  Extrapolation,
  interpolate,
  useDerivedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { hula } from '@/constants/theme';

type Props = {
  progress: SharedValue<number>;
  width: number;
  height: number;
};

const CLAMP = Extrapolation.CLAMP;

// Stops used across the scene for the three onboarding states.
const STOPS = [0, 0.5, 1];

/**
 * The entire premium onboarding scene, drawn with Skia and driven by a single
 * reanimated `progress` value. Nothing here is a screenshot or a flat RN View —
 * the background, orb and logo tile are all real layered Skia graphics.
 */
export function HulaSkiaScene({ progress, width: W, height: H }: Props) {
  const cx = W / 2;
  const { orb, logo } = hula.onboarding;

  /* ── Orb geometry (interpolated across hero → transition → auth) ── */
  const orbCy = useDerivedValue(() =>
    interpolate(progress.value, STOPS, [...orb.centerYFrac], CLAMP) * H,
  );
  const orbR = useDerivedValue(() =>
    interpolate(progress.value, STOPS, [...orb.radiusWFrac], CLAMP) * W,
  );
  const orbOpacity = useDerivedValue(() =>
    interpolate(
      progress.value,
      [...orb.opacityStops],
      [...orb.opacityValues],
      CLAMP,
    ),
  );

  // Derived vectors / scalars that depend on the live orb center + radius.
  const orbCenter = useDerivedValue(() => vec(cx, orbCy.value));
  const bodyCenter = useDerivedValue(() => vec(cx, orbCy.value - orbR.value * 0.18));
  const rimStart = useDerivedValue(() => vec(cx - orbR.value, orbCy.value + orbR.value * 0.15));
  const rimEnd = useDerivedValue(() => vec(cx + orbR.value, orbCy.value + orbR.value * 0.15));
  const rimGlowWidth = useDerivedValue(() => orbR.value * 0.1);
  const rimCrispWidth = useDerivedValue(() => orbR.value * 0.028);
  const rimGlowBlur = useDerivedValue(() => orbR.value * 0.14);
  const rimCrispBlur = useDerivedValue(() => orbR.value * 0.02);

  // Bottom ambient bloom pooled under the orb (purple-left, blue-right).
  const bloomLeftCenter = useDerivedValue(() =>
    vec(cx - orbR.value * 0.5, orbCy.value + orbR.value * 0.52),
  );
  const bloomRightCenter = useDerivedValue(() =>
    vec(cx + orbR.value * 0.5, orbCy.value + orbR.value * 0.52),
  );
  const bloomRadius = useDerivedValue(() => orbR.value * 0.8);
  const bloomBlur = useDerivedValue(() => orbR.value * 0.55);

  // Upper-left glossy specular highlight.
  const specCenter = useDerivedValue(() =>
    vec(cx - orbR.value * 0.34, orbCy.value - orbR.value * 0.52),
  );
  const specRadius = useDerivedValue(() => orbR.value * 0.3);
  const specBlur = useDerivedValue(() => orbR.value * 0.16);

  /* ── Logo tile (static final position, fades in late) ── */
  const tileOpacity = useDerivedValue(() =>
    interpolate(
      progress.value,
      [...logo.opacityStops],
      [...logo.opacityValues],
      CLAMP,
    ),
  );
  const tileSize = W * logo.tileSizeWFrac;
  const tileHalf = tileSize / 2;
  const tileCx = cx;
  const tileCy = H * logo.centerYFrac;
  const tileX = tileCx - tileHalf;
  const tileY = tileCy - tileHalf;
  const ringW = tileSize * 0.56;
  const ringH = tileSize * 0.36;

  /* ── Background central glow (tightens subtly as we reach auth) ── */
  const bgGlowCenter = vec(cx, H * 0.36);
  const bgGlowRadius = useDerivedValue(() =>
    interpolate(progress.value, [0, 1], [W * 1.15, W * 0.72], CLAMP),
  );

  const c = hula.colors;
  const g = hula.glow;
  const o = hula.orb;

  return (
    <Canvas style={StyleSheet.absoluteFill}>
      {/* ── Premium layered background ── */}
      <Fill color={c.voidBlack} />

      {/* Base vertical lift: deep navy rising from the void */}
      <Rect x={0} y={0} width={W} height={H}>
        <LinearGradient
          start={vec(0, 0)}
          end={vec(0, H)}
          colors={[c.baseNavy, c.deepNavy, c.baseNavy]}
          positions={[0, 0.55, 1]}
        />
      </Rect>

      {/* Purple undertone, lower-left */}
      <Circle c={vec(W * 0.08, H * 0.82)} r={W * 0.85}>
        <BlurMask blur={140} style="normal" />
        <RadialGradient
          c={vec(W * 0.08, H * 0.82)}
          r={W * 0.85}
          colors={['rgba(84,42,168,0.5)', 'rgba(84,42,168,0.0)']}
          positions={[0, 1]}
        />
      </Circle>

      {/* Electric blue undertone, lower-right */}
      <Circle c={vec(W * 0.94, H * 0.78)} r={W * 0.85}>
        <BlurMask blur={140} style="normal" />
        <RadialGradient
          c={vec(W * 0.94, H * 0.78)}
          r={W * 0.85}
          colors={['rgba(34,74,190,0.42)', 'rgba(34,74,190,0.0)']}
          positions={[0, 1]}
        />
      </Circle>

      {/* Subtle central ambient glow that tightens toward auth */}
      <Circle c={bgGlowCenter} r={bgGlowRadius}>
        <BlurMask blur={120} style="normal" />
        <RadialGradient
          c={bgGlowCenter}
          r={bgGlowRadius}
          colors={['rgba(111,91,255,0.16)', 'rgba(111,91,255,0.0)']}
          positions={[0, 1]}
        />
      </Circle>

      {/* Dark vignette pulling depth into the edges/corners */}
      <Rect x={0} y={0} width={W} height={H}>
        <RadialGradient
          c={vec(cx, H * 0.44)}
          r={Math.max(W, H) * 0.72}
          colors={['rgba(2,3,10,0.0)', 'rgba(2,3,10,0.0)', 'rgba(2,3,10,0.72)']}
          positions={[0, 0.62, 1]}
        />
      </Rect>

      {/* ── The orb ── */}
      <Group opacity={orbOpacity}>
        {/* Bottom ambient bloom (purple-left) */}
        <Circle c={bloomLeftCenter} r={bloomRadius} color={g.purple} opacity={0.55}>
          <BlurMask blur={bloomBlur} style="normal" />
        </Circle>
        {/* Bottom ambient bloom (blue-right) */}
        <Circle c={bloomRightCenter} r={bloomRadius} color={g.blue} opacity={0.5}>
          <BlurMask blur={bloomBlur} style="normal" />
        </Circle>

        {/* Dark glass body with inner depth shading */}
        <Circle c={orbCenter} r={orbR}>
          <RadialGradient
            c={bodyCenter}
            r={orbR}
            colors={[o.coreInner, o.coreOuter, '#0C0F1E']}
            positions={[0, 0.62, 1]}
          />
        </Circle>

        {/* Soft rim glow (purple → blue), just the sphere edge */}
        <Circle
          c={orbCenter}
          r={orbR}
          style="stroke"
          strokeWidth={rimGlowWidth}
        >
          <BlurMask blur={rimGlowBlur} style="normal" />
          <LinearGradient
            start={rimStart}
            end={rimEnd}
            colors={[o.rimLeft, '#7E7BFF', o.rimRight]}
            positions={[0, 0.5, 1]}
          />
        </Circle>

        {/* Crisp bright rim line on top */}
        <Circle
          c={orbCenter}
          r={orbR}
          style="stroke"
          strokeWidth={rimCrispWidth}
          opacity={0.9}
        >
          <BlurMask blur={rimCrispBlur} style="normal" />
          <LinearGradient
            start={rimStart}
            end={rimEnd}
            colors={[g.purpleBright, '#CFD6FF', g.blueBright]}
            positions={[0, 0.5, 1]}
          />
        </Circle>

        {/* Upper-left glossy specular highlight */}
        <Circle c={specCenter} r={specRadius} color={o.highlight} opacity={0.5}>
          <BlurMask blur={specBlur} style="normal" />
        </Circle>
      </Group>

      {/* ── Logo tile / ring / glow (auth state) ── */}
      <Group opacity={tileOpacity}>
        {/* Tile outer glow */}
        <RoundedRect
          x={tileX - 10}
          y={tileY - 10}
          width={tileSize + 20}
          height={tileSize + 20}
          r={hula.radius.tile + 8}
          color={g.iris}
          opacity={0.35}
        >
          <BlurMask blur={28} style="normal" />
        </RoundedRect>

        {/* Glass tile shell */}
        <RoundedRect
          x={tileX}
          y={tileY}
          width={tileSize}
          height={tileSize}
          r={hula.radius.tile}
        >
          <RadialGradient
            c={vec(tileCx, tileY + tileSize * 0.35)}
            r={tileSize}
            colors={['rgba(30,34,64,0.9)', 'rgba(12,14,28,0.92)']}
            positions={[0, 1]}
          />
        </RoundedRect>
        {/* Subtle tile border */}
        <RoundedRect
          x={tileX}
          y={tileY}
          width={tileSize}
          height={tileSize}
          r={hula.radius.tile}
          style="stroke"
          strokeWidth={1}
          color="rgba(160,170,220,0.22)"
        />

        {/* Ring glow (blurred, behind the crisp ring) */}
        <Group
          transform={[{ rotate: -0.5 }]}
          origin={vec(tileCx, tileCy)}
        >
          <Oval
            x={tileCx - ringW / 2}
            y={tileCy - ringH / 2}
            width={ringW}
            height={ringH}
            style="stroke"
            strokeWidth={9}
          >
            <BlurMask blur={10} style="normal" />
            <SweepGradient
              c={vec(tileCx, tileCy)}
              colors={[g.purple, g.blue, g.white, g.purpleBright, g.purple]}
            />
          </Oval>
          {/* Crisp ring */}
          <Oval
            x={tileCx - ringW / 2}
            y={tileCy - ringH / 2}
            width={ringW}
            height={ringH}
            style="stroke"
            strokeWidth={3.5}
          >
            <SweepGradient
              c={vec(tileCx, tileCy)}
              colors={[g.purpleBright, g.blueBright, g.white, g.purpleBright]}
            />
          </Oval>
        </Group>
      </Group>
    </Canvas>
  );
}
