import { randomUUID } from "node:crypto";

import { CONFIRM_INSTRUCTION } from "../../../actions/confirmationCopy";
import { resolveFollowupOwner } from "../../../actions/entityContextArbiter";
import { createActionProposal } from "../../../actions/proposals";
import { executeAction } from "../../../actions/executor";
import { getUserTimezone } from "../../../reminders/reminders";
import { logger } from "../../../utils/logger";
import { TodoistError } from "./client";
import {
  MAX_BULK_TARGETS,
  fetchLabels,
  fetchProjects,
  fetchSections,
  fetchTasks,
} from "./tasks";
import { resolveEntityByName, zonedDateTimeToIso } from "./todoistFilters";
import { matchesSearch } from "./todoistFilters";
import {
  isReferencePhrase,
  loadLatestTodoistSelection,
  loadTodoistEntityContext,
  parseTodoistOrdinal,
  referencesLastTodoistAction,
  resolveTodoistByPhrase,
  resolveTodoistSelection,
  type TodoistSelectionItem,
} from "./todoistContext";
import {
  extractTodoistWriteIntent,
  type TextGenerator,
  type TodoistWriteIntent,
} from "./todoistIntentExtract";
import { looksLikeTodoistFollowup, shouldConsiderTodoist } from "./todoistRelevance";
import { readReplyForError } from "./todoistReads";
import { TODOIST_PROVIDER, priorityLabel, uiPriorityToApi } from "./types";

/**
 * Todoist write lifecycle + safety policy (Section 19, Phases 5/6/9).
 *
 * This is the layer that decides WHAT a message means and WHETHER it may run
 * without asking. It resolves targets, resolves destinations, applies the
 * confirmation policy, and then hands ALREADY-RESOLVED structured input to the
 * shared executor — which performs the write, verifies the postcondition, and
 * reports honestly. No provider call for a write happens here.
 *
 * THE CONFIRMATION POLICY, and why it lives here rather than in the registry:
 *
 *   Execute immediately (target unambiguous, reversible, single task):
 *     create · update · complete · reopen · move · label · priority
 *   Require explicit confirmation:
 *     ANY delete (irreversible — Todoist does not trash)
 *     ANY action touching TWO OR MORE tasks (bulk)
 *
 * The registry cannot express "one is fine, five needs asking" — a definition flag
 * is static, and bulk-ness is only known once a message has been resolved against
 * the user's actual list. So the registry marks delete as confirmation-required
 * (a static truth), and this handler adds the bulk rule (a dynamic one).
 */

/** Honest replies. None leaks provider detail. */
export const TODOIST_WRITE_REPLIES = {
  unavailable: "I couldn’t reach Todoist just now — mind trying again in a bit?",
  noTarget: "I’m not sure which task you mean — could you say which one?",
  ambiguous: (titles: string[]) =>
    `I found a few that could match: ${titles.map((t) => `“${t}”`).join(", ")}. Which one?`,
  notFound: (phrase: string) => `I couldn’t find a task matching “${phrase}”.`,
  noProject: (name: string) =>
    `You don’t have a project called “${name}” in Todoist — want me to put it somewhere else?`,
  noSection: (name: string) => `I couldn’t find a section called “${name}”.`,
  noLabel: (name: string) =>
    `You don’t have a label called “${name}” in Todoist — want me to use a different one?`,
  ambiguousProject: (names: string[]) =>
    `I found a few projects that could match: ${names.join(", ")}. Which one?`,
  needChange: "What would you like me to change about it?",
  tooMany: `That’s more tasks than I’ll change at once (max ${MAX_BULK_TARGETS}). Could you narrow it down?`,
  nothingToUndo: "I haven’t done anything to your Todoist that I can undo.",
  cannotUndoDelete:
    "That task was deleted permanently — Todoist doesn’t keep a copy, so I can’t bring it back.",
  cannotUndoUpdate:
    "I can’t undo an edit — I don’t keep what it said before. Tell me what to change it back to and I’ll do it.",
} as const;

export interface HandlerResult {
  handled: boolean;
  reply?: string;
}

