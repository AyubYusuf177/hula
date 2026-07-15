import assert from "node:assert/strict";

import { handleActionConfirmation } from "../src/actions/confirmations";
import {
  DELETE_CONFIRM_ATTEMPTS,
  TODOIST_EXEC_REPLIES,
  confirmTodoistDeletion,
  executeAction,
} from "../src/actions/executor";
import type { ActionProposalView, CreateProposalInput } from "../src/actions/proposals";
import { TodoistError } from "../src/integrations/providers/todoist/client";
import {
  TODOIST_DELETE_SUCCESS_STATUSES,
  validateDeleteStatus,
} from "../src/integrations/providers/todoist/tasks";
import type { NormalizedTodoistTask } from "../src/integrations/providers/todoist/types";

/**
 * Todoist DELETE receipt + postcondition-verification tests — OFFLINE.
 *
 * THE LIVE FAILURE THESE ENCODE.
 *
 *   13:55:37  user confirms the delete
 *   13:55:43  Hula replies that verification said the change had not taken effect
 *   13:59:23  a real Todoist read returns "No tasks in Work"
 *
 * The deletion had SUCCEEDED. Todoist returned a documented DELETE success, then
 * — within the same six-second reply — still served the task from
 * `GET /tasks/{id}`. The verifier did one immediate read, saw the task, and
 * declared the delete failed. It was reading a stale replica and calling it
 * evidence.
 *
 * The rule these tests pin: a VALIDATED DELETE RECEIPT is authoritative, and a
 * read-back may only ever CONFIRM it — never overturn it. The DELETE itself is
 * executed exactly once, whatever any read says.
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

const TASK: NormalizedTodoistTask = {
  id: "t2",
  content: "Finish Todoist integration test",
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
};

/**
 * A Todoist whose DELETE succeeds but whose reads lag — the live condition.
 *
 * `staleReads` is how many absence checks still return the task AFTER the delete
 * has genuinely been applied. That is exactly what a read-after-write replica lag
 * looks like from the outside.
 */
class LaggyTodoist {
  calls: string[] = [];
  deleted = false;
  constructor(
    private staleReads: number,
    private opts: { deleteStatus?: number; deleteThrows?: TodoistError } = {},
  ) {}

  deleteTask = async (_u: string, id: string) => {
    this.calls.push(`delete:${id}`);
    if (this.opts.deleteThrows) throw this.opts.deleteThrows;
    const status = this.opts.deleteStatus ?? 200;
    if (!TODOIST_DELETE_SUCCESS_STATUSES.has(status)) {
      // Mirrors the real `deleteTask`'s validation of an unexpected 2xx.
      throw new TodoistError("malformed_provider_response", "Todoist did not confirm the deletion", status);
    }
    this.deleted = true;
    return { httpStatus: status };
  };

  fetchTask = async (_u: string, id: string): Promise<NormalizedTodoistTask> => {
    this.calls.push(`get:${id}`);
    // Before the delete, or while a replica is still stale, the task is visible.
    if (!this.deleted || this.staleReads-- > 0) return { ...TASK };
    throw new TodoistError("task_not_found", "gone", 404);
  };

  deleteCalls(): number {
    return this.calls.filter((c) => c.startsWith("delete:")).length;
  }
}

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
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      confirmedAt: null,
      rejectedAt: null,
      executedAt: null,
      createdAt: new Date().toISOString(),
    });
    return { id };
  };
  getActive = async (userId: string) =>
    this.rows.find((r) => r.userId === userId && r.status === "proposed" && r.confirmationRequired) ?? null;
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

/** The REAL executor, wired to a laggy provider. `sleep` is a no-op in tests. */
function executorWith(fake: LaggyTodoist) {
  return (userId: string, actionId: string, options: Record<string, unknown>) =>
    executeAction(userId, actionId, options as never, {
      buildContext: async (_u, o) => ({
        connectedProviders: ["todoist"],
        grantedScopesByProvider: { todoist: ["data:read_write", "data:delete"] },
        capabilitiesByProvider: { todoist: ["tasks.read", "tasks.write", "tasks.delete"] },
        userConfirmed: o.userConfirmed,
      }),
      record: async () => "exec_1",
      deleteTodoistTask: fake.deleteTask as never,
      fetchTodoistTask: fake.fetchTask,
      recordActedTodoistTask: async () => ({ id: "ctx" }),
      // Exercises the REAL bounded-backoff code path without spending real time.
      sleep: async () => {},
    });
}

const runDelete = (fake: LaggyTodoist) =>
  executorWith(fake)("u1", "task.delete", {
    input: { taskIds: ["t2"], label: TASK.content },
    userConfirmed: true,
  });

