import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Per-user local flag for whether a specific Clerk user has finished onboarding.
 *
 * This is intentionally client-only for now (no backend) and is ALWAYS scoped
 * to the current Clerk `userId`. There is no global onboarding flag: two
 * different users (including a deleted-then-recreated account, which gets a
 * brand-new userId) never share onboarding state.
 *
 * The value is only ever the exact string 'true'. Anything else — missing,
 * null, 'false', or a read error — means "not onboarded".
 */
export function onboardingKey(userId: string): string {
  return `onboarding_complete:${userId}`;
}

/**
 * The legacy global key. Only referenced so a dev tool can clean it up; it is
 * never read for routing decisions anymore.
 */
export const LEGACY_ONBOARDING_KEY = 'onboarding_complete';

/**
 * Returns true only when the current user's key is exactly 'true'.
 * A missing userId, missing value, null, false, or a read error returns false.
 */
export async function getOnboardingComplete(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const value = await AsyncStorage.getItem(onboardingKey(userId));
    return value === 'true';
  } catch {
    return false;
  }
}

/** Marks onboarding complete for the given user only. */
export async function setOnboardingComplete(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(onboardingKey(userId), 'true');
  } catch {
    // Non-fatal: routing will just keep treating the user as new.
  }
}

/** Removes only the current user's onboarding flag (dev reset). */
export async function clearOnboardingComplete(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(onboardingKey(userId));
  } catch {
    // Non-fatal.
  }
}

/** Removes only the old global flag, if present. Never touches user-scoped keys. */
export async function clearLegacyOnboardingFlag(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LEGACY_ONBOARDING_KEY);
  } catch {
    // Non-fatal.
  }
}

/* ── Onboarding stage (Section 2 activation flow) ─────────────────────────
 *
 * `onboarding_complete` above is a single boolean gate. The *stage* is finer
 * grained: it remembers exactly where a signed-in user is in the post-questions
 * activation flow (checking subscription → all set → what happens next →
 * paywall → free preview), so that signing out and back in resumes at the same
 * screen instead of restarting from `/onboarding/legal`.
 *
 * Still client-only and always scoped to the current Clerk `userId`.
 */

export type OnboardingStage =
  | 'questions'
  | 'checking_subscription'
  | 'all_set'
  | 'what_happens_next'
  | 'paywall'
  | 'free_preview'
  | 'preview_active'
  | 'complete';

const ONBOARDING_STAGES: readonly OnboardingStage[] = [
  'questions',
  'checking_subscription',
  'all_set',
  'what_happens_next',
  'paywall',
  'free_preview',
  'preview_active',
  'complete',
];

/** Narrow an unknown stored string to a valid stage (avoids unsafe casts). */
function isOnboardingStage(value: string | null): value is OnboardingStage {
  return value !== null && (ONBOARDING_STAGES as readonly string[]).includes(value);
}

/** The AsyncStorage key holding the current user's onboarding stage. */
export function getOnboardingStageKey(userId: string): string {
  return `onboarding_stage:${userId}`;
}

/**
 * Reads the user's current stage, or `null` when there is no userId, nothing
 * saved yet, an unrecognized value, or a read error — callers treat `null` as
 * "not started, fall back to the questions flow".
 */
export async function getOnboardingStage(
  userId: string | null | undefined,
): Promise<OnboardingStage | null> {
  if (!userId) return null;
  try {
    const value = await AsyncStorage.getItem(getOnboardingStageKey(userId));
    return isOnboardingStage(value) ? value : null;
  } catch {
    return null;
  }
}

/** Persists the user's current stage. A missing userId is a no-op. */
export async function setOnboardingStage(
  userId: string | null | undefined,
  stage: OnboardingStage,
): Promise<void> {
  if (!userId) return;
  try {
    await AsyncStorage.setItem(getOnboardingStageKey(userId), stage);
  } catch {
    // Non-fatal: routing will fall back to an earlier stage.
  }
}

/** Dev/debug helper: clears only the current user's stage. */
export async function clearOnboardingStage(
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;
  try {
    await AsyncStorage.removeItem(getOnboardingStageKey(userId));
  } catch {
    // Non-fatal.
  }
}
