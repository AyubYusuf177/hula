import { useAuth, useUser } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { hula } from '@/constants/theme';
import {
  clearOnboardingComplete,
  clearOnboardingStage,
} from '@/lib/onboarding';
import { clearHulaPreview } from '@/lib/hulaPreview';
import { clearOnboardingAnswers } from '@/lib/onboardingAnswers';

const font = hula.typography.fontFamily;

type MenuRow = { icon: keyof typeof Ionicons.glyphMap; label: string };

/** The account/home menu rows (all placeholder / no-op for now). */
const MENU_ROWS: readonly MenuRow[] = [
  { icon: 'link-outline', label: 'Integrations' },
  { icon: 'flash-outline', label: 'Actions' },
  { icon: 'ellipse-outline', label: 'Memory' },
  { icon: 'person-outline', label: 'Preferences' },
  { icon: 'card-outline', label: 'Billing & Plan' },
] as const;

/**
 * Hula home / account placeholder (reached only once onboarding is complete).
 *
 * Structure mirrors the Miora account screen but in Hula's dark, glassy style:
 * avatar with initials, name + verified badge, plan pill, a glass menu panel,
 * and Sign Out / Text hula actions. Menu rows and "Text hula" are intentionally
 * no-ops for now — no backend, no real integrations, no recurring paywall.
 */
