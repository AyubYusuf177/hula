import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { hula } from '@/constants/theme';

const font = hula.typography.fontFamily;

/**
 * A titled category section that lays its cards out in a responsive two-column
 * wrap (Section 13). Reusable for every future integration grouping.
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
      <View style={styles.grid}>{children}</View>
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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: hula.spacing.md,
  },
});
