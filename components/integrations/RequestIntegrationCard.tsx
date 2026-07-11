import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { hula } from '@/constants/theme';

const font = hula.typography.fontFamily;

/**
 * "Request an Integration" card (Section 13). Intentionally disabled and muted
 * for now — it is NOT pressable and does not navigate. It's built so a later
 * section can pass `onPress` to open the Hula chat.
 */
export function RequestIntegrationCard({ onPress }: { onPress?: () => void }) {
  // onPress is accepted for forward-compatibility but the card stays inert until
  // a future section wires it to chat.
  void onPress;

  return (
    <View
      accessibilityRole="button"
      accessibilityState={{ disabled: true }}
      accessibilityLabel="Request an Integration, coming soon"
      style={styles.card}
    >
      <View style={styles.iconBadge}>
        <Ionicons
          name="chatbubble-ellipses-outline"
          size={22}
          color={hula.colors.text.faint}
        />
      </View>
      <View style={styles.textCol}>
        <Text style={styles.title}>Request an Integration</Text>
        <Text style={styles.subtitle}>Tell Hula what to connect next.</Text>
      </View>
      <View style={styles.pill}>
        <Text style={styles.pillText}>Coming soon</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: hula.spacing.xl,
    paddingVertical: hula.spacing.lg,
    paddingHorizontal: hula.spacing.lg,
    borderRadius: hula.radius.tile,
    backgroundColor: 'rgba(16,20,40,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(150,160,210,0.12)',
    borderStyle: 'dashed',
    flexDirection: 'row',
    alignItems: 'center',
    gap: hula.spacing.md,
    opacity: 0.9,
  },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: 'rgba(150,160,210,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(150,160,210,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  textCol: {
    flex: 1,
  },
  title: {
    fontFamily: font.medium,
    fontSize: 15,
    color: hula.colors.text.secondary,
  },
  subtitle: {
    marginTop: 2,
    fontFamily: font.regular,
    fontSize: 12,
    color: hula.colors.text.faint,
  },
  pill: {
    paddingHorizontal: hula.spacing.md,
    paddingVertical: 4,
    borderRadius: hula.radius.pill,
    backgroundColor: 'rgba(150,160,210,0.08)',
  },
  pillText: {
    fontFamily: font.medium,
    fontSize: 11,
    letterSpacing: 1,
    color: hula.colors.text.faint,
  },
});
