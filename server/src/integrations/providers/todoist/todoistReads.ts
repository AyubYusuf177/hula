import { logger } from "../../../utils/logger";
import { getUserTimezone } from "../../../reminders/reminders";
import { TodoistError, isReconnectReason } from "./client";
import {
  DEFAULT_TASK_LIMIT,
  MAX_TASK_LIMIT,
  fetchCompletedTasks,
  fetchLabels,
  fetchProjects,
  fetchSections,
  fetchTask,
  fetchTasks,
  fetchTasksByFilter,
} from "./tasks";
import {
  buildScopeFilterQuery,
  matchesLabel,
  matchesPriority,
  matchesScope,
  matchesSearch,
  resolveEntityByName,
  type TodoistScope,
} from "./todoistFilters";
import {
  emptyStateFor,
  formatMoreNote,
  formatTaskDetail,
  formatTaskList,
  type ProjectNameLookup,
} from "./todoistDisplay";
import {
  loadLatestTodoistSelection,
  parseTodoistOrdinal,
  recordSelectedTodoistTask,
  recordTodoistSelection,
  resolveTodoistSelection,
} from "./todoistContext";
import {
  extractTodoistReadIntent,
  type TextGenerator,
  type TodoistReadIntent,
} from "./todoistIntentExtract";
import { looksLikeTodoistFollowup, shouldConsiderTodoist } from "./todoistRelevance";
import type { NormalizedTodoistTask } from "./types";

/**
 * Todoist reads (Section 19, Phase 4).
 *
 * The read half of the Todoist experience: turn a natural question into typed
 * slots, query Todoist deterministically, answer strictly from what came back,
 * and remember the numbered list so follow-ups resolve.
 *
 * WHY SOME READS FILTER CLIENT-SIDE. Todoist's `/tasks/filter` endpoint takes an
 * expression, and expressions are where a wrong selection hides. So the split is:
 *
 *  - A scope/priority-only read uses `/tasks/filter` with an ALLOWLISTED
 *    expression built from a closed enum + an integer. No user text can reach it.
 *  - Anything naming a project/section/label resolves that name to a real
 *    provider ID first and uses `GET /tasks` with typed parameters, then applies
 *    PURE predicates for scope/priority/search over the bounded result.
 *
 * That keeps every user-authored string out of the query language entirely, and
 * makes the whole selection path testable offline.
 */

/** Honest replies. None leaks provider detail. */
export const TODOIST_READ_REPLIES = {
  notConnected: "Your Todoist isn’t connected, so I can’t see your tasks.",
  reconnect: "I don’t have permission to read your Todoist yet — reconnect it in Hula.",
  unavailable: "I couldn’t reach Todoist just now — mind trying again in a bit?",
  noProject: (name: string) =>
    `I couldn’t find a project called “${name}” in your Todoist.`,
  ambiguousProject: (candidates: string[]) =>
    `I found a few projects that could match: ${candidates.join(", ")}. Which one?`,
  noLabel: (name: string) => `You don’t have a label called “${name}” in Todoist.`,
  noSuchTask: "I’m not sure which task you mean — could you say which one?",
} as const;

export interface HandlerResult {
  handled: boolean;
  reply?: string;
}

/** Injectable dependencies so every test runs with NO network and NO database. */
export interface TodoistReadDeps {
  extract?: typeof extractTodoistReadIntent;
  generate?: TextGenerator;
  getTimezone?: (userId: string) => Promise<string | undefined>;
  fetchTasksByFilter?: typeof fetchTasksByFilter;
  fetchTasks?: typeof fetchTasks;
  fetchTask?: typeof fetchTask;
  fetchCompletedTasks?: typeof fetchCompletedTasks;
  fetchProjects?: typeof fetchProjects;
  fetchSections?: typeof fetchSections;
  fetchLabels?: typeof fetchLabels;
  recordSelection?: typeof recordTodoistSelection;
  loadSelection?: typeof loadLatestTodoistSelection;
  recordSelected?: typeof recordSelectedTodoistTask;
  now?: Date;
}