/** Injectable dependencies so every test runs with NO network and NO database. */
export interface TodoistWriteDeps {
  extract?: typeof extractTodoistWriteIntent;
  generate?: TextGenerator;
  getTimezone?: (userId: string) => Promise<string | undefined>;
  fetchProjects?: typeof fetchProjects;
  fetchSections?: typeof fetchSections;
  fetchLabels?: typeof fetchLabels;
  fetchTasks?: typeof fetchTasks;
  loadSelection?: typeof loadLatestTodoistSelection;
  loadEntityContext?: typeof loadTodoistEntityContext;
  createProposal?: typeof createActionProposal;
  execute?: typeof executeAction;
  /** The shared cross-provider arbiter — injected so tests need no context store. */
  resolveFollowupOwner?: typeof resolveFollowupOwner;
  /**
   * True when the SHARED ARBITER has already decided this follow-up is Todoist's.
   *
   * The relevance gate exists to stop Todoist grabbing messages that were never
   * about tasks. It works on the words alone, so it necessarily rejects a bare
   * "delete it" — there is nothing task-shaped in those two words. But once the
   * arbiter has established that the conversation IS about a Todoist list, the
   * gate is answering a question that has already been answered better, and
   * re-asking it would bounce the message straight back out.
   *
   * Set ONLY by `entityFollowup`, which is the one caller that has consulted the
   * arbiter. Everything else keeps the gate.
   */
  arbitrated?: boolean;
  now?: Date;
}

/** The resolved outcome of working out which task(s) a message means. */
type TargetResolution =
  | { kind: "resolved"; items: TodoistSelectionItem[] }
  | { kind: "refused"; reply: string };

/**
 * Resolve which task(s) the user means, WITHOUT ever guessing.
 *
 * Priority order, most-explicit first — each step is a genuinely different way a
 * person refers to a task:
 *   1. "all of those"       → the whole remembered list
 *   2. "the second one"     → that position IN THE REMEMBERED LIST
 *   3. "the pitch deck one" → phrase match, list first, then a bounded search
 *   4. "undo that" / "the one you just completed" → the acted entity
 *   5. "it" / "that"        → the selected entity, else the acted one
 *
 * An out-of-range position, a phrase matching several tasks, or nothing to point
 * at all resolve to `refused` — the section forbids mutating an ambiguous target.
 */
export async function resolveWriteTargets(
  userId: string,
  intent: TodoistWriteIntent,
  text: string | undefined,
  deps: TodoistWriteDeps,
): Promise<TargetResolution> {
  const loadSelection = deps.loadSelection ?? loadLatestTodoistSelection;
  const loadEntity = deps.loadEntityContext ?? loadTodoistEntityContext;

  const ordinal = parseTodoistOrdinal(text);
  const selection = await loadSelection(userId);

  // 1 + 2. Positional references only mean something against a remembered list.
  if (intent.targetAll || (ordinal && "all" in ordinal)) {
    if (!selection) return { kind: "refused", reply: TODOIST_WRITE_REPLIES.noTarget };
    return { kind: "resolved", items: selection.data.items };
  }
  const position =
    typeof intent.targetPosition === "number"
      ? ({ position: intent.targetPosition } as const)
      : ordinal && !("all" in ordinal)
        ? ordinal
        : null;
  if (position) {
    if (!selection) return { kind: "refused", reply: TODOIST_WRITE_REPLIES.noTarget };
    const picked = resolveTodoistSelection(selection.data, position);
    // An out-of-range pick must ask, never clamp to the nearest task.
    if (picked.length === 0) return { kind: "refused", reply: TODOIST_WRITE_REPLIES.noTarget };
    return { kind: "resolved", items: picked };
  }

  // 3. A DESCRIPTIVE phrase: the remembered list first (cheap and exact), then a
  //    bounded search of real tasks.
  //
  //    A REFERENCE ("it", "that task", "the one I just reopened") is deliberately
  //    NOT a descriptive phrase and is dropped here, so it falls through to the
  //    context steps below. This is the fix for the live failure: the model
  //    returns `targetPhrase: "it"` for "Delete it", and searching titles for "it"
  //    either matches a task by coincidence or — as happened — matches nothing and
  //    refuses, while the real target sat verified in the entity context.
  const descriptivePhrase = isReferencePhrase(intent.targetPhrase)
    ? null
    : (intent.targetPhrase ?? null);

  if (descriptivePhrase) {
    if (selection) {
      const fromList = resolveTodoistByPhrase(selection.data, descriptivePhrase);
      if (fromList) return { kind: "resolved", items: [fromList] };
    }
    const search = await (deps.fetchTasks ?? fetchTasks)(userId, {}, 200);
    const matches = search.filter((task) => matchesSearch(task, descriptivePhrase));
    if (matches.length === 1) {
      const task = matches[0]!;
      return {
        kind: "resolved",
        items: [
          {
            id: task.id,
            content: task.content,
            projectId: task.projectId,
            dueDate: task.due?.date ?? null,
            isRecurring: task.due?.isRecurring ?? false,
            priority: task.priority,
            labels: task.labels,
          },
        ],
      };
    }
    if (matches.length > 1) {
      return {
        kind: "refused",
        reply: TODOIST_WRITE_REPLIES.ambiguous(matches.slice(0, 4).map((t) => t.content)),
      };
    }
    return { kind: "refused", reply: TODOIST_WRITE_REPLIES.notFound(descriptivePhrase) };
  }

  // 4 + 5. Pronouns resolve against the conversation's subject.
  const entity = await loadEntity(userId);
  if (referencesLastTodoistAction(text) && entity?.data.acted) {
    return { kind: "resolved", items: [entity.data.acted.task] };
  }
  if (entity?.data.selected) return { kind: "resolved", items: [entity.data.selected] };
  if (entity?.data.acted) return { kind: "resolved", items: [entity.data.acted.task] };

  // A single-result list is unambiguous enough to be "it".
  if (selection && selection.data.items.length === 1) {
    return { kind: "resolved", items: [selection.data.items[0]!] };
  }
  return { kind: "refused", reply: TODOIST_WRITE_REPLIES.noTarget };
}

