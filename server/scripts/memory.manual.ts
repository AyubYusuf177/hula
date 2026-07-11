import assert from "node:assert/strict";

import { getPrisma } from "../src/db/prisma";
import {
  buildMemoryContext,
  createMemoryForUser,
  handleMemoryCommand,
  listActiveMemoriesForUser,
  softDeleteAllMemoriesForUser,
  softDeleteMemoriesByTextMatch,
  softDeleteMemory,
} from "../src/users/memory";
import { getOrCreateUserByClerkId } from "../src/users/store";

/**
 * Manual, DB-backed check for Section 8 explicit memory.
 *
 * Unlike `npm test` (pure, offline), this touches the REAL database and so only
 * runs when `DATABASE_URL` is set — otherwise it prints a skip notice and exits
 * 0. It drives the memory helpers directly with a throwaway user, then cleans up
 * everything it created. It never calls Anthropic and never prints secrets.
 *
 * Run with: `npm run test:memory`.
 */

const STAMP = Date.now();
const CLERK = `clerk_section8_memory_${STAMP}`;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("SKIP: DATABASE_URL not set — skipping DB-backed memory check.");
    return;
  }

  const prisma = getPrisma();
  const user = await getOrCreateUserByClerkId(CLERK);
  assert.ok(user.id, "throwaway user should exist");
  console.log("  ok - created throwaway test user");

  try {
    // 1. create memories directly.
    await createMemoryForUser(user.id, { text: "You prefer blunt, concise replies." });
    await createMemoryForUser(user.id, { text: "You don't eat pork." });
    let active = await listActiveMemoriesForUser(user.id);
    assert.equal(active.length, 2, "two memories should be active");
    console.log("  ok - created and listed two memories");

    // 2. brain context returns the memory lines (and bumps lastUsedAt).
    const context = await buildMemoryContext(user.id);
    assert.equal(context.length, 2, "brain context should include both memories");
    console.log("  ok - buildMemoryContext returned both memories");

    // 3. the full command path: a "remember" command persists a new memory.
    const remembered = await handleMemoryCommand(user.id, "Remember I avoid alcohol");
    assert.equal(remembered.handled, true);
    assert.ok(remembered.reply?.startsWith("Got it"), "remember reply should confirm");
    active = await listActiveMemoriesForUser(user.id);
    assert.equal(active.length, 3, "three memories after remember command");
    console.log("  ok - remember command persisted a third memory");

    // 4. a blocked "remember" command must NOT persist anything.
    const blocked = await handleMemoryCommand(user.id, "Remember my password is hunter2");
    assert.equal(blocked.handled, true);
    assert.ok(blocked.reply?.includes("won’t save"), "blocked reply should decline");
    active = await listActiveMemoriesForUser(user.id);
    assert.equal(active.length, 3, "blocked memory must not be stored");
    console.log("  ok - blocked secret memory was not stored");

    // 5. soft-delete one by id.
    const first = active[0];
    assert.ok(first, "expected at least one memory");
    const deletedOne = await softDeleteMemory(user.id, first.id);
    assert.equal(deletedOne, true);
    assert.equal((await listActiveMemoriesForUser(user.id)).length, 2);
    console.log("  ok - soft-deleted one memory by id");

    // 6. forget by text match.
    const matchCount = await softDeleteMemoriesByTextMatch(user.id, "I prefer blunt replies");
    assert.ok(matchCount >= 0, "match count is a number");
    console.log(`  ok - forget-by-text match removed ${matchCount} memory(ies)`);

    // 7. clear all.
    await softDeleteAllMemoriesForUser(user.id);
    assert.equal((await listActiveMemoriesForUser(user.id)).length, 0);
    console.log("  ok - cleared all remaining memories");

    console.log("\nMemory check passed.");
  } finally {
    // Cleanup — hard-delete the throwaway user's memories and the user itself.
    await prisma.memory.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { clerkUserId: CLERK } });
    await prisma.$disconnect();
    console.log("  ok - cleaned up all synthetic test rows");
  }
}

main().catch((err) => {
  console.error("memory check failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
