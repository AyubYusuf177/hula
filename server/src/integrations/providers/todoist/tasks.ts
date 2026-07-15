import { randomUUID } from "node:crypto";

import {
  TodoistError,
  fetchTodoistPages,
  parseTodoistPage,
  todoistRequest,
  todoistRequestStatus,
} from "./client";
import {
  TODOIST_PROVIDER,
  clampApiPriority,
  hasTimeComponent,
  isFloatingDatetime,
  type NormalizedTodoistLabel,
  type NormalizedTodoistProject,
  type NormalizedTodoistSection,
  type NormalizedTodoistTask,
  type TodoistDue,
} from "./types";

/**
 * Todoist resource layer (Section 19).
 *
 * The ONLY module that knows Todoist's wire format. It normalizes every payload
 * into the `types.ts` shapes and performs the task/project/section/label calls.
 * Nothing above this layer sees a raw provider object, so a provider field rename
 * surfaces here rather than in a reply.
 *
 * Every function throws a classified `TodoistError` and never returns a partial
 * or invented object: a write whose response lacks a real Todoist-issued id is
 * treated as a failure, never as a success (that receipt check is what stops Hula
 * claiming a task exists when it does not).
 */

/** Injectable transport so tests exercise all of this with NO network. */
export interface TodoistCallOptions {
  fetchImpl?: TodoistFetch;
  baseUrl?: string;
}

type TodoistFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers?: { get: (name: string) => string | null };
}>;

/** Default cap on tasks returned for an open-ended read. */
export const DEFAULT_TASK_LIMIT = 5;

/** Hard cap on any single read, however many the user asks for. */
export const MAX_TASK_LIMIT = 50;

/** Cap on how many tasks a single bulk action may ever touch. */
export const MAX_BULK_TARGETS = 25;

// --- Normalization (PURE) ------------------------------------------------

/** PURE: read a string field, or null. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** PURE: coerce Todoist's id (string or number across resources) to a string. */
function id(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * PURE: normalize Todoist's `due` object, or null when the task has no due date.
 *
 * THE FIX. Todoist v1 returns the SYNC-shaped due object, which has NO `datetime`
 * field — the time is inside `date` (see `TodoistDue`). This previously read
 * `r.datetime`, which is always absent on v1, so every timed task came back as
 * all-day: the time disappeared from replies and postcondition verification
 * declared a perfectly good 5pm due date "not stuck".
 *
 * `r.datetime` is still accepted as a FALLBACK so a REST-v2-shaped payload (or a
 * fixture written against it) keeps working — but `date` is authoritative,
 * because that is what the live API sends.
 */
export function normalizeDue(raw: unknown): TodoistDue | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const date = str(r.date);
  const legacyDatetime = str(r.datetime);
  // A due object with no date information at all carries nothing.
  if (!date && !legacyDatetime) return null;

  const rawDate = date ?? (legacyDatetime as string);
  // v1: the time (when there is one) lives in `date`. Fall back to a v2-style
  // `datetime` only if `date` is date-only.
  const datetime = hasTimeComponent(rawDate)
    ? rawDate
    : hasTimeComponent(legacyDatetime)
      ? legacyDatetime
      : null;

  return {
    date: rawDate,
    datetime,
    isFloating: isFloatingDatetime(datetime),
    timezone: str(r.timezone),
    isRecurring: r.is_recurring === true,
    string: str(r.string),
  };
}

/**
 * PURE: normalize a raw Todoist task.
 *
 * Returns null when the payload has no usable id — an unidentifiable task cannot
 * be acted on later, so admitting it into a numbered list would create a
 * follow-up that silently fails.
 */
