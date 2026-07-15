import assert from "node:assert/strict";

import { handleActionConfirmation } from "../src/actions/confirmations";
import { executeAction } from "../src/actions/executor";
import type { ActionProposalView, CreateProposalInput } from "../src/actions/proposals";
import {
  isReferencePhrase,
  loadLatestTodoistSelection,
  loadTodoistEntityContext,
  recordActedTodoistTask,
  recordTodoistSelection,
} from "../src/integrations/providers/todoist/todoistContext";
import { parseTodoistWriteIntent } from "../src/integrations/providers/todoist/todoistIntentExtract";
import {
  handleTodoistUndo,
  handleTodoistWrite,
  resolveWriteTargets,
} from "../src/integrations/providers/todoist/todoistActions";
import { handleTodoistRead } from "../src/integrations/providers/todoist/todoistReads";
import { TodoistError } from "../src/integrations/providers/todoist/client";
import type { TodoistWriteIntent } from "../src/integrations/providers/todoist/todoistIntentExtract";
import type { TodoistDeleteReceipt } from "../src/integrations/providers/todoist/tasks";
import type {
  NormalizedTodoistProject,
  NormalizedTodoistTask,
} from "../src/integrations/providers/todoist/types";

/**
 * Pronoun-reference resolution tests (Section 19) — OFFLINE.
 *
 * THE LIVE FAILURE THESE ENCODE. After:
 *
 *   1. "Show my tasks for Work"  → one task, "Finish Todoist integration test"
 *   2. "Complete the first one"  → completed
 *   3. "Undo that"               → reopened
 *   4. "Delete it"               → "I couldn't find a task matching 'it'."
 *
 * The routing was by then correct — "Delete it" DID reach Todoist. The resolver was
 * wrong: the model returns `targetPhrase: "it"`, and the resolver checked
 * `targetPhrase` BEFORE the entity context, so it searched task TITLES for the
 * string "it", found none, and refused — while the task sat verified in context.
 *
 * WHY THE EXISTING SUITE MISSED IT. Every other Todoist test injects
 * `extract: async () => intent` with a HAND-WRITTEN intent, and none of those
 * hand-written intents ever set `targetPhrase: "it"` — because a human writing a
 * fixture writes `{ intent: "delete" }`, not what the model actually emits. The
 * mocks skipped the extractor, so the one field that caused the bug was never
 * populated the way production populates it.
 *
 * So these tests deliberately do the opposite of a convenient shortcut:
 *   - the intent is parsed by the REAL `parseTodoistWriteIntent` from a REAL model
 *     JSON reply containing `"targetPhrase": "it"`;
 *   - the context is written and read by the REAL context module in its REAL
 *     persisted shape (proposal rows), not an injected object;
 *   - target resolution is the REAL `resolveWriteTargets`.
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

const TZ = "Europe/London";
const NOW = new Date("2026-07-15T12:00:00.000Z");

const PROJECTS: NormalizedTodoistProject[] = [
  { id: "p_inbox", name: "Inbox", isInboxProject: true, parentId: null },
  { id: "p_work", name: "Work", isInboxProject: false, parentId: null },
];

function task(over: Partial<NormalizedTodoistTask> & { id: string }): NormalizedTodoistTask {
  return {
    content: "Task",
    description: null,
    projectId: "p_work",
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

/** A FAKE TODOIST with real mutable state, tracking every provider call. */
class FakeTodoist {
  tasks = new Map<string, NormalizedTodoistTask>();
  calls: string[] = [];
  constructor(seed: NormalizedTodoistTask[]) {
    for (const t of seed) this.tasks.set(t.id, { ...t });
  }
  fetchTask = async (_u: string, id: string): Promise<NormalizedTodoistTask> => {
    this.calls.push(`get:${id}`);
    const t = this.tasks.get(id);
    if (!t) throw new TodoistError("task_not_found", "gone", 404);
    return { ...t };
  };
  fetchTasks = async (): Promise<NormalizedTodoistTask[]> => {
    this.calls.push("list");
    return [...this.tasks.values()].filter((t) => !t.completed).map((t) => ({ ...t }));
  };
  fetchTasksByFilter = async (): Promise<NormalizedTodoistTask[]> => {
    this.calls.push("filter");
    return [...this.tasks.values()].filter((t) => !t.completed).map((t) => ({ ...t }));
  };
  closeTask = async (_u: string, id: string): Promise<void> => {
    this.calls.push(`close:${id}`);
    const t = this.tasks.get(id);
    if (!t) throw new TodoistError("task_not_found", "gone", 404);
    this.tasks.set(id, { ...t, completed: true });
  };
  reopenTask = async (_u: string, id: string): Promise<void> => {
    this.calls.push(`reopen:${id}`);
    const t = this.tasks.get(id);
    if (!t) throw new TodoistError("task_not_found", "gone", 404);
    this.tasks.set(id, { ...t, completed: false });
  };
  // Mirrors the real `deleteTask`: returns Todoist's DOCUMENTED success status as
  // a validated receipt (the spec lists 200 for DELETE /tasks/{id}).
  deleteTask = async (_u: string, id: string): Promise<TodoistDeleteReceipt> => {
    this.calls.push(`delete:${id}`);
    this.tasks.delete(id);
    return { httpStatus: 200 };
  };
  fetchProjects = async (): Promise<NormalizedTodoistProject[]> => PROJECTS;
  fetchSections = async () => [];
  fetchLabels = async () => [];
  deleteCalls(): number {
    return this.calls.filter((c) => c.startsWith("delete:")).length;
  }
}