async function run(): Promise<void> {
  console.log("delete: the documented success contract");

  check("only Todoist's DOCUMENTED success statuses count as a receipt", () => {
    // The official OpenAPI document lists 200 for DELETE /api/v1/tasks/{task_id};
    // 204 is the conventional bodyless-delete answer.
    assert.equal(TODOIST_DELETE_SUCCESS_STATUSES.has(200), true);
    assert.equal(TODOIST_DELETE_SUCCESS_STATUSES.has(204), true);
    // 202 means "queued", NOT "done" — it must never be reported as a deletion.
    assert.equal(TODOIST_DELETE_SUCCESS_STATUSES.has(202), false);
    assert.equal(TODOIST_DELETE_SUCCESS_STATUSES.has(200 + 1), false);
  });

  check("a documented success status becomes a validated receipt", () => {
    // The REAL production validation, called directly — no DB, no transport.
    for (const status of [200, 204]) {
      assert.deepEqual(validateDeleteStatus(status), { httpStatus: status });
    }
  });

  check("an unexpected 2xx is REFUSED rather than assumed to be a deletion", () => {
    // 202 Accepted means the provider took it, not that it did it. Any non-2xx
    // already throws in the client, so an unexpected 2xx is the case this catches.
    for (const status of [202, 201, 299]) {
      assert.throws(
        () => validateDeleteStatus(status),
        (err: TodoistError) =>
          err.reason === "malformed_provider_response" && err.httpStatus === status,
        `${status} must not be a receipt`,
      );
    }
  });

  console.log("delete: bounded confirmation never overturns the receipt");

  await asyncCheck("an immediately-absent read confirms on the first attempt", async () => {
    const fake = new LaggyTodoist(0);
    await fake.deleteTask("u1", "t2");
    const confirmation = await confirmTodoistDeletion("u1", "t2", fake.fetchTask, async () => {});
    assert.equal(confirmation, "absent");
    // One read — no pointless backoff when the answer is already definitive.
    assert.equal(fake.calls.filter((c) => c.startsWith("get:")).length, 1);
  });

  await asyncCheck("a stale read then absence confirms within the bound", async () => {
    const fake = new LaggyTodoist(1); // first check stale, second definitive
    await fake.deleteTask("u1", "t2");
    const confirmation = await confirmTodoistDeletion("u1", "t2", fake.fetchTask, async () => {});
    assert.equal(confirmation, "absent");
    assert.equal(fake.calls.filter((c) => c.startsWith("get:")).length, 2);
  });

  await asyncCheck("the confirmation loop is BOUNDED and never re-deletes", async () => {
    const fake = new LaggyTodoist(Number.MAX_SAFE_INTEGER); // never catches up
    await fake.deleteTask("u1", "t2");
    const confirmation = await confirmTodoistDeletion("u1", "t2", fake.fetchTask, async () => {});
    assert.equal(confirmation, "still_visible");
    assert.equal(
      fake.calls.filter((c) => c.startsWith("get:")).length,
      DELETE_CONFIRM_ATTEMPTS,
      "bounded — it cannot loop forever inside an iMessage round-trip",
    );
    assert.equal(fake.deleteCalls(), 1, "the DELETE is never repeated by the checker");
  });

  await asyncCheck("a failing CHECK is 'unknown' and stops — it proves nothing", async () => {
    const fake = new LaggyTodoist(0);
    await fake.deleteTask("u1", "t2");
    let reads = 0;
    const brokenRead = async () => {
      reads += 1;
      throw new TodoistError("todoist_timeout", "read timed out");
    };
    const confirmation = await confirmTodoistDeletion("u1", "t2", brokenRead as never, async () => {});
    assert.equal(confirmation, "unknown");
    assert.equal(reads, 1, "retrying a broken read helps no one");
  });

  console.log("delete: end-to-end outcomes");

  await asyncCheck("REQUIRED 1: success receipt + immediate stale read + later absence → success, one DELETE", async () => {
    // The exact live sequence: the delete lands, the first read lags, a later read
    // confirms. This previously reported "it hadn't taken effect".
    const fake = new LaggyTodoist(1);
    const result = await runDelete(fake);
    assert.equal(result.ok, true);
    assert.match(result.userMessage, /Deleted “Finish Todoist integration test”/);
    assert.doesNotMatch(result.userMessage, /hadn’t taken effect/);
    assert.equal(fake.deleteCalls(), 1, "exactly one DELETE");
    assert.deepEqual(result.receipt?.taskIds, ["t2"]);
  });

  await asyncCheck("REQUIRED 2: success receipt + EVERY read stale → still success, one DELETE", async () => {
    const fake = new LaggyTodoist(Number.MAX_SAFE_INTEGER);
    const result = await runDelete(fake);
    // The authoritative receipt stands. A stale replica cannot make it untrue.
    assert.equal(result.ok, true);
    assert.match(result.userMessage, /Deleted “Finish Todoist integration test”/);
    assert.equal(fake.deleteCalls(), 1, "never a second DELETE");
  });

  await asyncCheck("REQUIRED 3: an unexpected DELETE status is a FAILURE, not a deletion", async () => {
    const fake = new LaggyTodoist(0, { deleteStatus: 202 });
    const result = await runDelete(fake);
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.userMessage, /^Deleted/);
    assert.equal(fake.deleteCalls(), 1, "not retried");
  });

  await asyncCheck("REQUIRED 4: a transport timeout is honest UNCERTAINTY, never a claim", async () => {
    const fake = new LaggyTodoist(0, {
      deleteThrows: new TodoistError("todoist_timeout", "no validated response"),
    });
    const result = await runDelete(fake);
    assert.equal(result.ok, false);
    // It must claim NEITHER outcome, and must not invite a repeat of a
    // destructive write whose result is unknown.
    assert.equal(result.userMessage, TODOIST_EXEC_REPLIES.deleteUncertain);
    assert.doesNotMatch(result.userMessage, /^Deleted/);
    assert.doesNotMatch(result.userMessage, /trying again in a bit/);
    assert.equal(fake.deleteCalls(), 1, "an unknown-outcome DELETE is never retried");
  });

  await asyncCheck("REQUIRED 5: a definitive provider failure is a failure", async () => {
    const fake = new LaggyTodoist(0, {
      deleteThrows: new TodoistError("insufficient_scope", "no delete permission", 403),
    });
    const result = await runDelete(fake);
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.userMessage, /^Deleted/);
    // A definitive rejection means nothing happened — so it is NOT "uncertain".
    assert.notEqual(result.userMessage, TODOIST_EXEC_REPLIES.deleteUncertain);
    assert.match(result.userMessage, /reconnect Todoist/i);
  });

  await asyncCheck("a task already gone is the requested end state, with no DELETE at all", async () => {
    const fake = new LaggyTodoist(0);
    fake.deleted = true; // someone deleted it in the Todoist app first
    const result = await runDelete(fake);
    assert.equal(result.ok, true);
    assert.equal(fake.deleteCalls(), 0, "nothing to delete");
  });

  console.log("delete: confirmation + idempotency");

  await asyncCheck("REQUIRED 6: a repeated 'Yes' cannot trigger a second DELETE", async () => {
    const fake = new LaggyTodoist(1); // stale first read, as live
    const store = new FakeProposals();
    await store.create("u1", {
      provider: "todoist",
      actionId: "task.delete",
      riskLevel: "write",
      confirmationRequired: true,
      input: { taskIds: ["t2"], label: TASK.content },
      previewText: "Permanently delete …?",
    });
    const deps = {
      getActiveProposal: store.getActive as never,
      confirmProposal: store.confirm as never,
      rejectProposal: store.reject as never,
      finalizeProposal: store.finalize as never,
      executeAction: executorWith(fake) as never,
    };
    const first = await handleActionConfirmation("u1", "Yes", deps);
    assert.match(first.reply ?? "", /Deleted “Finish Todoist integration test”/);
    assert.equal(fake.deleteCalls(), 1);

    // A duplicate Sendblue delivery of the same "Yes".
    const second = await handleActionConfirmation("u1", "Yes", deps);
    assert.equal(second.handled, false, "no active proposal remains");
    assert.equal(fake.deleteCalls(), 1, "still exactly one DELETE");
  });

  await asyncCheck("REQUIRED 7: 'No' cancels with ZERO delete calls", async () => {
    const fake = new LaggyTodoist(0);
    const store = new FakeProposals();
    await store.create("u1", {
      provider: "todoist",
      actionId: "task.delete",
      riskLevel: "write",
      confirmationRequired: true,
      input: { taskIds: ["t2"], label: TASK.content },
      previewText: "Permanently delete …?",
    });
    const no = await handleActionConfirmation("u1", "No", {
      getActiveProposal: store.getActive as never,
      confirmProposal: store.confirm as never,
      rejectProposal: store.reject as never,
      finalizeProposal: store.finalize as never,
      executeAction: executorWith(fake) as never,
    });
    assert.equal(no.outcome, "cancelled");
    assert.equal(fake.deleteCalls(), 0, "cancel must never delete");
  });

  console.log(`\ndelete verification: ${passed} assertions passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
