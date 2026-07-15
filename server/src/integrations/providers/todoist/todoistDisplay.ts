import { dueLocalStamp, localDateKey } from "./todoistFilters";
import { priorityLabel, type NormalizedTodoistTask } from "./types";

/**
 * Todoist iMessage formatting (Section 19) — ALL PURE.
 *
 * The section's required shape:
 *
 *   1. Task title
 *      Due date/time · Project · Priority
 *
 * Two rules this file exists to hold:
 *  - INTERNAL IDS ARE NEVER SHOWN. A Todoist task id is meaningless to a person
 *    reading a text message, and printing one invites the user to quote it back.
 *    Follow-ups work by POSITION ("the second one"), which is why the numbering
 *    here and the stored selection order must agree exactly.
 *  - Only genuinely-known facts are printed. A missing project or due date is
 *    omitted rather than guessed at or filled with a placeholder.
 */

/** How a project id maps to a display name, for the meta line. */
export type ProjectNameLookup = (projectId: string | null) => string | null;

/**
 * PURE: render a LOCAL `HH:MM` as a 12-hour clock time, e.g. "5pm" / "5:30pm".
 *
 * Takes an already-localized wall time rather than an instant, because the caller
 * (`dueLocalStamp`) is the single place that knows whether Todoist gave us a
 * floating wall time or an absolute instant. Converting here would either
 * double-convert a floating time or leave an instant unconverted.
 */
export function formatLocalTime(time: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return "";
  const hour24 = Number(match[1]);
  const minute = match[2]!;
  const period = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  // Drop ":00" — "5pm" reads better than "5:00pm" in a text message.
  return minute === "00" ? `${hour12}${period}` : `${hour12}:${minute}${period}`;
}

/**
 * PURE: a LOCAL `HH:MM` as a full clock time, e.g. "5:00 PM".
 *
 * Distinct from `formatLocalTime` ("5pm") on purpose. The terse form is right for a
 * dense task list; this explicit form is used where precision matters more than
 * brevity — notably when telling a user which exact time FAILED to save, where
 * "5pm" invites a second look and "5:00 PM" does not.
 */