/**
 * How many tasks to pull when filtering client-side.
 *
 * Larger than any answer we would print, because predicates run AFTER the fetch —
 * asking for 5 and filtering would return fewer than 5. Still hard-bounded: a
 * single iMessage can never turn into an unbounded walk of someone's Todoist.
 */
const CANDIDATE_FETCH_LIMIT = 200;

/** PURE: map a project id to its display name, for the meta line. */
function projectLookup(projects: { id: string; name: string }[]): ProjectNameLookup {
  const byId = new Map(projects.map((p) => [p.id, p.name]));
  return (projectId) => (projectId ? (byId.get(projectId) ?? null) : null);
}

/** PURE: turn a provider failure into an honest, safe user reply. */
export function readReplyForError(err: unknown): string {
  const todoistErr = err instanceof TodoistError ? err : null;
  if (!todoistErr) return TODOIST_READ_REPLIES.unavailable;
  if (todoistErr.reason === "not_connected") return TODOIST_READ_REPLIES.notConnected;
  if (todoistErr.reason === "insufficient_scope" || isReconnectReason(todoistErr.reason)) {
    return TODOIST_READ_REPLIES.reconnect;
  }
  return TODOIST_READ_REPLIES.unavailable;
}

/**
 * PURE: decide the effective scope for a read.
 *
 * An open-ended "what do I need to do" means TODAY, not everything — a dump of
 * every task is not an answer. But a read that names a project/label with no
 * timeframe means "everything in there", so scope stays `all`.
 */
export function effectiveScope(intent: TodoistReadIntent): TodoistScope {
  if (intent.scope) return intent.scope;
  if (intent.projectName || intent.sectionName || intent.label || intent.query) return "all";
  if (intent.uiPriority) return "all";
  return "today";
}

/**
 * Handle a natural Todoist READ. Returns `{handled:false}` when the message isn't
 * one, so the cascade continues unchanged. Never throws.
 */
export async function handleTodoistRead(
  userId: string,
  text: string | undefined,
  deps: TodoistReadDeps = {},
): Promise<HandlerResult> {
  // The cheap gate first: no model call for a message that isn't task-shaped.
  // A pure follow-up ("the second one") is handled by the WRITE path, not here.
  if (!shouldConsiderTodoist(text) || looksLikeTodoistFollowup(text)) {
    return { handled: false };
  }

  const extract = deps.extract ?? extractTodoistReadIntent;
  const getTz = deps.getTimezone ?? getUserTimezone;
  const now = deps.now ?? new Date();

  try {
    const timezone = await getTz(userId);
    const intent = await extract({
      text: text ?? "",
      nowLocalIso: now.toISOString(),
      timezone,
      generate: deps.generate,
    });
    if (!intent || intent.intent === "not_todoist_read") return { handled: false };

    if (intent.intent === "inspect") {
      return await handleInspect(userId, intent, timezone, now, deps);
    }
    if (intent.intent === "completed") {
      return await handleCompleted(userId, intent, timezone, now, deps);
    }
    return await handleList(userId, intent, timezone, now, deps);
  } catch (err) {
    logger.error("todoist.read failed", {
      errorCode: err instanceof TodoistError ? err.reason : "unknown",
    });
    return { handled: true, reply: readReplyForError(err) };
  }
}

