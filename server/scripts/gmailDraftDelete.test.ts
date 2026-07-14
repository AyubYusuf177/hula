import assert from "node:assert/strict";

import {
  handleActionConfirmation,
  type ConfirmationDeps,
} from "../src/actions/confirmations";
import { executeAction } from "../src/actions/executor";
import type { ActionProposalView } from "../src/actions/proposals";
import type { ActionPolicyContext } from "../src/actions/policy";
import { GmailError } from "../src/integrations/providers/gmail/client";

/**
 * Offline tests for Gmail draft DELETION through the confirmation runtime
 * (Section 17 / Phase 3.4).
 *
 * Wires the REAL confirmation orchestrator to the REAL executor, faking only the
 * database and Gmail — so this proves the halves compose, which is where a wrongly
 * deleted draft would actually come from.
 *
 * Deleting a Gmail draft is IRREVERSIBLE (Gmail does not trash it), so the
 * guarantees are the same ones the calendar writes carry: exactly-once, never on a
 * cancel, never on an expired proposal, and never claimed without a real 2xx.
 */

let passed = 0;
const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function asyncCheck(name: string, fn: () => Promise<void>): void {
  asyncChecks.push({ name, fn });
}

/** A Gmail connection holding the compose scope (what Section 16 requests). */
function composeContext(userConfirmed?: boolean): ActionPolicyContext {
  return {
    connectedProviders: ["gmail"],
    grantedScopesByProvider: {
      gmail: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
    },
    capabilitiesByProvider: {
      gmail: ["email.read", "email.draft", "email.send"],
    },
    userConfirmed,
  };
}

