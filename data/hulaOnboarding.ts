/**
 * Static content + structure for the Hula onboarding flow (Section 1).
 *
 * This is the single source of truth for the 8 planned onboarding pages: their
 * order, routes, progress values, and the copy/options taken from the design
 * mockups. Pages read from here so wording and progress stay consistent and
 * there is no magic-number drift between screens.
 *
 * NOTE: The screens themselves are NOT built yet — this only defines the shared
 * content the pages will consume as they are implemented one by one.
 */

import type { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

/** An Ionicons glyph name — kept typed so option icons can't drift. */
export type IoniconName = ComponentProps<typeof Ionicons>['name'];

/** The 8 onboarding steps, in order. */
export type OnboardingStepId =
  | 'legal'
  | 'sex'
  | 'age'
  | 'tone'
  | 'help'
  | 'discovery'
  | 'location'
  | 'feedback';

/** Planned Expo Router paths for each step (only `legal` exists so far). */
export type OnboardingRoute =
  | '/onboarding/legal'
  | '/onboarding/sex'
  | '/onboarding/age'
  | '/onboarding/tone'
  | '/onboarding/help'
  | '/onboarding/discovery'
  | '/onboarding/location'
  | '/onboarding/feedback';

export type OnboardingStep = {
  id: OnboardingStepId;
  /** 1-based position in the flow. */
  index: number;
  route: OnboardingRoute;
  /** Progress bar value for this step, 0..1 (index / total). */
  progress: number;
  /** Whether this step can be skipped (location + feedback). */
  skippable: boolean;
  title: string;
  subtitle?: string;
};

export const ONBOARDING_TOTAL_STEPS = 8;

/** progress for step N of the flow (used by the top progress bar). */
export function stepProgress(index: number): number {
  return index / ONBOARDING_TOTAL_STEPS;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'legal',
    index: 1,
    route: '/onboarding/legal',
    progress: stepProgress(1),
    skippable: false,
    title: 'Terms of Service & Privacy Policy',
    subtitle:
      "Please review and accept Hula's Terms of Service and Privacy Policy to continue.",
  },
  {
    id: 'sex',
    index: 2,
    route: '/onboarding/sex',
    progress: stepProgress(2),
    skippable: false,
    title: "What's your sex?",
    subtitle: 'This helps hula personalize your experience.',
  },
  {
    id: 'age',
    index: 3,
    route: '/onboarding/age',
    progress: stepProgress(3),
    skippable: false,
    title: 'When were you born?',
    subtitle: 'This helps hula personalize your setup.',
  },
  {
    id: 'tone',
    index: 4,
    route: '/onboarding/tone',
    progress: stepProgress(4),
    skippable: false,
    title: "hula's tone of voice",
  },
  {
    id: 'help',
    index: 5,
    route: '/onboarding/help',
    progress: stepProgress(5),
    skippable: false,
    title: 'What do you want hula to help you with the most?',
    subtitle: 'Choose what matters most right now.',
  },
  {
    id: 'discovery',
    index: 6,
    route: '/onboarding/discovery',
    progress: stepProgress(6),
    skippable: false,
    title: 'Where did you find me?',
  },
  {
    id: 'location',
    index: 7,
    route: '/onboarding/location',
    progress: stepProgress(7),
    skippable: true,
    title: 'Allow location access',
    subtitle: 'hula uses your location to personalize messages.',
  },
  {
    id: 'feedback',
    index: 8,
    route: '/onboarding/feedback',
    progress: stepProgress(8),
    skippable: true,
    title: 'Your feedback helps hula improve.',
  },
] as const;

/** Look a step up by id (used by pages to avoid duplicating copy). */
export function getOnboardingStep(id: OnboardingStepId): OnboardingStep {
  const step = ONBOARDING_STEPS.find((s) => s.id === id);
  if (!step) throw new Error(`Unknown onboarding step: ${id}`);
  return step;
}

/* ── Step 1: Legal ────────────────────────────────────────────── */

/** The two tappable rows on the legal page. */
export const LEGAL_ROWS: readonly { id: 'terms' | 'privacy'; label: string; icon: IoniconName }[] = [
  { id: 'terms', label: 'Terms of Service', icon: 'document-text-outline' },
  { id: 'privacy', label: 'Privacy Policy', icon: 'shield-checkmark-outline' },
] as const;

/** Reassuring consent copy shown under the legal rows. */
export const LEGAL_TRUST_COPY =
  'Hula only acts with your consent. Sensitive actions like sending, booking, buying, contacting people, or changing calendar events will ask for approval first.';

/* ── Step 2: Sex ──────────────────────────────────────────────── */

