import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HulaBottomButton } from '@/components/onboarding';
import { hula } from '@/constants/theme';

const font = hula.typography.fontFamily;

type Props = {
  title: string;
  onBack: () => void;
  /** When provided, renders the bottom Save button. */
  onSave?: () => void;
  saveLabel?: string;
  saveDisabled?: boolean;
  children: ReactNode;
};

/**
 * Shared chrome for the Settings edit screens (Name, DOB, Sex, Tone, Helps With,
 * Source, iMessage). Provides the dark ambient background, the drag handle +
 * back button + centered title header, and an optional bottom Save button, so
 * each edit screen only supplies its own body.
 */
export function SettingsEditFrame({
  title,
  onBack,
  onSave,
  saveLabel = 'Save',
  saveDisabled = false,
  children,
}: Props) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar style="light" />
      <AmbientGlow />

      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={onBack}
            hitSlop={10}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
          >
            <Ionicons name="chevron-back" size={22} color={hula.colors.text.primary} />
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.headerSpacer} />
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.body}>{children}</View>
        {onSave ? (
          <View style={styles.footer}>
            <HulaBottomButton label={saveLabel} onPress={onSave} disabled={saveDisabled} />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Soft ambient purple/blue bloom, clipped so it never scrolls horizontally. */
function AmbientGlow() {
  return (
    <View pointerEvents="none" style={styles.glowLayer}>
      <View style={[styles.glow, styles.glowPurple]} />
      <View style={[styles.glow, styles.glowBlue]} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: hula.colors.voidBlack,
  },
  flex: {
    flex: 1,
  },
  glowLayer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    width: 320,
    height: 320,
    borderRadius: 160,
  },
  glowPurple: {
    left: -180,
    top: '14%',
    backgroundColor: 'rgba(123,77,255,0.16)',
  },
  glowBlue: {
    right: -190,
    top: '34%',
    backgroundColor: 'rgba(62,123,255,0.12)',
  },
  header: {
    paddingHorizontal: hula.spacing.xl,
    paddingTop: hula.spacing.sm,
    paddingBottom: hula.spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: hula.spacing.md,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Invisible, non-interactive spacer that balances the back button so the
  // title stays centered (no visible circle, nothing tappable).
  headerSpacer: {
    width: 40,
    height: 40,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontFamily: font.bold,
    fontSize: 22,
    color: hula.colors.text.primary,
  },
  body: {
    flex: 1,
    paddingHorizontal: hula.spacing.xl,
    paddingTop: hula.spacing.xl,
  },
  footer: {
    paddingHorizontal: hula.spacing.xl,
    paddingBottom: hula.spacing.lg,
  },
  pressed: {
    opacity: 0.6,
  },
});
