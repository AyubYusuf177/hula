import assert from "node:assert/strict";

import { executeAction } from "../src/actions/executor";
import { handleActionConfirmation } from "../src/actions/confirmations";
import type { CreateProposalInput, ActionProposalView } from "../src/actions/proposals";
import { routeInboundText } from "../src/routes/inboundRouting";
import { handleEntityFollowup } from "../src/routes/entityFollowup";
import { classifyMemoryCommand } from "../src/users/memory";
import { OPT_IN_ACKNOWLEDGEMENT } from "../src/channels/transportKeywords";
import {
  handleTodoistUndo,
  handleTodoistWrite,
  buildCreateInput,
  buildPreview,
  isValidRecurrenceString,
  updateChangesSomething,
} from "../src/integrations/providers/todoist/todoistActions";
import { handleTodoistRead } from "../src/integrations/providers/todoist/todoistReads";
import { TodoistError } from "../src/integrations/providers/todoist/client";
import {
  loadLatestTodoistSelection,
  parseTodoistOrdinal,
  recordTodoistSelection,
  resolveTodoistSelection,
  parseTodoistSelectionData,
} from "../src/integrations/providers/todoist/todoistContext";
import {
  addDaysToKey,
  dueLocalStamp,
  localDateKey,
  matchesScope,
  zonedDateTimeToIso,
} from "../src/integrations/providers/todoist/todoistFilters";
import {
  shouldConsiderTodoist,
  looksLikeReminderPhrase,
} from "../src/integrations/providers/todoist/todoistRelevance";
import {
  verifyCompletion,
  verifyDeletion,
  verifyReopen,
  verifyTaskState,
} from "../src/integrations/providers/todoist/todoistVerify";
import type {
  NormalizedTodoistTask,
  NormalizedTodoistProject,
  TodoistDue,
} from "../src/integrations/providers/todoist/types";
import { normalizeDue } from "../src/integrations/providers/todoist/tasks";
import type { TodoistDeleteReceipt, TodoistTaskWriteFields } from "../src/integrations/providers/todoist/tasks";
import type { TodoistWriteIntent, TodoistReadIntent } from "../src/integrations/providers/todoist/todoistIntentExtract";

/**
 * Todoist end-to-end flow tests (Section 19, Phase 10) — OFFLINE.
 *
 * Every test drives the REAL handlers, the REAL policy, the REAL executor, and the
 * REAL confirmation flow against a FAKE Todoist that holds genuine mutable state.
 * That is what makes them meaningful: the executor mutates the fake and then reads
 * it back, exactly as it does against Todoist — so a postcondition bug shows up
 * here rather than on Ayub's phone.
 *
 * NO network, NO database, NO real Todoist call, NO model call.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}
async function asyncCheck(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const NOW = new Date("2026-07-14T12:00:00.000Z"); // Tuesday
const TZ = "Europe/London";

function task(over: Partial<NormalizedTodoistTask> & { id: string }): NormalizedTodoistTask {
  return {
    content: "Task",
    description: null,
    projectId: "p_inbox",
    sectionId: null,
    parentId: null,
    labels: [],
    priority: 1,
    due: null,
    deadline: null,
    completed: false,
    assigneeId: null,
    url: null,
    createdAt: null,
    completedAt: null,
    source: "todoist",
    ...over,
  };
}

/**
 * Build a due object THE WAY TODOIST ACTUALLY SENDS ONE, through the real
 * normalizer.
 *
 * This helper used to hand-build `{date, datetime}` — the REST v2 shape — which is
 * precisely why the whole suite stayed green while every timed task lost its time
 * on a real device. Todoist v1 has NO `datetime` field: the time lives inside
 * `date`. Constructing the fixture from a v1-shaped payload and running it through
 * `normalizeDue` means these tests now exercise the exact code that was broken.
 *
 *   due("2026-07-17")                       → all-day
 *   due("2026-07-17T16:00:00.000000Z")      → fixed zone (absolute instant)
 *   due("2026-07-17T17:00:00.000000")       → floating local wall time
 */
/** PURE: render an ISO instant the way Todoist does — microseconds, then `Z`. */
function toTodoistMicros(iso: string): string {
  return iso.replace(/(?:\.\d+)?Z$/, ".000000Z");
}

function due(date: string, isRecurring = false): TodoistDue {
  const normalized = normalizeDue({
    date,
    timezone: null,
    is_recurring: isRecurring,
    string: isRecurring ? "every day" : null,
    lang: "en",
  });
  if (!normalized) throw new Error(`unusable due fixture: ${date}`);
  return normalized;
}

const PROJECTS: NormalizedTodoistProject[] = [
  { id: "p_inbox", name: "Inbox", isInboxProject: true, parentId: null },
  { id: "p_hula", name: "Hula", isInboxProject: false, parentId: null },
  { id: "p_work", name: "Work", isInboxProject: false, parentId: null },
];

/** A FAKE TODOIST with real, mutable state. */
class FakeTodoist {
  tasks = new Map<string, NormalizedTodoistTask>();
  calls: string[] = [];
  failNext: TodoistError | null = null;
  /** Simulates Todoist accepting a write but not applying it. */
  swallowWrites = false;

  constructor(seed: NormalizedTodoistTask[] = []) {
    for (const t of seed) this.tasks.set(t.id, { ...t });
  }
  private maybeFail() {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }

  /**
   * Mirror Todoist's real due-writing behaviour.
   *
   * `due_datetime` (an absolute instant) comes back as a `date` CARRYING the time
   * plus a `Z`; `due_date` comes back as a bare date. Reproducing that round-trip
   * is what makes these tests capable of catching the live bug — a fake that echoed
   * a `datetime` field back would keep passing forever while production broke.
   */
  private dueFromWrite(fields: TodoistTaskWriteFields): TodoistDue | null {
    if (fields.removeDue) return null;
    if (fields.dueDatetime) {
      if (this.dropDueTime) {
        // The observed failure mode: Todoist keeps the DAY but not the time.
        return due(String(fields.dueDatetime).slice(0, 10));
      }
      if (this.shiftDueByHours) {
        const shifted = new Date(Date.parse(String(fields.dueDatetime)) + this.shiftDueByHours * 3_600_000);
        return due(toTodoistMicros(shifted.toISOString()));
      }
      return due(toTodoistMicros(String(fields.dueDatetime)));
    }
    if (fields.dueDate) return due(String(fields.dueDate));
    if (fields.dueString) return due("2026-07-20", true);
    return null;
  }

  /** Simulates Todoist storing the date but silently dropping the time. */
  dropDueTime = false;
  /** Simulates Todoist storing a DIFFERENT instant than the one requested. */
  shiftDueByHours = 0;
  fetchTask = async (_u: string, id: string): Promise<NormalizedTodoistTask> => {
    this.calls.push(`get:${id}`);
    const t = this.tasks.get(id);
    if (!t) throw new TodoistError("task_not_found", "gone", 404);
    return { ...t };
  };
  fetchTasks = async (
    _u: string,
    filters: { projectId?: string; sectionId?: string; label?: string },
  ): Promise<NormalizedTodoistTask[]> => {
    this.calls.push("list");
    this.maybeFail();
    return [...this.tasks.values()]
      .filter((t) => !t.completed)
      .filter((t) => !filters.projectId || t.projectId === filters.projectId)
      .filter((t) => !filters.sectionId || t.sectionId === filters.sectionId)
      .filter((t) => !filters.label || t.labels.includes(filters.label))
      .map((t) => ({ ...t }));
  };
  /**
   * Applies the filter expression for real, the way Todoist does.
   *
   * A fake that ignored `query` and returned everything would let a WRONG filter
   * expression pass every test — the read path trusts this endpoint to do the
   * scoping, so the fake has to actually scope. It understands exactly the
   * allowlisted fragments `buildScopeFilterQuery` can emit; anything else is a bug
   * in the builder and throws loudly rather than silently matching.
   */
  fetchTasksByFilter = async (_u: string, query: string): Promise<NormalizedTodoistTask[]> => {
    this.calls.push(`filter:${query}`);
    this.maybeFail();
    const fragments = query.split("&").map((f) => f.trim()).filter(Boolean);
    return [...this.tasks.values()]
      .filter((t) => !t.completed)
      .filter((t) =>
        fragments.every((fragment) => {
          if (fragment === "today") return matchesScope(t, "today", NOW, TZ);
          if (fragment === "overdue") return matchesScope(t, "overdue", NOW, TZ);
          if (fragment === "next 7 days") return matchesScope(t, "week", NOW, TZ);
          if (fragment === "due after: today") return matchesScope(t, "upcoming", NOW, TZ);
          if (fragment === "no date") return matchesScope(t, "no_date", NOW, TZ);
          const priority = /^p([1-4])$/.exec(fragment);
          if (priority) return t.priority === 5 - Number(priority[1]);
          throw new Error(`fake Todoist got an unsupported filter fragment: "${fragment}"`);
        }),
      )
      .map((t) => ({ ...t }));
  };
  createTask = async (_u: string, fields: TodoistTaskWriteFields): Promise<NormalizedTodoistTask> => {
    this.calls.push("create");
    this.maybeFail();
    const id = `t_new_${this.tasks.size + 1}`;
    const created = task({
      id,
      content: String(fields.content ?? ""),
      description: (fields.description as string) ?? null,
      projectId: (fields.projectId as string) ?? "p_inbox",
      sectionId: (fields.sectionId as string) ?? null,
      labels: (fields.labels as string[]) ?? [],
      priority: (fields.priority as number) ?? 1,
      due: this.dueFromWrite(fields),
    });
    this.tasks.set(id, created);
    return { ...created };
  };
  updateTask = async (
    _u: string,
    id: string,
    fields: TodoistTaskWriteFields,
  ): Promise<NormalizedTodoistTask> => {
    this.calls.push(`update:${id}`);
    this.maybeFail();
    const t = this.tasks.get(id);
    if (!t) throw new TodoistError("task_not_found", "gone", 404);
    if (this.swallowWrites) return { ...t };
    const next = { ...t };
    if (fields.content !== undefined) next.content = String(fields.content);
    if (fields.description !== undefined) next.description = String(fields.description);
    if (fields.priority !== undefined) next.priority = Number(fields.priority);
    if (fields.labels !== undefined) next.labels = fields.labels as string[];
    if (fields.removeDue || fields.dueDatetime || fields.dueDate || fields.dueString) {
      next.due = this.dueFromWrite(fields);
    }
    this.tasks.set(id, next);
    return { ...next };
  };
  moveTask = async (_u: string, id: string, target: { projectId?: string }): Promise<void> => {
    this.calls.push(`move:${id}`);
    this.maybeFail();
    const t = this.tasks.get(id);
    if (!t) throw new TodoistError("task_not_found", "gone", 404);
    if (this.swallowWrites) return;
    this.tasks.set(id, { ...t, projectId: target.projectId ?? t.projectId });
  };
  closeTask = async (_u: string, id: string): Promise<void> => {
    this.calls.push(`close:${id}`);
    this.maybeFail();
    const t = this.tasks.get(id);
    if (!t) throw new TodoistError("task_not_found", "gone", 404);
    if (this.swallowWrites) return;
    // A recurring task rolls forward and stays ACTIVE rather than completing.
    if (t.due?.isRecurring) {
      this.tasks.set(id, { ...t, due: due(addDaysToKey(t.due.date.slice(0, 10), 1), true) });
      return;
    }
    this.tasks.set(id, { ...t, completed: true });
  };
  reopenTask = async (_u: string, id: string): Promise<void> => {
    this.calls.push(`reopen:${id}`);
    this.maybeFail();
    const t = this.tasks.get(id);
    if (!t) throw new TodoistError("task_not_found", "gone", 404);
    this.tasks.set(id, { ...t, completed: false });
  };
  // Mirrors the real `deleteTask`: a validated receipt carrying Todoist's
  // documented success status. `swallowWrites` models the provider accepting the
  // delete and the task nonetheless remaining readable (a stale replica).
  deleteTask = async (_u: string, id: string): Promise<TodoistDeleteReceipt> => {
    this.calls.push(`delete:${id}`);
    this.maybeFail();
    if (!this.swallowWrites) this.tasks.delete(id);
    return { httpStatus: 200 };
  };
  fetchProjects = async (): Promise<NormalizedTodoistProject[]> => PROJECTS;
  fetchSections = async () => [{ id: "s_later", projectId: "p_hula", name: "Later" }];
  fetchLabels = async () => [
    { id: "l_work", name: "work" },
    { id: "l_home", name: "home" },
  ];
  fetchCompletedTasks = async (): Promise<NormalizedTodoistTask[]> =>
    [...this.tasks.values()].filter((t) => t.completed).map((t) => ({ ...t }));
}

