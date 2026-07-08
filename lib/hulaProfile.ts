import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Local, per-user profile overrides layered on top of the Clerk user.
 *
 * MVP-safe: rather than mutate the Clerk user from the mobile client (a network
 * write that can fail offline / in Expo Go), the Settings "Name" edit stores a
 * local `displayName` override here. Home and Account Overview prefer this value
 * and fall back to Clerk (fullName → firstName → email prefix → "User").
 *
 * Client-only and ALWAYS scoped to the current Clerk `userId`.
 */

export type HulaProfile = {
  displayName?: string;
};

/** The AsyncStorage key holding the current user's profile overrides. */
export function getHulaProfileKey(userId: string): string {
  return `hula_profile:${userId}`;
}

/**
 * Reads the stored profile overrides. Returns `{}` when there is no userId,
 * nothing saved yet, or on any read/parse error.
 */
export async function getHulaProfile(
  userId: string | null | undefined,
): Promise<HulaProfile> {
  if (!userId) return {};
  try {
    const raw = await AsyncStorage.getItem(getHulaProfileKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as HulaProfile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merges `partial` into the stored profile and persists it. Returns the merged
 * record. A missing userId is a no-op that returns the partial as-is.
 */
export async function setHulaProfile(
  userId: string | null | undefined,
  partial: Partial<HulaProfile>,
): Promise<HulaProfile> {
  if (!userId) return { ...partial };
  const current = await getHulaProfile(userId);
  const next = { ...current, ...partial };
  try {
    await AsyncStorage.setItem(getHulaProfileKey(userId), JSON.stringify(next));
  } catch {
    // Non-fatal: the in-memory value is still returned to the caller.
  }
  return next;
}

/** Clears only the current user's profile overrides (used by the MVP delete/reset). */
export async function clearHulaProfile(
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;
  try {
    await AsyncStorage.removeItem(getHulaProfileKey(userId));
  } catch {
    // Non-fatal.
  }
}