export default function Home() {
  const router = useRouter();
  const { signOut, userId } = useAuth();
  const { user } = useUser();

  const displayName = getDisplayName(user);
  const initials = getInitials(user);

  const onSignOut = async () => {
    // Sign out only. We do NOT clear onboarding flags here.
    await signOut();
    router.replace('/');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />
      <AmbientGlow />

      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        {/* Top bar */}
        <View style={styles.topBar}>
          <CircleIcon icon="chatbubble-ellipses-outline" onPress={() => {}} />
          <CircleIcon icon="settings-outline" onPress={() => {}} />
        </View>

        {/* Profile */}
        <View style={styles.profile}>
          <LinearGradient
            colors={[hula.glow.purple, hula.glow.blue]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.avatarRing}
          >
            <View style={styles.avatarInner}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
          </LinearGradient>

          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {displayName}
            </Text>
            <Ionicons
              name="checkmark-circle"
              size={22}
              color={hula.glow.purpleBright}
              style={styles.verified}
            />
          </View>

          <View style={styles.planPill}>
            <Text style={styles.planPillText}>ESSENTIAL</Text>
          </View>
        </View>

        {/* Menu panel */}
        <View style={styles.panel}>
          {MENU_ROWS.map((row) => (
            <Pressable
              key={row.label}
              onPress={() => {}}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <Ionicons name={row.icon} size={22} color={hula.glow.purpleBright} />
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Ionicons
                name="chevron-forward"
                size={18}
                color={hula.colors.text.faint}
              />
            </Pressable>
          ))}

          <View style={styles.bottomActions}>
            <Pressable
              onPress={onSignOut}
              style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
            >
              <Ionicons name="log-out-outline" size={20} color={hula.glow.purpleBright} />
              <Text style={styles.actionText}>Sign Out</Text>
            </Pressable>

            <Pressable
              onPress={() => {}}
              style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
            >
              <Ionicons name="chatbubble-outline" size={20} color={hula.glow.blueBright} />
              <Text style={[styles.actionText, styles.actionTextBlue]}>Text hula</Text>
            </Pressable>
          </View>
        </View>

        {__DEV__ ? <DevReset userId={userId} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function CircleIcon({
  icon,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => [styles.circleIcon, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={20} color={hula.colors.text.secondary} />
    </Pressable>
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

/** Dev-only full reset so the whole flow can be retested from the start. */
function DevReset({ userId }: { userId: string | null | undefined }) {
  const router = useRouter();

  const resetAll = async () => {
    if (!userId) return;
    await Promise.all([
      clearOnboardingComplete(userId),
      clearOnboardingStage(userId),
      clearHulaPreview(userId),
      clearOnboardingAnswers(userId),
    ]);
    router.replace('/onboarding/legal');
  };

  return (
    <Pressable onPress={resetAll} hitSlop={8} style={styles.devReset}>
      <Text style={styles.devResetText}>DEV · Reset onboarding & restart flow</Text>
    </Pressable>
  );
}

function getDisplayName(user: ReturnType<typeof useUser>['user']): string {
  if (!user) return 'Hula User';
  if (user.fullName) return user.fullName;
  const parts = [user.firstName, user.lastName].filter(Boolean);
  if (parts.length) return parts.join(' ');
  const email = user.primaryEmailAddress?.emailAddress;
  if (email) return email.split('@')[0];
  return 'Hula User';
}

function getInitials(user: ReturnType<typeof useUser>['user']): string {
  const name = user?.fullName || [user?.firstName, user?.lastName].filter(Boolean).join(' ');
  if (name) {
    const words = name.trim().split(/\s+/);
    const first = words[0]?.[0] ?? '';
    const second = words[1]?.[0] ?? '';
    return (first + second).toUpperCase() || 'HU';
  }
  const email = user?.primaryEmailAddress?.emailAddress;
  if (email) return email.slice(0, 2).toUpperCase();
  return 'HU';
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: hula.colors.voidBlack,
  },
  glowLayer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    width: 340,
    height: 340,
    borderRadius: 170,
    ...Platform.select({
      ios: { shadowOpacity: 0.7, shadowRadius: 100, shadowOffset: { width: 0, height: 0 } },
      default: {},
    }),
  },
  glowPurple: {
    left: -160,
    top: '30%',
    backgroundColor: 'rgba(123,77,255,0.16)',
    shadowColor: hula.glow.purple,
  },
  glowBlue: {
    right: -160,
    top: '18%',
    backgroundColor: 'rgba(62,123,255,0.12)',
    shadowColor: hula.glow.blue,
  },
  body: {
    paddingHorizontal: hula.spacing.xl,
    paddingBottom: hula.spacing['2xl'],
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: hula.spacing.sm,
  },
  circleIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profile: {
    alignItems: 'center',
    marginTop: hula.spacing.lg,
  },
  avatarRing: {
    width: 128,
    height: 128,
    borderRadius: 64,
    padding: 2,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: hula.glow.purple,
        shadowOpacity: 0.5,
        shadowRadius: 28,
        shadowOffset: { width: 0, height: 0 },
      },
      default: {},
    }),
  },
  avatarInner: {
    flex: 1,
    alignSelf: 'stretch',
    borderRadius: 62,
    backgroundColor: '#0C0E1C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontFamily: font.semiBold,
    fontSize: 40,
    color: hula.colors.text.primary,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: hula.spacing.lg,
  },
  name: {
    fontFamily: font.bold,
    fontSize: 26,
    color: hula.colors.text.primary,
  },
  verified: {
    marginLeft: hula.spacing.sm,
  },
  planPill: {
    marginTop: hula.spacing.md,
    paddingHorizontal: hula.spacing.lg,
    paddingVertical: hula.spacing.sm,
    borderRadius: hula.radius.pill,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
  },
  planPillText: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.legal.fontSize,
    letterSpacing: 2,
    color: hula.colors.text.secondary,
  },
  panel: {
    marginTop: hula.spacing['2xl'],
    padding: hula.spacing.lg,
    borderRadius: hula.radius.card,
    backgroundColor: hula.glass.card,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    gap: hula.spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 60,
    paddingHorizontal: hula.spacing.lg,
    borderRadius: hula.radius.pill,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    gap: hula.spacing.lg,
  },
  rowLabel: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: hula.typography.hint.fontSize,
    color: hula.colors.text.primary,
  },
  bottomActions: {
    flexDirection: 'row',
    gap: hula.spacing.md,
    marginTop: hula.spacing.xs,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: hula.spacing.sm,
    minHeight: 56,
    borderRadius: hula.radius.pill,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
  },
  actionText: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.hint.fontSize,
    color: hula.glow.purpleBright,
  },
  actionTextBlue: {
    color: hula.glow.blueBright,
  },
  devReset: {
    marginTop: hula.spacing.xl,
    alignSelf: 'center',
    paddingVertical: hula.spacing.sm,
    paddingHorizontal: hula.spacing.lg,
  },
  devResetText: {
    fontFamily: font.medium,
    fontSize: hula.typography.legal.fontSize,
    color: hula.colors.text.faint,
  },
  pressed: {
    opacity: 0.7,
  },
});