/**
 * The REAL persisted context shape: proposal rows, exactly as the DB holds them.
 * The context modules read/write through this — no injected context objects.
 */
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

/** The REAL executor, wired to the fake provider and the REAL context module. */
function executorWith(fake: FakeTodoist, store: FakeProposals): typeof executeAction {
  return (userId, actionId, options) =>
    executeAction(userId, actionId, options, {
      buildContext: async (_u, o) => ({
        connectedProviders: ["todoist"],
        grantedScopesByProvider: { todoist: ["data:read_write", "data:delete"] },
        capabilitiesByProvider: { todoist: ["tasks.read", "tasks.write", "tasks.delete"] },
        userConfirmed: o.userConfirmed,
      }),
      record: async () => "exec_1",
      closeTodoistTask: fake.closeTask,
      reopenTodoistTask: fake.reopenTask,
      deleteTodoistTask: fake.deleteTask,
      fetchTodoistTask: fake.fetchTask,
      // The REAL context writer, over the REAL persisted shape.
      recordActedTodoistTask: (u, acted) => recordActedTodoistTask(u, acted, store),
    });
}

/**
 * Handler deps that use the REAL context module throughout. Only the PROVIDER and
 * the MODEL are faked — everything else is production code.
 */
function realCtxDeps(fake: FakeTodoist, store: FakeProposals, modelReply: string) {
  return {
    // The REAL parser, fed a REAL model JSON reply.
    extract: async () => parseTodoistWriteIntent(modelReply),
    getTimezone: async () => TZ,
    now: NOW,
    fetchProjects: fake.fetchProjects,
    fetchSections: fake.fetchSections as never,
    fetchLabels: fake.fetchLabels as never,
    fetchTasks: fake.fetchTasks as never,
    loadSelection: (u: string) => loadLatestTodoistSelection(u, store),
    loadEntityContext: (u: string) => loadTodoistEntityContext(u, store),
    createProposal: store.create as never,
    execute: executorWith(fake, store),
  };
}

