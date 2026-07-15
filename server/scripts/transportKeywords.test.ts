import assert from "node:assert/strict";

import { PENDING_PROPOSAL_REPROMPT, classifyConfirmationReply, handleActionConfirmation } from "../src/actions/confirmations";
import { CONFIRM_INSTRUCTION } from "../src/actions/confirmationCopy";
import {
  CARRIER_OPT_OUT_KEYWORDS,
  OPT_IN_ACKNOWLEDGEMENT,
  classifyTransportKeyword,
  handleTransportKeyword,
} from "../src/channels/transportKeywords";
import { routeInboundText, inboundHandlerOrder } from "../src/routes/inboundRouting";
import { buildPreview } from "../src/integrations/providers/todoist/todoistActions";

/**
 * Carrier/transport keyword + confirmation-copy tests — OFFLINE.
 *
 * These encode a REAL DEVICE INCIDENT, end to end:
 *
 *   1. Hula asked for a Calendar confirmation and told the user to reply "cancel".
 *   2. The user replied "Cancel". The backend correctly cancelled the proposal, but
 *      Sendblue read the word as a CARRIER OPT-OUT and blocked Hula's reply
 *      (402 / OPTED_OUT / SpamRule). The user saw silence.
 *   3. The user sent "START" to restore delivery. START reached the general brain,
 *      which replied: "Cancelled — no worries. Both tasks left as they were."
 *      No such tasks existed. It was a fabrication.
 *
 * Every assertion below exists to keep one link of that chain broken.
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

/** Every handler declines, so anything unclaimed would reach the brain. */
function allDecline() {
  const decline = async () => ({ handled: false as const });
  return {
    entityFollowup: decline,
    memory: decline,
    reminder: decline,
    confirmation: decline,
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
  };
}

