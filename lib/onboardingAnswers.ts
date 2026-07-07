import AsyncStorage from '@react-native-async-storage/async-storage';

import type {
  DiscoverySourceId,
  HelpOptionId,
  SexValue,
  ToneValue,
} from '@/data/hulaOnboarding';

/**
 * Local, per-user store for the answers a user gives during onboarding.
 *
 * This is separate from the onboarding *completion* flag in `lib/onboarding.ts`:
 * - `onboarding_complete:${userId}`  → a single boolean gate for routing.
 * - `onboarding_answers:${userId}`   → the collected answers (this file).
 *
 * Both are client-only (no backend yet) and ALWAYS scoped to the current Clerk
 * `userId`, so two different users never share state. Saving answers here does
 * NOT mark onboarding complete — that only happens at the end of the full flow.
 */

export type LocationPermissionStatus =
  | 'not_asked'
  | 'allowed_placeholder'
  | 'skipped';

export type FeedbackAction = 'rated_placeholder' | 'skipped';

/**
 * The access option a user leaned towards during the Section 2 activation flow.
 * Set on the paywall (`yearly` / `monthly`) and on the free-preview screen
 * (`preview_24h` / `trial_7d`). This records *intent* only — no real purchase.
 */
export type PlanIntent = 'yearly' | 'monthly' | 'preview_24h' | 'trial_7d';

export type OnboardingAnswers = {
  sex?: SexValue;
  /** ISO date string, `YYYY-MM-DD`. */
  birthday?: string;
  tone?: ToneValue;
  helpMost?: HelpOptionId[];
  discoverySource?: DiscoverySourceId;
  locationPermissionStatus?: LocationPermissionStatus;
  feedbackAction?: FeedbackAction;
  /** Access option the user leaned towards (paywall / free-preview). */
  planIntent?: PlanIntent;
  /** ISO timestamp when the user accepted terms/privacy. */
  legalAcceptedAt?: string;
  /** ISO timestamp when the full flow finished. Set later, not in Section 1. */
  onboardingCompletedAt?: string;
};

/** The AsyncStorage key holding the current user's onboarding answers. */
export function getOnboardingAnswersKey(userId: string): string {
  return `onboarding_answers:${userId}`;
}

/**
 * Reads the stored answers for a user. Returns `{}` when there is no userId,
 * nothing saved yet, or on any read/parse error — callers can always treat the
 * result as a plain partial object.
 */
export async function getOnboardingAnswers(
  userId: string | null | undefined,
): Promise<OnboardingAnswers> {
  if (!userId) return {};
  try {
    const raw = await AsyncStorage.getItem(getOnboardingAnswersKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as OnboardingAnswers;
    // Guard against a corrupted/non-object payload.
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merges `partial` into the user's stored answers and persists the result.
 * Returns the merged answers so callers can use them immediately. A missing
 * userId is a no-op that returns the partial as-is.
 */
export async function setOnboardingAnswer(
  userId: string | null | undefined,
  partial: Partial<OnboardingAnswers>,
): Promise<OnboardingAnswers> {
  if (!userId) return { ...partial };
  const current = await getOnboardingAnswers(userId);
  const next = { ...current, ...partial };
  try {
    await AsyncStorage.setItem(getOnboardingAnswersKey(userId), JSON.stringify(next));
  } catch {
    // Non-fatal: the in-memory value is still returned to the caller.
  }
  return next;
}

/** Dev/debug helper: clears only the current user's saved answers. */
export async function clearOnboardingAnswers(
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;
  try {
    await AsyncStorage.removeItem(getOnboardingAnswersKey(userId));
  } catch {
    // Non-fatal.
  }
}
