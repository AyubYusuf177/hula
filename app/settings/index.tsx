import { useAuth, useUser } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { hula } from '@/constants/theme';
import {
  DISCOVERY_OPTIONS,
  HELP_OPTIONS,
  TONE_OPTIONS,
} from '@/data/hulaOnboarding';
import { clearHulaMessaging, getHulaMessaging, type HulaMessaging } from '@/lib/hulaMessaging';
import {
  clearOnboardingComplete,
  clearOnboardingStage,
} from '@/lib/onboarding';
import {
  clearHulaPreview,
  getHulaPreview,
  type HulaPreview,
} from '@/lib/hulaPreview';
import { clearHulaProfile, getHulaProfile, type HulaProfile } from '@/lib/hulaProfile';
import { resolveDisplayName, resolveInitials } from '@/lib/hulaUser';
import {
  clearOnboardingAnswers,
  getOnboardingAnswers,
  type OnboardingAnswers,
} from '@/lib/onboardingAnswers';

const font = hula.typography.fontFamily;
const NOT_SET = 'Not set';

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * Hula Settings — Account Overview.
 *
 * Companion panel for the signed-in user: profile from Clerk (with a local name
 * override), plus the onboarding answers, which are editable in place via the
 * per-field edit screens. Everything is client-only (no backend). Sign Out uses
 * Clerk; Delete Account performs a real Clerk deletion when the account allows
 * self-deletion, otherwise an honest local data reset (see the confirm modal).
 */