async function run(): Promise<void> {
  console.log("pronoun: references are never titles (pure)");

  check("the REAL parser strips a pronoun out of targetPhrase", () => {
    // Exactly what the model returns for "Delete it".
    const intent = parseTodoistWriteIntent('{"intent":"delete","targetPhrase":"it"}');
    assert.equal(intent?.intent, "delete");
    assert.equal(intent?.targetPhrase, null, "a pronoun must never survive as a title");

    // A REAL title is preserved untouched.
    const named = parseTodoistWriteIntent('{"intent":"delete","targetPhrase":"the pitch deck"}');
    assert.equal(named?.targetPhrase, "the pitch deck");
  });

  check("reference phrases are classified; real titles are not", () => {
    for (const p of ["it", "that", "this", "them", "that task", "the one", "the last one", "the one I just reopened", "the task you just created"]) {
      assert.equal(isReferencePhrase(p), true, `"${p}" is a reference`);
    }
    for (const p of ["Finish Todoist integration test", "the deck", "Call Rob", "integration test", "pitch deck"]) {
      assert.equal(isReferencePhrase(p), false, `"${p}" is a real title`);
    }
  });

  console.log("pronoun: the exact live transcript, real resolver + real context");

  await asyncCheck("list → complete → undo → 'Delete it' proposes the RIGHT task, mutating nothing", async () => {
    const fake = new FakeTodoist([task({ id: "t2", content: "Finish Todoist integration test" })]);
    const store = new FakeProposals();

    // 1. "Show my tasks for Work" — REAL read, REAL selection context.
    const listed = await handleTodoistRead("u1", "show my tasks for Work", {
      extract: async () => ({ intent: "list", projectName: "Work" }) as never,
      getTimezone: async () => TZ,
      now: NOW,
      fetchTasks: fake.fetchTasks as never,
      fetchTasksByFilter: fake.fetchTasksByFilter as never,
      fetchProjects: fake.fetchProjects,
      fetchSections: fake.fetchSections as never,
      fetchLabels: fake.fetchLabels as never,
      recordSelection: (u, tasks) => recordTodoistSelection(u, tasks, store),
    });
    assert.match(listed.reply ?? "", /1\. Finish Todoist integration test/);

    // 2. "Complete the first one".
    await handleTodoistWrite(
      "u1",
      "complete the first one",
      realCtxDeps(fake, store, '{"intent":"complete","targetPosition":1}'),
    );
    assert.equal(fake.tasks.get("t2")?.completed, true, "completed");

    // 3. "Undo that" — REAL undo, refreshing the verified entity context.
    const undone = await handleTodoistUndo(
      "u1",
      "undo that",
      realCtxDeps(fake, store, '{"intent":"undo"}'),
    );
    assert.match(undone.reply ?? "", /Reopened “Finish Todoist integration test”/);
    assert.equal(fake.tasks.get("t2")?.completed, false, "reopened");

    // The context is genuinely persisted in the real shape.
    const ctx = await loadTodoistEntityContext("u1", store);
    assert.equal(ctx?.data.acted?.kind, "reopened");
    assert.equal(ctx?.data.acted?.task.id, "t2");

    // 4. "Delete it" — the model says targetPhrase "it"; the REAL parser + REAL
    //    resolver must reach the task via context, not a title search.
    // In production this arrives via `entityFollowup`, which dispatches with
    // `arbitrated: true` once the shared arbiter has established the conversation
    // is about a Todoist list. Mirrored here so the handler is entered exactly as
    // it is live.
    const deleted = await handleTodoistWrite("u1", "Delete it", {
      ...realCtxDeps(fake, store, '{"intent":"delete","targetPhrase":"it"}'),
      arbitrated: true,
    });

    // The live bug, pinned.
    assert.doesNotMatch(deleted.reply ?? "", /couldn’t find a task matching/);
    // 5. The proposal names the ORIGINAL task by title, and targets its real id.
    assert.match(deleted.reply ?? "", /Permanently delete “Finish Todoist integration test”\?/);
    assert.match(deleted.reply ?? "", /can’t be undone/);
    const proposal = await store.getActive("u1");
    assert.equal(proposal?.actionId, "task.delete");
    assert.deepEqual((proposal?.input as { taskIds?: string[] })?.taskIds, ["t2"]);
    // 6. ZERO provider deletes before confirmation.
    assert.equal(fake.deleteCalls(), 0, "nothing deleted before the yes");
    assert.ok(fake.tasks.has("t2"));

    // 7. "No" preserves it.
    const confirmDeps = {
      getActiveProposal: store.getActive as never,
      confirmProposal: store.confirm as never,
      rejectProposal: store.reject as never,
      finalizeProposal: store.finalize as never,
      executeAction: executorWith(fake, store),
    };
    const no = await handleActionConfirmation("u1", "No", confirmDeps);
    assert.equal(no.outcome, "cancelled");
    assert.ok(fake.tasks.has("t2"), "'No' must preserve the task");
    assert.equal(fake.deleteCalls(), 0);

    // 8. Propose again.
    await handleTodoistWrite("u1", "Delete it", {
      ...realCtxDeps(fake, store, '{"intent":"delete","targetPhrase":"it"}'),
      arbitrated: true,
    });
    assert.equal(fake.deleteCalls(), 0);

    // 9. "Yes" deletes exactly once, verified against the provider.
    const yes = await handleActionConfirmation("u1", "Yes", confirmDeps);
    assert.match(yes.reply ?? "", /Deleted “Finish Todoist integration test”/);
    assert.equal(fake.tasks.has("t2"), false, "really gone");
    assert.equal(fake.deleteCalls(), 1, "exactly one provider delete");

    // 10. A repeated "Yes" cannot delete twice.
    const again = await handleActionConfirmation("u1", "Yes", confirmDeps);
    assert.equal(again.handled, false, "no active proposal remains");
    assert.equal(fake.deleteCalls(), 1, "still exactly one");
  });

  console.log("pronoun: other reference forms");

  for (const [label, text, phrase] of [
    ["'Delete that'", "Delete that", "that"],
    ["'Delete the task I just reopened'", "Delete the task I just reopened", "the task I just reopened"],
  ] as const) {
    await asyncCheck(`${label} resolves to the verified task`, async () => {
      const fake = new FakeTodoist([task({ id: "t2", content: "Finish Todoist integration test" })]);
      const store = new FakeProposals();
      await recordActedTodoistTask(
        "u1",
        {
          task: { id: "t2", content: "Finish Todoist integration test", projectId: "p_work", dueDate: null, isRecurring: false, priority: 1, labels: [] },
          kind: "reopened",
          at: NOW.toISOString(),
        },
        store,
      );
      const result = await handleTodoistWrite("u1", text, {
        ...realCtxDeps(fake, store, JSON.stringify({ intent: "delete", targetPhrase: phrase })),
        arbitrated: true,
      });
      assert.match(result.reply ?? "", /Permanently delete “Finish Todoist integration test”\?/);
      assert.equal(fake.deleteCalls(), 0);
    });
  }

  await asyncCheck("Todoist is NEVER searched for a task literally named 'it'", async () => {
    // A real task with an unrelated name must not be reached by a title search for
    // the pronoun — and no search should happen at all.
    const fake = new FakeTodoist([task({ id: "t9", content: "Buy milk" })]);
    const store = new FakeProposals();
    await recordActedTodoistTask(
      "u1",
      {
        task: { id: "t9", content: "Buy milk", projectId: "p_work", dueDate: null, isRecurring: false, priority: 1, labels: [] },
        kind: "reopened",
        at: NOW.toISOString(),
      },
      store,
    );
    const resolution = await resolveWriteTargets(
      "u1",
      { intent: "delete", targetPhrase: "it" } as TodoistWriteIntent,
      "Delete it",
      {
        loadSelection: (u) => loadLatestTodoistSelection(u, store),
        loadEntityContext: (u) => loadTodoistEntityContext(u, store),
        fetchTasks: fake.fetchTasks as never,
      },
    );
    assert.equal(resolution.kind, "resolved");
    assert.equal(resolution.kind === "resolved" ? resolution.items[0]?.id : null, "t9");
    // The tell-tale: a title search would have listed tasks.
    assert.equal(fake.calls.includes("list"), false, "no title search for a pronoun");
  });

  await asyncCheck("no context + 'Delete it' fails closed with a clarification, mutating nothing", async () => {
    const fake = new FakeTodoist([task({ id: "t2", content: "Finish Todoist integration test" })]);
    const store = new FakeProposals();
    const result = await handleTodoistWrite(
      "u1",
      "Delete it",
      // `arbitrated` mirrors how `entityFollowup` dispatches, so the handler is
      // reached exactly as in production even with no context to resolve against.
      { ...realCtxDeps(fake, store, '{"intent":"delete","targetPhrase":"it"}'), arbitrated: true },
    );
    assert.match(result.reply ?? "", /not sure which task you mean/);
    assert.equal(fake.deleteCalls(), 0, "no mutation");
    assert.equal(await store.getActive("u1"), null, "no proposal created");
  });

  await asyncCheck("a REAL title still resolves by search", async () => {
    // The other half: dropping pronouns must not break naming a task outright.
    const fake = new FakeTodoist([
      task({ id: "t1", content: "Buy milk" }),
      task({ id: "t2", content: "Finish Todoist integration test" }),
    ]);
    const store = new FakeProposals();
    const result = await handleTodoistWrite("u1", "delete the integration test task", {
      ...realCtxDeps(fake, store, '{"intent":"delete","targetPhrase":"integration test"}'),
      arbitrated: true,
    });
    assert.match(result.reply ?? "", /Permanently delete “Finish Todoist integration test”\?/);
    assert.equal(fake.calls.includes("list"), true, "a real title DOES search");
  });

  console.log(`\npronoun: ${passed} assertions passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
