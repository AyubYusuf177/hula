import assert from "node:assert/strict";

import type { InboundMessage } from "../src/channels/types";
import { getPrisma } from "../src/db/prisma";
import { recordInbound, recordOutbound } from "../src/db/persist";
import { listRecentMessagesForUser } from "../src/db/queries";
import { getOrCreateUserByClerkId } from "../src/users/store";

/**
 * Manual, DB-backed persistence check for Section 5.
 *
 * Unlike `npm test` (pure, offline), this touches the REAL database and so only
 * runs when `DATABASE_URL` is set — otherwise it prints a skip notice and exits
 * 0. It does NOT require Sendblue, Clerk, or ngrok: it drives the persistence
 * helpers directly with synthetic data, then cleans everything it created.
 *
 * It verifies:
 *   1. create/find a user by Clerk id
 *   2. an inbound message persists (event + conversation + message)
 *   3. an outbound reply persists to the same conversation
 *   4. `listRecentMessagesForUser` returns only that user's messages
 *   5. a second user's messages are NOT visible to the first user
 *   6. all synthetic rows are removed afterwards
 *
 * Run with: `npm run test:persistence`. Never prints secrets.
 */

// Unique, obviously-synthetic identifiers so cleanup can target exactly what we
// created and we never collide with real linked identities.
const STAMP = Date.now();
const CLERK_A = `clerk_section5_test_a_${STAMP}`;
const CLERK_B = `clerk_section5_test_b_${STAMP}`;
const HANDLE_A = `+1999555${String(STAMP).slice(-4)}0`;
const HANDLE_B = `+1999555${String(STAMP).slice(-4)}1`;
const HULA_LINE = "+16465480761";

function inboundFor(handle: string, text: string): InboundMessage {
  return {
    providerMessageId: `test-${handle}-${STAMP}`,
    channel: "imessage",
    provider: "sendblue",
    senderHandle: handle,
    recipientHandle: HULA_LINE,
    content: { type: "text", text },
    isIMessage: true,
    receivedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log(
      "SKIP: DATABASE_URL not set — skipping DB-backed persistence check.",
    );
    return;
  }

  const prisma = getPrisma();

  // 1. create/find users.
  const userA = await getOrCreateUserByClerkId(CLERK_A);
  const userB = await getOrCreateUserByClerkId(CLERK_B);
  assert.ok(userA.id && userB.id, "both users should exist");
  console.log("  ok - created/found two test users");

  try {
    // 2. inbound message for user A (creates event + conversation + message).
    const { conversationId } = await recordInbound({
      message: inboundFor(HANDLE_A, "Test section 5 inbound"),
      userId: userA.id,
      outcomeStatus: "already_connected",
      codeMatched: false,
    });
    assert.ok(conversationId, "inbound should create/return a conversation id");
    console.log("  ok - inbound message persisted");

    // 3. outbound reply for user A on the same conversation.
    await recordOutbound({
      conversationId,
      userId: userA.id,
      channel: "imessage",
      provider: "sendblue",
      recipientHandle: HANDLE_A,
      text: "You're connected to Hula.",
      providerMessageId: `test-out-${STAMP}`,
      status: "sent",
    });
    console.log("  ok - outbound reply persisted");

    // A message for user B, which user A must never see.
    await recordInbound({
      message: inboundFor(HANDLE_B, "Other user message"),
      userId: userB.id,
      outcomeStatus: "already_connected",
      codeMatched: false,
    });

    // 4. query only user A's messages.
    const aMessages = await listRecentMessagesForUser({
      clerkUserId: CLERK_A,
      limit: 50,
      order: "desc",
    });
    assert.equal(aMessages.length, 2, "user A should have exactly 2 messages");
    const directions = aMessages.map((m) => m.direction).sort();
    assert.deepEqual(directions, ["inbound", "outbound"]);
    console.log("  ok - user A sees exactly their inbound + outbound");

    // 5. isolation: none of user A's messages leak user B's text.
    assert.ok(
      aMessages.every((m) => m.text !== "Other user message"),
      "user A must not see user B's messages",
    );
    console.log("  ok - user B's messages are NOT visible to user A");

    console.log("\nPersistence check passed.");
  } finally {
    // 6. cleanup — remove everything we created, in FK-safe order.
    await prisma.message.deleteMany({
      where: { userId: { in: [userA.id, userB.id] } },
    });
    await prisma.conversation.deleteMany({
      where: { userId: { in: [userA.id, userB.id] } },
    });
    await prisma.providerEvent.deleteMany({
      where: {
        providerMessageId: {
          in: [
            `test-${HANDLE_A}-${STAMP}`,
            `test-${HANDLE_B}-${STAMP}`,
          ],
        },
      },
    });
    await prisma.user.deleteMany({
      where: { clerkUserId: { in: [CLERK_A, CLERK_B] } },
    });
    await prisma.$disconnect();
    console.log("  ok - cleaned up all synthetic test rows");
  }
}

main().catch((err) => {
  console.error(
    "persistence check failed:",
    err instanceof Error ? err.message : "unknown error",
  );
  process.exitCode = 1;
});