export default function Settings() {
  const router = useRouter();
  const { signOut, userId } = useAuth();
  const { user } = useUser();

  const [answers, setAnswers] = useState<OnboardingAnswers>({});
  const [messaging, setMessaging] = useState<HulaMessaging>({});
  const [preview, setPreview] = useState<HulaPreview | null>(null);
  const [profile, setProfile] = useState<HulaProfile>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reload local state every time the screen regains focus so values edited on
  // a child screen (name, DOB, iMessage, …) show immediately on return.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      Promise.all([
        getOnboardingAnswers(userId),
        getHulaMessaging(userId),
        getHulaPreview(userId),
        getHulaProfile(userId),
      ]).then(([a, m, p, pr]) => {
        if (!active) return;
        setAnswers(a);
        setMessaging(m);
        setPreview(p);
        setProfile(pr);
      });
      return () => {
        active = false;
      };
    }, [userId]),
  );

  const displayName = resolveDisplayName(user, profile.displayName);
  const initials = resolveInitials(user, profile.displayName);
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const deleteEnabled = Boolean(user?.deleteSelfEnabled);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/home');
  };

  const comingSoon = () =>
    Alert.alert('Coming soon', 'This will be available in a future update.');

  const onSignOut = async () => {
    // Sign out only. We do NOT clear onboarding storage here.
    await signOut();
    router.replace('/');
  };

  const onDeleteConfirmed = async () => {
    setConfirmDelete(false);
    // Always clear every local per-user Hula key first so nothing is left behind
    // (and a same-userId re-login restarts cleanly at /onboarding/legal).
    if (userId) {
      await Promise.all([
        clearOnboardingAnswers(userId),
        clearOnboardingStage(userId),
        clearOnboardingComplete(userId),
        clearHulaPreview(userId),
        clearHulaMessaging(userId),
        clearHulaProfile(userId),
      ]);
    }

    if (deleteEnabled && user) {
      try {
        // Real server-side deletion; this also ends the current session.
        await user.delete();
      } catch {
        // Fall back so we never leave the app in a half-signed-in state.
        await signOut();
      }
    } else {
      await signOut();
    }
    router.replace('/');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar style="light" />
      <AmbientGlow />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={goBack}
            hitSlop={10}
            style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
          >
            <Ionicons name="close" size={22} color={hula.colors.text.primary} />
          </Pressable>
          <Text style={styles.headerTitle}>Account Overview</Text>
          <View style={styles.headerSpacer} />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile */}
        <View style={styles.profile}>
          <LinearGradient
            colors={[hula.glow.purple, hula.glow.iris]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.avatar}
          >
            <Text style={styles.avatarText}>{initials}</Text>
          </LinearGradient>
          <View style={styles.profileText}>
            <Text style={styles.profileName} numberOfLines={1}>
              {displayName}
            </Text>
            {email ? (
              <Text style={styles.profileEmail} numberOfLines={1}>
                {email}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Personal Details */}
        <Section label="Personal Details">
          <Row icon="person-outline" label="Name" value={displayName} onPress={() => router.push('/settings/name')} />
          <Divider />
          <Row icon="calendar-outline" label="Date of Birth" value={formatBirthday(answers.birthday)} onPress={() => router.push('/settings/birthday')} />
          <Divider />
          <Row icon="male-female-outline" label="Sex" value={formatSex(answers.sex)} onPress={() => router.push('/settings/sex')} />
        </Section>

        {/* Messaging */}
        <Section label="Messaging">
          <Row
            icon="chatbubble-outline"
            label="iMessage"
            value={iMessageValue(messaging)}
            onPress={() => router.push('/settings/imessage-address')}
          />
          <Divider />
          <Row
            icon="logo-whatsapp"
            label="WhatsApp"
            value={messaging.whatsappNumber?.trim() || NOT_SET}
            onPress={comingSoon}
          />
          <Divider />
          <Row icon="person-add-outline" label="Add hula to Contacts" onPress={comingSoon} />
          <Divider />
          <Row icon="time-outline" label="Chat History" onPress={comingSoon} />
        </Section>

        {/* Hula Setup */}
        <Section label="Hula Setup">
          <Row icon="sparkles-outline" label="Tone" value={formatTone(answers.tone)} onPress={() => router.push('/settings/tone')} />
          <Divider />
          <Row icon="heart-outline" label="Helps With" value={formatHelp(answers.helpMost)} onPress={() => router.push('/settings/help')} />
          <Divider />
          <Row icon="compass-outline" label="Source" value={formatDiscovery(answers.discoverySource)} onPress={() => router.push('/settings/discovery')} />
        </Section>

        {/* Permissions */}
        <Section label="Permissions">
          <Row icon="location-outline" label="Location" value={locationStatus(answers)} />
          <Divider />
          <Row icon="notifications-outline" label="Notifications" value="Disabled" />
          <Divider />
          <Row icon="calendar-outline" label="Calendar" value="Disabled" />
          <Divider />
          <Row icon="people-outline" label="Contacts" value="Disabled" />
        </Section>

        {/* Subscription */}
        <Section label="Subscription">
          <Row icon="card-outline" label="Current Plan" value={formatPlan(answers, preview)} />
          <Divider />
          <Row icon="wallet-outline" label="Manage Billing" onPress={comingSoon} />
          <Divider />
          <Row icon="gift-outline" label="Rewards & Referrals" onPress={comingSoon} />
        </Section>

        {/* Rate hula (standalone, matches mockup) */}
        <View style={styles.card}>
          <Row icon="star-outline" label="Rate hula in the App Store" onPress={comingSoon} />
        </View>

        {/* Legal */}
        <Section label="Legal">
          <Row icon="document-text-outline" label="Terms of Service" onPress={comingSoon} />
          <Divider />
          <Row icon="shield-checkmark-outline" label="Privacy Policy" onPress={comingSoon} />
        </Section>

        {/* Account */}
        <View style={styles.card}>
          <Row icon="log-out-outline" label="Sign Out" tint={hula.glow.purpleBright} onPress={onSignOut} />
          <Divider />
          <Row
            icon="trash-outline"
            label={deleteEnabled ? 'Delete Account' : 'Reset Account Data'}
            tint={DANGER}
            onPress={() => setConfirmDelete(true)}
          />
        </View>

        {/* Decorative social row (matches mockup) */}
        <View style={styles.social}>
          {SOCIALS.map((name) => (
            <View key={name} style={styles.socialDot}>
              <Ionicons name={name} size={18} color={hula.colors.text.tertiary} />
            </View>
          ))}
        </View>
      </ScrollView>

      <DeleteAccountModal
        visible={confirmDelete}
        deleteEnabled={deleteEnabled}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={onDeleteConfirmed}
      />
    </SafeAreaView>
  );
}