function deleteProposal(over: Partial<ActionProposalView> = {}): ActionProposalView {
  return {
    id: "prop_del_1",
    provider: "gmail",
    actionId: "email.deleteDraft",
    status: "proposed",
    riskLevel: "write",
    confirmationRequired: true,
    previewText: "I’ll delete the draft to Rob (“Friday”). Gmail can’t undo that — want me to go ahead?",
    input: { draftId: "d1", label: "Rob" },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    confirmedAt: null,
    rejectedAt: null,
    executedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function harness(
  over: { active?: ActionProposalView | null; onDelete?: () => Promise<void> } = {},
): {
  deps: ConfirmationDeps;
  calls: { deletes: string[]; finalized: string[] };
} {
  const calls = { deletes: [] as string[], finalized: [] as string[] };
  let claimed = false;

  const deps: ConfirmationDeps = {
    getActiveProposal: async () =>
      over.active === undefined ? deleteProposal() : over.active,
    confirmProposal: async (_u, id) => {
      // The store's atomic guarded transition: only the first caller may win.
      if (claimed) return null;
      claimed = true;
      return deleteProposal({ id, status: "confirmed" });
    },
    rejectProposal: async (_u, id) => deleteProposal({ id, status: "rejected" }),
    finalizeProposal: async (_u, _id, outcome) => {
      calls.finalized.push(outcome);
    },
    executeAction: async (userId, actionId, options) =>
      executeAction(userId, actionId, options, {
        buildContext: async (_u, o) => composeContext(o.userConfirmed),
        record: async () => "exec_1",
        deleteGmailDraft: async (_u, draftId) => {
          calls.deletes.push(draftId);
          if (over.onDelete) await over.onDelete();
        },
      }),
  };
  return { deps, calls };
}

asyncCheck("confirm: 'yes' deletes exactly the previewed draft, once", async () => {
  const { deps, calls } = harness();
  const r = await handleActionConfirmation("u", "yes", deps);
  assert.equal(r.outcome, "confirmed");
  assert.deepEqual(calls.deletes, ["d1"]);
  assert.deepEqual(calls.finalized, ["executed"]);
  assert.ok(/Deleted the draft to Rob/.test(r.reply ?? ""), r.reply);
});

asyncCheck("cancel: 'no' leaves the Gmail draft completely untouched", async () => {
  // THE distinction from the brief: cancelling a pending action must never be the
  // same thing as deleting the user's draft.
  const { deps, calls } = harness();
  const r = await handleActionConfirmation("u", "no", deps);
  assert.equal(r.outcome, "cancelled");
  assert.equal(calls.deletes.length, 0, "a cancellation must NEVER delete a draft");
  assert.ok(/cancelled/i.test(r.reply ?? ""));
});

asyncCheck("cancel: every cancellation phrase spares the draft", async () => {
  for (const phrase of ["no", "cancel", "never mind", "leave it", "forget it", "stop"]) {
    const { deps, calls } = harness();
    const r = await handleActionConfirmation("u", phrase, deps);
    assert.equal(r.outcome, "cancelled", `${phrase} must cancel`);
    assert.equal(calls.deletes.length, 0, `${phrase} must not delete`);
  }
});

asyncCheck("idempotency: a repeated 'yes' cannot delete twice", async () => {
  const { deps, calls } = harness();
  await handleActionConfirmation("u", "yes", deps);
  const second = await handleActionConfirmation("u", "yes", deps);
  assert.deepEqual(calls.deletes, ["d1"], "a second confirmation must not delete again");
  assert.ok(/already been handled/i.test(second.reply ?? ""));
});

asyncCheck("idempotency: concurrent confirmations delete once", async () => {
  const { deps, calls } = harness();
  await Promise.all([
    handleActionConfirmation("u", "yes", deps),
    handleActionConfirmation("u", "do it", deps),
  ]);
  assert.equal(calls.deletes.length, 1);
});

asyncCheck("expiry: an expired proposal never deletes", async () => {
  const { deps, calls } = harness({ active: null });
  const r = await handleActionConfirmation("u", "yes", deps);
  assert.equal(r.handled, false, "a stale yes must fall through");
  assert.equal(calls.deletes.length, 0);
});

asyncCheck("honesty: a failed provider delete is never reported as deleted", async () => {
  const { deps, calls } = harness({
    onDelete: async () => {
      throw new GmailError("provider_unavailable", "boom", 503);
    },
  });
  const r = await handleActionConfirmation("u", "yes", deps);
  assert.deepEqual(calls.finalized, ["failed"]);
  assert.ok(!/Deleted the draft/i.test(r.reply ?? ""), `must not claim deletion: ${r.reply}`);
});

asyncCheck("honesty: a draft already gone reports that, not a deletion", async () => {
  const { deps } = harness({
    onDelete: async () => {
      throw new GmailError("mailbox_not_found", "gone", 404);
    },
  });
  const r = await handleActionConfirmation("u", "yes", deps);
  assert.ok(/isn’t in your Gmail anymore/i.test(r.reply ?? ""), r.reply);
  // The copy may mention the draft "may have been deleted already" — that is a
  // statement about Gmail's state, not a claim that WE performed the deletion.
  // What must never appear is our own success line.
  assert.ok(!/Deleted the draft/i.test(r.reply ?? ""), `must not claim we deleted it: ${r.reply}`);
});

asyncCheck("scope: a read-only Gmail connection cannot delete a draft", async () => {
  let called = false;
  const deps: ConfirmationDeps = {
    getActiveProposal: async () => deleteProposal(),
    confirmProposal: async (_u, id) => deleteProposal({ id, status: "confirmed" }),
    rejectProposal: async (_u, id) => deleteProposal({ id, status: "rejected" }),
    finalizeProposal: async () => {},
    executeAction: async (userId, actionId, options) =>
      executeAction(userId, actionId, options, {
        buildContext: async () => ({
          connectedProviders: ["gmail"],
          grantedScopesByProvider: {
            gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
          },
          capabilitiesByProvider: { gmail: ["email.read"] },
          userConfirmed: true,
        }),
        record: async () => "exec_ro",
        deleteGmailDraft: async () => {
          called = true;
        },
      }),
  };
  const r = await handleActionConfirmation("u", "yes", deps);
  assert.equal(called, false, "a read-only connection must never reach Gmail");
  assert.ok(!/Deleted the draft/i.test(r.reply ?? ""));
});

asyncCheck("safety: no reply leaks token material", async () => {
  const { deps } = harness();
  const r = await handleActionConfirmation("u", "yes", deps);
  assert.ok(!/Bearer|ya29\.|access_token|refresh_token/i.test(JSON.stringify(r)));
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} Gmail draft delete confirmation (Section 17) tests passed.`);
}

void run().catch((err) => {
  console.error(
    "Gmail draft delete tests failed:",
    err instanceof Error ? err.message : "unknown error",
  );
  process.exitCode = 1;
});
