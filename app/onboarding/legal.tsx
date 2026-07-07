import { useAuth } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { HulaBottomButton, HulaOnboardingFrame } from '@/components/onboarding';
import { hula } from '@/constants/theme';
import {
  getOnboardingStep,
  LEGAL_ROWS,
  LEGAL_TRUST_COPY,
  ONBOARDING_CTA,
} from '@/data/hulaOnboarding';
import { setOnboardingAnswer } from '@/lib/onboardingAnswers';

const font = hula.typography.fontFamily;
const step = getOnboardingStep('legal');

/**
 * Onboarding page 1 — Terms of Service & Privacy Policy.
 *
 * Accepting records `legalAcceptedAt` locally (per Clerk userId) and advances
 * to the sex page. It does NOT mark onboarding complete — this is Section 1.
 */
export default function OnboardingLegal() {
  const router = useRouter();
  const { userId } = useAuth();
  const [saving, setSaving] = useState(false);

  const onAccept = async () => {
    if (saving) return;
    setSaving(true);
    await setOnboardingAnswer(userId, { legalAcceptedAt: new Date().toISOString() });
    router.push('/onboarding/sex');
  };

  return (
    <HulaOnboardingFrame
      progress={step.progress}
      showLogo
      title={step.title}
      subtitle={step.subtitle}
      footer={
        <>
          <Text style={styles.agreement}>
            By tapping “Accept and Continue”, you agree to our{' '}
            <Text style={styles.agreementLink}>Terms of Service</Text> and{' '}
            <Text style={styles.agreementLink}>Privacy Policy</Text>.
          </Text>
          <HulaBottomButton
            label={ONBOARDING_CTA.legal}
            onPress={onAccept}
            loading={saving}
          />
        </>
      }
    >
      <View style={styles.rowsCard}>
        {LEGAL_ROWS.map((row, i) => (
          <View key={row.id}>
            {i > 0 ? <View style={styles.divider} /> : null}
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              hitSlop={4}
            >
              <View style={styles.rowIcon}>
                <Ionicons name={row.icon} size={20} color={hula.colors.text.primary} />
              </View>
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Ionicons
                name="chevron-forward"
                size={20}
                color={hula.colors.text.tertiary}
              />
            </Pressable>
          </View>
        ))}
      </View>

      <Text style={styles.trust}>{LEGAL_TRUST_COPY}</Text>
    </HulaOnboardingFrame>
  );
}

const styles = StyleSheet.create({
  rowsCard: {
    width: '100%',
    marginTop: hula.spacing.xl,
    borderRadius: hula.radius.card,
    backgroundColor: hula.glass.card,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    paddingHorizontal: hula.spacing.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: hula.spacing.lg + 2,
  },
  rowPressed: {
    opacity: 0.7,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: hula.spacing.lg,
  },
  rowLabel: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: hula.typography.hint.fontSize,
    color: hula.colors.text.primary,
  },
  divider: {
    height: 1,
    backgroundColor: hula.glass.cardBorder,
  },
  trust: {
    marginTop: hula.spacing.xl,
    fontFamily: font.regular,
    fontSize: hula.typography.legal.fontSize,
    lineHeight: hula.typography.legal.lineHeight,
    color: hula.colors.text.faint,
    textAlign: 'center',
  },
  agreement: {
    fontFamily: font.regular,
    fontSize: hula.typography.legal.fontSize,
    lineHeight: hula.typography.legal.lineHeight,
    color: hula.colors.text.tertiary,
    textAlign: 'center',
    marginBottom: hula.spacing.lg,
  },
  agreementLink: {
    fontFamily: font.medium,
    color: hula.glow.purpleBright,
  },
});