/** The resolved destination/label values a write needs. */
interface ResolvedDestination {
  projectId?: string;
  projectName?: string;
  sectionId?: string;
  labels?: string[];
}

/**
 * Resolve project/section/label NAMES to real provider ids.
 *
 * The section is explicit: Hula must NOT silently create a missing project,
 * section, or label after a typo. So every name is matched against what actually
 * exists, and anything unmatched REFUSES with a message naming what was missing.
 */
async function resolveDestination(
  userId: string,
  intent: TodoistWriteIntent,
  existingLabels: string[],
  deps: TodoistWriteDeps,
): Promise<{ kind: "resolved"; value: ResolvedDestination } | { kind: "refused"; reply: string }> {
  const out: ResolvedDestination = {};

  if (intent.projectName) {
    const projects = await (deps.fetchProjects ?? fetchProjects)(userId);
    const resolution = resolveEntityByName(intent.projectName, projects);
    if (resolution.kind === "not_found") {
      return { kind: "refused", reply: TODOIST_WRITE_REPLIES.noProject(intent.projectName) };
    }
    if (resolution.kind === "ambiguous") {
      return {
        kind: "refused",
        reply: TODOIST_WRITE_REPLIES.ambiguousProject(resolution.candidates.map((c) => c.name)),
      };
    }
    out.projectId = resolution.entity.id;
    out.projectName = resolution.entity.name;
  }

  if (intent.sectionName) {
    const sections = await (deps.fetchSections ?? fetchSections)(userId, out.projectId);
    const resolution = resolveEntityByName(intent.sectionName, sections);
    if (resolution.kind !== "resolved") {
      return { kind: "refused", reply: TODOIST_WRITE_REPLIES.noSection(intent.sectionName) };
    }
    out.sectionId = resolution.entity.id;
  }

  const adds = intent.addLabels ?? [];
  const removes = intent.removeLabels ?? [];
  if (adds.length > 0 || removes.length > 0) {
    const labels = await (deps.fetchLabels ?? fetchLabels)(userId);
    const resolvedAdds: string[] = [];
    for (const name of adds) {
      const resolution = resolveEntityByName(name, labels);
      if (resolution.kind !== "resolved") {
        return { kind: "refused", reply: TODOIST_WRITE_REPLIES.noLabel(name) };
      }
      resolvedAdds.push(resolution.entity.name);
    }
    // Todoist writes the COMPLETE label set, so add/remove must be merged against
    // the task's real current labels — sending only the additions would silently
    // strip every label the task already had.
    const removeSet = new Set(removes.map((r) => r.trim().toLowerCase()));
    const kept = existingLabels.filter((l) => !removeSet.has(l.trim().toLowerCase()));
    const merged = [...new Set([...kept, ...resolvedAdds])];
    out.labels = merged;
  }

  return { kind: "resolved", value: out };
}

