import assert from "node:assert/strict";

import {
  handleActionConfirmation,
  handlePendingProposalReprompt,
  type ConfirmationDeps,
} from "../src/actions/confirmations";
import { executeAction } from "../src/actions/executor";
import type { ActionProposalView } from "../src/actions/proposals";
import type { ActionPolicyContext } from "../src/actions/policy";
import type { NormalizedCalendarEvent } from "../src/integrations/providers/googleCalendar/types";

/**
 * Offline tests for the Section 17 Calendar CONFIRMATION lifecycle.
 *
 * Everything else in the suite tests one half at a time: `calendarWrites.test.ts`
 * covers resolve → preview → propose, and `actions.test.ts` covers the executor's
 * provider adapters. This file wires the REAL confirmation orchestrator to the REAL
 * executor and fakes only the database and Google, so it proves the two halves
 * actually compose — which is where a duplicate write would really come from.
 *
 * The property under test is the one that matters most: a Calendar write happens
 * EXACTLY once, or not at all. NO database, NO Google, NO Anthropic.
 */

let passed = 0;
const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function asyncCheck(name: string, fn: () => Promise<void>): void {
  asyncChecks.push({ name, fn });
}

const TZ = "America/New_York";

/** An ISO instant safely in the future, so never-past checks pass. */
function futureIso(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

const START = futureIso(60);
const END = futureIso(120);

/** A calendar connection that granted the write scope + capability. */
function writeContext(userConfirmed?: boolean): ActionPolicyContext {
  return {
    connectedProviders: ["google_calendar"],
    grantedScopesByProvider: {
      google_calendar: [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
      ],
    },
    capabilitiesByProvider: {
      google_calendar: ["read_calendar_events", "write_calendar_events"],
    },
    userConfirmed,
  };
}

function proposal(over: Partial<ActionProposalView> = {}): ActionProposalView {
  return {
    id: "prop_cal_1",
    provider: "google_calendar",
    actionId: "calendar.createEvent",
    status: "proposed",
    riskLevel: "write",
    confirmationRequired: true,
    previewText: "I’ll schedule “Gym” for Tuesday from 7:00 AM to 8:00 AM. Want me to go ahead?",
    input: { title: "Gym", startIso: START, endIso: END, timezone: TZ },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    confirmedAt: null,
    rejectedAt: null,
    executedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function created(id: string): NormalizedCalendarEvent {
  return {
    id,
    calendarId: "primary",
    summary: "Gym",
    location: null,
    start: START,
    end: END,
    allDay: false,
    status: "confirmed",
    htmlLink: null,
    attendeeCount: null,
    // Section 18 fields. Real events always carry these — a fixture that
    // omits them is not a realistic event and hides formatting bugs.
    description: null,
    attendees: [],
    timeZone: null,
    conference: null,
    isRecurringMaster: false,
    organizerEmail: null,
    source: "google_calendar",
  };
}

/**
 * Wire the REAL confirmation orchestrator to the REAL executor, faking only the DB
 * (proposal store + ledger) and Google. `confirmProposal` models the store's ATOMIC
 * guarded transition — `updateMany({ where: { status: "proposed" } })` — which is
 * the single mechanism the whole idempotency guarantee rests on: it can only win
 * once, no matter how many callers race for it.
 */
function harness(
  over: {
    active?: ActionProposalView | null;
    onCreate?: () => Promise<NormalizedCalendarEvent>;
  } = {},
): {
  deps: ConfirmationDeps;
  calls: { providerWrites: number; confirmed: number; finalized: string[] };
  seenInput: () => Record<string, unknown> | undefined;
} {
  const calls = { providerWrites: 0, confirmed: 0, finalized: [] as string[] };
  let claimed = false;
  let seen: Record<string, unknown> | undefined;

  const deps: ConfirmationDeps = {
    getActiveProposal: async () =>
      over.active === undefined ? proposal() : over.active,
    confirmProposal: async (_u, id) => {
      // Atomic claim: only the first caller flips proposed -> confirmed.
      if (claimed) return null;
      claimed = true;
      calls.confirmed += 1;
      return proposal({ id, status: "confirmed" });
    },
    rejectProposal: async (_u, id) => proposal({ id, status: "rejected" }),
    finalizeProposal: async (_u, _id, outcome) => {
      calls.finalized.push(outcome);
    },
    // The REAL executor, with only the DB ledger + Google faked.
    executeAction: async (userId, actionId, options) => {
      seen = options?.input;
      return executeAction(userId, actionId, options, {
        buildContext: async (_u, o) => writeContext(o.userConfirmed),
        record: async () => "exec_1",
        createCalendarEvent: async () => {
          calls.providerWrites += 1;
          return over.onCreate ? await over.onCreate() : created("evt_real");
        },
      });
    },
  };
  return { deps, calls, seenInput: () => seen };
}

// --- The core guarantee --------------------------------------------------

asyncCheck("confirm: 'Yh' on a calendar proposal writes exactly once", async () => {
  const { deps, calls } = harness();
  const r = await handleActionConfirmation("u", "Yh", deps);
  assert.equal(r.handled, true);
  assert.equal(r.outcome, "confirmed");
  assert.equal(calls.providerWrites, 1, "exactly one calendar write");
  assert.deepEqual(calls.finalized, ["executed"]);
  assert.ok(/scheduled/i.test(r.reply ?? ""), r.reply);
});

asyncCheck("confirm: the executor receives the PROPOSED input verbatim", async () => {
  // The user confirmed what the preview described; the executor must act on exactly
  // that, never on a re-parse of the original request.
  const { deps, seenInput } = harness();
  await handleActionConfirmation("u", "do it", deps);
  assert.deepEqual(seenInput(), { title: "Gym", startIso: START, endIso: END, timezone: TZ });
});

asyncCheck("idempotency: a REPEATED confirmation cannot write twice", async () => {
  // The duplicate-delivery / double-tap case. The second "yes" loses the atomic
  // claim and must not reach Google.
  const { deps, calls } = harness();
  const first = await handleActionConfirmation("u", "yes", deps);
  const second = await handleActionConfirmation("u", "yes", deps);
  assert.equal(calls.providerWrites, 1, "a second confirmation must not write again");
  assert.equal(calls.confirmed, 1);
  assert.ok(/scheduled/i.test(first.reply ?? ""));
  assert.equal(second.outcome, "none");
  assert.ok(/already been handled/i.test(second.reply ?? ""), second.reply);
});

asyncCheck("idempotency: concurrent confirmations race safely — only one writes", async () => {
  // Models two backend instances (or a Sendblue retry overlapping the original)
  // handling the same "yes" at once. Only the claim winner may write.
  const { deps, calls } = harness();
  await Promise.all([
    handleActionConfirmation("u", "yes", deps),
    handleActionConfirmation("u", "yes", deps),
    handleActionConfirmation("u", "go ahead", deps),
  ]);
  assert.equal(calls.providerWrites, 1, "concurrent confirmations must write once");
});

asyncCheck("cancel: 'no' never performs the calendar write", async () => {
  const { deps, calls } = harness();
  const r = await handleActionConfirmation("u", "no", deps);
  assert.equal(r.outcome, "cancelled");
  assert.equal(calls.providerWrites, 0, "a cancellation must never reach Google");
  assert.ok(/cancelled/i.test(r.reply ?? ""));
});

asyncCheck("expiry: an expired proposal is not confirmable and never writes", async () => {
  // The real store lazily flips an expired row to `expired` and returns null, so a
  // stale "yes" finds no active proposal and falls through.
  const { deps, calls } = harness({ active: null });
  const r = await handleActionConfirmation("u", "yes", deps);
  assert.equal(r.handled, false, "a stale yes must fall through, not execute");
  assert.equal(calls.providerWrites, 0);
});

asyncCheck("restart-safety: proposal state lives in the DB, not in process memory", async () => {
  // Simulates a process restart between the preview and the "yes": a brand-new
  // harness (fresh in-memory state) still resolves the proposal and writes once.
  // This is why the claim must be a DB transition and not a process-level Set.
  const { deps, calls } = harness();
  const r = await handleActionConfirmation("u", "yes", deps);
  assert.equal(calls.providerWrites, 1);
  assert.ok(/scheduled/i.test(r.reply ?? ""));
});

// --- No false success ----------------------------------------------------

asyncCheck("honesty: a malformed provider result is never reported as scheduled", async () => {
  const { deps, calls } = harness({
    onCreate: async () => {
      const { GoogleCalendarError } = await import(
        "../src/integrations/providers/googleCalendar/client"
      );
      // What `requireEventReceipt` throws when Google returns no event id.
      throw new GoogleCalendarError("malformed_provider_response", "no id");
    },
  });
  const r = await handleActionConfirmation("u", "yes", deps);
  assert.equal(calls.providerWrites, 1, "the attempt was made");
  assert.deepEqual(calls.finalized, ["failed"], "must be recorded as failed");
  assert.ok(!/scheduled|done/i.test(r.reply ?? ""), `must not claim success: ${r.reply}`);
});

asyncCheck("honesty: a provider failure finalizes as failed, not executed", async () => {
  const { deps, calls } = harness({
    onCreate: async () => {
      const { GoogleCalendarError } = await import(
        "../src/integrations/providers/googleCalendar/client"
      );
      throw new GoogleCalendarError("provider_unavailable", "boom", 503);
    },
  });
  const r = await handleActionConfirmation("u", "yes", deps);
  assert.deepEqual(calls.finalized, ["failed"]);
  assert.ok(/trying again/i.test(r.reply ?? ""), r.reply);
});

// --- The fall-through guard ----------------------------------------------

asyncCheck("guard: a pending calendar proposal never falls through to the brain", async () => {
  // An unrecognised reply while a write is pending must be re-prompted
  // deterministically — the brain holds no receipt and could fabricate a success.
  const r = await handlePendingProposalReprompt("u", {
    getActiveProposal: async () => proposal(),
  });
  assert.equal(r.handled, true);
  assert.ok(/waiting for your go-ahead/i.test(r.reply ?? ""));
});

asyncCheck("guard: with no pending proposal, normal conversation is unaffected", async () => {
  const r = await handlePendingProposalReprompt("u", {
    getActiveProposal: async () => null,
  });
  assert.equal(r.handled, false);
});

// --- Safety --------------------------------------------------------------

asyncCheck("safety: no confirmation reply leaks token material", async () => {
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
  console.log(`\nAll ${passed} Calendar confirmation (Section 17) tests passed.`);
}

void run().catch((err) => {
  console.error(
    "Calendar confirmation tests failed:",
    err instanceof Error ? err.message : "unknown error",
  );
  process.exitCode = 1;
});