export function normalizeTask(raw: unknown): NormalizedTodoistTask | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const taskId = id(r.id);
  if (!taskId) return null;

  const labels = Array.isArray(r.labels)
    ? r.labels.filter((l): l is string => typeof l === "string")
    : [];

  // Todoist reports completion as `checked` on v1 and `is_completed` on older
  // payloads. Accepting both costs one line and avoids reporting a completed task
  // as active if a response mixes shapes.
  const completed = r.checked === true || r.is_completed === true;

  // `deadline` is an object (`{ date }`), distinct from `due` — a task can have a
  // hard deadline and a separate working due date.
  const deadlineRaw = r.deadline;
  const deadline =
    deadlineRaw && typeof deadlineRaw === "object"
      ? str((deadlineRaw as Record<string, unknown>).date)
      : str(deadlineRaw);

  return {
    id: taskId,
    content: typeof r.content === "string" ? r.content : "",
    description: str(r.description),
    projectId: id(r.project_id),
    sectionId: id(r.section_id),
    parentId: id(r.parent_id),
    labels,
    priority: clampApiPriority(r.priority),
    due: normalizeDue(r.due),
    deadline,
    completed,
    assigneeId: id(r.assignee_id) ?? id(r.responsible_uid),
    url: str(r.url),
    createdAt: str(r.created_at) ?? str(r.added_at),
    completedAt: str(r.completed_at),
    source: "todoist",
  };
}

/** PURE: normalize a raw Todoist project, or null without a usable id/name. */
export function normalizeProject(raw: unknown): NormalizedTodoistProject | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const projectId = id(r.id);
  if (!projectId) return null;
  return {
    id: projectId,
    name: typeof r.name === "string" ? r.name : "",
    isInboxProject: r.is_inbox_project === true || r.inbox_project === true,
    parentId: id(r.parent_id),
  };
}

/** PURE: normalize a raw Todoist section. */
export function normalizeSection(raw: unknown): NormalizedTodoistSection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sectionId = id(r.id);
  const projectId = id(r.project_id);
  if (!sectionId || !projectId) return null;
  return {
    id: sectionId,
    projectId,
    name: typeof r.name === "string" ? r.name : "",
  };
}

/** PURE: normalize a raw Todoist label. */
export function normalizeLabel(raw: unknown): NormalizedTodoistLabel | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const labelId = id(r.id);
  if (!labelId) return null;
  return { id: labelId, name: typeof r.name === "string" ? r.name : "" };
}

/** PURE: normalize a page of tasks, dropping any unusable entries. */
function normalizeTasks(rows: unknown[]): NormalizedTodoistTask[] {
  const tasks: NormalizedTodoistTask[] = [];
  for (const row of rows) {
    const task = normalizeTask(row);
    if (task) tasks.push(task);
  }
  return tasks;
}

// --- Reads ---------------------------------------------------------------

/** Bound a requested count into the allowed range. */
export function boundLimit(requested: number | null | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return DEFAULT_TASK_LIMIT;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_TASK_LIMIT);
}

/**
 * Fetch ACTIVE tasks matching a deterministic Todoist filter expression.
 *
 * The `query` string is ALWAYS built by `buildFilterQuery` from typed intent
 * fields — never by the model, and never from raw user text. That boundary is
 * deliberate: Todoist's filter language is powerful enough that a model-authored
 * expression could quietly select the wrong tasks, and a write built on top of it
 * would then act on tasks the user never saw.
 */
export async function fetchTasksByFilter(
  userId: string,
  query: string,
  limit: number,
  options: TodoistCallOptions = {},
): Promise<NormalizedTodoistTask[]> {
  const rows = await fetchTodoistPages<unknown>(
    userId,
    "/tasks/filter",
    { query },
    boundLimit(limit),
    options,
  );
  return normalizeTasks(rows);
}

/** Fetch ACTIVE tasks, optionally scoped to a project/section/label. */
export async function fetchTasks(
  userId: string,
  filters: { projectId?: string; sectionId?: string; label?: string },
  limit: number,
  options: TodoistCallOptions = {},
): Promise<NormalizedTodoistTask[]> {
  const rows = await fetchTodoistPages<unknown>(
    userId,
    "/tasks",
    {
      project_id: filters.projectId,
      section_id: filters.sectionId,
      label: filters.label,
    },
    boundLimit(limit),
    options,
  );
  return normalizeTasks(rows);
}

/**
 * Fetch ONE task by id.
 *
 * This is the re-fetch every write performs before mutating: context may be
 * minutes old, and the task may have been completed, moved, or deleted in the
 * Todoist app since. Throws `task_not_found` when it is gone.
 */
