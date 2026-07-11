import { Image } from 'expo-image';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { hula } from '@/constants/theme';
import type { IntegrationProviderConfig } from '@/data/integrations';
import type { IntegrationView } from '@/lib/integrationStatus';

const font = hula.typography.fontFamily;

/**
 * Reusable integration card (Section 13). Compact and refined: the real product
 * icon, a clear title, and an honest status line. Disconnected cards read muted;
 * a connected card gains a restrained Hula sky/violet border + glow. A transient
 * error shows inline WITHOUT overwriting backend-connected truth. Tapping anywhere
 * opens the details sheet. Every future provider reuses this same card.
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
  // An error/expired signal only ever shows on a NON-connected card.
  const attention = !connected && (view.state === 'expired' || view.state === 'error');

  const statusText = busy
    ? 'Connecting…'
    : connected
      ? 'Connected'
      : view.state === 'expired'
        ? 'Reconnect needed'
        : view.state === 'error'
          ? 'Tap to retry'
          : 'Not connected';

  const statusColor = connected
    ? provider.accent
    : attention
      ? '#F0A868'
      : hula.colors.text.tertiary;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${provider.displayName}, ${statusText}`}
      style={({ pressed }) => [
        styles.card,
        connected && styles.cardConnected,
        connected &&
          Platform.select({
            ios: {
              shadowColor: provider.accent,
              shadowOpacity: 0.3,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: 0 },
            },
            default: {},
          }),
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.topRow}>
        <View style={[styles.iconTile, !connected && styles.iconTileMuted]}>
          <Image
            source={provider.iconImage}
            style={[styles.icon, !connected && styles.iconMuted]}
            contentFit="contain"
            accessibilityLabel={provider.displayName}
          />
        </View>
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
      </View>

      <Text style={[styles.name, !connected && styles.nameMuted]} numberOfLines={1}>
        {provider.displayName}
      </Text>

      <Text style={[styles.status, { color: statusColor }]} numberOfLines={1}>
        {statusText}
      </Text>

      {connected && view.accountLabel ? (
        <Text style={styles.account} numberOfLines={1}>
          {view.accountLabel}
        </Text>
      ) : (
        <Text style={styles.summary} numberOfLines={2}>
          {provider.summary}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexGrow: 1,
    flexBasis: '47%',
    minHeight: 152,
    padding: hula.spacing.lg,
    borderRadius: hula.radius.tile,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
  },
  cardConnected: {
    borderColor: 'rgba(92,168,255,0.55)',
    backgroundColor: 'rgba(20,28,56,0.72)',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: hula.spacing.md,
  },
  iconTile: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconTileMuted: {
    opacity: 0.9,
  },
  icon: {
    width: 44,
    height: 44,
  },
  iconMuted: {
    // Slightly desaturate the disconnected icon by dimming it.
    opacity: 0.55,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 4,
  },
  name: {
    fontFamily: font.semiBold,
    fontSize: 16,
    color: hula.colors.text.primary,
  },
  nameMuted: {
    color: hula.colors.text.secondary,
  },
  status: {
    marginTop: 2,
    fontFamily: font.medium,
    fontSize: 13,
  },
  account: {
    marginTop: 6,
    fontFamily: font.regular,
    fontSize: 12,
    color: hula.colors.text.tertiary,
  },
  summary: {
    marginTop: 6,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    color: hula.colors.text.faint,
  },
  pressed: {
    opacity: 0.7,
  },
});