/** The main list read: today / overdue / upcoming / week / no date / project / … */
async function handleList(
  userId: string,
  intent: TodoistReadIntent,
  timezone: string | undefined,
  now: Date,
  deps: TodoistReadDeps,
): Promise<HandlerResult> {
  const getProjects = deps.fetchProjects ?? fetchProjects;
  const getSections = deps.fetchSections ?? fetchSections;
  const getLabels = deps.fetchLabels ?? fetchLabels;
  const byFilter = deps.fetchTasksByFilter ?? fetchTasksByFilter;
  const byParams = deps.fetchTasks ?? fetchTasks;

  const scope = effectiveScope(intent);
  const explicitCount = typeof intent.count === "number";
  const limit = Math.min(intent.count ?? DEFAULT_TASK_LIMIT, MAX_TASK_LIMIT);

  const projects = await getProjects(userId);
  let projectId: string | undefined;
  let projectLabel: string | null = null;

  // Resolve a named project against REAL projects. Never create, never guess.
  if (intent.projectName) {
    const resolution = resolveEntityByName(intent.projectName, projects);
    if (resolution.kind === "not_found") {
      return { handled: true, reply: TODOIST_READ_REPLIES.noProject(intent.projectName) };
    }
    if (resolution.kind === "ambiguous") {
      return {
        handled: true,
        reply: TODOIST_READ_REPLIES.ambiguousProject(resolution.candidates.map((c) => c.name)),
      };
    }
    projectId = resolution.entity.id;
    projectLabel = resolution.entity.name;
  }

  let sectionId: string | undefined;
  if (intent.sectionName) {
    const sections = await getSections(userId, projectId);
    const resolution = resolveEntityByName(intent.sectionName, sections);
    if (resolution.kind === "not_found") {
      return {
        handled: true,
        reply: `I couldn’t find a section called “${intent.sectionName}”${projectLabel ? ` in ${projectLabel}` : ""}.`,
      };
    }
    if (resolution.kind === "ambiguous") {
      return {
        handled: true,
        reply: TODOIST_READ_REPLIES.ambiguousProject(resolution.candidates.map((c) => c.name)),
      };
    }
    sectionId = resolution.entity.id;
  }

  // Resolve a named label against REAL labels, so a typo says so rather than
  // silently returning zero tasks (which reads as "you have none").
  let labelName: string | undefined;
  if (intent.label) {
    const labels = await getLabels(userId);
    const resolution = resolveEntityByName(intent.label, labels);
    if (resolution.kind === "not_found") {
      return { handled: true, reply: TODOIST_READ_REPLIES.noLabel(intent.label) };
    }
    if (resolution.kind === "ambiguous") {
      return {
        handled: true,
        reply: TODOIST_READ_REPLIES.ambiguousProject(resolution.candidates.map((c) => c.name)),
      };
    }
    labelName = resolution.entity.name;
  }

  const scoped = Boolean(projectId || sectionId || labelName || intent.query);

  let candidates: NormalizedTodoistTask[];
  if (scoped) {
    // Typed provider parameters + pure client-side predicates. No expression.
    candidates = await byParams(
      userId,
      { projectId, sectionId, label: labelName },
      CANDIDATE_FETCH_LIMIT,
    );
    candidates = candidates.filter(
      (task) =>
        matchesScope(task, scope, now, timezone) &&
        matchesPriority(task, intent.uiPriority) &&
        matchesLabel(task, labelName) &&
        matchesSearch(task, intent.query),
    );
  } else {
    // Allowlisted expression only — built from a closed enum + an integer.
    const query = buildScopeFilterQuery(scope, intent.uiPriority);
    candidates = query
      ? await byFilter(userId, query, CANDIDATE_FETCH_LIMIT)
      : await byParams(userId, {}, CANDIDATE_FETCH_LIMIT);
  }

  // Overdue-first, then soonest, then priority: the order a person triages in.
  const sorted = sortForDisplay(candidates, now, timezone);
  const shown = sorted.slice(0, limit);

  if (shown.length === 0) {
    return { handled: true, reply: emptyStateFor(scope, projectLabel) };
  }

  // Remember the EXACT list, in the EXACT order shown, so "the second one" is
  // stable. Best-effort: losing this costs the shortcut, never the reply.
  try {
    await (deps.recordSelection ?? recordTodoistSelection)(userId, shown);
  } catch {
    // Non-fatal by design.
  }

  const body = formatTaskList(shown, now, timezone, projectLookup(projects));
  const more = formatMoreNote(shown.length, sorted.length, explicitCount);
  return { handled: true, reply: more ? `${body}${more}` : body };
}