export async function fetchTask(
  userId: string,
  taskId: string,
  options: TodoistCallOptions = {},
): Promise<NormalizedTodoistTask> {
  const raw = await todoistRequest<unknown>(userId, {
    method: "GET",
    path: `/tasks/${encodeURIComponent(taskId)}`,
    ...options,
  });
  const task = normalizeTask(raw);
  if (!task) {
    throw new TodoistError("malformed_provider_response", "Todoist returned an unusable task");
  }
  return task;
}

/**
 * Fetch RECENTLY COMPLETED tasks by completion date.
 *
 * Todoist exposes completed tasks through their own endpoint with a REQUIRED
 * bounded window — completed history is not part of the normal task list. The
 * window is capped rather than open-ended so "what did I just finish" stays a
 * cheap, bounded question.
 */
export async function fetchCompletedTasks(
  userId: string,
  input: { since: string; until: string; projectId?: string },
  limit: number,
  options: TodoistCallOptions = {},
): Promise<NormalizedTodoistTask[]> {
  const rows = await fetchTodoistPages<unknown>(
    userId,
    "/tasks/completed/by_completion_date",
    { since: input.since, until: input.until, project_id: input.projectId },
    boundLimit(limit),
    options,
  );
  // The completed endpoint does not always set a completion flag on each item;
  // these tasks are completed BY DEFINITION of the endpoint they came from.
  return normalizeTasks(rows).map((t) => ({ ...t, completed: true }));
}

/** Fetch the user's projects (bounded). */
export async function fetchProjects(
  userId: string,
  options: TodoistCallOptions = {},
): Promise<NormalizedTodoistProject[]> {
  const rows = await fetchTodoistPages<unknown>(userId, "/projects", {}, 200, options);
  const projects: NormalizedTodoistProject[] = [];
  for (const row of rows) {
    const project = normalizeProject(row);
    if (project) projects.push(project);
  }
  return projects;
}

/** Fetch sections, optionally for one project (bounded). */
export async function fetchSections(
  userId: string,
  projectId: string | undefined,
  options: TodoistCallOptions = {},
): Promise<NormalizedTodoistSection[]> {
  const rows = await fetchTodoistPages<unknown>(
    userId,
    "/sections",
    { project_id: projectId },
    200,
    options,
  );
  const sections: NormalizedTodoistSection[] = [];
  for (const row of rows) {
    const section = normalizeSection(row);
    if (section) sections.push(section);
  }
  return sections;
}

/** Fetch the user's personal labels (bounded). */
export async function fetchLabels(
  userId: string,
  options: TodoistCallOptions = {},
): Promise<NormalizedTodoistLabel[]> {
  const rows = await fetchTodoistPages<unknown>(userId, "/labels", {}, 200, options);
  const labels: NormalizedTodoistLabel[] = [];
  for (const row of rows) {
    const label = normalizeLabel(row);
    if (label) labels.push(label);
  }
  return labels;
}

// --- Writes --------------------------------------------------------------

/** The fields a create/update may set. Every one arrives ALREADY RESOLVED. */
export interface TodoistTaskWriteFields {
  content?: string;
  description?: string;
  projectId?: string;
  sectionId?: string;
  /** Label NAMES. Todoist takes names, not ids, on a task write. */
  labels?: string[];
  /** RAW API priority (1..4). Callers convert from UI priority first. */
  priority?: number;
  /** A date-only due (`YYYY-MM-DD`). Mutually exclusive with the others. */
  dueDate?: string;
  /** A full ISO instant due (timed). Mutually exclusive with the others. */
  dueDatetime?: string;
  /** A natural-language due Todoist parses ("every Monday"). Recurring only. */
  dueString?: string;
  /** Set true to CLEAR the due date. */
  removeDue?: boolean;
  assigneeId?: string;
}