export type SexValue = 'female' | 'male';

export const SEX_OPTIONS: readonly { value: SexValue; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
] as const;

/* ── Step 4: Tone of voice ────────────────────────────────────── */

export type ToneValue = 'concise' | 'witty' | 'strategic';

export type TonePreview = { title: string; message: string };

export const TONE_OPTIONS: readonly {
  value: ToneValue;
  label: string;
  suggested?: boolean;
  /** Sample "Daily Brief" push that demonstrates how hula speaks in this tone. */
  preview: TonePreview;
}[] = [
  {
    value: 'concise',
    label: 'Concise & Efficient',
    preview: {
      title: 'Daily Brief',
      message: '2 follow-ups due today. Free slot at 4pm. Tesco order ready to place.',
    },
  },
  {
    value: 'witty',
    label: 'Witty & Bold',
    suggested: true,
    preview: {
      title: 'Daily Brief',
      message:
        'You’ve got 2 follow-ups, a free 4pm slot, and your Tesco order is ready to place. Want me to handle it?',
    },
  },
  {
    value: 'strategic',
    label: 'Strategic & Smart',
    preview: {
      title: 'Daily Brief',
      message:
        'Your highest-leverage move today is clearing 2 follow-ups before 4pm. I can draft both now.',
    },
  },
] as const;

/** Relative time shown on the tone preview notification. */
export const TONE_PREVIEW_TIME = '1m ago';

/* ── Step 5: What can hula help with ──────────────────────────── */

export type HelpOptionId =
  | 'travel'
  | 'reminders'
  | 'emails'
  | 'itineraries'
  | 'general'
  | 'research'
  | 'shopping'
  | 'talk';

export const HELP_OPTIONS: readonly {
  id: HelpOptionId;
  label: string;
  icon: IoniconName;
}[] = [
  { id: 'travel', label: 'Travel', icon: 'airplane' },
  { id: 'reminders', label: 'Reminders', icon: 'notifications' },
  { id: 'emails', label: 'Emails & follow-ups', icon: 'mail' },
  { id: 'itineraries', label: 'Itineraries', icon: 'map' },
  { id: 'general', label: 'General reminders', icon: 'time' },
  { id: 'research', label: 'Research & answers', icon: 'search' },
  { id: 'shopping', label: 'Shopping & bookings', icon: 'bag' },
  { id: 'talk', label: 'Someone to talk to', icon: 'chatbubble-ellipses' },
] as const;

/* ── Step 6: Where did you find me ────────────────────────────── */

export type DiscoverySourceId =
  | 'tiktok'
  | 'instagram'
  | 'x'
  | 'linkedin'
  | 'friend'
  | 'whatsapp'
  | 'imessage'
  | 'other';

export const DISCOVERY_OPTIONS: readonly {
  id: DiscoverySourceId;
  label: string;
  icon: IoniconName;
}[] = [
  { id: 'tiktok', label: 'TikTok', icon: 'musical-notes' },
  { id: 'instagram', label: 'Instagram', icon: 'logo-instagram' },
  { id: 'x', label: 'X (Twitter)', icon: 'logo-twitter' },
  { id: 'linkedin', label: 'LinkedIn', icon: 'logo-linkedin' },
  { id: 'friend', label: 'Friend', icon: 'people' },
  { id: 'whatsapp', label: 'WhatsApp', icon: 'logo-whatsapp' },
  { id: 'imessage', label: 'iMessage', icon: 'chatbubble' },
  { id: 'other', label: 'Other', icon: 'ellipsis-horizontal' },
] as const;

/* ── Step 8: Feedback / testimonials ──────────────────────────── */

export type Testimonial = {
  name: string;
  handle: string;
  rating: number;
  quote: string;
};

export const TESTIMONIALS: readonly Testimonial[] = [
  {
    name: 'Aisha M.',
    handle: '@aishabuilds',
    rating: 5,
    quote:
      'hula drafts my follow-ups, keeps my day organized, and reminds me about the small things I always forget.',
  },
  {
    name: 'Sam K.',
    handle: '@samknowsops',
    rating: 5,
    quote:
      'I use hula through WhatsApp for research, errands, and planning my week. It actually saves me time.',
  },
] as const;

/* ── Bottom CTA labels (per step) ─────────────────────────────── */

export const ONBOARDING_CTA: Record<OnboardingStepId, string> = {
  legal: 'Accept and Continue',
  sex: 'Continue',
  age: 'Continue',
  tone: 'Continue',
  help: 'Continue',
  discovery: 'Continue',
  location: 'Allow Location',
  feedback: 'Rate hula',
};
