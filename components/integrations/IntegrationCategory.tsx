import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { hula } from '@/constants/theme';

const font = hula.typography.fontFamily;

/**
 * A titled section that stacks its full-width integration rows vertically
 * (Integrations V2). Reusable for the CONNECTED / AVAILABLE groupings.
 */
export function IntegrationCategory({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>{label.toUpperCase()}</Text>
      <View style={styles.stack}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: hula.spacing['2xl'],
  },
  heading: {
    fontFamily: font.semiBold,
    fontSize: 13,
    letterSpacing: 2,
    color: hula.colors.text.tertiary,
    marginBottom: hula.spacing.lg,
  },
  stack: {
    gap: hula.spacing.md,
  },
});