/**
 * PURE: project write fields onto Todoist's wire body.
 *
 * `mode` is NOT cosmetic — it encodes a real asymmetry in Todoist's contract that
 * is verified against the official OpenAPI schema:
 *
 *   - CREATE (`POST /tasks`) accepts `project_id` and `section_id`.
 *   - UPDATE (`POST /tasks/{id}`) does NOT. Its schema has no such fields, and
 *     relocating an existing task is a separate `POST /tasks/{id}/move` call.
 *
 * Emitting `project_id` on an update would therefore be silently IGNORED by
 * Todoist: the call returns 200 with a task that never moved, and Hula would
 * report a move that did not happen. Refusing here (see `updateTask`) forces the
 * caller through `moveTask`, which is the only thing that actually relocates a
 * task.
 *
 * The due fields are mutually exclusive by Todoist's contract, so exactly one is
 * ever emitted, in a fixed precedence. `removeDue` emits an explicit
 * `due_string: "no date"` — Todoist's documented way to CLEAR a due date. Simply
 * omitting the field would leave the due date untouched, which is the opposite of
 * what "take the date off that" asks for.
 */
export function buildTaskWriteBody(
  fields: TodoistTaskWriteFields,
  mode: "create" | "update" = "create",
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.content !== undefined) body.content = fields.content;
  if (fields.description !== undefined) body.description = fields.description;
  if (mode === "create") {
    if (fields.projectId !== undefined) body.project_id = fields.projectId;
    if (fields.sectionId !== undefined) body.section_id = fields.sectionId;
  }
  if (fields.labels !== undefined) body.labels = fields.labels;
  if (fields.priority !== undefined) body.priority = clampApiPriority(fields.priority);
  if (fields.assigneeId !== undefined) body.assignee_id = fields.assigneeId;

  if (fields.removeDue) {
    body.due_string = "no date";
  } else if (fields.dueDatetime) {
    body.due_datetime = fields.dueDatetime;
  } else if (fields.dueDate) {
    body.due_date = fields.dueDate;
  } else if (fields.dueString) {
    body.due_string = fields.dueString;
  }
  return body;
}

/**
 * Create a task. Returns the created task ONLY when Todoist issues a real id.
 *
 * `requestId` is generated ONCE by the caller and replayed on a retry so Todoist
 * de-duplicates rather than creating a second task — the same discipline the
 * Calendar Meet `requestId` uses.
 */
export async function createTask(
  userId: string,
  fields: TodoistTaskWriteFields,
  options: TodoistCallOptions & { requestId?: string } = {},
): Promise<NormalizedTodoistTask> {
  const body = buildTaskWriteBody(fields, "create");
  if (typeof body.content !== "string" || body.content.trim().length === 0) {
    throw new TodoistError("invalid_request", "A task needs a title");
  }
  const raw = await todoistRequest<unknown>(userId, {
    method: "POST",
    path: "/tasks",
    body,
    requestId: options.requestId ?? randomUUID(),
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
  });
  const task = normalizeTask(raw);
  // A create with no provider-issued id is NOT a confirmed create.
  if (!task) {
    throw new TodoistError("malformed_provider_response", "Todoist did not return a created task");
  }
  return task;
}

/**
 * Update a task. Returns Todoist's updated task (its echo of the write).
 *
 * REFUSES a project/section change rather than silently dropping it: Todoist's
 * update endpoint has no such fields and would answer 200 having moved nothing,
 * which is exactly the shape of a false success. Relocation goes through
 * `moveTask`.
 */
export async function updateTask(
  userId: string,
  taskId: string,
  fields: TodoistTaskWriteFields,
  options: TodoistCallOptions = {},
): Promise<NormalizedTodoistTask> {
  if (fields.projectId !== undefined || fields.sectionId !== undefined) {
    throw new TodoistError(
      "invalid_request",
      "Todoist cannot move a task through update — use moveTask",
    );
  }
  const body = buildTaskWriteBody(fields, "update");
  if (Object.keys(body).length === 0) {
    throw new TodoistError("invalid_request", "Nothing to change on the task");
  }
  const raw = await todoistRequest<unknown>(userId, {
    method: "POST",
    path: `/tasks/${encodeURIComponent(taskId)}`,
    body,
    ...options,
  });
  const task = normalizeTask(raw);
  if (!task) {
    throw new TodoistError("malformed_provider_response", "Todoist did not return the updated task");
  }
  return task;
}

