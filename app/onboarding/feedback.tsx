import { useAuth } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { HulaBottomButton, HulaOnboardingFrame } from '@/components/onboarding';
import { hula } from '@/constants/theme';
import {
  getOnboardingStep,
  ONBOARDING_CTA,
  TESTIMONIALS,
  type Testimonial,
} from '@/data/hulaOnboarding';
import { setOnboardingStage } from '@/lib/onboarding';
import {
  setOnboardingAnswer,
  type FeedbackAction,
} from '@/lib/onboardingAnswers';

const font = hula.typography.fontFamily;
const step = getOnboardingStep('feedback');
const GOLD = '#F6C445';

/**
 * Onboarding page 8 — feedback / testimonials. Last of the Section 1 questions.
 *
 * MVP placeholder: "Rate hula" does NOT open the real App Store prompt. It
 * records `rated_placeholder` and "Skip" records `skipped`. Either way we move
 * into the Section 2 activation flow: set the stage to `checking_subscription`
 * and hand off to that bridge screen. Onboarding is NOT marked complete here.
 */
export default function OnboardingFeedback() {
  const router = useRouter();
  const { userId } = useAuth();

  const finish = async (action: FeedbackAction) => {
    await setOnboardingAnswer(userId, { feedbackAction: action });
    await setOnboardingStage(userId, 'checking_subscription');
    router.push('/onboarding/checking-subscription');
  };

  return (
    <HulaOnboardingFrame
      progress={step.progress}
      onBack={() => router.back()}
      onSkip={() => finish('skipped')}
      scroll
      showLogo
      title={step.title}
      footer={
        <HulaBottomButton
          label={ONBOARDING_CTA.feedback}
          onPress={() => finish('rated_placeholder')}
        />
      }
    >
      <View style={styles.cards}>
        {TESTIMONIALS.map((t) => (
          <TestimonialCard key={t.handle} testimonial={t} />
        ))}
      </View>
    </HulaOnboardingFrame>
  );
}

function TestimonialCard({ testimonial }: { testimonial: Testimonial }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.avatar}>
          <Ionicons name="person" size={22} color={hula.colors.text.primary} />
        </View>
        <View style={styles.nameCol}>
          <Text style={styles.name}>{testimonial.name}</Text>
          <Text style={styles.handle}>{testimonial.handle}</Text>
        </View>
        <View style={styles.stars}>
          {Array.from({ length: testimonial.rating }).map((_, i) => (
            <Ionicons key={i} name="star" size={14} color={GOLD} />
          ))}
        </View>
      </View>
      <Text style={styles.quote}>{testimonial.quote}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cards: {
    width: '100%',
    marginTop: hula.spacing.xl,
    gap: hula.spacing.lg,
  },
  card: {
    borderRadius: hula.radius.card,
    backgroundColor: hula.glass.card,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    padding: hula.spacing.xl,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: hula.spacing.lg,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: hula.colors.purpleUndertone,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: hula.spacing.md,
  },
  nameCol: {
    flex: 1,
  },
  name: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.hint.fontSize,
    color: hula.colors.text.primary,
  },
  handle: {
    fontFamily: font.regular,
    fontSize: hula.typography.legal.fontSize,
    color: hula.colors.text.tertiary,
    marginTop: 1,
  },
  stars: {
    flexDirection: 'row',
    gap: 2,
  },
  quote: {
    fontFamily: font.regular,
    fontSize: hula.typography.hint.fontSize,
    lineHeight: 23,
    color: hula.colors.text.secondary,
  },
});