async function run(): Promise<void> {
  console.log("transport keywords: classification");

  check("START and UNSTOP are recognised, case- and punctuation-insensitively", () => {
    for (const text of ["START", "start", "Start", " start ", "start.", "UNSTOP", "unstop!"]) {
      assert.equal(classifyTransportKeyword(text), "opt_in", `"${text}" must be an opt-in`);
    }
  });

  check("only a STANDALONE keyword counts — real requests are untouched", () => {
    // The safety property: a greedy match here would silently swallow ordinary
    // messages and answer them with a reconnection notice.
    for (const text of [
      "start the report task",
      "add a task to start the pitch deck",
      "unstop the pipeline",
      "when does the meeting start",
      "restart my subscription",
      "what do I need to do today",
      "",
      "   ",
    ]) {
      assert.equal(classifyTransportKeyword(text), "none", `"${text}" must NOT be an opt-in`);
    }
  });

  check("the acknowledgement asserts nothing about the user's data", () => {
    // The whole point: there is no version of this string that can be false.
    assert.equal(OPT_IN_ACKNOWLEDGEMENT, "You’re reconnected to Hula.");
    for (const forbidden of [/task/i, /event/i, /email/i, /reminder/i, /cancel/i, /left as they were/i]) {
      assert.doesNotMatch(OPT_IN_ACKNOWLEDGEMENT, forbidden);
    }
  });

  await asyncCheck("the handler answers an opt-in and declines everything else", async () => {
    const optIn = await handleTransportKeyword("u1", "START");
    assert.equal(optIn.handled, true);
    assert.equal(optIn.reply, OPT_IN_ACKNOWLEDGEMENT);

    const ordinary = await handleTransportKeyword("u1", "what tasks are overdue");
    assert.equal(ordinary.handled, false);
    assert.equal(ordinary.reply, undefined);
  });

  console.log("transport keywords: routing");

  check("transportKeyword is FIRST in the cascade", () => {
    // Order is the contract. Anything above it could interpret a carrier command.
    assert.equal(inboundHandlerOrder()[0], "transportKeyword");
  });

  await asyncCheck("START never reaches the brain, even with every handler declining", async () => {
    // This is the exact shape of the live bug: nothing claimed START, so it fell
    // through to the brain, which invented an operational success.
    for (const keyword of ["START", "start", "UNSTOP"]) {
      const routed = await routeInboundText("u1", keyword, allDecline());
      assert.ok(routed, `"${keyword}" must be claimed, never returned as null (null = brain)`);
      assert.equal(routed.source, "transportKeyword");
      assert.equal(routed.reply, OPT_IN_ACKNOWLEDGEMENT);
    }
  });

  await asyncCheck("START never claims a provider action, whatever else is pending", async () => {
    // Reproduces the transcript: a proposal had just been cancelled, and a pending
    // re-prompt / brain fallback was standing by. START must still say only the
    // neutral line — it must not be answered by ANY content handler.
    const deps = allDecline();
    const routed = await routeInboundText("u1", "START", {
      ...deps,
      // If routing were wrong, each of these would happily claim it.
      confirmation: async () => ({ handled: true, reply: "Okay, I’ve cancelled that." }),
      todoistRead: async () => ({ handled: true, reply: "1. Some task" }),
      pendingReprompt: async () => ({ handled: true, reply: PENDING_PROPOSAL_REPROMPT }),
    });
    assert.equal(routed?.source, "transportKeyword");
    assert.equal(routed?.reply, OPT_IN_ACKNOWLEDGEMENT);
    // The precise fabrication from the real transcript.
    assert.doesNotMatch(routed?.reply ?? "", /left as they were/i);
    assert.doesNotMatch(routed?.reply ?? "", /cancelled/i);
  });

  await asyncCheck("a message merely CONTAINING 'start' still routes normally", async () => {
    const routed = await routeInboundText("u1", "add a task to start the pitch deck", {
      ...allDecline(),
      todoistWrite: async () => ({ handled: true, reply: "Added “start the pitch deck”." }),
    });
    assert.equal(routed?.source, "todoistWrite", "must not be swallowed as a carrier keyword");
  });

  console.log("transport keywords: confirmation copy");

  check("Hula never instructs the user to reply with a carrier opt-out word", () => {
    // The instruction that caused the incident. "Cancel" is a carrier opt-out
    // keyword — telling users to send it opts them out of their own delivery.
    assert.equal(CONFIRM_INSTRUCTION, "Reply Yes to confirm or No to cancel.");
    const instructed = CONFIRM_INSTRUCTION.toLowerCase();
    for (const keyword of CARRIER_OPT_OUT_KEYWORDS) {
      // "cancel" may appear as a WORD ("...or No to cancel") but must never be
      // presented as the thing to REPLY with.
      assert.doesNotMatch(
        instructed,
        new RegExp(`reply\\s+["'‘“]?${keyword}\\b`),
        `must not instruct replying "${keyword}"`,
      );
      assert.doesNotMatch(
        instructed,
        new RegExp(`["'‘“]${keyword}["'’”]\\s+to\\s+(stop|cancel)`),
        `must not offer "${keyword}" as the stop word`,
      );
    }
  });

  check("the pending re-prompt uses the safe instruction", () => {
    assert.match(PENDING_PROPOSAL_REPROMPT, /Reply Yes to confirm or No to cancel\./);
    assert.doesNotMatch(PENDING_PROPOSAL_REPROMPT, /‘cancel’ to stop/);
    assert.doesNotMatch(PENDING_PROPOSAL_REPROMPT, /send it’ to continue/);
  });

  check("Todoist previews use the safe instruction, including the delete preview", () => {
    const items = [
      { id: "a", content: "A", projectId: null, dueDate: null, isRecurring: false, priority: 1, labels: [] },
    ];
    const del = buildPreview("task.delete", items);
    assert.match(del, /Reply Yes to confirm or No to cancel\./);
    // The permanence warning must survive the copy change.
    assert.match(del, /can’t be undone/);
    assert.doesNotMatch(del, /“cancel” to stop/);

    const bulk = buildPreview("task.complete", [...items, { ...items[0]!, id: "b", content: "B" }]);
    assert.match(bulk, /Reply Yes to confirm or No to cancel\./);
  });

  console.log("transport keywords: cancellation still works");

  check("'No' cancels — the word Hula now advertises", () => {
    for (const text of ["no", "No", "NO", "nope", "nah", "no thanks"]) {
      assert.equal(classifyConfirmationReply(text), "cancel", `"${text}" must cancel`);
    }
  });

  check("'Cancel' STILL cancels, even though Hula no longer asks for it", () => {
    // Deliberately unchanged. A user who types it means stop; the carrier will
    // swallow our reply, but abandoning the pending write is still correct — far
    // better than leaving it armed because the word was also meaningful to Sendblue.
    for (const text of ["cancel", "Cancel", "cancel that", "stop"]) {
      assert.equal(classifyConfirmationReply(text), "cancel", `"${text}" must still cancel`);
    }
  });

  check("'Yes' still confirms", () => {
    for (const text of ["yes", "Yes", "yep", "go ahead", "do it"]) {
      assert.equal(classifyConfirmationReply(text), "confirm", `"${text}" must confirm`);
    }
  });

  await asyncCheck("'No' cancels a pending proposal and never executes it", async () => {
    let executed = false;
    const proposal = {
      id: "pr_1",
      provider: "todoist",
      actionId: "task.delete",
      status: "proposed" as const,
      riskLevel: "write",
      confirmationRequired: true,
      previewText: `Permanently delete “Alpha”? ${CONFIRM_INSTRUCTION}`,
      input: { taskIds: ["t1"] },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      confirmedAt: null,
      rejectedAt: null,
      executedAt: null,
      createdAt: new Date().toISOString(),
    };
    let rejected = false;
    const result = await handleActionConfirmation("u1", "No", {
      getActiveProposal: async () => (rejected ? null : proposal),
      rejectProposal: async () => {
        rejected = true;
        return { ...proposal, status: "rejected" as const };
      },
      confirmProposal: async () => {
        throw new Error("‘No’ must never confirm");
      },
      finalizeProposal: async () => {},
      executeAction: async () => {
        executed = true;
        throw new Error("‘No’ must never execute");
      },
    });
    assert.equal(result.handled, true);
    assert.equal(result.outcome, "cancelled");
    assert.equal(executed, false);
    assert.equal(rejected, true);
  });

  console.log(`\ntransport keywords: ${passed} assertions passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