/** An in-memory, USER-SCOPED proposal store standing in for the DB. */
class FakeProposals {
  rows: (ActionProposalView & { userId: string })[] = [];
  private seq = 0;
  create = async (userId: string, input: CreateProposalInput) => {
    const id = `pr_${++this.seq}`;
    this.rows.unshift({
      userId,
      id,
      provider: input.provider ?? null,
      actionId: input.actionId,
      status: "proposed",
      riskLevel: input.riskLevel,
      confirmationRequired: input.confirmationRequired ?? true,
      previewText: input.previewText,
      input: input.input ?? null,
      expiresAt: new Date(Date.now() + (input.ttlMs ?? 600_000)).toISOString(),
      confirmedAt: null,
      rejectedAt: null,
      executedAt: null,
      createdAt: new Date().toISOString(),
    });
    return { id };
  };
  listRecent = async (userId: string, actionId: string) =>
    this.rows.filter((r) => r.userId === userId && r.actionId === actionId);
  getActive = async (userId: string) => {
    const row = this.rows.find(
      (r) => r.userId === userId && r.status === "proposed" && r.confirmationRequired,
    );
    if (!row) return null;
    if (Date.parse(row.expiresAt) <= Date.now()) {
      row.status = "expired";
      return null;
    }
    return row;
  };
  /** Atomic claim: only a still-`proposed` row flips. */
  confirm = async (userId: string, id: string) => {
    const row = this.rows.find((r) => r.id === id && r.userId === userId);
    if (!row || row.status !== "proposed") return null;
    row.status = "confirmed";
    return row;
  };
  reject = async (userId: string, id: string) => {
    const row = this.rows.find((r) => r.id === id && r.userId === userId);
    if (!row || row.status !== "proposed") return null;
    row.status = "rejected";
    return row;
  };
  finalize = async (userId: string, id: string, outcome: "executed" | "failed") => {
    const row = this.rows.find((r) => r.id === id && r.userId === userId);
    if (row && row.status === "confirmed") row.status = outcome;
  };
}

/** Wire the real executor to the fake Todoist. */
function executorWith(fake: FakeTodoist, store: FakeProposals, capabilities: string[] = ["tasks.read", "tasks.write", "tasks.delete"], scopes: string[] = ["data:read_write", "data:delete"]) {
  const exec: typeof executeAction = (userId, actionId, options) =>
    executeAction(userId, actionId, options, {
      buildContext: async (_u, o) => ({
        connectedProviders: ["todoist"],
        grantedScopesByProvider: { todoist: scopes },
        capabilitiesByProvider: { todoist: capabilities },
        userConfirmed: o.userConfirmed,
      }),
      record: async () => "exec_1",
      createTodoistTask: fake.createTask,
      updateTodoistTask: fake.updateTask,
      moveTodoistTask: fake.moveTask,
      closeTodoistTask: fake.closeTask,
      reopenTodoistTask: fake.reopenTask,
      deleteTodoistTask: fake.deleteTask,
      fetchTodoistTask: fake.fetchTask,
      recordActedTodoistTask: async (userId, acted) => {
        await store.create(userId, {
          provider: "todoist",
          actionId: "todoist.entityContext",
          riskLevel: "read",
          confirmationRequired: false,
          input: { kind: "todoist_entity_context", selected: acted.kind === "deleted" ? null : acted.task, acted } as unknown as Record<string, unknown>,
          previewText: "ctx",
          ttlMs: 7_200_000,
        });
        return { id: "ctx" };
      },
    });
  return exec;
}

/** Build write-handler deps around a fake Todoist + fake store. */
function writeDeps(fake: FakeTodoist, store: FakeProposals, intent: TodoistWriteIntent, over: Record<string, unknown> = {}) {
  return {
    extract: async () => intent,
    getTimezone: async () => TZ,
    now: NOW,
    fetchProjects: fake.fetchProjects,
    fetchSections: fake.fetchSections as never,
    fetchLabels: fake.fetchLabels as never,
    fetchTasks: fake.fetchTasks as never,
    loadSelection: (userId: string) => loadLatestTodoistSelection(userId, store),
    loadEntityContext: async (userId: string) => {
      const rows = await store.listRecent(userId, "todoist.entityContext");
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, data: row.input as never, createdAt: row.createdAt };
    },
    createProposal: store.create as never,
    execute: executorWith(fake, store),
    ...over,
  };
}

function readDeps(fake: FakeTodoist, store: FakeProposals, intent: TodoistReadIntent) {
  return {
    extract: async () => intent,
    getTimezone: async () => TZ,
    now: NOW,
    fetchTasks: fake.fetchTasks as never,
    fetchTasksByFilter: fake.fetchTasksByFilter as never,
    fetchTask: fake.fetchTask,
    fetchProjects: fake.fetchProjects,
    fetchSections: fake.fetchSections as never,
    fetchLabels: fake.fetchLabels as never,
    fetchCompletedTasks: fake.fetchCompletedTasks as never,
    recordSelection: (userId: string, tasks: readonly NormalizedTodoistTask[]) =>
      recordTodoistSelection(userId, tasks, store),
    loadSelection: (userId: string) => loadLatestTodoistSelection(userId, store),
  };
}

