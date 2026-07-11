import type { Prisma } from "@prisma/client";

import { getPrisma } from "../db/prisma";
import type { HulaPromptContext } from "../ai/prompts";
import { getOrCreateUserByClerkId } from "./store";

/**
 * User profile persistence + sanitisation (Section 7).
 *
 * The mobile app silently mirrors a few safe onboarding/profile fields to the
 * backend so the Hula brain can be a little more personal. Nothing here is
 * trusted blindly: every write goes through `sanitizeProfileInput` first, which
 * trims strings, caps lengths/array sizes, validates the tone enum, and drops
 * any unknown fields. No secrets or tokens are ever accepted or stored.
 *
 * The split mirrors the rest of the codebase: a PURE, DB-free sanitiser that is
 * fully unit-testable, and thin DB-backed helpers around it.
 */

/** Allowed tone values (must match the app's onboarding options). */
export const TONE_VALUES = ["concise", "witty", "strategic"] as const;
export type ToneValue = (typeof TONE_VALUES)[number];

/** Length/size caps so a client can never store oversized junk. */
const MAX_SHORT = 120; // names / short free text
const MAX_TINY = 64; // structured codes (sex, discoverySource, locale, country, timezone)
const MAX_HELP_ITEMS = 12;
const MAX_HELP_ITEM_LEN = 40;

/** The safe profile fields the app may sync and the API may return. */
export interface SafeProfileInput {
  displayName?: string;
  firstName?: string;
  birthday?: string;
  sex?: string;
  tone?: ToneValue;
  helpMost?: string[];
  discoverySource?: string;
  timezone?: string;
  locale?: string;
  country?: string;
}

/** Trim a value to a string and cap its length; undefined if not a usable string. */
function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

/** Validate the tone against the allowed enum; undefined otherwise. */
function cleanTone(value: unknown): ToneValue | undefined {
  return typeof value === "string" && (TONE_VALUES as readonly string[]).includes(value)
    ? (value as ToneValue)
    : undefined;
}

