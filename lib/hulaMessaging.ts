import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Local, per-user store for the messaging addresses a user texts Hula from.
 *
 * Client-only for now (no backend) and ALWAYS scoped to the current Clerk
 * `userId`, so two different users never share state. Phone and email are stored
 * SEPARATELY so switching the iMessage Address tab never overwrites the other.
 */

export type HulaMessaging = {
  iMessagePhone?: string;
  iMessageEmail?: string;
  /** Which tab the user last had selected on the iMessage Address screen. */
  selectedIMessageTab?: 'phone' | 'email';
  whatsappNumber?: string;
};

/** The AsyncStorage key holding the current user's messaging addresses. */
export function getHulaMessagingKey(userId: string): string {
  return `hula_messaging:${userId}`;
}

/**
 * Reads the stored messaging record for a user. Returns `{}` when there is no
 * userId, nothing saved yet, or on any read/parse error — callers can always
 * treat the result as a plain partial object.
 */
export async function getHulaMessaging(
  userId: string | null | undefined,
): Promise<HulaMessaging> {
  if (!userId) return {};
  try {
    const raw = await AsyncStorage.getItem(getHulaMessagingKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as HulaMessaging;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merges `partial` into the user's stored messaging record and persists it.
 * Returns the merged record so callers can use it immediately. A missing userId
 * is a no-op that returns the partial as-is.
 */
export async function setHulaMessaging(
  userId: string | null | undefined,
  partial: Partial<HulaMessaging>,
): Promise<HulaMessaging> {
  if (!userId) return { ...partial };
  const current = await getHulaMessaging(userId);
  const next = { ...current, ...partial };
  try {
    await AsyncStorage.setItem(getHulaMessagingKey(userId), JSON.stringify(next));
  } catch {
    // Non-fatal: the in-memory value is still returned to the caller.
  }
  return next;
}

/** Clears only the current user's messaging record (used by the MVP delete/reset). */
export async function clearHulaMessaging(
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;
  try {
    await AsyncStorage.removeItem(getHulaMessagingKey(userId));
  } catch {
    // Non-fatal.
  }
}
