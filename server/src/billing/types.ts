/**
 * Billing / subscription placeholder types.
 *
 * Section 1: types only — no billing provider, no webhooks, no enforcement.
 */
export type SubscriptionPlan = "free" | "pro" | "unlimited";

export type SubscriptionStatus =
  | "none"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled";

export interface Subscription {
  id: string;
  clerkUserId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  /** Provider customer id (placeholder — no provider wired yet). */
  providerCustomerId?: string;
  currentPeriodEnd?: string; // ISO 8601
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
