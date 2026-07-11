/**
 * Shared reminder types (Section 9).
 *
 * Hula can create explicit, user-requested reminders ("remind me …") and deliver
 * them proactively over iMessage via Sendblue. Everything here is deliberately
 * small and conservative: explicit reminders only, deterministic delivery text,
 * and daily/weekly recurrence at most. Integration-sourced reminders (Calendar,
 * Zoom, Gmail, …) are NOT built yet — `ReminderSourceValue` just reserves space
 * for them.
 */

/** Where a reminder came from (mirrors the Prisma `ReminderSource` enum). */
export type ReminderSourceValue =
  | "explicit_user_request"
  | "future_calendar"
  | "future_integration";

/** Lifecycle of a reminder (mirrors the Prisma `ReminderStatus` enum). */
export type ReminderStatusValue = "scheduled" | "sent" | "cancelled" | "failed";

/**
 * Recurrence for a reminder. Section 9 only supports one-off (null), `daily`,
 * and `weekly`. The time-of-day and (for weekly) the weekday live in the
 * reminder's `dueAt`/`nextRunAt`, so this only needs the cadence.
 */
export type RecurrenceRule = "daily" | "weekly";

/** A saved reminder as returned to callers/endpoints. Safe fields only. */
export interface ReminderView {
  id: string;
  title: string;
  body: string | null;
  status: ReminderStatusValue;
  dueAt: string; // ISO 8601
  nextRunAt: string | null; // ISO 8601
  recurrenceRule: RecurrenceRule | null;
  timezone: string | null;
  createdAt: string; // ISO 8601
}