async function run(): Promise<void> {
  console.log("todoist flow: scopes + timezone logic");

  check("scope predicates are timezone-aware at the day boundary", () => {
    // 23:30Z on 14 July. The SAME instant is a different calendar date depending on
    // where the user is, which is the whole point: a task due 15 July is "today" for
    // some users and "upcoming" for others at this exact moment.
    const late = new Date("2026-07-14T23:30:00.000Z");
    const t = task({ id: "a", due: due("2026-07-15") });

    // Tokyo (UTC+9) → already 08:30 on the 15th → due TODAY.
    assert.equal(matchesScope(t, "today", late, "Asia/Tokyo"), true);
    assert.equal(matchesScope(t, "upcoming", late, "Asia/Tokyo"), false);

    // New York (UTC-4 in July) → still 19:30 on the 14th → NOT today, upcoming.
    assert.equal(matchesScope(t, "today", late, "America/New_York"), false);
    assert.equal(matchesScope(t, "upcoming", late, "America/New_York"), true);

    // London is UTC+1 in July (BST), so 23:30Z is already the 15th there — the
    // exact trap a "London == UTC" assumption would fall into.
    assert.equal(matchesScope(t, "today", late, "Europe/London"), true);
  });

  check("overdue compares instants for timed tasks and dates for all-day", () => {
    const timedPast = task({ id: "a", due: due("2026-07-14T09:00:00.000000Z") });
    const timedFuture = task({ id: "b", due: due("2026-07-14T17:00:00.000000Z") });
    const allDayToday = task({ id: "c", due: due("2026-07-14") });
    const yesterday = task({ id: "d", due: due("2026-07-13") });

    assert.equal(matchesScope(timedPast, "overdue", NOW, TZ), true, "9am has passed");
    assert.equal(matchesScope(timedFuture, "overdue", NOW, TZ), false, "5pm has not");
    // An all-day task due today is NOT overdue until the day turns over.
    assert.equal(matchesScope(allDayToday, "overdue", NOW, TZ), false);
    assert.equal(matchesScope(yesterday, "overdue", NOW, TZ), true);
  });

  check("week means today..+6; no_date means genuinely undated", () => {
    assert.equal(matchesScope(task({ id: "a", due: due("2026-07-20") }), "week", NOW, TZ), true);
    assert.equal(matchesScope(task({ id: "b", due: due("2026-07-21") }), "week", NOW, TZ), false);
    assert.equal(matchesScope(task({ id: "c" }), "no_date", NOW, TZ), true);
    assert.equal(matchesScope(task({ id: "d", due: due("2026-07-14") }), "no_date", NOW, TZ), false);
    // A task with no due date can never match a date scope.
    assert.equal(matchesScope(task({ id: "e" }), "today", NOW, TZ), false);
  });

  check("local wall time converts to the right UTC instant, including BST", () => {
    // 17:00 in London in JULY is BST (UTC+1) → 16:00Z. Sending 17:00Z would put the
    // task an hour late for the user.
    assert.equal(zonedDateTimeToIso("2026-07-17", "17:00", "Europe/London"), "2026-07-17T16:00:00.000Z");
    // In JANUARY London is GMT (UTC+0) → unchanged.
    assert.equal(zonedDateTimeToIso("2026-01-17", "17:00", "Europe/London"), "2026-01-17T17:00:00.000Z");
    assert.equal(zonedDateTimeToIso("2026-07-17", "17:00", "UTC"), "2026-07-17T17:00:00.000Z");
    // Unusable input must never fabricate a time.
    assert.equal(zonedDateTimeToIso("nope", "17:00", "UTC"), null);
    assert.equal(zonedDateTimeToIso("2026-07-17", "5pm", "UTC"), null);
  });

  console.log("todoist flow: reads");

  await asyncCheck("read: 'what do I need to do today' lists today's tasks, numbered", async () => {
    const fake = new FakeTodoist([
      task({ id: "t1", content: "Finish the pitch deck", due: due("2026-07-14"), priority: 4, projectId: "p_work" }),
      task({ id: "t2", content: "Call Rob", due: due("2026-07-14") }),
      task({ id: "t3", content: "Later thing", due: due("2026-07-30") }),
    ]);
    const store = new FakeProposals();
    const result = await handleTodoistRead("u1", "what do I need to do today", readDeps(fake, store, { intent: "list", scope: "today" }));
    assert.equal(result.handled, true);
    assert.match(result.reply ?? "", /1\. Finish the pitch deck/);
    assert.match(result.reply ?? "", /2\. Call Rob/);
    assert.doesNotMatch(result.reply ?? "", /Later thing/, "only today's tasks");
    // The section's format: title, then meta.
    assert.match(result.reply ?? "", /Today · Work · Urgent/);
    // Internal ids are NEVER shown.
    assert.doesNotMatch(result.reply ?? "", /t1|t2/);
  });

  await asyncCheck("read: the shown list is remembered in the EXACT order shown", async () => {
    const fake = new FakeTodoist([
      task({ id: "t1", content: "Alpha", due: due("2026-07-14") }),
      task({ id: "t2", content: "Beta", due: due("2026-07-14") }),
    ]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    const selection = await loadLatestTodoistSelection("u1", store);
    assert.ok(selection);
    // Position N in the reply must be item N in the snapshot, or "the second one"
    // resolves to a task the user never saw.
    assert.equal(selection.data.items[0]?.content, "Alpha");
    assert.equal(selection.data.items[1]?.content, "Beta");
  });

  await asyncCheck("read: overdue sorts first and is flagged as overdue", async () => {
    const fake = new FakeTodoist([
      task({ id: "t1", content: "Upcoming", due: due("2026-07-20") }),
      task({ id: "t2", content: "Late one", due: due("2026-07-10") }),
    ]);
    const store = new FakeProposals();
    const result = await handleTodoistRead("u1", "what's overdue", readDeps(fake, store, { intent: "list", scope: "overdue" }));
    assert.match(result.reply ?? "", /1\. Late one/);
    assert.match(result.reply ?? "", /Overdue —/);
    assert.doesNotMatch(result.reply ?? "", /Upcoming/);
  });

  await asyncCheck("read: an explicit count is respected exactly, with no 'showing 5 of 10'", async () => {
    const fake = new FakeTodoist(
      Array.from({ length: 10 }, (_, i) => task({ id: `t${i}`, content: `Task ${i}`, due: due("2026-07-14") })),
    );
    const store = new FakeProposals();
    const result = await handleTodoistRead("u1", "show me 5 tasks", readDeps(fake, store, { intent: "list", scope: "today", count: 5 }));
    const lines = (result.reply ?? "").split("\n").filter((l) => /^\d+\./.test(l));
    assert.equal(lines.length, 5);
    // The section is explicit: do not say "I found 10, showing 5" when they asked for 5.
    assert.doesNotMatch(result.reply ?? "", /more\./);
  });

  await asyncCheck("read: an open-ended ask is bounded and says more exist", async () => {
    const fake = new FakeTodoist(
      Array.from({ length: 9 }, (_, i) => task({ id: `t${i}`, content: `Task ${i}`, due: due("2026-07-14") })),
    );
    const store = new FakeProposals();
    const result = await handleTodoistRead("u1", "what's on my plate", readDeps(fake, store, { intent: "list", scope: "today" }));
    const lines = (result.reply ?? "").split("\n").filter((l) => /^\d+\./.test(l));
    assert.equal(lines.length, 5, "bounded default");
    assert.match(result.reply ?? "", /\+4 more\./);
  });

  await asyncCheck("read: a project read resolves the name to a real project", async () => {
    const fake = new FakeTodoist([
      task({ id: "t1", content: "Hula task", projectId: "p_hula" }),
      task({ id: "t2", content: "Work task", projectId: "p_work" }),
    ]);
    const store = new FakeProposals();
    const result = await handleTodoistRead("u1", "show my tasks for Hula", readDeps(fake, store, { intent: "list", projectName: "Hula" }));
    assert.match(result.reply ?? "", /Hula task/);
    assert.doesNotMatch(result.reply ?? "", /Work task/);
  });

  await asyncCheck("read: an unknown project says so rather than returning nothing", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "x" })]);
    const store = new FakeProposals();
    const result = await handleTodoistRead("u1", "show my Personl tasks", readDeps(fake, store, { intent: "list", projectName: "Personl" }));
    // Returning an empty list would read as "you have no tasks there" — a lie.
    assert.match(result.reply ?? "", /couldn’t find a project called “Personl”/);
  });

  await asyncCheck("read: label and priority reads filter correctly", async () => {
    const fake = new FakeTodoist([
      task({ id: "t1", content: "Work thing", labels: ["work"], priority: 4 }),
      task({ id: "t2", content: "Home thing", labels: ["home"], priority: 1 }),
    ]);
    const store = new FakeProposals();
    const byLabel = await handleTodoistRead("u1", "tasks labelled work", readDeps(fake, store, { intent: "list", label: "work" }));
    assert.match(byLabel.reply ?? "", /Work thing/);
    assert.doesNotMatch(byLabel.reply ?? "", /Home thing/);

    const byPriority = await handleTodoistRead("u1", "highest priority tasks", readDeps(fake, store, { intent: "list", uiPriority: 1 }));
    // UI p1 = API 4. Getting the inversion wrong would return "Home thing".
    assert.match(byPriority.reply ?? "", /Work thing/);
  });

  await asyncCheck("read: an unknown label says so", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "x" })]);
    const store = new FakeProposals();
    const result = await handleTodoistRead("u1", "tasks labelled wrok", readDeps(fake, store, { intent: "list", label: "wrok" }));
    assert.match(result.reply ?? "", /don’t have a label called “wrok”/);
  });

  await asyncCheck("read: a recurring task shows its repeat", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Standup", due: due("2026-07-14", true) })]);
    const store = new FakeProposals();
    const result = await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    assert.match(result.reply ?? "", /Repeats every day/);
  });

  await asyncCheck("read: empty results get an honest, friendly empty state", async () => {
    const fake = new FakeTodoist([]);
    const store = new FakeProposals();
    const result = await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    assert.equal(result.handled, true);
    assert.match(result.reply ?? "", /Nothing due today/);
  });

  await asyncCheck("read: a provider failure is reported, never fabricated", async () => {
    const fake = new FakeTodoist([]);
    fake.failNext = new TodoistError("provider_unavailable", "boom", 503);
    const store = new FakeProposals();
    const result = await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    assert.match(result.reply ?? "", /couldn’t reach Todoist/);
  });

  await asyncCheck("read: a dead grant asks the user to reconnect", async () => {
    const fake = new FakeTodoist([]);
    fake.failNext = new TodoistError("invalid_grant", "revoked", 401);
    const store = new FakeProposals();
    const result = await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    assert.match(result.reply ?? "", /reconnect it in Hula/);
  });

  await asyncCheck("read: recently completed is answered from the completed endpoint", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Done thing", completed: true })]);
    const store = new FakeProposals();
    const result = await handleTodoistRead("u1", "what did I just complete", readDeps(fake, store, { intent: "completed" }));
    assert.match(result.reply ?? "", /Recently completed/);
    assert.match(result.reply ?? "", /Done thing/);
  });

  console.log("todoist flow: durable selection");

  check("ordinals parse, and a bare number only counts when it is the whole message", () => {
    assert.deepEqual(parseTodoistOrdinal("the second one"), { position: 2 });
    assert.deepEqual(parseTodoistOrdinal("2"), { position: 2 });
    assert.deepEqual(parseTodoistOrdinal("complete all of those"), { all: true });
    assert.deepEqual(parseTodoistOrdinal("the last one"), { last: true });
    // "move it to 3" must NOT be read as "item 3".
    assert.equal(parseTodoistOrdinal("move it to 3"), null);
  });

  check("an out-of-range position resolves to nothing rather than clamping", () => {
    const data = parseTodoistSelectionData({
      kind: "todoist_selection",
      items: [{ id: "a", content: "A", labels: [], priority: 1 }],
    });
    assert.ok(data);
    // Clamping to the nearest task would complete something the user never chose.
    assert.deepEqual(resolveTodoistSelection(data, { position: 5 }), []);
    assert.equal(resolveTodoistSelection(data, { position: 1 })[0]?.id, "a");
  });

  await asyncCheck("context is user-scoped: one user's list never resolves for another", async () => {
    const store = new FakeProposals();
    await recordTodoistSelection("user_a", [task({ id: "secret_a", content: "A's task" })], store);
    const forB = await loadLatestTodoistSelection("user_b", store);
    assert.equal(forB, null, "cross-user leakage would be a privacy breach");
    const forA = await loadLatestTodoistSelection("user_a", store);
    assert.equal(forA?.data.items[0]?.id, "secret_a");
  });

  await asyncCheck("an EXPIRED selection never resolves a position", async () => {
    const store = new FakeProposals();
    await store.create("u1", {
      provider: "todoist",
      actionId: "todoist.lastSelection",
      riskLevel: "read",
      confirmationRequired: false,
      input: { kind: "todoist_selection", items: [{ id: "old", content: "Stale", labels: [], priority: 1 }] },
      previewText: "x",
      ttlMs: -1000, // already expired
    });
    const loaded = await loadLatestTodoistSelection("u1", store);
    // The numbers the user is looking at are long gone.
    assert.equal(loaded, null);
  });

  console.log("todoist flow: writes");

  await asyncCheck("write: create makes a real task and confirms only after verifying", async () => {
    const fake = new FakeTodoist([]);
    const store = new FakeProposals();
    const result = await handleTodoistWrite(
      "u1",
      "add finish the pitch deck to my work project for Friday at 5",
      writeDeps(fake, store, {
        intent: "create",
        content: "Finish the pitch deck",
        projectName: "Work",
        dueDate: "2026-07-17",
        dueTime: "17:00",
      } as TodoistWriteIntent),
    );
    assert.match(result.reply ?? "", /Added “Finish the pitch deck”/);
    const created = [...fake.tasks.values()][0];
    assert.equal(created?.projectId, "p_work");
    // What matters is what the USER sees: 5pm on Friday, in their own zone. The raw
    // wire form is Todoist's business — asserting it pinned a v2-shaped string and
    // hid the very bug this test now covers.
    const stamp = dueLocalStamp(created?.due ?? null, TZ);
    assert.equal(stamp?.dateKey, "2026-07-17");
    assert.equal(stamp?.time, "17:00", "5pm London, not 4pm and not UTC");
    // Create needs NO confirmation — it is reversible and non-external.
    assert.equal(store.rows.filter((r) => r.confirmationRequired).length, 0);
  });

  await asyncCheck("write: a create into a non-existent project REFUSES, never invents one", async () => {
    const fake = new FakeTodoist([]);
    const store = new FakeProposals();
    const result = await handleTodoistWrite(
      "u1",
      "add a task to my Wrok project",
      writeDeps(fake, store, { intent: "create", content: "Thing", projectName: "Wrok" } as TodoistWriteIntent),
    );
    // Silently creating a project after a typo is exactly what the section forbids.
    assert.match(result.reply ?? "", /don’t have a project called “Wrok”/);
    assert.equal(fake.tasks.size, 0, "nothing created");
  });

  await asyncCheck("write: 'the second one' resolves against the remembered list", async () => {
    const fake = new FakeTodoist([
      task({ id: "t1", content: "Alpha", due: due("2026-07-14") }),
      task({ id: "t2", content: "Beta", due: due("2026-07-14") }),
    ]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));

    const result = await handleTodoistWrite(
      "u1",
      "mark the second one complete",
      writeDeps(fake, store, { intent: "complete", targetPosition: 2 } as TodoistWriteIntent),
    );
    assert.match(result.reply ?? "", /Completed “Beta”/);
    assert.equal(fake.tasks.get("t2")?.completed, true);
    assert.equal(fake.tasks.get("t1")?.completed, false, "the first must be untouched");
  });

  await asyncCheck("write: priority change reports the NEW priority, and maps p1 → API 4", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-14") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    const result = await handleTodoistWrite(
      "u1",
      "change its priority to high",
      writeDeps(fake, store, { intent: "update", uiPriority: 1 } as TodoistWriteIntent),
    );
    assert.equal(fake.tasks.get("t1")?.priority, 4, "UI p1 is API 4");
    assert.match(result.reply ?? "", /priority is now Urgent/);
  });

  await asyncCheck("write: reschedule and remove-due both work and are verified", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-14") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));

    await handleTodoistWrite("u1", "move that task to Monday", writeDeps(fake, store, { intent: "update", dueDate: "2026-07-20" } as TodoistWriteIntent));
    assert.equal(fake.tasks.get("t1")?.due?.date, "2026-07-20");

    const removed = await handleTodoistWrite("u1", "take the due date off that task", writeDeps(fake, store, { intent: "update", removeDue: true } as TodoistWriteIntent));
    assert.equal(fake.tasks.get("t1")?.due, null);
    assert.match(removed.reply ?? "", /no longer has a due date/);
  });

  await asyncCheck("write: labels MERGE against real current labels rather than replacing", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", labels: ["home"], due: due("2026-07-14") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    await handleTodoistWrite("u1", "add the label work to that task", writeDeps(fake, store, { intent: "update", addLabels: ["work"] } as TodoistWriteIntent));
    // Sending only the addition would silently STRIP "home".
    assert.deepEqual(fake.tasks.get("t1")?.labels.sort(), ["home", "work"]);
  });

  await asyncCheck("write: an unknown label refuses rather than creating one", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-14") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    const result = await handleTodoistWrite("u1", "add the label wrok", writeDeps(fake, store, { intent: "update", addLabels: ["wrok"] } as TodoistWriteIntent));
    assert.match(result.reply ?? "", /don’t have a label called “wrok”/);
  });

  await asyncCheck("write: moving a task uses the MOVE endpoint and is verified", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", projectId: "p_inbox", due: due("2026-07-14") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    const result = await handleTodoistWrite("u1", "put that in my Hula project", writeDeps(fake, store, { intent: "move", projectName: "Hula" } as TodoistWriteIntent));
    assert.match(result.reply ?? "", /Moved “Alpha”/);
    assert.equal(fake.tasks.get("t1")?.projectId, "p_hula");
    // The move MUST go through /move — update silently ignores project_id.
    assert.ok(fake.calls.some((c) => c.startsWith("move:")));
  });

  await asyncCheck("write: completing a RECURRING task reports the roll-forward honestly", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Standup", due: due("2026-07-14", true) })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    const result = await handleTodoistWrite("u1", "mark that complete", writeDeps(fake, store, { intent: "complete" } as TodoistWriteIntent));
    // The task is STILL ACTIVE (Todoist advanced it). Reporting failure would be
    // wrong; reporting a plain success would confuse ("why is it still there?").
    assert.match(result.reply ?? "", /Completed “Standup”/);
    assert.match(result.reply ?? "", /repeats, so it’s already back/);
    assert.equal(fake.tasks.get("t1")?.completed, false);
  });

  await asyncCheck("write: reopen puts a completed task back", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", completed: true })]);
    const store = new FakeProposals();
    const result = await handleTodoistWrite(
      "u1",
      "reopen the Alpha task",
      writeDeps(fake, store, { intent: "reopen", targetPhrase: "Alpha" } as TodoistWriteIntent, {
        fetchTasks: async () => [{ ...fake.tasks.get("t1")!, completed: false }],
      }),
    );
    assert.match(result.reply ?? "", /Reopened “Alpha”/);
    assert.equal(fake.tasks.get("t1")?.completed, false);
  });

  await asyncCheck("write: an ambiguous phrase ASKS rather than mutating", async () => {
    const fake = new FakeTodoist([
      task({ id: "t1", content: "Call Rob about the deck" }),
      task({ id: "t2", content: "Call Rob about invoices" }),
    ]);
    const store = new FakeProposals();
    const result = await handleTodoistWrite(
      "u1",
      "complete the call Rob task",
      writeDeps(fake, store, { intent: "complete", targetPhrase: "Call Rob" } as TodoistWriteIntent),
    );
    assert.match(result.reply ?? "", /I found a few that could match/);
    // Nothing may be mutated on an ambiguous target.
    assert.equal(fake.tasks.get("t1")?.completed, false);
    assert.equal(fake.tasks.get("t2")?.completed, false);
  });

  await asyncCheck("write: with no context at all, 'complete it' asks rather than guessing", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha" })]);
    const store = new FakeProposals();
    const result = await handleTodoistWrite("u1", "mark it complete", writeDeps(fake, store, { intent: "complete" } as TodoistWriteIntent));
    assert.match(result.reply ?? "", /not sure which task you mean/);
    assert.equal(fake.tasks.get("t1")?.completed, false);
  });

  await asyncCheck("write: a STALE context target that no longer exists is reported honestly", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-14") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    // The user deletes it in the Todoist app between reading and replying.
    fake.tasks.delete("t1");
    const result = await handleTodoistWrite("u1", "complete the first one", writeDeps(fake, store, { intent: "complete", targetPosition: 1 } as TodoistWriteIntent));
    assert.match(result.reply ?? "", /isn’t in your Todoist anymore|couldn’t/i);
  });

  await asyncCheck("write: an update that changes nothing asks what to change", async () => {
    assert.equal(updateChangesSomething({ intent: "update" } as TodoistWriteIntent), false);
    assert.equal(updateChangesSomething({ intent: "update", uiPriority: 1 } as TodoistWriteIntent), true);
  });

  console.log("todoist flow: receipts + postconditions");

  check("verification proves state rather than trusting a 2xx", () => {
    const t = task({ id: "a", content: "Alpha", priority: 4 });
    assert.equal(verifyTaskState(t, { content: "Alpha", priority: 4 }).ok, true);
    assert.equal(verifyTaskState(t, { priority: 1 }).ok, false);
    // A task that could not be read back proves nothing.
    assert.equal(verifyTaskState(null, { content: "Alpha" }).ok, false);
    // An unstated field is not an assertion.
    assert.equal(verifyTaskState(t, {}).ok, true);
  });

  check("completion verification handles absence, checked, and recurring roll-forward", () => {
    // A closed task drops out of the active endpoints — 404 PROVES completion.
    assert.deepEqual(verifyCompletion({ found: false, task: null, wasRecurring: false }), { ok: true, rolledForward: false });
    assert.deepEqual(
      verifyCompletion({ found: true, task: task({ id: "a", completed: true }), wasRecurring: false }),
      { ok: true, rolledForward: false },
    );
    // Recurring: still active, but this occurrence IS done.
    assert.deepEqual(
      verifyCompletion({ found: true, task: task({ id: "a", completed: false }), wasRecurring: true }),
      { ok: true, rolledForward: true },
    );
    // Non-recurring, still active → the close did NOT take effect.
    assert.deepEqual(
      verifyCompletion({ found: true, task: task({ id: "a", completed: false }), wasRecurring: false }),
      { ok: false, rolledForward: false },
    );
  });

  check("reopen and delete verification are asymmetric, correctly", () => {
    assert.equal(verifyReopen(task({ id: "a", completed: false })), true);
    assert.equal(verifyReopen(task({ id: "a", completed: true })), false);
    // A missing task cannot prove a reopen…
    assert.equal(verifyReopen(null), false);
    // …but absence is exactly what proves a delete.
    assert.equal(verifyDeletion(true), false, "still readable = not deleted");
    assert.equal(verifyDeletion(false), true);
  });

  await asyncCheck("a write Todoist ACCEPTS but does not apply is never reported as success", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-14") })]);
    fake.swallowWrites = true; // 200 OK, no effect — the false-success shape.
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    const result = await handleTodoistWrite("u1", "mark that complete", writeDeps(fake, store, { intent: "complete" } as TodoistWriteIntent));
    assert.doesNotMatch(result.reply ?? "", /^Completed/);
    assert.match(result.reply ?? "", /hadn’t taken effect/);
    assert.equal(fake.tasks.get("t1")?.completed, false);
  });

  await asyncCheck("a VALIDATED delete receipt is authoritative, even if every read is stale", async () => {
    // THIS TEST PREVIOUSLY ASSERTED THE OPPOSITE, and it was wrong — it encoded the
    // live bug. A real device proved the premise false: Todoist returned a
    // documented DELETE success, still served the task from GET seconds later, and
    // the task was demonstrably gone minutes afterwards. "Still readable" is a
    // stale replica, not evidence the delete failed.
    //
    // `swallowWrites` makes EVERY absence re-read stale. The receipt must still
    // stand, and the DELETE must not be repeated.
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha" })]);
    fake.swallowWrites = true;
    const store = new FakeProposals();
    const result = await executeAction(
      "u1",
      "task.delete",
      { input: { taskIds: ["t1"], label: "Alpha" }, userConfirmed: true },
      {
        buildContext: async () => ({
          connectedProviders: ["todoist"],
          grantedScopesByProvider: { todoist: ["data:read_write", "data:delete"] },
          capabilitiesByProvider: { todoist: ["tasks.read", "tasks.write", "tasks.delete"] },
          userConfirmed: true,
        }),
        record: async () => "e1",
        deleteTodoistTask: fake.deleteTask,
        fetchTodoistTask: fake.fetchTask,
        recordActedTodoistTask: async () => ({ id: "ctx" }),
        sleep: async () => {}, // exercise the real backoff without spending time
      },
    );
    assert.equal(result.ok, true, "a validated receipt is authoritative");
    assert.match(result.userMessage, /Deleted “Alpha”/);
    assert.doesNotMatch(result.userMessage, /hadn’t taken effect/);
    // Exactly one DELETE, however many stale reads happened.
    assert.equal(fake.calls.filter((c) => c.startsWith("delete:")).length, 1);
  });

  await asyncCheck("PARTIAL bulk failure is reported as partial, never rounded up", async () => {
    const fake = new FakeTodoist([
      task({ id: "t1", content: "A" }),
      task({ id: "t2", content: "B" }),
      task({ id: "t3", content: "C" }),
    ]);
    const store = new FakeProposals();
    // t2 vanishes mid-run.
    const realClose = fake.closeTask;
    fake.closeTask = async (u, id) => {
      if (id === "t2") throw new TodoistError("provider_unavailable", "flake", 503);
      return realClose(u, id);
    };
    const result = await executorWith(fake, store)("u1", "task.complete", {
      input: { taskIds: ["t1", "t2", "t3"], label: "A" },
      userConfirmed: true,
    });
    // The section's exact requirement.
    assert.match(result.userMessage, /Completed 2 of 3 tasks — one didn’t go through\./);
    assert.equal(result.ok, false, "partial is not success");
    assert.deepEqual(result.receipt?.taskIds, ["t1", "t3"]);
  });

  await asyncCheck("a receipt without a provider id is not a create", async () => {
    const fake = new FakeTodoist([]);
    const store = new FakeProposals();
    const result = await executeAction(
      "u1",
      "task.create",
      { input: { content: "Ghost" } },
      {
        buildContext: async () => ({
          connectedProviders: ["todoist"],
          grantedScopesByProvider: { todoist: ["data:read_write"] },
          capabilitiesByProvider: { todoist: ["tasks.read", "tasks.write"] },
        }),
        record: async () => "e1",
        // A malformed provider response.
        createTodoistTask: async () => {
          throw new TodoistError("malformed_provider_response", "no id");
        },
        fetchTodoistTask: fake.fetchTask,
      },
    );
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.userMessage, /Added/);
  });

  console.log("todoist flow: safety + confirmation");

  await asyncCheck("delete ALWAYS requires confirmation, and the preview says it is permanent", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-14") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    const result = await handleTodoistWrite("u1", "delete that task", writeDeps(fake, store, { intent: "delete" } as TodoistWriteIntent));

    assert.match(result.reply ?? "", /Permanently delete “Alpha”\?/);
    assert.match(result.reply ?? "", /can’t be undone/);
    assert.ok(fake.tasks.has("t1"), "nothing deleted before the yes");
    const active = await store.getActive("u1");
    assert.equal(active?.actionId, "task.delete");
  });

  await asyncCheck("BULK actions require confirmation even when each one is reversible", async () => {
    const fake = new FakeTodoist([
      task({ id: "t1", content: "A", due: due("2026-07-14") }),
      task({ id: "t2", content: "B", due: due("2026-07-14") }),
    ]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    const result = await handleTodoistWrite("u1", "complete all of those", writeDeps(fake, store, { intent: "complete", targetAll: true } as TodoistWriteIntent));

    assert.match(result.reply ?? "", /Complete these 2 tasks\?/);
    assert.equal(fake.tasks.get("t1")?.completed, false, "nothing done before the yes");
    assert.equal(fake.tasks.get("t2")?.completed, false);
  });

  await asyncCheck("confirming a bulk proposal executes it exactly once", async () => {
    const fake = new FakeTodoist([
      task({ id: "t1", content: "A", due: due("2026-07-14") }),
      task({ id: "t2", content: "B", due: due("2026-07-14") }),
    ]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    await handleTodoistWrite("u1", "complete all of those", writeDeps(fake, store, { intent: "complete", targetAll: true } as TodoistWriteIntent));

    const confirmDeps = {
      getActiveProposal: store.getActive as never,
      confirmProposal: store.confirm as never,
      rejectProposal: store.reject as never,
      finalizeProposal: store.finalize as never,
      executeAction: executorWith(fake, store),
    };
    const yes = await handleActionConfirmation("u1", "yes", confirmDeps);
    assert.match(yes.reply ?? "", /Completed 2 tasks\./);
    assert.equal(fake.tasks.get("t1")?.completed, true);
    assert.equal(fake.tasks.get("t2")?.completed, true);
  });

  await asyncCheck("CANCEL never executes", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-14") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    await handleTodoistWrite("u1", "delete that task", writeDeps(fake, store, { intent: "delete" } as TodoistWriteIntent));

    const no = await handleActionConfirmation("u1", "cancel", {
      getActiveProposal: store.getActive as never,
      confirmProposal: store.confirm as never,
      rejectProposal: store.reject as never,
      finalizeProposal: store.finalize as never,
      executeAction: executorWith(fake, store),
    });
    assert.match(no.reply ?? "", /cancelled/i);
    assert.ok(fake.tasks.has("t1"), "cancel must never delete");
  });

  await asyncCheck("a REPEATED confirmation (duplicate delivery) never executes twice", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-14") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    await handleTodoistWrite("u1", "delete that task", writeDeps(fake, store, { intent: "delete" } as TodoistWriteIntent));

    const deps = {
      getActiveProposal: store.getActive as never,
      confirmProposal: store.confirm as never,
      rejectProposal: store.reject as never,
      finalizeProposal: store.finalize as never,
      executeAction: executorWith(fake, store),
    };
    const first = await handleActionConfirmation("u1", "yes", deps);
    assert.match(first.reply ?? "", /Deleted “Alpha”/);
    assert.equal(fake.tasks.has("t1"), false);

    const deleteCalls = fake.calls.filter((c) => c.startsWith("delete:")).length;
    // Sendblue can deliver the same "yes" twice. The atomic proposal claim is what
    // makes the second one a no-op.
    const second = await handleActionConfirmation("u1", "yes", deps);
    assert.equal(second.handled, false, "no active proposal remains");
    assert.equal(fake.calls.filter((c) => c.startsWith("delete:")).length, deleteCalls, "no second provider call");
  });

  await asyncCheck("CONCURRENT confirmations race safely — exactly one executes", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-14") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    await handleTodoistWrite("u1", "delete that task", writeDeps(fake, store, { intent: "delete" } as TodoistWriteIntent));

    const deps = {
      getActiveProposal: store.getActive as never,
      confirmProposal: store.confirm as never,
      rejectProposal: store.reject as never,
      finalizeProposal: store.finalize as never,
      executeAction: executorWith(fake, store),
    };
    await Promise.all([
      handleActionConfirmation("u1", "yes", deps),
      handleActionConfirmation("u1", "yes", deps),
    ]);
    assert.equal(fake.calls.filter((c) => c.startsWith("delete:")).length, 1, "exactly one delete");
  });

  await asyncCheck("an EXPIRED proposal never executes", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha" })]);
    const store = new FakeProposals();
    await store.create("u1", {
      provider: "todoist",
      actionId: "task.delete",
      riskLevel: "write",
      confirmationRequired: true,
      input: { taskIds: ["t1"], label: "Alpha" },
      previewText: "Permanently delete “Alpha”?",
      ttlMs: -1000, // already expired
    });
    const late = await handleActionConfirmation("u1", "yes", {
      getActiveProposal: store.getActive as never,
      confirmProposal: store.confirm as never,
      rejectProposal: store.reject as never,
      finalizeProposal: store.finalize as never,
      executeAction: executorWith(fake, store),
    });
    assert.equal(late.handled, false, "a stale yes must do nothing");
    assert.ok(fake.tasks.has("t1"));
  });

  await asyncCheck("delete WITHOUT the data:delete scope refuses and never calls Todoist", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha" })]);
    const store = new FakeProposals();
    // A partial grant: read/write but the user declined deletion.
    const exec = executorWith(fake, store, ["tasks.read", "tasks.write"], ["data:read_write"]);
    const result = await exec("u1", "task.delete", { input: { taskIds: ["t1"] }, userConfirmed: true });
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.ok(fake.tasks.has("t1"));
    assert.equal(fake.calls.filter((c) => c.startsWith("delete:")).length, 0);
  });

  await asyncCheck("a partial grant still allows every non-delete action", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha" })]);
    const store = new FakeProposals();
    const exec = executorWith(fake, store, ["tasks.read", "tasks.write"], ["data:read_write"]);
    const result = await exec("u1", "task.complete", { input: { taskIds: ["t1"], label: "Alpha" } });
    // Missing delete access must NOT present as a broken integration.
    assert.equal(result.ok, true);
    assert.equal(fake.tasks.get("t1")?.completed, true);
  });

  check("previews name the count and, for delete, the permanence", () => {
    const items = [
      { id: "a", content: "A", projectId: null, dueDate: null, isRecurring: false, priority: 1, labels: [] },
      { id: "b", content: "B", projectId: null, dueDate: null, isRecurring: false, priority: 1, labels: [] },
    ];
    const del = buildPreview("task.delete", items);
    assert.match(del, /Permanently delete these 2 tasks\?/);
    assert.match(del, /can’t be undone/);
    const bulk = buildPreview("task.complete", items);
    assert.match(bulk, /Complete these 2 tasks\?/);
    assert.match(bulk, /• A/);
  });

  console.log("todoist flow: undo");

  await asyncCheck("undo reverses a VERIFIED completion", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-14") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));
    await handleTodoistWrite("u1", "complete that", writeDeps(fake, store, { intent: "complete" } as TodoistWriteIntent));
    assert.equal(fake.tasks.get("t1")?.completed, true);

    const undo = await handleTodoistUndo("u1", "undo that", writeDeps(fake, store, { intent: "undo" } as TodoistWriteIntent));
    assert.equal(undo.handled, true);
    assert.match(undo.reply ?? "", /Reopened “Alpha”/);
    assert.equal(fake.tasks.get("t1")?.completed, false);
  });

  await asyncCheck("undo declines when Todoist has done nothing (so Gmail/Calendar undo still win)", async () => {
    const fake = new FakeTodoist([]);
    const store = new FakeProposals();
    const undo = await handleTodoistUndo("u1", "undo that", writeDeps(fake, store, { intent: "undo" } as TodoistWriteIntent));
    // Declining is what lets the cascade's earlier undo handlers keep priority.
    assert.equal(undo.handled, false);
  });

  await asyncCheck("undo of a DELETE is honestly refused — Todoist keeps no copy", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha" })]);
    const store = new FakeProposals();
    await store.create("u1", {
      provider: "todoist",
      actionId: "todoist.entityContext",
      riskLevel: "read",
      confirmationRequired: false,
      input: {
        kind: "todoist_entity_context",
        selected: null,
        acted: { task: { id: "t1", content: "Alpha", labels: [], priority: 1 }, kind: "deleted", at: NOW.toISOString() },
      },
      previewText: "ctx",
      ttlMs: 7_200_000,
    });
    const undo = await handleTodoistUndo("u1", "undo that", writeDeps(fake, store, { intent: "undo" } as TodoistWriteIntent));
    assert.match(undo.reply ?? "", /deleted permanently|doesn’t keep a copy/i);
  });

  console.log("todoist flow: routing + collisions");

  check("'remind me to call Rob tomorrow' is NOT a Todoist request", () => {
    // The single most important collision in this section.
    assert.equal(looksLikeReminderPhrase("remind me to call Rob tomorrow"), true);
    assert.equal(shouldConsiderTodoist("remind me to call Rob tomorrow"), false);
    // Even with a task-ish verb, a reminder stays a reminder.
    assert.equal(shouldConsiderTodoist("remind me to complete the deck"), false);
  });

  check("explicit Todoist language DOES route to Todoist, even in reminder shape", () => {
    assert.equal(shouldConsiderTodoist("remind me to call Rob by adding a task"), true);
    assert.equal(shouldConsiderTodoist("add a todoist task to call Rob"), true);
    assert.equal(shouldConsiderTodoist("what do I need to do today"), true);
    assert.equal(shouldConsiderTodoist("what tasks are overdue"), true);
    assert.equal(shouldConsiderTodoist("show my tasks for Hula"), true);
    assert.equal(shouldConsiderTodoist("what's on my plate"), true);
  });

  check("a due date does NOT turn a task into an event", () => {
    // The exact misroute, generalised. "for <day> at <time>" is a DUE DATE. It was
    // being read as event evidence, which is how a task became a one-hour meeting.
    assert.equal(shouldConsiderTodoist("add finish the write-up to my project for friday at 5pm"), true);
    assert.equal(shouldConsiderTodoist("add review the roadmap to my project for tomorrow"), true);
    // Same request without a date — still a task.
    assert.equal(shouldConsiderTodoist("add review the roadmap to my project"), true);
  });

  check("explicit EVENT language beats weak task words, so meetings stay Calendar's", () => {
    // Todoist is now evaluated BEFORE calendarWrite, so cascade position no longer
    // protects meetings — the gate does. "project" alone must not capture a meeting.
    assert.equal(shouldConsiderTodoist("schedule a project review meeting on friday"), false);
    assert.equal(shouldConsiderTodoist("book a meeting about the project"), false);
    assert.equal(shouldConsiderTodoist("put the project kickoff on my calendar"), false);
    assert.equal(shouldConsiderTodoist("invite the project team for tuesday"), false);
  });

  check("an explicit TASK word still wins over event language", () => {
    // "the meeting prep task" is a task that happens to mention a meeting.
    assert.equal(shouldConsiderTodoist("complete the meeting prep task"), true);
    assert.equal(shouldConsiderTodoist("add a todoist task to prep for the meeting"), true);
  });

  check("ordinary conversation and other providers are not claimed", () => {
    assert.equal(shouldConsiderTodoist("what's on my calendar today"), false);
    assert.equal(shouldConsiderTodoist("any emails from Rob"), false);
    assert.equal(shouldConsiderTodoist("how are you"), false);
    assert.equal(shouldConsiderTodoist(""), false);
    assert.equal(shouldConsiderTodoist("book a meeting with Sam on Friday"), false);
  });

  await asyncCheck("routing: a reminder reaches the reminder handler, never Todoist", async () => {
    let todoistCalled = false;
    const routed = await routeInboundText("u1", "remind me to call Rob tomorrow", {
      memory: async () => ({ handled: false }),
      reminder: async () => ({ handled: true, reply: "Reminder set for tomorrow." }),
      confirmation: async () => ({ handled: false }),
      gmailClarify: async () => ({ handled: false }),
      gmailDraftFollowup: async () => ({ handled: false }),
      gmailDraftLifecycle: async () => ({ handled: false }),
      gmailCommand: async () => ({ handled: false }),
      calendarUndo: async () => ({ handled: false }),
      calendarWrite: async () => ({ handled: false }),
      gmailWrite: async () => ({ handled: false }),
      actionIntent: async () => ({ handled: false }),
      calendarAvailability: async () => ({ handled: false }),
      calendar: async () => ({ handled: false }),
      calendarRead: async () => ({ handled: false }),
      gmailReadOne: async () => ({ handled: false }),
      gmailSummary: async () => ({ handled: false }),
      gmailSearch: async () => ({ handled: false }),
      gmailQuestion: async () => ({ handled: false }),
      todoistUndo: async () => ({ handled: false }),
      todoistWrite: async () => {
        todoistCalled = true;
        return { handled: true, reply: "TODOIST STOLE IT" };
      },
      todoistRead: async () => ({ handled: false }),
      pendingReprompt: async () => ({ handled: false }),
    });
    assert.equal(routed?.source, "reminder");
    assert.equal(routed?.reply, "Reminder set for tomorrow.");
    assert.equal(todoistCalled, false, "reminder must claim it first");
  });

  await asyncCheck("routing: an explicit Todoist request reaches the Todoist handler", async () => {
    const decline = async () => ({ handled: false as const });
    const routed = await routeInboundText("u1", "what tasks are overdue", {
      memory: decline,
      reminder: decline,
      confirmation: decline,
      gmailClarify: decline,
      gmailDraftFollowup: decline,
      gmailDraftLifecycle: decline,
      gmailCommand: decline,
      calendarUndo: decline,
      calendarWrite: decline,
      gmailWrite: decline,
      actionIntent: decline,
      calendarAvailability: decline,
      calendar: decline,
      calendarRead: decline,
      gmailReadOne: decline,
      gmailSummary: decline,
      gmailSearch: decline,
      gmailQuestion: decline,
      todoistUndo: decline,
      todoistWrite: decline,
      todoistRead: async () => ({ handled: true, reply: "1. Late task" }),
      pendingReprompt: decline,
    });
    assert.equal(routed?.source, "todoistRead");
  });

  await asyncCheck("routing: Gmail, memory, reminders and undo keep priority over Todoist", async () => {
    // NOTE: `calendarWrite` and `calendar` are deliberately NOT in this list any
    // more. They used to be — and that ordering is exactly what misrouted "add … to
    // my work project for Friday at 5" into a calendar event on a real device.
    // Todoist now precedes them, and Calendar is protected by the Todoist GATE
    // rather than by cascade position (proved in "a genuine calendar request still
    // reaches Calendar, untouched", which runs the real gate).
    const decline = async () => ({ handled: false as const });
    for (const winner of ["memory", "reminder", "gmailCommand", "calendarUndo"] as const) {
      const routed = await routeInboundText("u1", "do the thing", {
        memory: decline,
        reminder: decline,
        confirmation: decline,
        gmailClarify: decline,
        gmailDraftFollowup: decline,
        gmailDraftLifecycle: decline,
        gmailCommand: decline,
        calendarUndo: decline,
        calendarWrite: decline,
        gmailWrite: decline,
        actionIntent: decline,
        calendarAvailability: decline,
        calendar: decline,
        calendarRead: decline,
        gmailReadOne: decline,
        gmailSummary: decline,
        gmailSearch: decline,
        gmailQuestion: decline,
        [winner]: async () => ({ handled: true, reply: `handled by ${winner}` }),
        todoistUndo: async () => ({ handled: true, reply: "TODOIST STOLE IT" }),
        todoistWrite: async () => ({ handled: true, reply: "TODOIST STOLE IT" }),
        todoistRead: async () => ({ handled: true, reply: "TODOIST STOLE IT" }),
        pendingReprompt: decline,
      });
      assert.equal(routed?.source, winner, `${winner} must win over Todoist`);
    }
  });

  await asyncCheck("routing: a pending Todoist proposal never falls through to the brain", async () => {
    const decline = async () => ({ handled: false as const });
    const routed = await routeInboundText("u1", "is it gone yet?", {
      memory: decline,
      // "it" is a follow-up shape, so the real arbiter would otherwise run — and
      // reach the real context store. Injected so this suite stays fully offline.
      entityFollowup: decline,
      reminder: decline,
      confirmation: decline,
      gmailClarify: decline,
      gmailDraftFollowup: decline,
      gmailDraftLifecycle: decline,
      gmailCommand: decline,
      calendarUndo: decline,
      calendarWrite: decline,
      gmailWrite: decline,
      actionIntent: decline,
      calendarAvailability: decline,
      calendar: decline,
      calendarRead: decline,
      gmailReadOne: decline,
      gmailSummary: decline,
      gmailSearch: decline,
      gmailQuestion: decline,
      todoistUndo: decline,
      todoistWrite: decline,
      todoistRead: decline,
      // A Todoist deletion is awaiting a yes/no.
      pendingReprompt: async () => ({ handled: true, reply: "I’m waiting for your go-ahead." }),
    });
    // The brain could otherwise fabricate "yes, it's deleted!".
    assert.equal(routed?.source, "pendingReprompt");
  });

  await asyncCheck("write: a date WITHOUT a time stays date-only and never asks for a time", async () => {
    // A task due "tomorrow" is genuinely date-only. Calendar had to ask for a time
    // because an event needs one — a task does not, and inventing a time (or
    // demanding one) would be answering a question the user never asked.
    const fake = new FakeTodoist([]);
    const store = new FakeProposals();
    const result = await handleTodoistWrite(
      "u1",
      "add a task to my project for tomorrow",
      writeDeps(fake, store, {
        intent: "create",
        content: "Review the roadmap",
        projectName: "Hula",
        dueDate: "2026-07-15",
        // No dueTime — the user named a day, not a moment.
      } as TodoistWriteIntent),
    );
    // It must be CREATED, not deferred behind a clarifying question.
    assert.match(result.reply ?? "", /Added “Review the roadmap”/);
    assert.doesNotMatch(result.reply ?? "", /what time|which time|at what/i);

    const created = [...fake.tasks.values()][0];
    assert.equal(created?.due?.date, "2026-07-15");
    assert.equal(created?.due?.datetime, null, "date-only tasks must carry no instant");
  });

  check("a date-only intent never produces a timed due; a timed one always does", () => {
    // The pure boundary behind the test above.
    const dateOnly = buildCreateInput(
      { intent: "create", content: "x", dueDate: "2026-07-15" } as TodoistWriteIntent,
      {},
      TZ,
    );
    assert.equal(dateOnly.dueDate, "2026-07-15");
    assert.equal("dueDatetime" in dateOnly, false);

    const timed = buildCreateInput(
      { intent: "create", content: "x", dueDate: "2026-07-17", dueTime: "17:00" } as TodoistWriteIntent,
      {},
      TZ,
    );
    // Converted through the USER's zone, never sent as naive wall time.
    assert.equal(timed.dueDatetime, "2026-07-17T16:00:00.000Z");
    assert.equal("dueDate" in timed, false);
  });

  await asyncCheck("project names match case-insensitively but keep the provider's casing", async () => {
    // Users type project names however they like; Todoist owns the display casing.
    // Matching must be forgiving, and what Hula shows back must be what Todoist
    // actually calls it — not an echo of what the user typed.
    const fake = new FakeTodoist([]);
    const store = new FakeProposals();
    const canonical = PROJECTS.find((p) => !p.isInboxProject)!;
    const typedByUser = canonical.name.toLowerCase();
    assert.notEqual(typedByUser, canonical.name, "fixture must actually differ in case");

    await handleTodoistWrite(
      "u1",
      "add a task to that project",
      writeDeps(fake, store, {
        intent: "create",
        content: "Case test",
        projectName: typedByUser,
      } as TodoistWriteIntent),
    );
    const created = [...fake.tasks.values()][0];
    assert.equal(created?.projectId, canonical.id, "lower-cased name must still resolve");

    // And the read renders the provider's display casing on the meta line.
    const read = await handleTodoistRead(
      "u1",
      "show my tasks for that project",
      readDeps(fake, store, { intent: "list", projectName: typedByUser }),
    );
    assert.ok(
      (read.reply ?? "").includes(canonical.name),
      "the meta line shows the provider's display casing",
    );
    assert.ok(
      !(read.reply ?? "").includes(typedByUser),
      "must render Todoist's casing, never an echo of what the user typed",
    );
  });

  console.log("todoist flow: due-time provider contract");

  check("v1 due payloads normalize: the time lives in `date`, not a `datetime` field", () => {
    // THE ROOT CAUSE, pinned. Todoist v1 returns the SYNC-shaped due object and has
    // NO `datetime` property. Reading one yields null for every timed task, which is
    // exactly how a 5pm task became all-day, lost its time in the reply, and then
    // failed its own postcondition.
    const allDay = normalizeDue({ date: "2026-07-17", timezone: null, is_recurring: false, string: "17 Jul", lang: "en" });
    assert.equal(allDay?.datetime, null);
    assert.equal(allDay?.isFloating, false);

    const fixed = normalizeDue({ date: "2026-07-17T16:00:00.000000Z", timezone: "Europe/London", is_recurring: false, string: "17 Jul 17:00", lang: "en" });
    assert.equal(fixed?.datetime, "2026-07-17T16:00:00.000000Z", "the time comes from `date`");
    assert.equal(fixed?.isFloating, false, "a trailing Z is an absolute instant");

    const floating = normalizeDue({ date: "2026-07-17T17:00:00.000000", timezone: null, is_recurring: false, string: "17 Jul 17:00", lang: "en" });
    assert.equal(floating?.datetime, "2026-07-17T17:00:00.000000");
    assert.equal(floating?.isFloating, true, "no Z means a LOCAL wall time");
  });

  check("a fixed instant is converted to the user's zone; a floating time never is", () => {
    // Both say 5pm to a London user, by two different routes. Conflating them is how
    // a time gets shifted by an hour.
    const fixed = dueLocalStamp(due("2026-07-17T16:00:00.000000Z"), TZ);
    assert.deepEqual([fixed?.dateKey, fixed?.time], ["2026-07-17", "17:00"], "16:00Z → 5pm BST");

    const floating = dueLocalStamp(due("2026-07-17T17:00:00.000000"), TZ);
    assert.deepEqual([floating?.dateKey, floating?.time], ["2026-07-17", "17:00"], "wall time, verbatim");
    // The bug a naive Date.parse would cause: floating read as UTC → 18:00 in BST.
    assert.notEqual(floating?.time, "18:00");
  });

  check("all-day dues carry no time and are not timezone-shifted", () => {
    const stamp = dueLocalStamp(due("2026-07-17"), TZ);
    assert.equal(stamp?.dateKey, "2026-07-17");
    assert.equal(stamp?.time, null);
    // A date is not an instant. Converting it could move it a day in either zone.
    assert.equal(dueLocalStamp(due("2026-07-17"), "Asia/Tokyo")?.dateKey, "2026-07-17");
    assert.equal(dueLocalStamp(due("2026-07-17"), "America/New_York")?.dateKey, "2026-07-17");
  });

  await asyncCheck("create: a LONDON SUMMER time is stored as that local time (BST)", async () => {
    const fake = new FakeTodoist([]);
    const store = new FakeProposals();
    const result = await handleTodoistWrite(
      "u1",
      "add a task to my project for friday at 5pm",
      writeDeps(fake, store, {
        intent: "create",
        content: "Summer task",
        dueDate: "2026-07-17",
        dueTime: "17:00",
      } as TodoistWriteIntent),
    );
    // The live failure: this said the due date didn't stick.
    assert.match(result.reply ?? "", /Added “Summer task”/);
    assert.doesNotMatch(result.reply ?? "", /didn’t/);

    const created = [...fake.tasks.values()][0];
    // Sent as the correct instant (BST = UTC+1) …
    assert.equal(created?.due?.datetime, "2026-07-17T16:00:00.000000Z");
    // … and reads back as 5pm local — not 4pm, not 6pm, not UTC.
    assert.deepEqual(
      [dueLocalStamp(created?.due ?? null, TZ)?.dateKey, dueLocalStamp(created?.due ?? null, TZ)?.time],
      ["2026-07-17", "17:00"],
    );
  });

  await asyncCheck("create: a LONDON WINTER time is stored as that local time (GMT)", async () => {
    const fake = new FakeTodoist([]);
    const store = new FakeProposals();
    await handleTodoistWrite(
      "u1",
      "add a task to my project for a january afternoon",
      writeDeps(fake, store, {
        intent: "create",
        content: "Winter task",
        dueDate: "2026-01-16",
        dueTime: "17:00",
      } as TodoistWriteIntent),
    );
    const created = [...fake.tasks.values()][0];
    // London in January is GMT (UTC+0) — the instant differs from summer by an hour.
    assert.equal(created?.due?.datetime, "2026-01-16T17:00:00.000000Z");
    assert.equal(dueLocalStamp(created?.due ?? null, TZ)?.time, "17:00", "still 5pm to the user");
  });

  check("DST transition boundaries resolve to the right instant", () => {
    // BST starts 29 Mar 2026 at 01:00 GMT; ends 25 Oct 2026 at 02:00 BST. A fixed
    // UTC offset would be wrong on one side of each of these.
    assert.equal(zonedDateTimeToIso("2026-03-28", "12:00", TZ), "2026-03-28T12:00:00.000Z", "GMT, day before spring-forward");
    assert.equal(zonedDateTimeToIso("2026-03-30", "12:00", TZ), "2026-03-30T11:00:00.000Z", "BST, day after");
    assert.equal(zonedDateTimeToIso("2026-10-24", "12:00", TZ), "2026-10-24T11:00:00.000Z", "BST, day before fall-back");
    assert.equal(zonedDateTimeToIso("2026-10-26", "12:00", TZ), "2026-10-26T12:00:00.000Z", "GMT, day after");
    // Round-trip through the reader: the user always sees the wall time they asked for.
    for (const day of ["2026-03-28", "2026-03-30", "2026-10-24", "2026-10-26"]) {
      const iso = zonedDateTimeToIso(day, "12:00", TZ)!;
      assert.equal(dueLocalStamp(due(toTodoistMicros(iso)), TZ)?.time, "12:00", `${day} round-trips`);
    }
  });

  await asyncCheck("reschedule: a timed update reads back as that local time", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-14") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "what tasks are due today", readDeps(fake, store, { intent: "list", scope: "today" }));

    const result = await handleTodoistWrite(
      "u1",
      "move that task to friday at 5pm",
      writeDeps(fake, store, { intent: "update", dueDate: "2026-07-17", dueTime: "17:00" } as TodoistWriteIntent),
    );
    assert.match(result.reply ?? "", /Updated “Alpha”/);
    const stamp = dueLocalStamp(fake.tasks.get("t1")?.due ?? null, TZ);
    assert.deepEqual([stamp?.dateKey, stamp?.time], ["2026-07-17", "17:00"]);
  });

  await asyncCheck("removing the TIME keeps the day, using the task's own real date", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-17T16:00:00.000000Z") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "show my tasks", readDeps(fake, store, { intent: "list", scope: "all" }));

    const result = await handleTodoistWrite(
      "u1",
      "drop the time on that task but keep the day",
      writeDeps(fake, store, { intent: "update", removeDueTime: true } as TodoistWriteIntent),
    );
    assert.match(result.reply ?? "", /Updated “Alpha”/);
    const stamp = dueLocalStamp(fake.tasks.get("t1")?.due ?? null, TZ);
    // The day survives; only the time is gone.
    assert.equal(stamp?.dateKey, "2026-07-17");
    assert.equal(stamp?.time, null);
    assert.notEqual(fake.tasks.get("t1")?.due, null, "removing a time must not unschedule the task");
  });

  await asyncCheck("removing the whole due date leaves no date at all", async () => {
    const fake = new FakeTodoist([task({ id: "t1", content: "Alpha", due: due("2026-07-17T16:00:00.000000Z") })]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "show my tasks", readDeps(fake, store, { intent: "list", scope: "all" }));

    const result = await handleTodoistWrite(
      "u1",
      "take the due date off that task",
      writeDeps(fake, store, { intent: "update", removeDue: true } as TodoistWriteIntent),
    );
    assert.match(result.reply ?? "", /no longer has a due date/);
    assert.equal(fake.tasks.get("t1")?.due, null);
  });

  await asyncCheck("provider keeps the DATE but drops the TIME → named honestly, not as a date failure", async () => {
    // The EXACT live failure. Hula said "The due date didn't stick" when the date was
    // perfect and only the time was missing — sending the user after the wrong problem.
    const fake = new FakeTodoist([]);
    fake.dropDueTime = true;
    const store = new FakeProposals();
    const result = await handleTodoistWrite(
      "u1",
      "add a task to my project for friday at 5pm",
      writeDeps(fake, store, {
        intent: "create",
        content: "Finish Todoist integration test",
        dueDate: "2026-07-17",
        dueTime: "17:00",
      } as TodoistWriteIntent),
    );
    assert.equal(result.reply, "I created the task, but its 5:00 PM due time wasn’t saved. Have a look in Todoist and I can fix it from there.");
    // It must NOT blame the date, which saved correctly.
    assert.doesNotMatch(result.reply ?? "", /due date didn’t stick/);
    // And it must not claim success.
    assert.doesNotMatch(result.reply ?? "", /^Added/);
    assert.equal(dueLocalStamp([...fake.tasks.values()][0]?.due ?? null, TZ)?.dateKey, "2026-07-17");
  });

  await asyncCheck("provider SHIFTS the instant → reported, never rounded up to success", async () => {
    const fake = new FakeTodoist([]);
    fake.shiftDueByHours = 2; // Todoist stores 7pm when we asked for 5pm.
    const store = new FakeProposals();
    const result = await handleTodoistWrite(
      "u1",
      "add a task to my project for friday at 5pm",
      writeDeps(fake, store, {
        intent: "create",
        content: "Shifted task",
        dueDate: "2026-07-17",
        dueTime: "17:00",
      } as TodoistWriteIntent),
    );
    assert.doesNotMatch(result.reply ?? "", /^Added/);
    // Says what it ACTUALLY observed rather than what was intended — and does not
    // claim the time "wasn't saved", because it was; it was saved WRONG.
    assert.match(result.reply ?? "", /saved as 7pm rather than the 5:00 PM I asked for/);
    assert.doesNotMatch(result.reply ?? "", /wasn’t saved/);
  });

  await asyncCheck("a grounded read shows the provider's REAL due time", async () => {
    const fake = new FakeTodoist([
      task({ id: "t1", content: "Finish Todoist integration test", due: due("2026-07-17T16:00:00.000000Z") }),
      task({ id: "t2", content: "Review Hula roadmap", due: due("2026-07-15") }),
    ]);
    const store = new FakeProposals();
    const result = await handleTodoistRead(
      "u1",
      "show my tasks",
      readDeps(fake, store, { intent: "list", scope: "all" }),
    );
    // The live read printed "Fri 17 Jul" with no time at all.
    assert.match(result.reply ?? "", /Fri 17 Jul at 5pm/);
    // The date-only task stays date-only — no invented time.
    assert.match(result.reply ?? "", /Review Hula roadmap/);
    assert.doesNotMatch(result.reply ?? "", /Review Hula roadmap\n   \w+ at /);
  });

  check("recurring due strings are validated, never trusted raw", () => {
    // A `due_string` is parsed by TODOIST, so we cannot verify the result. It is
    // accepted only for recurrence, which has no structured equivalent.
    assert.equal(isValidRecurrenceString("every Monday"), true);
    assert.equal(isValidRecurrenceString("each weekday"), true);
    // A one-off date must go through the deterministic path we can verify.
    assert.equal(isValidRecurrenceString("friday at 5"), false);
    assert.equal(isValidRecurrenceString("tomorrow"), false);
    assert.equal(isValidRecurrenceString(""), false);
    assert.equal(isValidRecurrenceString(null), false);
    // Nothing exotic or unbounded.
    assert.equal(isValidRecurrenceString("every day; DROP TABLE tasks"), false);
    assert.equal(isValidRecurrenceString("every " + "x".repeat(80)), false);
  });

  check("a one-off natural-language due never reaches Todoist's parser", () => {
    // Even if the model puts "friday at 5" in dueString, it is rejected and the
    // deterministic date/time path is used instead.
    const input = buildCreateInput(
      { intent: "create", content: "x", dueString: "friday at 5", dueDate: "2026-07-17", dueTime: "17:00" } as TodoistWriteIntent,
      {},
      TZ,
    );
    assert.equal("dueString" in input, false, "unvalidated NL must not be sent");
    assert.equal(input.dueDatetime, "2026-07-17T16:00:00.000Z");
    assert.equal(input.dueLocalTime, "17:00");
  });

  check("a valid recurrence IS passed through, and asserts no computed instant", () => {
    const input = buildCreateInput(
      { intent: "create", content: "x", dueString: "every Monday" } as TodoistWriteIntent,
      {},
      TZ,
    );
    assert.equal(input.dueString, "every Monday");
    // We do not compute the recurrence, so we must not claim an expected date.
    assert.equal("dueLocalDate" in input, false);
    assert.equal("dueDatetime" in input, false);
  });

  console.log("todoist flow: 'delete it' after a list → complete → undo");

  await asyncCheck("the exact transcript: list → complete → undo → 'delete it' → confirmation, no mutation", async () => {
    // The real conversation, replayed through the REAL cascade:
    //   1. "Show my tasks for Work"   2. "Complete it"   3. "Undo that"   4. "Delete it"
    // Step 4 was answered by MEMORY ("I couldn't find a saved memory matching that")
    // because its delete pattern matches any "delete …" and it sits above the
    // arbiter. Nothing about the message concerns memories.
    const fake = new FakeTodoist([
      task({ id: "t1", content: "Review Hula roadmap", projectId: "p_work", due: due("2026-07-15") }),
      task({ id: "t2", content: "Finish Todoist integration test", projectId: "p_work", due: due("2026-07-17T16:00:00.000000Z") }),
    ]);
    const store = new FakeProposals();

    // 1. A grounded, numbered list.
    const listed = await handleTodoistRead(
      "u1",
      "show my tasks for Work",
      readDeps(fake, store, { intent: "list", projectName: "Work" }),
    );
    assert.match(listed.reply ?? "", /1\. Review Hula roadmap/);

    // 2 + 3. Complete the second, then undo it — leaving a VERIFIED entity context.
    await handleTodoistWrite("u1", "complete the second one", writeDeps(fake, store, { intent: "complete", targetPosition: 2 } as TodoistWriteIntent));
    assert.equal(fake.tasks.get("t2")?.completed, true);
    await handleTodoistUndo("u1", "undo that", writeDeps(fake, store, { intent: "undo" } as TodoistWriteIntent));
    assert.equal(fake.tasks.get("t2")?.completed, false, "undo restored it");

    // 4. "Delete it" — through the REAL cascade, with the REAL memory gate above.
    const routed = await routeInboundText("u1", "Delete it", {
      memory: async (_u, t) =>
        classifyMemoryCommand(t).intent === "none"
          ? { handled: false }
          : { handled: true, reply: "I couldn’t find a saved memory matching that." },
      reminder: async () => ({ handled: false }),
      confirmation: async () => ({ handled: false }),
      entityFollowup: (u, t) =>
        handleEntityFollowup(u, t, {
          listRecent: store.listRecent as never,
          todoistWrite: (uu, tt) =>
            handleTodoistWrite(uu, tt, writeDeps(fake, store, { intent: "delete" } as TodoistWriteIntent, { arbitrated: true })),
        }),
      gmailClarify: async () => ({ handled: false }),
      gmailDraftFollowup: async () => ({ handled: false }),
      gmailDraftLifecycle: async () => ({ handled: false }),
      gmailCommand: async () => ({ handled: false }),
      calendarUndo: async () => ({ handled: false }),
      todoistUndo: async () => ({ handled: false }),
      todoistWrite: async () => ({ handled: false }),
      todoistRead: async () => ({ handled: false }),
      calendarWrite: async () => ({ handled: false }),
      gmailWrite: async () => ({ handled: false }),
      actionIntent: async () => ({ handled: false }),
      calendarAvailability: async () => ({ handled: false }),
      calendar: async () => ({ handled: false }),
      calendarRead: async () => ({ handled: false }),
      gmailReadOne: async () => ({ handled: false }),
      gmailSummary: async () => ({ handled: false }),
      gmailSearch: async () => ({ handled: false }),
      gmailQuestion: async () => ({ handled: false }),
      pendingReprompt: async () => ({ handled: false }),
    });

    // It reaches Todoist, NOT memory.
    assert.equal(routed?.source, "entityFollowup");
    assert.doesNotMatch(routed?.reply ?? "", /memory/i, "Memory must never answer this");
    // It resolves to the task the conversation is about, and asks first.
    assert.match(routed?.reply ?? "", /Permanently delete “Finish Todoist integration test”\?/);
    assert.match(routed?.reply ?? "", /can’t be undone/);
    assert.match(routed?.reply ?? "", /Reply Yes to confirm or No to cancel\./);
    // ZERO provider mutation before confirmation.
    assert.ok(fake.tasks.has("t2"), "nothing deleted before the yes");
    assert.equal(fake.calls.filter((c) => c.startsWith("delete:")).length, 0);
  });

  await asyncCheck("'No' preserves the task; a fresh proposal then 'Yes' deletes exactly once", async () => {
    const fake = new FakeTodoist([
      task({ id: "t2", content: "Finish Todoist integration test", projectId: "p_work", due: due("2026-07-17") }),
    ]);
    const store = new FakeProposals();
    await handleTodoistRead("u1", "show my tasks for Work", readDeps(fake, store, { intent: "list", projectName: "Work" }));

    const deleteDeps = writeDeps(fake, store, { intent: "delete" } as TodoistWriteIntent, { arbitrated: true });
    const confirmDeps = {
      getActiveProposal: store.getActive as never,
      confirmProposal: store.confirm as never,
      rejectProposal: store.reject as never,
      finalizeProposal: store.finalize as never,
      executeAction: executorWith(fake, store),
    };

    // Propose → "No" → the task survives.
    await handleTodoistWrite("u1", "delete it", deleteDeps);
    const no = await handleActionConfirmation("u1", "No", confirmDeps);
    assert.equal(no.outcome, "cancelled");
    assert.ok(fake.tasks.has("t2"), "'No' must preserve the task");
    assert.equal(fake.calls.filter((c) => c.startsWith("delete:")).length, 0);

    // Propose again → "Yes" → deleted exactly once, and VERIFIED.
    await handleTodoistWrite("u1", "delete it", deleteDeps);
    const yes = await handleActionConfirmation("u1", "Yes", confirmDeps);
    assert.match(yes.reply ?? "", /Deleted “Finish Todoist integration test”/);
    assert.equal(fake.tasks.has("t2"), false, "gone from the provider");
    assert.equal(fake.calls.filter((c) => c.startsWith("delete:")).length, 1, "exactly one provider delete");

    // A repeated "Yes" (duplicate Sendblue delivery) must not delete again.
    const again = await handleActionConfirmation("u1", "Yes", confirmDeps);
    assert.equal(again.handled, false, "no active proposal remains");
    assert.equal(fake.calls.filter((c) => c.startsWith("delete:")).length, 1, "still exactly one");
  });

  console.log("todoist flow: the real-device incident");

  await asyncCheck("a task-create request reaches Todoist, NOT Calendar", async () => {
    // THE PRIMARY MISROUTE. "add … to my work project for Friday at 5" was claimed
    // by calendarWrite, whose extractor reads "for Friday at 5" as an event — so the
    // user got a calendar-event confirmation for a request that never mentioned a
    // calendar. Todoist now precedes Calendar in the cascade.
    let calendarSaw = false;
    const decline = async () => ({ handled: false as const });
    const routed = await routeInboundText(
      "u1",
      "add finish the pitch deck to my work project for Friday at 5",
      {
        memory: decline,
        reminder: decline,
        confirmation: decline,
        gmailClarify: decline,
        gmailDraftFollowup: decline,
        gmailDraftLifecycle: decline,
        gmailCommand: decline,
        calendarUndo: decline,
        todoistUndo: decline,
        todoistWrite: async () => ({ handled: true, reply: "Added “Finish the pitch deck”." }),
        todoistRead: decline,
        // The greedy handler that caused the incident.
        calendarWrite: async () => {
          calendarSaw = true;
          return { handled: true, reply: "I’ll put “Finish the pitch deck” on your calendar…" };
        },
        gmailWrite: decline,
        actionIntent: decline,
        calendarAvailability: decline,
        calendar: decline,
        calendarRead: decline,
        gmailReadOne: decline,
        gmailSummary: decline,
        gmailSearch: decline,
        gmailQuestion: decline,
        pendingReprompt: decline,
      },
    );
    assert.equal(routed?.source, "todoistWrite");
    assert.equal(calendarSaw, false, "calendarWrite must never even see a task request");
  });

  await asyncCheck("a genuine calendar request still reaches Calendar, untouched", async () => {
    // The other half of the correction: moving Todoist up must not steal meetings.
    // The REAL gate runs here (no stubbed todoistWrite), so this proves the gate —
    // not the ordering — is what protects Calendar.
    const fake = new FakeTodoist([]);
    const store = new FakeProposals();
    const decline = async () => ({ handled: false as const });
    for (const text of [
      "book a meeting with Sam on Friday",
      "schedule gym tomorrow at 7pm",
      "what's on my calendar today",
      "am I free Friday afternoon",
    ]) {
      const routed = await routeInboundText("u1", text, {
        memory: decline,
        reminder: decline,
        confirmation: decline,
        gmailClarify: decline,
        gmailDraftFollowup: decline,
        gmailDraftLifecycle: decline,
        gmailCommand: decline,
        calendarUndo: decline,
        todoistUndo: decline,
        // The REAL Todoist handlers, with a model that would claim anything it saw.
        todoistWrite: (userId, t) =>
          handleTodoistWrite(userId, t, writeDeps(fake, store, { intent: "create", content: "STOLEN" } as TodoistWriteIntent)),
        todoistRead: (userId, t) =>
          handleTodoistRead(userId, t, readDeps(fake, store, { intent: "list", scope: "today" })),
        calendarWrite: async () => ({ handled: true, reply: "calendar handled it" }),
        gmailWrite: decline,
        actionIntent: decline,
        calendarAvailability: async () => ({ handled: true, reply: "calendar handled it" }),
        calendar: async () => ({ handled: true, reply: "calendar handled it" }),
        calendarRead: decline,
        gmailReadOne: decline,
        gmailSummary: decline,
        gmailSearch: decline,
        gmailQuestion: decline,
        pendingReprompt: decline,
      });
      assert.equal(routed?.reply, "calendar handled it", `"${text}" must reach Calendar`);
    }
    assert.equal(fake.tasks.size, 0, "no task may be created from a calendar request");
  });

  await asyncCheck("REGRESSION: no Todoist task exists after the misrouted, unconfirmed transcript", async () => {
    // The full real-device sequence, replayed:
    //   1. two task-create requests are MISROUTED to Calendar → two proposals
    //   2. the user replies "Cancel" → the proposal is cancelled (reply blocked by
    //      Sendblue as OPTED_OUT, but the backend state is correct)
    //   3. a second "Cancel" arrives with no proposal left
    //   4. the user sends "START"; the brain answered "Both tasks left as they were"
    //
    // The invariant that MUST hold at the end: no Todoist task was ever created, so
    // any claim about "both tasks" is a fabrication.
    const fake = new FakeTodoist([]);
    const store = new FakeProposals();

    // 1. Two create requests that were never confirmed. Each produces a Calendar
    //    proposal (that is what the misroute did) — and crucially, no Todoist task.
    for (const text of [
      "add finish the pitch deck to my work project for Friday at 5",
      "add send the invoice to my work project for Friday at 5",
    ]) {
      await store.create("u1", {
        provider: "google_calendar",
        actionId: "calendar.createEvent",
        riskLevel: "write",
        confirmationRequired: true,
        input: { title: text },
        previewText: "I’ll put that on your calendar…",
      });
    }
    assert.equal(fake.tasks.size, 0, "no Todoist task from an unconfirmed request");

    // 2 + 3. "Cancel" cancels the pending proposal; a second finds nothing.
    const confirmDeps = {
      getActiveProposal: store.getActive as never,
      confirmProposal: store.confirm as never,
      rejectProposal: store.reject as never,
      finalizeProposal: store.finalize as never,
      executeAction: executorWith(fake, store),
    };
    const first = await handleActionConfirmation("u1", "Cancel", confirmDeps);
    assert.equal(first.outcome, "cancelled");
    const second = await handleActionConfirmation("u1", "Cancel", confirmDeps);
    assert.equal(second.outcome, "cancelled", "the second proposal is cancelled too");
    const third = await handleActionConfirmation("u1", "Cancel", confirmDeps);
    assert.equal(third.handled, false, "nothing left to cancel — must not reach the brain as content");

    // 4. START. It must be answered by the transport handler with the neutral line.
    const decline = async () => ({ handled: false as const });
    const routed = await routeInboundText("u1", "START", {
      memory: decline,
      reminder: decline,
      confirmation: (userId, t) => handleActionConfirmation(userId, t, confirmDeps),
      gmailClarify: decline,
      gmailDraftFollowup: decline,
      gmailDraftLifecycle: decline,
      gmailCommand: decline,
      calendarUndo: decline,
      todoistUndo: decline,
      todoistWrite: decline,
      todoistRead: decline,
      calendarWrite: decline,
      gmailWrite: decline,
      actionIntent: decline,
      calendarAvailability: decline,
      calendar: decline,
      calendarRead: decline,
      gmailReadOne: decline,
      gmailSummary: decline,
      gmailSearch: decline,
      gmailQuestion: decline,
      pendingReprompt: decline,
    });
    assert.equal(routed?.source, "transportKeyword");
    assert.equal(routed?.reply, OPT_IN_ACKNOWLEDGEMENT);
    // The exact sentence the brain fabricated on the real device.
    assert.doesNotMatch(routed?.reply ?? "", /left as they were/i);
    assert.doesNotMatch(routed?.reply ?? "", /both tasks/i);

    // THE INVARIANT: the tasks the brain talked about never existed.
    assert.equal(fake.tasks.size, 0, "no Todoist task was ever created");
    assert.equal(
      fake.calls.filter((c) => c.startsWith("create")).length,
      0,
      "Todoist was never asked to create anything",
    );
  });

  console.log(`\ntodoist flow: ${passed} assertions passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
