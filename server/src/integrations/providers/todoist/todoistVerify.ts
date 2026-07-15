import { dueLocalStamp } from "./todoistFilters";
import type { NormalizedTodoistTask } from "./types";

/**
 * Todoist postcondition verification (Section 19) — ALL PURE.
 *
 * Mirrors `calendarVerify` / `gmailVerify`. After a write, Hula RE-READS the task
 * and checks reality against what it is about to claim. Only then is success
 * reported.
 *
 * WHY A SEPARATE READ, when the write already returned a task? Because the write's
 * response is Todoist's echo of the request it just processed, and echo and truth
 * can disagree. The concrete Todoist case: `POST /tasks/{id}` silently IGNORES
 * `project_id` — a move attempted through update returns a clean 200 describing a
 * task that never moved. Every field in that response looks right. The only way to
 * catch it is to state the expectation up front and check it against a fresh read.
 * (`updateTask` also refuses that call outright; this is the second line.)
 *
 * A failed verification is never a reason to retry — an ambiguous write retried is
 * how one task becomes two. It is a reason to describe what was actually observed.
 */

/** What a write claimed it would produce. Every field is optional. */
export interface TaskExpectation {
  content?: string;
  description?: string;
  /** Expected local due date (`YYYY-MM-DD`), as the user would say it. */
  dueDate?: string;
  /**
   * Expected LOCAL due time (`HH:MM`), as the user would say it.
   *
   * Deliberately a local wall time rather than an instant: Todoist may return the
   * due as a floating wall time OR as a UTC instant, and the only thing that is
   * stable across both — and the only thing the user actually cares about — is
   * "does it say 5pm?". `dueTimezone` resolves the comparison.
   */
  dueTime?: string;
  /** The zone the expected date/time are expressed in. */
  dueTimezone?: string;
  /** True when the due date should now be GONE entirely. */
  dueRemoved?: boolean;
  /** True when the TIME should be gone but the date retained. */
  dueTimeRemoved?: boolean;
  /** Expected RAW API priority (1..4). */
  priority?: number;
  /** Expected project id after a move. */
  projectId?: string;
  /** Expected section id after a move. */
  sectionId?: string;
  /** Labels that must ALL be present (order-free, case-insensitive). */
  labels?: string[];
  /** Labels that must be ABSENT. */
  labelsAbsent?: string[];
  /** Expected completion state. */
  completed?: boolean;
}

/**
 * One field that did not match, named safely for logs and honest replies.
 *
 * `due` and `due_time` are SEPARATE because they are separate failures with
 * separate remedies, and conflating them produced a genuinely misleading reply on
 * a real device: a task whose DATE saved fine but whose 5pm time did not was
 * reported as "the due date didn't stick", telling the user their date was wrong
 * when it was correct.
 */
export type TaskMismatch =
  | "content"
  | "description"
  | "due"
  | "due_time"
  | "priority"
  | "project"
  | "section"
  | "labels"
  | "completed";

export interface TaskVerification {
  ok: boolean;
  mismatches: TaskMismatch[];
}

/** PURE: trimmed, case-insensitive text equality. */
function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}


/**
 * PURE: verify a re-fetched task against what the write promised.
 *
 * Only STATED expectations are checked — an absent field is not an assertion, so
 * an update that changed the due date says nothing about the title.
 */