/* ── Row + Section building blocks (settings-only) ────────────────────────── */

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({
  icon,
  label,
  value,
  tint,
  onPress,
}: {
  icon: IconName;
  label: string;
  value?: string;
  tint?: string;
  onPress?: () => void;
}) {
  const content = (
    <>
      <Ionicons name={icon} size={22} color={tint ?? hula.glow.purpleBright} />
      <Text style={[styles.rowLabel, tint ? { color: tint } : null]} numberOfLines={1}>
        {label}
      </Text>
      {value ? (
        <Text style={styles.rowValue} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      <Ionicons
        name="chevron-forward"
        size={18}
        color={hula.colors.text.faint}
        style={styles.chevron}
      />
    </>
  );

  if (!onPress) {
    return <View style={styles.row}>{content}</View>;
  }
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      {content}
    </Pressable>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

/* ── Delete confirmation modal ────────────────────────────────────────────── */

function DeleteAccountModal({
  visible,
  deleteEnabled,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  deleteEnabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const title = deleteEnabled ? 'Delete account?' : 'Reset local account data?';
  const body = deleteEnabled
    ? 'This permanently deletes your Hula account and removes your data from this device. This cannot be undone.'
    : "This clears your Hula data on this device and signs you out. Your account isn't deleted from our servers yet — full account deletion will be connected before production.";
  const confirmLabel = deleteEnabled ? 'Delete Account' : 'Reset Data';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalIcon}>
            <Ionicons name="trash-outline" size={28} color={DANGER} />
          </View>
          <Text style={styles.modalTitle}>{title}</Text>
          <Text style={styles.modalBody}>{body}</Text>

          <Pressable
            onPress={onCancel}
            style={({ pressed }) => [styles.modalBtn, styles.modalCancel, pressed && styles.pressed]}
          >
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={onConfirm}
            style={({ pressed }) => [styles.modalBtn, styles.modalDelete, pressed && styles.pressed]}
          >
            <Text style={styles.modalDeleteText}>{confirmLabel}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/* ── Value formatting ─────────────────────────────────────────────────────── */

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** ISO `YYYY-MM-DD` → e.g. "17 Mar 2006". Missing/invalid → "Not set". */
function formatBirthday(iso?: string): string {
  if (!iso) return NOT_SET;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return NOT_SET;
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

function formatSex(sex?: OnboardingAnswers['sex']): string {
  if (sex === 'male') return 'Male';
  if (sex === 'female') return 'Female';
  return NOT_SET;
}

function formatTone(tone?: OnboardingAnswers['tone']): string {
  return TONE_OPTIONS.find((t) => t.value === tone)?.label ?? NOT_SET;
}

/** Comma-joined help labels, collapsing to "N selected" when too long to fit. */
function formatHelp(help?: OnboardingAnswers['helpMost']): string {
  if (!help || help.length === 0) return NOT_SET;
  const labels = help
    .map((id) => HELP_OPTIONS.find((o) => o.id === id)?.label)
    .filter((l): l is string => Boolean(l));
  if (labels.length === 0) return NOT_SET;
  const joined = labels.join(', ');
  return joined.length > 22 ? `${labels.length} selected` : joined;
}

function formatDiscovery(source?: OnboardingAnswers['discoverySource']): string {
  return DISCOVERY_OPTIONS.find((o) => o.id === source)?.label ?? NOT_SET;
}

/** iMessage summary: prefer email, then phone, else Not set. */
function iMessageValue(m: HulaMessaging): string {
  return m.iMessageEmail?.trim() || m.iMessagePhone?.trim() || NOT_SET;
}

/** Maps the raw permission status to a user-facing Enabled/Disabled (never "skipped"). */
function locationStatus(answers: OnboardingAnswers): string {
  return answers.locationPermissionStatus === 'allowed_placeholder' ? 'Enabled' : 'Disabled';
}

function formatPlan(answers: OnboardingAnswers, preview: HulaPreview | null): string {
  const intent = answers.planIntent ?? preview?.type;
  switch (intent) {
    case 'preview_24h':
      return '24 hour preview';
    case 'trial_7d':
      return '1 week trial';
    case 'yearly':
      return 'Yearly';
    case 'monthly':
      return 'Monthly';
    default:
      return NOT_SET;
  }
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

const DANGER = '#FF5D6C';

const SOCIALS: readonly IconName[] = [
  'logo-instagram',
  'logo-tiktok',
  'logo-twitter',
  'logo-linkedin',
  'logo-whatsapp',
  'logo-reddit',
] as const;

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
    width: 320,
    height: 320,
    borderRadius: 160,
  },
  glowPurple: {
    left: -170,
    top: '18%',
    backgroundColor: 'rgba(123,77,255,0.16)',
  },
  glowBlue: {
    right: -180,
    top: '30%',
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
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Invisible, non-interactive spacer that balances the close button so the
  // title stays centered (no visible circle, nothing tappable).
  headerSpacer: {
    width: 40,
    height: 40,
  },
  headerTitle: {
    fontFamily: font.bold,
    fontSize: 22,
    color: hula.colors.text.primary,
  },
  body: {
    paddingHorizontal: hula.spacing.xl,
    paddingBottom: hula.spacing['3xl'],
  },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: hula.spacing.sm,
    marginBottom: hula.spacing.xl,
    gap: hula.spacing.lg,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontFamily: font.bold,
    fontSize: 22,
    color: hula.colors.text.primary,
  },
  profileText: {
    flex: 1,
  },
  profileName: {
    fontFamily: font.semiBold,
    fontSize: 22,
    color: hula.colors.text.primary,
  },
  profileEmail: {
    fontFamily: font.regular,
    fontSize: 15,
    color: hula.colors.text.tertiary,
    marginTop: 2,
  },
  section: {
    marginBottom: hula.spacing.xl,
  },
  sectionLabel: {
    fontFamily: font.medium,
    fontSize: 15,
    color: hula.colors.text.tertiary,
    marginBottom: hula.spacing.md,
    marginLeft: hula.spacing.xs,
  },
  card: {
    borderRadius: hula.radius.card,
    backgroundColor: hula.glass.card,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    paddingHorizontal: hula.spacing.lg,
    marginBottom: hula.spacing.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 58,
    gap: hula.spacing.lg,
  },
  rowLabel: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: hula.typography.hint.fontSize,
    color: hula.colors.text.primary,
  },
  rowValue: {
    fontFamily: font.regular,
    fontSize: 15,
    color: hula.colors.text.tertiary,
    maxWidth: '52%',
    textAlign: 'right',
  },
  chevron: {
    marginLeft: -hula.spacing.sm,
  },
  divider: {
    height: 1,
    backgroundColor: hula.glass.tileBorder,
    opacity: 0.6,
  },
  social: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: hula.spacing.md,
    marginTop: hula.spacing.sm,
    marginBottom: hula.spacing.xl,
  },
  socialDot: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
  /* Delete modal */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(2,3,10,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: hula.spacing['2xl'],
  },
  modalCard: {
    width: '100%',
    borderRadius: hula.radius.card,
    backgroundColor: hula.colors.deepNavy,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    padding: hula.spacing.xl,
    alignItems: 'center',
  },
  modalIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255,93,108,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,93,108,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: hula.spacing.lg,
  },
  modalTitle: {
    fontFamily: font.bold,
    fontSize: 22,
    color: hula.colors.text.primary,
    marginBottom: hula.spacing.sm,
    textAlign: 'center',
  },
  modalBody: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 21,
    color: hula.colors.text.tertiary,
    textAlign: 'center',
    marginBottom: hula.spacing.xl,
  },
  modalBtn: {
    width: '100%',
    height: 54,
    borderRadius: hula.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: hula.spacing.md,
  },
  modalCancel: {
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
  },
  modalCancelText: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.button.fontSize,
    color: hula.colors.text.primary,
  },
  modalDelete: {
    backgroundColor: 'rgba(255,93,108,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,93,108,0.5)',
  },
  modalDeleteText: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.button.fontSize,
    color: DANGER,
  },
});