/**
 * PURE: is this a due string we are willing to hand to Todoist's parser?
 *
 * A `due_string` is natural language that TODOIST parses server-side — we do not
 * compute the resulting date, so we cannot verify it, and a wrong one silently
 * schedules the task somewhere we never previewed. The section is explicit that no
 * raw natural-language due string may be trusted without deterministic validation.
 *
 * So it is accepted for exactly ONE job it is uniquely good at: RECURRENCE, which
 * has no structured equivalent in the API. It must look like a recurrence rule
 * ("every Monday", "each weekday"), be short, and contain nothing exotic. Anything
 * else — including a plain "friday at 5" — is rejected here and goes through the
 * deterministic date/time path instead, where we compute the instant ourselves and
 * can verify it afterwards.
 */
export function isValidRecurrenceString(value: string | null | undefined): boolean {
  const s = (value ?? "").trim().toLowerCase();
  if (!s || s.length > 60) return false;
  if (!/^(?:every|each)\b/.test(s)) return false;
  // Conservative allowlist: words, numbers, spaces, colons and simple separators.
  return /^[a-z0-9 ,:!@#-]+$/.test(s);
}

/**
 * PURE: attach the due fields to an executor input.
 *
 * Emits BOTH the wire value (`dueDatetime`/`dueDate`) and the LOCAL terms
 * (`dueLocalDate`/`dueLocalTime`/`timezone`). The local terms are what
 * postcondition verification compares against, because Todoist may return the due
 * as a floating wall time OR an absolute instant, and "does it say 5pm on Friday?"
 * is the only question that is stable across both — and the only one the user asked.
 */
function attachDue(
  input: Record<string, unknown>,
  intent: TodoistWriteIntent,
  timezone: string | undefined,
): void {
  if (intent.removeDue) {
    input.removeDue = true;
    return;
  }
  if (intent.removeDueTime) {
    // The date is resolved by the executor from the task's own fresh state.
    input.removeDueTime = true;
    input.timezone = timezone;
    return;
  }
  if (isValidRecurrenceString(intent.dueString)) {
    input.dueString = intent.dueString;
    return;
  }
  if (!intent.dueDate) return;

  input.dueLocalDate = intent.dueDate;
  input.timezone = timezone;
  if (intent.dueTime) {
    const iso = zonedDateTimeToIso(intent.dueDate, intent.dueTime, timezone);
    if (iso) {
      // `due_datetime` takes an absolute instant; we compute it from the user's
      // wall time through THEIR zone, so DST is handled at the one place that
      // knows the zone rather than inferred by Todoist.
      input.dueDatetime = iso;
      input.dueLocalTime = intent.dueTime;
      return;
    }
    // An unusable zone/time must not invent a moment — fall back to date-only
    // rather than silently scheduling the wrong instant.
  }
  input.dueDate = intent.dueDate;
}

/** PURE: build the redacted executor input for a create. */
export function buildCreateInput(
  intent: TodoistWriteIntent,
  destination: ResolvedDestination,
  timezone: string | undefined,
): Record<string, unknown> {
  const input: Record<string, unknown> = { content: intent.content };
  if (intent.description) input.description = intent.description;
  attachDue(input, intent, timezone);
  if (destination.projectId) input.projectId = destination.projectId;
  if (destination.sectionId) input.sectionId = destination.sectionId;
  if (destination.labels) input.labels = destination.labels;
  if (typeof intent.uiPriority === "number") input.priority = uiPriorityToApi(intent.uiPriority);
  // Generated ONCE here and replayed on execution, so a duplicate delivery reuses
  // Todoist's de-duplication rather than creating a twin.
  input.requestId = randomUUID();
  return input;
}

/** PURE: build the redacted executor input for an update. */
export function buildUpdateInput(
  intent: TodoistWriteIntent,
  destination: ResolvedDestination,
  taskIds: string[],
  timezone: string | undefined,
): Record<string, unknown> {
  const input: Record<string, unknown> = { taskIds };
  if (intent.newContent) input.content = intent.newContent;
  if (intent.description) input.description = intent.description;
  attachDue(input, intent, timezone);
  if (destination.labels) input.labels = destination.labels;
  if (typeof intent.uiPriority === "number") input.priority = uiPriorityToApi(intent.uiPriority);
  return input;
}

/** PURE: does an update intent actually change anything? */
export function updateChangesSomething(intent: TodoistWriteIntent): boolean {
  return Boolean(
    intent.newContent ||
      intent.description ||
      intent.removeDue ||
      intent.removeDueTime ||
      intent.dueDate ||
      intent.dueString ||
      typeof intent.uiPriority === "number" ||
      (intent.addLabels?.length ?? 0) > 0 ||
      (intent.removeLabels?.length ?? 0) > 0,
  );
}

/**
 * PURE: the confirmation preview.
 *
 * A deletion preview MUST say it is permanent — Todoist does not trash, so the
 * user cannot recover from a mistaken yes. Bulk previews name the count, because
 * "yes" to "complete these?" should not be a surprise about how many.
 */
export function buildPreview(
  actionId: string,
  items: readonly TodoistSelectionItem[],
): string {
  const count = items.length;
  const names = items.slice(0, 5).map((i) => `• ${i.content}`).join("\n");
  const more = count > 5 ? `\n…and ${count - 5} more` : "";

  if (actionId === "task.delete") {
    const head =
      count === 1
        ? `Permanently delete “${items[0]!.content}”?`
        : `Permanently delete these ${count} tasks?`;
    // The word "permanently" is load-bearing, not decoration.
    return `${head}\n${count > 1 ? `${names}${more}\n` : ""}This can’t be undone — Todoist doesn’t keep a copy.\n\n${CONFIRM_INSTRUCTION}`;
  }

  const verb =
    actionId === "task.complete"
      ? "Complete"
      : actionId === "task.reopen"
        ? "Reopen"
        : actionId === "task.move"
          ? "Move"
          : "Update";
  return `${verb} these ${count} tasks?\n${names}${more}\n\n${CONFIRM_INSTRUCTION}`;
}

/**
 * Handle a natural Todoist WRITE. Returns `{handled:false}` when the message isn't
 * one, so the cascade continues unchanged. Never throws.
 */
export async function handleTodoistWrite(
  userId: string,
  text: string | undefined,
  deps: TodoistWriteDeps = {},
): Promise<HandlerResult> {
  // The cheap gate. A bare follow-up ("the second one") carries no task
  // vocabulary, so it is only ours when a live Todoist list exists to resolve it
  // against — checked below rather than assumed here.
  // An arbitrated dispatch skips the gate: ownership is already settled, and the
  // gate cannot see conversational context (see `arbitrated`).
  const isFollowup = looksLikeTodoistFollowup(text);
  if (!deps.arbitrated && !shouldConsiderTodoist(text) && !isFollowup) {
    return { handled: false };
  }

  const extract = deps.extract ?? extractTodoistWriteIntent;
  const getTz = deps.getTimezone ?? getUserTimezone;
  const now = deps.now ?? new Date();

  try {
    // Skipped for an arbitrated dispatch — that IS the arbiter's answer.
    if (!deps.arbitrated && isFollowup && !shouldConsiderTodoist(text)) {
      // A bare follow-up carries no task vocabulary, so it is ours ONLY if the
      // conversation is actually about a Todoist list. The arbiter is the same one
      // the routing step uses, so both directions agree by construction: it stops
      // Todoist claiming "reply to the second one" just because a stale task list
      // happens to exist, exactly as it stops Gmail claiming a task follow-up.
      const resolveOwner = deps.resolveFollowupOwner ?? resolveFollowupOwner;
      const owner = await resolveOwner(userId, text);
      if (owner.kind !== "owner" || owner.owner !== "todoist_task") {
        return { handled: false };
      }
    }

    const timezone = await getTz(userId);
    const intent = await extract({
      text: text ?? "",
      nowLocalIso: now.toISOString(),
      timezone,
      generate: deps.generate,
    });
    if (!intent || intent.intent === "not_todoist_write") return { handled: false };

    if (intent.intent === "undo") return await handleUndoInternal(userId, deps);
    if (intent.intent === "create") return await runCreate(userId, intent, timezone, deps);
    return await runExistingTaskAction(userId, intent, text, timezone, deps);
  } catch (err) {
    logger.error("todoist.write failed", {
      errorCode: err instanceof TodoistError ? err.reason : "unknown",
    });
    return { handled: true, reply: readReplyForError(err) };
  }
}

/** Create is the one action with no existing target to resolve. */
async function runCreate(
  userId: string,
  intent: TodoistWriteIntent,
  timezone: string | undefined,
  deps: TodoistWriteDeps,
): Promise<HandlerResult> {
  const destination = await resolveDestination(userId, intent, [], deps);
  if (destination.kind === "refused") return { handled: true, reply: destination.reply };

  const execute = deps.execute ?? executeAction;
  const result = await execute(userId, "task.create", {
    input: buildCreateInput(intent, destination.value, timezone),
  });
  return { handled: true, reply: result.userMessage };
}

/** Everything that acts on tasks the user already has. */
async function runExistingTaskAction(
  userId: string,
  intent: TodoistWriteIntent,
  text: string | undefined,
  timezone: string | undefined,
  deps: TodoistWriteDeps,
): Promise<HandlerResult> {
  const targets = await resolveWriteTargets(userId, intent, text, deps);
  if (targets.kind === "refused") return { handled: true, reply: targets.reply };
  if (targets.items.length === 0) {
    return { handled: true, reply: TODOIST_WRITE_REPLIES.noTarget };
  }
  if (targets.items.length > MAX_BULK_TARGETS) {
    return { handled: true, reply: TODOIST_WRITE_REPLIES.tooMany };
  }

  const actionId =
    intent.intent === "complete"
      ? "task.complete"
      : intent.intent === "reopen"
        ? "task.reopen"
        : intent.intent === "delete"
          ? "task.delete"
          : intent.intent === "move"
            ? "task.move"
            : "task.update";

  if (actionId === "task.update" && !updateChangesSomething(intent)) {
    return { handled: true, reply: TODOIST_WRITE_REPLIES.needChange };
  }

  // Labels merge against the target's REAL current labels. Only meaningful for a
  // single task — a merged set from one task must never be written across many.
  const existingLabels = targets.items.length === 1 ? targets.items[0]!.labels : [];
  const destination = await resolveDestination(userId, intent, existingLabels, deps);
  if (destination.kind === "refused") return { handled: true, reply: destination.reply };

  if (actionId === "task.move" && !destination.value.projectId && !destination.value.sectionId) {
    return { handled: true, reply: "Where would you like me to move it?" };
  }

  const taskIds = targets.items.map((i) => i.id);
  const input: Record<string, unknown> =
    actionId === "task.update"
      ? buildUpdateInput(intent, destination.value, taskIds, timezone)
      : actionId === "task.move"
        ? {
            taskIds,
            ...(destination.value.projectId ? { projectId: destination.value.projectId } : {}),
            ...(destination.value.sectionId ? { sectionId: destination.value.sectionId } : {}),
          }
        : { taskIds };
  input.label = targets.items[0]?.content ?? "";

  // THE CONFIRMATION DECISION. Deletion is irreversible; bulk is high-blast-radius.
  // Everything else is a single reversible change and runs now.
  const needsConfirmation = actionId === "task.delete" || targets.items.length > 1;
  if (needsConfirmation) {
    const create = deps.createProposal ?? createActionProposal;
    await create(userId, {
      provider: TODOIST_PROVIDER,
      actionId,
      riskLevel: actionId === "task.delete" ? "write" : "modify",
      confirmationRequired: true,
      input,
      previewText: buildPreview(actionId, targets.items),
    });
    return { handled: true, reply: buildPreview(actionId, targets.items) };
  }

  const execute = deps.execute ?? executeAction;
  const result = await execute(userId, actionId, { input });
  return { handled: true, reply: decorateSingleResult(result.userMessage, intent) };
}

/**
 * PURE-ish: add the one detail a bare confirmation misses.
 *
 * "Change its priority to high" answered with "Updated “Call Rob”." is technically
 * honest but useless — the user cannot tell WHAT changed. Naming the new value
 * makes the confirmation checkable.
 */
function decorateSingleResult(message: string, intent: TodoistWriteIntent): string {
  if (!message.startsWith("Updated")) return message;
  if (typeof intent.uiPriority === "number") {
    return `${message.replace(/\.$/, "")} — priority is now ${priorityLabel(uiPriorityToApi(intent.uiPriority))}.`;
  }
  if (intent.removeDue) return `${message.replace(/\.$/, "")} — it no longer has a due date.`;
  return message;
}

/**
 * Undo the immediately preceding SUPPORTED state action.
 *
 * "Supported" is doing real work here, and the boundaries are honest rather than
 * convenient:
 *   - completed → reopen. reopened → complete. Genuine inverses.
 *   - created   → delete, which is irreversible, so it CONFIRMS like any delete.
 *   - deleted   → refuse. Todoist keeps no copy; there is nothing to restore and
 *                 pretending otherwise would be the worst possible lie.
 *   - updated/moved → refuse. Hula does not store the previous value, and
 *                 inventing one would be worse than saying so.
 */
async function handleUndoInternal(
  userId: string,
  deps: TodoistWriteDeps,
): Promise<HandlerResult> {
  const entity = await (deps.loadEntityContext ?? loadTodoistEntityContext)(userId);
  const acted = entity?.data.acted;
  if (!acted) return { handled: true, reply: TODOIST_WRITE_REPLIES.nothingToUndo };

  // Only the VERIFIED set is ever recorded, so anything here provably happened.
  const taskIds = acted.bulkIds?.length ? acted.bulkIds : [acted.task.id];

  if (acted.kind === "deleted") {
    return { handled: true, reply: TODOIST_WRITE_REPLIES.cannotUndoDelete };
  }
  if (acted.kind === "updated" || acted.kind === "moved") {
    return { handled: true, reply: TODOIST_WRITE_REPLIES.cannotUndoUpdate };
  }

  if (acted.kind === "created") {
    // Undoing a create means deleting — irreversible, so it confirms.
    const items: TodoistSelectionItem[] = [acted.task];
    const create = deps.createProposal ?? createActionProposal;
    const preview = buildPreview("task.delete", items);
    await create(userId, {
      provider: TODOIST_PROVIDER,
      actionId: "task.delete",
      riskLevel: "write",
      confirmationRequired: true,
      input: { taskIds, label: acted.task.content },
      previewText: preview,
    });
    return { handled: true, reply: preview };
  }

  const inverse = acted.kind === "completed" ? "task.reopen" : "task.complete";
  const execute = deps.execute ?? executeAction;
  const result = await execute(userId, inverse, {
    input: { taskIds, label: acted.task.content },
  });
  return { handled: true, reply: result.userMessage };
}

/**
 * The routing entry point for "undo that" specifically.
 *
 * Separate from `handleTodoistWrite` so the cascade can place it AFTER Gmail's and
 * Calendar's own undo handlers — a bare "undo that" after an email action must
 * still mean the email, exactly as it does today. It declines unless a verified
 * Todoist action is there to invert, so it can never swallow an ordinary message.
 */
export async function handleTodoistUndo(
  userId: string,
  text: string | undefined,
  deps: TodoistWriteDeps = {},
): Promise<HandlerResult> {
  if (!referencesLastTodoistAction(text)) return { handled: false };
  try {
    const entity = await (deps.loadEntityContext ?? loadTodoistEntityContext)(userId);
    if (!entity?.data.acted) return { handled: false };
    return await handleUndoInternal(userId, deps);
  } catch (err) {
    logger.error("todoist.undo failed", {
      errorCode: err instanceof TodoistError ? err.reason : "unknown",
    });
    return { handled: false };
  }
}
