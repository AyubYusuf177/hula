import assert from "node:assert/strict";

import { getPrisma } from "../src/db/prisma";
import { linkIdentity } from "../src/users/messagingIdentity";
import {
  cancelAllRemindersForUser,
  cancelRemindersByTitleMatch,
  createReminderForUser,
  listActiveRemindersForUser,
} from "../src/reminders/reminders";
import { runReminderTick, type ReminderSender } from "../src/reminders/worker";
import { getOrCreateUserByClerkId } from "../src/users/store";

/**
 * Manual, DB-backed check for Section 9 reminders.
 *
 * Unlike `npm test` (pure, offline), this touches the REAL database and so only
 * runs when `DATABASE_URL` is set — otherwise it prints a skip notice and exits
 * 0. It drives the reminder helpers and the delivery worker directly with a
 * throwaway user, then cleans up everything it created.
 *
 * IMPORTANT: it NEVER sends a real iMessage. The worker's sender is stubbed so
 * "delivery" only records calls in memory. It never calls Anthropic and never
 * prints secrets. Run with: `npm run test:reminders`.
 */

const STAMP = Date.now();
const CLERK = `clerk_section9_reminders_${STAMP}`;
const HANDLE = `+1999${String(STAMP).slice(-7)}`;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("SKIP: DATABASE_URL not set — skipping DB-backed reminders check.");
    return;
  }

  const prisma = getPrisma();
  const user = await getOrCreateUserByClerkId(CLERK);
  assert.ok(user.id, "throwaway user should exist");
  // A linked identity so the worker has somewhere to "send".
  await linkIdentity({ handle: HANDLE, userId: user.id, provider: "sendblue", channel: "imessage" });
  console.log("  ok - created throwaway user + linked identity");

  // Stub sender: records calls, sends nothing real.
  const sentTexts: string[] = [];
  const stubSender: ReminderSender = async (_to, text) => {
    sentTexts.push(text);
    return { providerMessageId: `stub_${sentTexts.length}`, status: "sent" };
  };

  try {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);

    // 1. create + list.
    const oneOff = await createReminderForUser(user.id, {
      title: "test one-off",
      dueAt: past,
      recurrenceRule: null,
      timezone: "America/New_York",
    });
    const recurring = await createReminderForUser(user.id, {
      title: "test daily",
      dueAt: past,
      recurrenceRule: "daily",
      timezone: "America/New_York",
    });
    const futureOne = await createReminderForUser(user.id, {
      title: "test future",
      dueAt: future,
      recurrenceRule: null,
      timezone: "America/New_York",
    });
    let active = await listActiveRemindersForUser(user.id);
    assert.equal(active.length, 3, "three reminders should be active");
    console.log("  ok - created and listed three reminders");

    // 2. worker selects the two DUE reminders (not the future one) and sends.
    const tick1 = await runReminderTick(new Date(), stubSender);
    assert.equal(tick1.due, 2, "worker should select exactly the two due reminders");
    assert.equal(tick1.sent, 2, "worker should send both due reminders");
    assert.ok(sentTexts.some((t) => t === "Reminder: test one-off"), "deterministic one-off text");
    assert.ok(sentTexts.some((t) => t === "Reminder: test daily"), "deterministic daily text");
    console.log("  ok - worker delivered due reminders with deterministic text");

    // 3. one-off is now marked sent (no longer scheduled); recurring advanced.
    const oneOffRow = await prisma.reminder.findUnique({ where: { id: oneOff.id } });
    assert.equal(oneOffRow?.status, "sent", "one-off should be marked sent");
    assert.equal(oneOffRow?.sendCount, 1, "one-off send count is 1");
    const recurringRow = await prisma.reminder.findUnique({ where: { id: recurring.id } });
    assert.equal(recurringRow?.status, "scheduled", "recurring stays scheduled");
    assert.equal(recurringRow?.sendCount, 1, "recurring send count is 1");
    assert.ok(
      recurringRow && recurringRow.nextRunAt!.getTime() > Date.now(),
      "recurring nextRunAt advanced into the future",
    );
    console.log("  ok - one-off marked sent; recurring advanced");

    // 4. a second immediate tick must NOT re-send anything (no duplicates).
    const before = sentTexts.length;
    const tick2 = await runReminderTick(new Date(), stubSender);
    assert.equal(tick2.due, 0, "no reminders should be due immediately after");
    assert.equal(sentTexts.length, before, "no duplicate sends on the second tick");
    console.log("  ok - no duplicate sends on a second tick");

    // 5. cancel-by-match, then cancel-all.
    const matched = await cancelRemindersByTitleMatch(user.id, "future");
    assert.equal(matched, 1, "cancel-by-match cancels the future reminder");
    const remaining = await cancelAllRemindersForUser(user.id);
    assert.equal(remaining, 1, "cancel-all cancels the remaining recurring reminder");
    active = await listActiveRemindersForUser(user.id);
    assert.equal(active.length, 0, "no active reminders remain");
    console.log("  ok - cancel-by-match and cancel-all work");

    console.log("\nAll DB-backed reminder checks passed.");
  } finally {
    // Clean up everything this run created (reminders cascade with the user).
    await prisma.reminder.deleteMany({ where: { userId: user.id } });
    await prisma.messagingIdentity.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.$disconnect();
    console.log("  ok - cleaned up throwaway data");
  }
}

main().catch((err) => {
  console.error("reminders.manual failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
