import type { OnboardingAnswers } from '@/lib/onboardingAnswers';

/**
 * Pure helper for the silent profile sync (Section 7).
 *
 * The app already stores onboarding answers and a local display-name override.
 * On Home load we quietly mirror a few SAFE fields to the backend so the Hula
 * brain can be a little more personal. This file only builds the payload — the
 * network call lives in `lib/hulaApi.ts` and the trigger in
 * `hooks/useSyncHulaProfile.ts`. Kept free of React/React Native imports so it
 * is trivially testable.
 *
 * Nothing sensitive is ever synced: no tokens, no message content, no ids —
 * only the lightweight onboarding-style hints below.
 */

/** The exact safe fields the backend `PUT /v1/me/profile` accepts. */
export interface ProfileSyncPayload {
  displayName?: string;
  firstName?: string;
  birthday?: string;
  sex?: string;
  tone?: 'concise' | 'witty' | 'strategic';
  helpMost?: string[];
  discoverySource?: string;
  timezone?: string;
  locale?: string;
  country?: string;
}

/** Inputs gathered from local storage, Clerk, and the device. */
export interface ProfileSyncInputs {
  answers?: OnboardingAnswers | null;
  /** Local display-name override (from `hula_profile:<userId>`). */
  displayName?: string | null;
  /** Resolved first name (from Clerk / display name). */
  firstName?: string | null;
  /** IANA timezone from the device, e.g. "Europe/London". */
  timezone?: string | null;
  /** BCP-47 locale from the device, e.g. "en-GB". */
  locale?: string | null;
  /** Country, if known. */
  country?: string | null;
}

/** Trim a possibly-null string; undefined when empty. */
function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Build the safe sync payload from local inputs. Only defined, non-empty fields
 * are included, so an incomplete onboarding never sends blank values. Pure and
 * side-effect free.
 */
export function buildProfileSyncPayload(inputs: ProfileSyncInputs): ProfileSyncPayload {
  const { answers } = inputs;
  const payload: ProfileSyncPayload = {};

  const displayName = clean(inputs.displayName);
  if (displayName) payload.displayName = displayName;

  const firstName = clean(inputs.firstName);
  if (firstName) payload.firstName = firstName;

  if (answers?.birthday) payload.birthday = answers.birthday;
  if (answers?.sex) payload.sex = answers.sex;
  if (answers?.tone) payload.tone = answers.tone;
  if (answers?.helpMost && answers.helpMost.length > 0) {
    payload.helpMost = [...answers.helpMost];
  }
  if (answers?.discoverySource) payload.discoverySource = answers.discoverySource;

  const timezone = clean(inputs.timezone);
  if (timezone) payload.timezone = timezone;

  const locale = clean(inputs.locale);
  if (locale) payload.locale = locale;

  const country = clean(inputs.country);
  if (country) payload.country = country;

  return payload;
}

/** True when the payload has at least one field worth syncing. */
export function hasSyncableFields(payload: ProfileSyncPayload): boolean {
  return Object.keys(payload).length > 0;
}