/** Clean an array of short string tags, dropping blanks/dupes and capping size. */
function cleanStringArray(value: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const cleaned = cleanString(item, maxLen);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Pure: turn an untrusted request body into a safe, minimal profile object.
 * Only known fields survive; everything is trimmed, capped, and validated. Keys
 * with no usable value are omitted entirely (so a partial sync never clobbers a
 * stored field with an empty string). No I/O — safe to unit test.
 */
export function sanitizeProfileInput(raw: unknown): SafeProfileInput {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const result: SafeProfileInput = {};

  const displayName = cleanString(body.displayName, MAX_SHORT);
  if (displayName) result.displayName = displayName;

  const firstName = cleanString(body.firstName, MAX_SHORT);
  if (firstName) result.firstName = firstName;

  const birthday = cleanString(body.birthday, MAX_TINY);
  if (birthday) result.birthday = birthday;

  const sex = cleanString(body.sex, MAX_TINY);
  if (sex) result.sex = sex;

  const tone = cleanTone(body.tone);
  if (tone) result.tone = tone;

  const helpMost = cleanStringArray(body.helpMost, MAX_HELP_ITEMS, MAX_HELP_ITEM_LEN);
  if (helpMost) result.helpMost = helpMost;

  const discoverySource = cleanString(body.discoverySource, MAX_TINY);
  if (discoverySource) result.discoverySource = discoverySource;

  const timezone = cleanString(body.timezone, MAX_TINY);
  if (timezone) result.timezone = timezone;

  const locale = cleanString(body.locale, MAX_TINY);
  if (locale) result.locale = locale;

  const country = cleanString(body.country, MAX_TINY);
  if (country) result.country = country;

  return result;
}

/** The safe profile shape returned by `GET /v1/me/profile`. */
export interface ProfileView extends SafeProfileInput {
  updatedAt: string | null; // ISO 8601, or null when no profile exists yet
}

/** Shape of the additive `preferencesJson` bag stored on UserProfile. */
interface StoredPreferences {
  helpMost?: string[];
  discoverySource?: string;
}

/** Read the loosely-typed preferences JSON back into a typed object. */
function readPreferences(value: unknown): StoredPreferences {
  if (!value || typeof value !== "object") return {};
  const bag = value as Record<string, unknown>;
  const prefs: StoredPreferences = {};
  const helpMost = cleanStringArray(bag.helpMost, MAX_HELP_ITEMS, MAX_HELP_ITEM_LEN);
  if (helpMost) prefs.helpMost = helpMost;
  const discoverySource = cleanString(bag.discoverySource, MAX_TINY);
  if (discoverySource) prefs.discoverySource = discoverySource;
  return prefs;
}

/**
 * Upsert the authenticated user's profile from a sanitised input. Resolves (or
 * creates) the internal Hula user for the Clerk id, then writes ONLY the fields
 * present in `input` so a partial sync never blanks existing data. helpMost and
 * discoverySource live in the additive `preferencesJson` bag. Returns the merged
 * profile view.
 */
export async function upsertUserProfile(
  clerkUserId: string,
  input: SafeProfileInput,
): Promise<ProfileView> {
  const user = await getOrCreateUserByClerkId(clerkUserId);
  const prisma = getPrisma();

  // Merge preference fields onto whatever is already stored (partial-safe).
  const existing = await prisma.userProfile.findUnique({
    where: { userId: user.id },
    select: { preferencesJson: true },
  });
  const currentPrefs = readPreferences(existing?.preferencesJson);
  const nextPrefs: StoredPreferences = { ...currentPrefs };
  if (input.helpMost !== undefined) nextPrefs.helpMost = input.helpMost;
  if (input.discoverySource !== undefined) nextPrefs.discoverySource = input.discoverySource;

  // Only include column fields that are actually present in the input.
  const columns: Record<string, unknown> = {};
  if (input.displayName !== undefined) columns.displayName = input.displayName;
  if (input.firstName !== undefined) columns.firstName = input.firstName;
  if (input.birthday !== undefined) columns.birthday = input.birthday;
  if (input.sex !== undefined) columns.sex = input.sex;
  if (input.tone !== undefined) columns.tone = input.tone;
  if (input.timezone !== undefined) columns.timezone = input.timezone;
  if (input.locale !== undefined) columns.locale = input.locale;
  if (input.country !== undefined) columns.country = input.country;

  const hasPrefs = nextPrefs.helpMost !== undefined || nextPrefs.discoverySource !== undefined;
  const data = {
    ...columns,
    ...(hasPrefs
      ? { preferencesJson: nextPrefs as unknown as Prisma.InputJsonValue }
      : {}),
  };

  const saved = await prisma.userProfile.upsert({
    where: { userId: user.id },
    update: data,
    create: { userId: user.id, ...data },
  });

  return toProfileView(saved);
}

/** Read the authenticated user's profile, or an empty view when none exists. */
export async function getUserProfile(clerkUserId: string): Promise<ProfileView> {
  const user = await getOrCreateUserByClerkId(clerkUserId);
  const saved = await getPrisma().userProfile.findUnique({
    where: { userId: user.id },
  });
  if (!saved) return { updatedAt: null };
  return toProfileView(saved);
}

/** Map a stored profile row to the safe view (columns + preferences bag). */
function toProfileView(row: {
  displayName: string | null;
  firstName: string | null;
  birthday: string | null;
  sex: string | null;
  tone: string | null;
  timezone: string | null;
  locale: string | null;
  country: string | null;
  preferencesJson: unknown;
  updatedAt: Date;
}): ProfileView {
  const prefs = readPreferences(row.preferencesJson);
  const view: ProfileView = { updatedAt: row.updatedAt.toISOString() };
  if (row.displayName) view.displayName = row.displayName;
  if (row.firstName) view.firstName = row.firstName;
  if (row.birthday) view.birthday = row.birthday;
  if (row.sex) view.sex = row.sex;
  if (row.tone) view.tone = cleanTone(row.tone);
  if (prefs.helpMost) view.helpMost = prefs.helpMost;
  if (prefs.discoverySource) view.discoverySource = prefs.discoverySource;
  if (row.timezone) view.timezone = row.timezone;
  if (row.locale) view.locale = row.locale;
  if (row.country) view.country = row.country;
  return view;
}

/**
 * Pure: derive the safe brain context from a stored profile view. Prefers
 * `firstName`, falling back to the first word of `displayName`. Only the
 * lightweight, non-sensitive hints the brain should see are included — never
 * secrets, ids, or provider internals. `channel` is added separately by the
 * caller. No I/O — unit-testable.
 */
export function profileToBrainContext(
  profile: SafeProfileInput | null | undefined,
): HulaPromptContext {
  const context: HulaPromptContext = {};
  if (!profile) return context;

  const firstName = profile.firstName?.trim() || profile.displayName?.trim().split(/\s+/)[0];
  if (firstName) context.firstName = firstName;
  if (profile.tone) context.tone = profile.tone;
  if (profile.helpMost && profile.helpMost.length > 0) context.helpMost = profile.helpMost;
  if (profile.birthday) context.birthday = profile.birthday;
  if (profile.sex) context.sex = profile.sex;
  if (profile.timezone) context.timezone = profile.timezone;
  if (profile.locale) context.locale = profile.locale;
  if (profile.country) context.country = profile.country;
  return context;
}

/**
 * Load safe brain context for an already-linked user (by internal Hula user id).
 * Best-effort: returns an empty context when there is no profile so a missing
 * profile never breaks a reply. Never throws.
 */
export async function loadBrainContextForUser(userId: string): Promise<HulaPromptContext> {
  const saved = await getPrisma().userProfile.findUnique({ where: { userId } });
  if (!saved) return {};
  return profileToBrainContext(toProfileView(saved));
}