/**
 * PURE: order tasks the way a person triages — overdue first, then by due date,
 * then by priority, then stably by title.
 */
export function sortForDisplay(
  tasks: readonly NormalizedTodoistTask[],
  now: Date,
  timezone: string | undefined,
): NormalizedTodoistTask[] {
  return [...tasks].sort((a, b) => {
    const aOver = matchesScope(a, "overdue", now, timezone) ? 0 : 1;
    const bOver = matchesScope(b, "overdue", now, timezone) ? 0 : 1;
    if (aOver !== bOver) return aOver - bOver;

    // A task with no due date sorts after one that has a date.
    const aDue = a.due?.datetime ?? a.due?.date ?? null;
    const bDue = b.due?.datetime ?? b.due?.date ?? null;
    if (aDue && bDue && aDue !== bDue) return aDue < bDue ? -1 : 1;
    if (aDue && !bDue) return -1;
    if (!aDue && bDue) return 1;

    // Higher RAW priority is more urgent (4 = urgent), so descending.
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.content.localeCompare(b.content);
  });
}

/** "What did I just complete?" — bounded to a real, recent window. */
async function handleCompleted(
  userId: string,
  intent: TodoistReadIntent,
  timezone: string | undefined,
  now: Date,
  deps: TodoistReadDeps,
): Promise<HandlerResult> {
  const getCompleted = deps.fetchCompletedTasks ?? fetchCompletedTasks;
  const getProjects = deps.fetchProjects ?? fetchProjects;
  const limit = Math.min(intent.count ?? DEFAULT_TASK_LIMIT, MAX_TASK_LIMIT);

  // Todoist REQUIRES a bounded window on the completed endpoint. A week is long
  // enough for "what did I finish?" and keeps the call cheap.
  const until = now.toISOString();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const tasks = await getCompleted(userId, { since, until }, limit);
  if (tasks.length === 0) {
    return { handled: true, reply: "You haven’t completed anything in the last week." };
  }

  const projects = await getProjects(userId);
  try {
    await (deps.recordSelection ?? recordTodoistSelection)(userId, tasks);
  } catch {
    // Non-fatal.
  }
  const body = formatTaskList(tasks, now, timezone, projectLookup(projects));
  return { handled: true, reply: `Recently completed:\n${body}` };
}

/** "Tell me about the second one" — full detail for one resolved task. */
async function handleInspect(
  userId: string,
  intent: TodoistReadIntent,
  timezone: string | undefined,
  now: Date,
  deps: TodoistReadDeps,
): Promise<HandlerResult> {
  const loadSelection = deps.loadSelection ?? loadLatestTodoistSelection;
  const getTask = deps.fetchTask ?? fetchTask;
  const getProjects = deps.fetchProjects ?? fetchProjects;

  const selection = await loadSelection(userId);
  if (!selection) return { handled: true, reply: TODOIST_READ_REPLIES.noSuchTask };

  const ordinal = parseTodoistOrdinal(intent.query ?? "");
  const picked = ordinal ? resolveTodoistSelection(selection.data, ordinal) : [];
  const target = picked.length === 1 ? picked[0] : null;
  if (!target) return { handled: true, reply: TODOIST_READ_REPLIES.noSuchTask };

  // ALWAYS re-fetch before describing: the stored snapshot may be up to 30
  // minutes old and the task may have changed in the Todoist app since.
  const fresh = await getTask(userId, target.id);
  const projects = await getProjects(userId);

  try {
    await (deps.recordSelected ?? recordSelectedTodoistTask)(userId, {
      id: fresh.id,
      content: fresh.content,
      projectId: fresh.projectId,
      dueDate: fresh.due?.date ?? null,
      isRecurring: fresh.due?.isRecurring ?? false,
      priority: fresh.priority,
      labels: fresh.labels,
    });
  } catch {
    // Non-fatal.
  }

  return {
    handled: true,
    reply: formatTaskDetail(fresh, now, timezone, projectLookup(projects)),
  };
}