export function formatClockTime(time: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return "";
  const hour24 = Number(match[1]);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${match[2]} ${hour24 >= 12 ? "PM" : "AM"}`;
}

/** PURE: a 12-hour clock time for an absolute instant, in the user's zone. */
export function formatTime(instant: string, timezone?: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return formatLocalTime(hhmm);
}

/**
 * PURE: a human due description relative to today ("Today", "Tomorrow",
 * "Overdue — Mon 13 Jul", "Fri 17 Jul at 5pm").
 *
 * Relative words are used only for today/tomorrow/yesterday, where they are
 * unambiguous. Anything further out gets a real date, because "in 5 days" forces
 * the reader to do arithmetic.
 */
export function formatDue(
  task: NormalizedTodoistTask,
  now: Date,
  timezone?: string,
): string | null {
  // ONE resolution of what the due date means (all-day / floating / fixed), shared
  // with filtering and verification. Re-deriving it here is how the display and the
  // verifier drifted apart in the first place.
  const stamp = dueLocalStamp(task.due, timezone);
  if (!stamp) return null;

  const dueKey = stamp.dateKey;
  const todayKey = localDateKey(now, timezone);
  const time = stamp.time ? formatLocalTime(stamp.time) : null;

  let dayLabel: string;
  if (dueKey === todayKey) {
    dayLabel = "Today";
  } else {
    const [y, m, d] = dueKey.split("-").map(Number);
    if (!y || !m || !d) return null;
    const asDate = new Date(Date.UTC(y, m - 1, d));
    const yesterdayKey = localDateKey(new Date(now.getTime() - 86_400_000), timezone);
    const tomorrowKey = localDateKey(new Date(now.getTime() + 86_400_000), timezone);
    if (dueKey === tomorrowKey) dayLabel = "Tomorrow";
    else if (dueKey === yesterdayKey) dayLabel = "Yesterday";
    else {
      dayLabel = new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        weekday: "short",
        day: "numeric",
        month: "short",
      }).format(asDate);
    }
  }

  const withTime = time ? `${dayLabel} at ${time}` : dayLabel;
  // Flagging overdue on the line itself is the single most useful signal in a
  // task list, and it costs nothing to state plainly.
  return dueKey < todayKey ? `Overdue — ${withTime}` : withTime;
}

/**
 * PURE: the meta line under a task title: "Due · Project · Priority".
 *
 * Priority is shown ONLY when it is not Todoist's default. Every task has a
 * priority, so printing "Normal" on each line would be noise that buries the one
 * task that is actually urgent.
 */
export function formatTaskMeta(
  task: NormalizedTodoistTask,
  now: Date,
  timezone: string | undefined,
  projectName: ProjectNameLookup,
): string {
  const bits: string[] = [];
  const due = formatDue(task, now, timezone);
  if (due) bits.push(due);
  if (task.due?.isRecurring && task.due.string) bits.push(`Repeats ${task.due.string}`);

  const project = projectName(task.projectId);
  if (project) bits.push(project);

  if (task.priority > 1) bits.push(priorityLabel(task.priority));
  if (task.labels.length > 0) bits.push(task.labels.map((l) => `@${l}`).join(" "));
  return bits.join(" · ");
}

/**
 * PURE: render a NUMBERED task list in the section's required format.
 *
 * The numbering is the contract with `todoistContext`: position N here must be
 * the Nth stored item, because that is what "complete the second one" resolves
 * against.
 */
export function formatTaskList(
  tasks: readonly NormalizedTodoistTask[],
  now: Date,
  timezone: string | undefined,
  projectName: ProjectNameLookup,
): string {
  return tasks
    .map((task, index) => {
      const title = task.content.trim() || "(untitled task)";
      const meta = formatTaskMeta(task, now, timezone, projectName);
      return meta ? `${index + 1}. ${title}\n   ${meta}` : `${index + 1}. ${title}`;
    })
    .join("\n");
}

/** The honest, friendly empty-state line for each scope. */
export function emptyStateFor(scope: string, projectLabel?: string | null): string {
  const where = projectLabel ? ` in ${projectLabel}` : "";
  switch (scope) {
    case "today":
      return `Nothing due today${where}. 🎉`;
    case "overdue":
      return `Nothing overdue${where} — you're all caught up.`;
    case "week":
      return `Nothing due in the next 7 days${where}.`;
    case "upcoming":
      return `Nothing coming up${where}.`;
    case "no_date":
      return `Every task${where} has a due date.`;
    default:
      return `No tasks${where}.`;
  }
}

/**
 * PURE: a header describing what was read, plus an honest note about more.
 *
 * The "and N more" note appears ONLY when the user did NOT ask for a specific
 * count. The section calls this out directly: answering "show me five" with "I
 * found 10, showing 5" is a non-answer to a question they already bounded.
 */
export function formatMoreNote(
  shown: number,
  totalFetched: number,
  explicitCount: boolean,
): string | null {
  if (explicitCount) return null;
  if (totalFetched <= shown) return null;
  const more = totalFetched - shown;
  return `\n\n+${more} more.`;
}

/** PURE: render one task in full, for "tell me about that task". */
export function formatTaskDetail(
  task: NormalizedTodoistTask,
  now: Date,
  timezone: string | undefined,
  projectName: ProjectNameLookup,
): string {
  const lines: string[] = [task.content.trim() || "(untitled task)"];
  const due = formatDue(task, now, timezone);
  if (due) lines.push(`Due: ${due}`);
  if (task.due?.isRecurring && task.due.string) lines.push(`Repeats: ${task.due.string}`);
  if (task.deadline) lines.push(`Deadline: ${task.deadline}`);
  const project = projectName(task.projectId);
  if (project) lines.push(`Project: ${project}`);
  lines.push(`Priority: ${priorityLabel(task.priority)}`);
  if (task.labels.length > 0) lines.push(`Labels: ${task.labels.map((l) => `@${l}`).join(" ")}`);
  if (task.description) lines.push(`\n${task.description.trim()}`);
  return lines.join("\n");
}