/**
 * Move a task to a different project/section.
 *
 * Todoist exposes move as its own endpoint rather than a field on update, so a
 * "put that in my Hula project" is a distinct call.
 */
export async function moveTask(
  userId: string,
  taskId: string,
  target: { projectId?: string; sectionId?: string },
  options: TodoistCallOptions = {},
): Promise<void> {
  if (!target.projectId && !target.sectionId) {
    throw new TodoistError("invalid_request", "A move needs a destination");
  }
  await todoistRequest<unknown>(userId, {
    method: "POST",
    path: `/tasks/${encodeURIComponent(taskId)}/move`,
    body: {
      ...(target.projectId ? { project_id: target.projectId } : {}),
      ...(target.sectionId ? { section_id: target.sectionId } : {}),
    },
    ...options,
  });
}

/**
 * Complete a task. Todoist answers 204 with no body, so success here means "the
 * provider accepted it" — NOT "it is complete". The caller must verify.
 */
export async function closeTask(
  userId: string,
  taskId: string,
  options: TodoistCallOptions = {},
): Promise<void> {
  await todoistRequest<unknown>(userId, {
    method: "POST",
    path: `/tasks/${encodeURIComponent(taskId)}/close`,
    ...options,
  });
}

/** Reopen a completed task. Same 204 semantics as `closeTask`. */
export async function reopenTask(
  userId: string,
  taskId: string,
  options: TodoistCallOptions = {},
): Promise<void> {
  await todoistRequest<unknown>(userId, {
    method: "POST",
    path: `/tasks/${encodeURIComponent(taskId)}/reopen`,
    ...options,
  });
}

/**
 * The statuses Todoist's DELETE contract defines as SUCCESS.
 *
 * The official OpenAPI document lists `200 Successful Response` for
 * `DELETE /api/v1/tasks/{task_id}`; `204 No Content` is the conventional REST
 * answer for a bodyless delete and is accepted too. Anything else — including an
 * unexpected 2xx such as `202 Accepted`, which would mean "queued", not "done" —
 * is NOT a confirmed deletion and must never be reported as one.
 */
export const TODOIST_DELETE_SUCCESS_STATUSES: ReadonlySet<number> = new Set([200, 204]);

/** A validated, authoritative receipt for a completed delete. */
export interface TodoistDeleteReceipt {
  /** The documented success status Todoist actually returned. */
  httpStatus: number;
}

/**
 * Delete a task. Requires the `data:delete` scope.
 *
 * Returns a VALIDATED RECEIPT rather than void, and this is the whole point: a
 * delete has no response body, so the status IS the evidence. Discarding it left
 * the caller with nothing to trust when the follow-up read was stale — which is
 * precisely how a genuinely successful deletion was reported to a user as "it
 * hadn't taken effect".
 *
 * Any non-2xx already throws in the client. This additionally rejects an
 * UNEXPECTED 2xx, so only a documented success can ever become a receipt.
 */
export async function deleteTask(
  userId: string,
  taskId: string,
  options: TodoistCallOptions = {},
): Promise<TodoistDeleteReceipt> {
  const httpStatus = await todoistRequestStatus(userId, {
    method: "DELETE",
    path: `/tasks/${encodeURIComponent(taskId)}`,
    ...options,
  });
  return validateDeleteStatus(httpStatus);
}

/**
 * PURE: turn a delete's HTTP status into an authoritative receipt, or throw.
 *
 * Separated from the network call so the rule that actually matters — WHICH
 * statuses constitute a confirmed deletion — is testable on its own, with no
 * database, no token lookup, and no transport. This is production code the tests
 * call directly, rather than a rule a mock re-implements and then "verifies".
 */
export function validateDeleteStatus(httpStatus: number): TodoistDeleteReceipt {
  if (!TODOIST_DELETE_SUCCESS_STATUSES.has(httpStatus)) {
    throw new TodoistError(
      "malformed_provider_response",
      "Todoist did not confirm the deletion",
      httpStatus,
    );
  }
  return { httpStatus };
}

export { TODOIST_PROVIDER, parseTodoistPage };
