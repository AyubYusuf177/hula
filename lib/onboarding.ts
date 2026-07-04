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
