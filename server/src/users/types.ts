import type { SubscriptionStatus } from "../billing/types";

/**
 * Backend user profile. Eventually mirrors the Hula frontend onboarding and
 * settings screens, but lives server-side and is keyed off the Clerk user id.
 */
export type UserTone = "concise" | "witty" | "strategic";

export type UserSex = "male" | "female" | "other" | "prefer_not_to_say";

export interface UserProfile {
  clerkUserId: string;

  // Personal details (mirrors onboarding / settings)
  displayName?: string;
  birthday?: string; // ISO date (YYYY-MM-DD)
  /** Derived from birthday at read time — placeholder until computed. */
  age?: number;
  sex?: UserSex;

  // Agent personalization
  tone?: UserTone;
  helpMost?: string;
  discoverySource?: string;

  // Locale / environment
  timezone?: string;
  locale?: string;
  country?: string;

  // Billing (placeholder — see billing/types)
  subscriptionStatus?: SubscriptionStatus;

  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
