import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { hula } from '@/constants/theme';
import type { IoniconName } from '@/data/hulaOnboarding';

const font = hula.typography.fontFamily;

type Props = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  /** Optional leading Ionicons glyph (help / discovery options use these). */
  icon?: IoniconName;
  /** Show the white check circle when selected (default true). */
  showCheck?: boolean;
};

/**
 * A rounded glass "pill" option row used across the sex / help / discovery
 * pages. Selected state gets a light border and a white checkmark circle,
 * matching the mockups. Press gives a subtle scale/opacity response.
 */
export function HulaOptionCard({
  label,
  selected = false,
  onPress,
  icon,
  showCheck = true,
}: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        selected && styles.cardSelected,
        pressed && styles.pressed,
      ]}
    >
      {icon ? (
        <Ionicons
          name={icon}
          size={22}
          color={hula.colors.text.primary}
          style={styles.icon}
        />
      ) : null}

      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>

      {selected && showCheck ? (
        <View style={styles.check}>
          <Ionicons name="checkmark" size={16} color={hula.button.solidText} />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 64,
    borderRadius: hula.radius.pill,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: 'transparent',
    paddingHorizontal: hula.spacing.xl,
    paddingVertical: hula.spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardSelected: {
    borderColor: 'rgba(246,248,255,0.55)',
    backgroundColor: 'rgba(28,33,60,0.75)',
  },
  icon: {
    marginRight: hula.spacing.lg,
  },
  label: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: hula.typography.hint.fontSize,
    color: hula.colors.text.primary,
  },
  check: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: hula.button.solidBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: hula.spacing.md,
  },
  pressed: {
    transform: [{ scale: 0.99 }],
    opacity: 0.9,
  },
});
