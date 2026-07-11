import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { getPrisma } from "../src/db/prisma";
import { getOrCreateUserByClerkId } from "../src/users/store";
import { upsertIntegrationConnection } from "../src/integrations/connections";
import {
  createActionProposal,
  getActiveProposal,
  getProposalForUser,
  listProposalsForUser,
} from "../src/actions/proposals";
import { listExecutionsForUser } from "../src/actions/executions";
import { executeAction } from "../src/actions/executor";
import { handleActionConfirmation } from "../src/actions/confirmations";
import type { NormalizedCalendarEvent } from "../src/integrations/providers/googleCalendar/types";

/**
 * Manual, DB-backed check for the Section 12 action runtime.
 *
 * Unlike `npm test` (pure, offline), this touches the REAL database and so only
 * runs when `DATABASE_URL` is set — otherwise it prints a skip notice and exits
 * 0. It drives the runtime with a throwaway user, proving:
 *   - a proposal can be created, read as the active proposal, and confirmed,
 *   - confirming a STUB write action runs the executor and stays honest,
 *   - a proposal expires (a stale "yes" can't confirm it),
 *   - a "yes" with no pending proposal does nothing,
 *   - a read action logs a `succeeded` execution (calendar fetch is FAKED — no
 *     real Google call) and the ledger holds NO token material,
 *   - a proposal belongs only to its owner,
 * then cleans up everything it created. It never calls a real provider, never
 * calls Anthropic, and never prints a secret.
 *
 * Requires the Section 12 migration to be applied. Run with: `npm run test:actions`.
 */

const STAMP = Date.now();
const CLERK = `clerk_section12_actions_${STAMP}`;
const OTHER = `clerk_section12_other_${STAMP}`;

const FAKE_EVENT: NormalizedCalendarEvent = {
  id: "evt_fake",
  calendarId: "primary",
  summary: "Fake Standup",
  location: null,
  start: "2026-07-11T09:00:00Z",
  end: "2026-07-11T09:15:00Z",
  allDay: false,
  status: "confirmed",
  htmlLink: null,
  attendeeCount: 2,
  organizerEmail: null,
  source: "google_calendar",
};

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("SKIP: DATABASE_URL not set — skipping DB-backed action runtime check.");
    return;
  }

  // Throwaway in-process encryption key so any credential writes work without a
  // real one configured. Only lives in this process; never printed.
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");

  const prisma = getPrisma();
  const user = await getOrCreateUserByClerkId(CLERK);
  const other = await getOrCreateUserByClerkId(OTHER);
  console.log("  ok - created throwaway users");

  try {
    // A connected (read-only) Google Calendar so read policy passes.
    await upsertIntegrationConnection(user.id, {
      provider: "google_calendar",
      status: "connected",
      grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      capabilities: ["read_calendar_events"],
    });
    console.log("  ok - stub connected google_calendar (read-only)");

    // 1. Create a proposal for a confirmable (stubbed) write action.
    const proposal = await createActionProposal(user.id, {
      provider: "google_calendar",
      actionId: "calendar.createEvent",
      riskLevel: "write",
      confirmationRequired: true,
      input: { title: "Gym", start: "2026-07-12T19:00:00Z" },
      previewText: "Create “Gym” tomorrow at 7pm?",
    });
    const active = await getActiveProposal(user.id);
    assert.equal(active?.id, proposal.id, "the new proposal should be active");
    console.log("  ok - created proposal and read it back as active");

    // 2. Confirm via the natural-language flow → executor runs → honest reply.
    const confirmYes = await handleActionConfirmation(user.id, "yes");
    assert.equal(confirmYes.handled, true);
    assert.equal(confirmYes.outcome, "confirmed");
    assert.ok(/not enabled|only read/i.test(confirmYes.reply ?? ""), "must stay honest");
    const afterConfirm = await getProposalForUser(user.id, proposal.id);
    assert.ok(
      afterConfirm && ["executed", "failed"].includes(afterConfirm.status),
      "proposal should be finalized",
    );
    console.log("  ok - confirmed stub action ran executor and stayed honest");

    // 3. A "yes" with no pending proposal does nothing.
    const staleYes = await handleActionConfirmation(user.id, "yes");
    assert.equal(staleYes.handled, false, "yes with no active proposal must be a no-op");
    console.log("  ok - 'yes' with no pending proposal executes nothing");

    // 4. Expiry: a proposal created already-expired is never active.
    await createActionProposal(user.id, {
      provider: "google_calendar",
      actionId: "calendar.createEvent",
      riskLevel: "write",
      previewText: "expired preview",
      ttlMs: -1000,
    });
    const noneActive = await getActiveProposal(user.id);
    assert.equal(noneActive, null, "expired proposal must not be active");
    console.log("  ok - expired proposal cannot be confirmed");

    // 5. Cancellation flow.
    await createActionProposal(user.id, {
      provider: "google_calendar",
      actionId: "calendar.createEvent",
      riskLevel: "write",
      previewText: "cancel me",
    });
    const cancel = await handleActionConfirmation(user.id, "cancel");
    assert.equal(cancel.outcome, "cancelled");
    console.log("  ok - cancellation flow rejects the active proposal");

    // 6. Read action logs a succeeded execution (calendar fetch is FAKED).
    const read = await executeAction(
      user.id,
      "calendar.listEvents",
      { input: { range: "today" } },
      { fetchEvents: async () => [FAKE_EVENT], getTimezone: async () => "UTC" },
    );
    assert.equal(read.ok, true);
    assert.ok(/Fake Standup/.test(read.userMessage));
    console.log("  ok - read action executed via faked helper");

    // 7. A blocked write also lands in the ledger (honest, no execution).
    const blocked = await executeAction(user.id, "email.sendDraft", { input: {} });
    assert.equal(blocked.status, "blocked");
    console.log("  ok - blocked write recorded honestly");

    // 8. Ledger holds NO token material and only a count for reads.
    const executions = await listExecutionsForUser(user.id);
    const blob = JSON.stringify(executions);
    assert.ok(!/Bearer|ya29\.|access_token|refresh_token/i.test(blob), "no tokens in ledger");
    const readRow = executions.find((e) => e.actionId === "calendar.listEvents");
    assert.deepEqual(readRow?.resultSummary, { eventCount: 1 }, "read ledger keeps only a count");
    console.log("  ok - execution ledger contains no tokens and only safe summaries");

    // 9. A proposal belongs only to its owner.
    const proposals = await listProposalsForUser(user.id);
    assert.ok(proposals.length >= 3, "owner sees their proposals");
    const leaked = await getProposalForUser(other.id, proposal.id);
    assert.equal(leaked, null, "another user cannot read this proposal");
    console.log("  ok - proposals are scoped to their owner");

    console.log("\nAction runtime check passed.");
  } finally {
    // Cleanup — deleting the users cascades proposals/executions/connections.
    await prisma.user.deleteMany({ where: { clerkUserId: { in: [CLERK, OTHER] } } });
    await prisma.$disconnect();
    console.log("  ok - cleaned up all synthetic test rows");
  }
}

main().catch((err) => {
  console.error(
    "action runtime check failed:",
    err instanceof Error ? err.message : "unknown error",
  );
  process.exitCode = 1;
});
