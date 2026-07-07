import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Local record of a user's free access window (24-hour preview or 7-day trial).
 *
 * This is an MVP placeholder: there is NO real billing, receipt, or entitlement
 * check yet. It simply remembers, per Clerk `userId`, which free window the user
 * started and when it expires, plus lightweight counters that a later section
 * (recurring paywall / expiry prompts) will read. Client-only for now.
 */

export type HulaPreviewType = 'preview_24h' | 'trial_7d';

export type HulaPreview = {
  type: HulaPreviewType;
  /** ISO timestamp when the preview/trial started. */
  startedAt: string;
  /** ISO timestamp when it expires. */
  expiresAt: string;
  /** How many times the user has dismissed a paywall since starting. */
  paywallDismissCount: number;
  /** ISO timestamp the paywall was last shown, if ever. */
  lastPaywallShownAt?: string;
};

/** Access-window length per type, in milliseconds. */
const DURATION_MS: Record<HulaPreviewType, number> = {
  preview_24h: 24 * 60 * 60 * 1000,
  trial_7d: 7 * 24 * 60 * 60 * 1000,
};

/** The AsyncStorage key holding the current user's preview record. */
export function getHulaPreviewKey(userId: string): string {
  return `hula_preview:${userId}`;
}

/**
 * Reads the stored preview record, or `null` when there is no userId, nothing
 * saved, or on any read/parse error.
 */
export async function getHulaPreview(
  userId: string | null | undefined,
): Promise<HulaPreview | null> {
  if (!userId) return null;
  try {
    const raw = await AsyncStorage.getItem(getHulaPreviewKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HulaPreview;
    return parsed && typeof parsed === 'object' && parsed.type ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Starts (or restarts) a free access window for the user and persists it.
 * Returns the created record so the caller can use it immediately. A missing
 * userId returns the record without persisting.
 */
export async function startHulaPreview(
  userId: string | null | undefined,
  type: HulaPreviewType,
): Promise<HulaPreview> {
  const now = new Date();
  const preview: HulaPreview = {
    type,
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DURATION_MS[type]).toISOString(),
    paywallDismissCount: 0,
  };
  if (!userId) return preview;
  try {
    await AsyncStorage.setItem(getHulaPreviewKey(userId), JSON.stringify(preview));
  } catch {
    // Non-fatal: the in-memory record is still returned to the caller.
  }
  return preview;
}

/** Dev/debug helper: clears only the current user's preview record. */
export async function clearHulaPreview(
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;
  try {
    await AsyncStorage.removeItem(getHulaPreviewKey(userId));
  } catch {
    // Non-fatal.
  }
}
