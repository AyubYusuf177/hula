import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { hula } from '@/constants/theme';

const font = hula.typography.fontFamily;

type Props = {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
};

/**
 * The white pill CTA anchored to the bottom of every onboarding page
 * ("Accept and Continue", "Continue", "Allow Location", "Rate hula").
 *
 * Uses the shared `hula.button` tokens so it matches the launch/auth buttons,
 * with a subtle press scale/opacity. Disabled state dims to match the mockups
 * (e.g. the greyed-out "Continue" before an option is chosen).
 */
export function HulaBottomButton({ label, onPress, disabled = false, loading = false }: Props) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={hula.button.solidText} />
      ) : (
        <Text style={styles.label}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: hula.button.height,
    borderRadius: hula.button.radius,
    backgroundColor: hula.button.solidBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.button.fontSize,
    color: hula.button.solidText,
  },
  pressed: {
    transform: [{ scale: 0.98 }],
    opacity: 0.9,
  },
  disabled: {
    opacity: 0.4,
  },
});
