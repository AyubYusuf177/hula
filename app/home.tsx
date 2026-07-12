import { useAuth, useUser } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { hula } from '@/constants/theme';
import { createLinkSession, fetchMessagingStatus, MissingApiUrlError } from '@/lib/hulaApi';
import {
  clearOnboardingComplete,
  clearOnboardingStage,
} from '@/lib/onboarding';
import { clearHulaPreview } from '@/lib/hulaPreview';
import { getHulaProfile, type HulaProfile } from '@/lib/hulaProfile';
import { resolveDisplayName, resolveFirstName, resolveInitials } from '@/lib/hulaUser';
import { clearOnboardingAnswers } from '@/lib/onboardingAnswers';
import { useIntegrationStatusPrefetch } from '@/hooks/useIntegrationStatusPrefetch';
import { useSyncHulaProfile } from '@/hooks/useSyncHulaProfile';

const font = hula.typography.fontFamily;

type MenuRow = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  /** Route to navigate to, or omitted for placeholder rows. */
  route?: string;
};

/** The account/home menu rows. Only Integrations is wired up so far. */
const MENU_ROWS: readonly MenuRow[] = [
  { icon: 'link-outline', label: 'Integrations', route: '/integrations' },
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
  const { signOut, getToken, userId, isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();

  const [profile, setProfile] = useState<HulaProfile>({});
  const [texting, setTexting] = useState(false);

  // Silently mirror local onboarding/profile data to the backend so Hula can be
  // more personal in iMessage. No UI, no popup, no user action — best-effort.
  useSyncHulaProfile();

  // Warm the integration-status cache in the background so tapping Integrations
  // renders instantly. Best-effort; never blocks navigation.
  useIntegrationStatusPrefetch();

  // Refresh the local name override on focus so a name edited in Settings shows
  // here on return.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      getHulaProfile(userId).then((p) => {
        if (active) setProfile(p);
      });
      return () => {
        active = false;
      };
    }, [userId]),
  );

  const displayName = resolveDisplayName(user, profile.displayName);
  const initials = resolveInitials(user, profile.displayName);

  const onSignOut = async () => {
    // Sign out only. We do NOT clear onboarding flags here.
    await signOut();
    router.replace('/');
  };

  // "Text hula": if the user is already connected, just open the existing
  // Messages thread to Hula — no new code, no prefilled text. If they are not
  // connected yet, ask the backend for a one-time connect code and open Messages
  // with the prefilled connect text (the user only presses send). If the status
  // check fails for any reason, fall back to the safe connect-code flow.
  const onTextHula = async () => {
    if (texting) return;
    setTexting(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not signed in');

      const firstName = resolveFirstName(user, profile.displayName);

      // Best-effort connection check. A failure here must never block the user —
      // we simply fall through to the connect-code flow below.
      let alreadyConnected = false;
      let connectedNumber: string | undefined;
      try {
        const status = await fetchMessagingStatus(token);
        alreadyConnected = status.imessage.connected;
        connectedNumber = status.hulaNumber;
      } catch (statusErr) {
        if (__DEV__) {
          console.warn('[Text hula] status check failed, using connect flow:', statusErr);
        }
      }

      let hulaNumber: string;
      let messageBody: string | undefined;
      if (alreadyConnected && connectedNumber) {
        // Connected: open the existing thread only — no new session, no code.
        hulaNumber = connectedNumber;
        messageBody = undefined;
      } else {
        // Not connected (or status unknown): one-time connect code + prefill.
        const session = await createLinkSession(token, { firstName });
        hulaNumber = session.hulaNumber;
        messageBody = session.messageBody;
      }

      // iOS uses `&` between the number and query; Android uses `?`.
      const separator = Platform.OS === 'ios' ? '&' : '?';
      const url = messageBody
        ? `sms:${hulaNumber}${separator}body=${encodeURIComponent(messageBody)}`
        : `sms:${hulaNumber}`;

      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) throw new Error('Messages is not available on this device');
      await Linking.openURL(url);
    } catch (err) {
      if (__DEV__) {
        console.warn('[Text hula] failed:', err);
      }
      const message =
        err instanceof MissingApiUrlError
          ? 'Hula backend URL is not configured. Set EXPO_PUBLIC_HULA_API_URL and restart Expo.'
          : "Couldn't start your Hula connect message. Please try again.";
      Alert.alert('Text hula', message);
    } finally {
      setTexting(false);
    }
  };

  // Once Clerk resolves a signed-out session (e.g. after Sign Out / delete),
  // never render the stale account UI — bounce to the entry gate. This also
  // prevents back-navigation landing on a previous user's Home.
  if (isLoaded && !isSignedIn) {
    return <Redirect href="/" />;
  }

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
          <CircleIcon icon="settings-outline" onPress={() => router.push('/settings')} />
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
              onPress={() => {
                if (row.route) router.push(row.route as never);
              }}
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
              onPress={onTextHula}
              disabled={texting}
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
