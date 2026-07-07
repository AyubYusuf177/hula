import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { hula } from '@/constants/theme';

/* Shared wheel geometry — exported so parents can size a centered selection
 * pill (Miora-style) that lines up exactly with the middle row. */
export const WHEEL_ITEM_H = 48;
export const WHEEL_VISIBLE = 5;
export const WHEEL_H = WHEEL_ITEM_H * WHEEL_VISIBLE;
export const WHEEL_PAD = WHEEL_ITEM_H * ((WHEEL_VISIBLE - 1) / 2);

const clampIndex = (n: number, max: number) => Math.max(0, Math.min(max, n));

type Props = {
  items: string[];
  initialIndex: number;
  /** Fired the instant the centered item changes (live, while scrolling). */
  onIndexChange: (index: number) => void;
  style?: StyleProp<ViewStyle>;
  fontSize?: number;
};

/**
 * A single fixed-height wheel column built on a plain `ScrollView` — Expo Go
 * friendly, no picker package.
 *
 * Design goals (from the stabilisation pass):
 * - Free, unrestricted scrolling across long lists (no `disableIntervalMomentum`,
 *   so a single fling travels many items and never gets "stuck" at boundaries).
 * - The highlight updates *immediately* as the centered item changes, driven by
 *   `onScroll` at 16ms — not on a delayed settle.
 * - Cheap per-frame work: each row is a memoized `WheelItem`, so a scroll tick
 *   only re-renders the two rows whose highlighted state actually flips.
 *
 * `snapToInterval` + `decelerationRate="fast"` give the crisp centered snap.
 */
export const HulaWheelPicker = memo(function HulaWheelPicker({
  items,
  initialIndex,
  onIndexChange,
  style,
  fontSize = 22,
}: Props) {
  const ref = useRef<ScrollView>(null);
  const [active, setActive] = useState(initialIndex);
  const activeRef = useRef(initialIndex);
  const maxIndex = items.length - 1;

  useEffect(() => {
    // Position at the hydrated index once layout exists (next frame) so the
    // wheel never sticks at the top on first render.
    const id = requestAnimationFrame(() => {
      ref.current?.scrollTo({ y: initialIndex * WHEEL_ITEM_H, animated: false });
    });
    return () => cancelAnimationFrame(id);
  }, [initialIndex]);

  const report = useCallback(
    (i: number) => {
      if (i === activeRef.current) return;
      activeRef.current = i;
      setActive(i);
      onIndexChange(i);
    },
    [onIndexChange],
  );

  const indexFromEvent = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    clampIndex(Math.round(e.nativeEvent.contentOffset.y / WHEEL_ITEM_H), maxIndex);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => report(indexFromEvent(e)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report, maxIndex],
  );

  return (
    <ScrollView
      ref={ref}
      style={[styles.wheel, style]}
      showsVerticalScrollIndicator={false}
      snapToInterval={WHEEL_ITEM_H}
      snapToAlignment="start"
      decelerationRate="fast"
      scrollEventThrottle={16}
      onScroll={onScroll}
      onMomentumScrollEnd={onScroll}
      onScrollEndDrag={onScroll}
      nestedScrollEnabled
      contentContainerStyle={styles.content}
    >
      {items.map((label, i) => (
        <WheelItem key={`${label}-${i}`} label={label} active={i === active} fontSize={fontSize} />
      ))}
    </ScrollView>
  );
});

const WheelItem = memo(function WheelItem({
  label,
  active,
  fontSize,
}: {
  label: string;
  active: boolean;
  fontSize: number;
}) {
  return (
    <View style={styles.item}>
      <Text
        numberOfLines={1}
        style={[styles.text, { fontSize }, active ? styles.active : styles.inactive]}
      >
        {label}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  wheel: {
    height: WHEEL_H,
  },
  content: {
    paddingVertical: WHEEL_PAD,
  },
  item: {
    height: WHEEL_ITEM_H,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: hula.spacing.sm,
  },
  text: {
    textAlign: 'center',
  },
  active: {
    fontFamily: hula.typography.fontFamily.semiBold,
    color: hula.colors.text.primary,
  },
  inactive: {
    fontFamily: hula.typography.fontFamily.regular,
    color: hula.colors.text.faint,
  },
});