export function verifyTaskState(
  actual: NormalizedTodoistTask | null,
  expected: TaskExpectation,
): TaskVerification {
  const mismatches: TaskMismatch[] = [];

  if (!actual) {
    // Nothing came back: every stated expectation is unmet. Reporting success
    // here is exactly the fabrication this module exists to prevent.
    const all: TaskMismatch[] = [];
    if (expected.content !== undefined) all.push("content");
    if (expected.description !== undefined) all.push("description");
    if (expected.dueDate !== undefined || expected.dueRemoved) all.push("due");
    if (expected.dueTime !== undefined || expected.dueTimeRemoved) all.push("due_time");
    if (expected.priority !== undefined) all.push("priority");
    if (expected.projectId !== undefined) all.push("project");
    if (expected.sectionId !== undefined) all.push("section");
    if (expected.labels !== undefined || expected.labelsAbsent !== undefined) all.push("labels");
    if (expected.completed !== undefined) all.push("completed");
    return { ok: false, mismatches: all.length > 0 ? all : ["content"] };
  }

  if (expected.content !== undefined && !sameText(actual.content, expected.content)) {
    mismatches.push("content");
  }
  if (expected.description !== undefined && !sameText(actual.description, expected.description)) {
    mismatches.push("description");
  }
  // Resolve what Todoist ACTUALLY says, in the user's own terms — the same
  // resolution the reply uses, so the verifier and the display can never disagree.
  const stamp = dueLocalStamp(actual.due, expected.dueTimezone);

  if (expected.dueRemoved) {
    if (actual.due !== null) mismatches.push("due");
  } else {
    if (expected.dueDate !== undefined && stamp?.dateKey !== expected.dueDate) {
      mismatches.push("due");
    }
    if (expected.dueTime !== undefined) {
      // Checked INDEPENDENTLY of the date. The live failure was exactly this
      // combination: the date landed, the time did not.
      if (stamp?.time !== expected.dueTime) mismatches.push("due_time");
    }
    if (expected.dueTimeRemoved && stamp?.time !== null) {
      mismatches.push("due_time");
    }
  }
  if (expected.priority !== undefined && actual.priority !== expected.priority) {
    mismatches.push("priority");
  }
  if (expected.projectId !== undefined && actual.projectId !== expected.projectId) {
    mismatches.push("project");
  }
  if (expected.sectionId !== undefined && actual.sectionId !== expected.sectionId) {
    mismatches.push("section");
  }
  if (expected.labels !== undefined) {
    const have = new Set(actual.labels.map((l) => l.trim().toLowerCase()));
    const missing = expected.labels
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !have.has(l));
    if (missing.length > 0) mismatches.push("labels");
  }
  if (expected.labelsAbsent !== undefined) {
    const have = new Set(actual.labels.map((l) => l.trim().toLowerCase()));
    const lingering = expected.labelsAbsent
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && have.has(l));
    if (lingering.length > 0 && !mismatches.includes("labels")) mismatches.push("labels");
  }
  if (expected.completed !== undefined && actual.completed !== expected.completed) {
    mismatches.push("completed");
  }

  return { ok: mismatches.length === 0, mismatches };
}

/**
 * PURE: verify a COMPLETION, given the outcome of re-reading the task.
 *
 * Todoist's semantics make this subtler than it looks, and each branch is a real
 * case rather than defensive padding:
 *
 *  - `not_found` PROVES completion for a normal task: a closed task drops out of
 *    the active endpoints entirely, so a 404 on re-read is success, not failure.
 *  - A returned task with `checked: true` proves it too.
 *  - A RECURRING task is the trap. Closing one does not complete it — Todoist
 *    rolls it forward to its next occurrence, so the task is still present and
 *    still ACTIVE. That is a correct, successful completion of this occurrence,
 *    and reporting it as a failure would be wrong. It is only distinguishable by
 *    the task being recurring, which is why the caller must pass that in.
 */
export function verifyCompletion(input: {
  found: boolean;
  task: NormalizedTodoistTask | null;
  wasRecurring: boolean;
}): { ok: boolean; rolledForward: boolean } {
  if (!input.found) return { ok: true, rolledForward: false };
  if (input.task?.completed) return { ok: true, rolledForward: false };
  if (input.wasRecurring && input.task) {
    // Still active, but this is a repeat — Todoist advanced it to the next due
    // date. The occurrence the user asked about IS done.
    return { ok: true, rolledForward: true };
  }
  return { ok: false, rolledForward: false };
}

/**
 * PURE: verify a REOPEN — the task must exist AND be active again.
 *
 * The asymmetry with completion is deliberate: a missing task cannot prove a
 * reopen (there is nothing to be active), so `found: false` is a failure here
 * even though it is a success above.
 */
export function verifyReopen(task: NormalizedTodoistTask | null): boolean {
  return Boolean(task && !task.completed);
}

/**
 * PURE: does a read CONFIRM a deletion? Absence is the proof.
 *
 * IMPORTANT — this is a CONFIRMATION, not a verdict, and it is deliberately no
 * longer what decides whether a delete succeeded.
 *
 * It used to be. The executor did one immediate read and treated "still visible"
 * as proof the delete had failed. On a real device Todoist returned a documented
 * DELETE success and then still served the task from `GET /tasks/{id}` seconds
 * later; Hula told the user it "hadn't taken effect", and the task was in fact
 * already gone. A read-after-write lag is a property of the store, not evidence
 * about the write.
 *
 * So the authority is now the VALIDATED DELETE RECEIPT (see `deleteTask` and
 * `confirmTodoistDeletion` in the executor). `found === false` still positively
 * confirms absence — which is useful — but `found === true` proves nothing, and
 * this helper must never again be used to overturn a receipt.
 */
export function verifyDeletion(found: boolean): boolean {
  return !found;
}
