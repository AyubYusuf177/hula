/**
 * Reminder placeholder types.
 *
 * Sendblue permits proactive outbound reminders once the user has messaged
 * first. These types describe scheduled proactive nudges Hula can send. Section
 * 1: types only — no scheduler, no delivery.
 */
export type ReminderStatus =
  | "scheduled"
  | "sent"
  | "cancelled"
  | "failed";

export type ReminderRecurrence = "none" | "daily" | "weekly" | "monthly";

export interface Reminder {
  id: string;
  clerkUserId: string;
  conversationId?: string;
  /** What Hula should say/do when the reminder fires. */
  message: string;
  /** When to fire. */
  dueAt: string; // ISO 8601
  recurrence: ReminderRecurrence;
  status: ReminderStatus;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
