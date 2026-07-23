import { Ionicons } from '@expo/vector-icons';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { hula } from '@/constants/theme';
import type { IntegrationProviderConfig } from '@/data/integrations';
import type { IntegrationView } from '@/lib/integrationStatus';
import { IntegrationProviderIcon } from './IntegrationProviderIcon';

const font = hula.typography.fontFamily;

/**
 * Full-width integration row (Integrations V2).
 *
 * Premium glass card, horizontal layout: a product icon on the left, name +
 * summary in the middle, and state on the right. Connection state is EMERALD
 * only — never red — so a red-brand provider like Gmail never reads as an error.
 * A provider's brand colour lives ONLY inside its own product icon; disconnected
 * cards desaturate that icon so nothing pops until it's actually connected.
 * Tapping anywhere opens the details sheet.
 */
export function IntegrationCard({
  provider,
  view,
  onPress,
}: {
  provider: IntegrationProviderConfig;
  view: IntegrationView;
  onPress: () => void;
}) {
  const connected = view.state === 'connected';
  const busy = view.state === 'connecting';
  // An expired/error signal only ever shows on a NON-connected card, in amber.
  const attention = !connected && (view.state === 'expired' || view.state === 'error');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${provider.displayName}, ${view.statusLabel}`}
      style={({ pressed }) => [
        styles.card,
        connected && styles.cardConnected,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.iconTile, !connected && styles.iconTileMuted]}>
        <IntegrationProviderIcon provider={provider} size={32} dimmed={!connected} />
      </View>

      <View style={styles.textCol}>
        <Text style={styles.name} numberOfLines={1}>
          {provider.displayName}
        </Text>
        {/* Always the short, honest summary — never the email (which wraps badly). */}
        <Text style={styles.summary} numberOfLines={2}>
          {provider.summary}
        </Text>
      </View>

      <View style={styles.rightCol}>
        {connected ? (
          // Pill replaces the chevron here so the name always has room to fit.
          <View style={styles.connectedPill}>
            <View style={styles.connectedDot} />
            <Text style={styles.connectedPillText}>
              {view.partial ? 'Limited' : 'Connected'}
            </Text>
          </View>
        ) : busy ? (
          <>
            <View style={styles.mutedPill}>
              <Text style={styles.mutedPillText}>Connecting…</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={hula.colors.text.faint} />
          </>
        ) : attention ? (
          <>
            <View style={styles.attentionPill}>
              <Text style={styles.attentionPillText}>
                {view.state === 'expired' ? 'Reconnect' : 'Retry'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={hula.colors.text.faint} />
          </>
        ) : (
          <Ionicons name="chevron-forward" size={18} color={hula.colors.text.faint} />
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: hula.spacing.md,
    paddingVertical: hula.spacing.lg,
    paddingHorizontal: hula.spacing.lg,
    borderRadius: hula.radius.tile,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
  },
  cardConnected: {
    // Subtle emerald success treatment — no brand colour, never red.
    backgroundColor: 'rgba(20, 30, 44, 0.7)',
    borderColor: hula.status.successBorder,
    ...Platform.select({
      ios: {
        shadowColor: hula.status.successDot,
        shadowOpacity: 0.18,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
      },
      android: { elevation: 5 },
      default: {},
    }),
  },
  iconTile: {
    width: 48,
    height: 48,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(150,160,210,0.16)',
  },
  iconTileMuted: {
    backgroundColor: 'rgba(150, 160, 210, 0.05)',
    borderColor: 'rgba(150, 160, 210, 0.12)',
  },
  textCol: {
    flex: 1,
    // Let the column shrink so the name truncates within it rather than pushing
    // the pill off-screen.
    minWidth: 0,
  },
  name: {
    fontFamily: font.semiBold,
    fontSize: 15.5,
    color: hula.colors.text.primary,
  },
  summary: {
    marginTop: 2,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 17,
    color: hula.colors.text.tertiary,
  },
  rightCol: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 0,
  },
  connectedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: hula.radius.pill,
    backgroundColor: hula.status.successBg,
    borderWidth: 1,
    borderColor: hula.status.successBorder,
  },
  connectedDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: hula.status.successDot,
  },
  connectedPillText: {
    fontFamily: font.medium,
    fontSize: 11.5,
    color: hula.status.success,
  },
  mutedPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: hula.radius.pill,
    backgroundColor: hula.glass.tile,
  },
  mutedPillText: {
    fontFamily: font.medium,
    fontSize: 12,
    color: hula.colors.text.tertiary,
  },
  attentionPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: hula.radius.pill,
    backgroundColor: hula.status.attentionBg,
    borderWidth: 1,
    borderColor: hula.status.attentionBorder,
  },
  attentionPillText: {
    fontFamily: font.medium,
    fontSize: 12,
    color: hula.status.attention,
  },
  pressed: {
    opacity: 0.7,
  },
});
