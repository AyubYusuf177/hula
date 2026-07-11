import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { getPrisma } from "../src/db/prisma";
import { getOrCreateUserByClerkId } from "../src/users/store";
import {
  disconnectIntegrationConnection,
  getConnectionForUserProvider,
  getUserIntegrationStatus,
  listConnectedProviderNames,
  listUserIntegrationConnections,
  recordIntegrationAction,
  recordIntegrationEvent,
  upsertIntegrationConnection,
} from "../src/integrations/connections";
import { decryptToken, encryptToken } from "../src/integrations/tokenVault";

/**
 * Manual, DB-backed check for Section 10 integration foundation.
 *
 * Unlike `npm test` (pure, offline), this touches the REAL database and so only
 * runs when `DATABASE_URL` is set — otherwise it prints a skip notice and exits
 * 0. It drives the integration helpers with a throwaway user + a FAKE token,
 * proving:
 *   - a stub connection can be created and listed,
 *   - a fake token is encrypted at rest and only decrypts inside the server,
 *   - NO helper ever returns a token value,
 *   - disconnect flips status + clears credentials but KEEPS the audit trail,
 * then cleans up everything it created. It never calls a real provider, never
 * calls Anthropic, and never prints a secret.
 *
 * Run with: `npm run test:integrations`.
 */

const STAMP = Date.now();
const CLERK = `clerk_section10_integrations_${STAMP}`;
const FAKE_ACCESS_TOKEN = `fake_access_${STAMP}_do_not_use`;
const FAKE_REFRESH_TOKEN = `fake_refresh_${STAMP}_do_not_use`;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("SKIP: DATABASE_URL not set — skipping DB-backed integration check.");
    return;
  }

  // A throwaway in-process encryption key so token storage works without needing
  // a real one configured. Only lives in this process; never printed.
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");

  const prisma = getPrisma();
  const user = await getOrCreateUserByClerkId(CLERK);
  assert.ok(user.id, "throwaway user should exist");
  console.log("  ok - created throwaway test user");

  try {
    // 1. Create a stub connection (as a future OAuth callback would).
    await upsertIntegrationConnection(user.id, {
      provider: "google_calendar",
      status: "connected",
      providerAccountEmail: "fake@example.com",
      grantedScopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      capabilities: ["calendar.read"],
    });
    console.log("  ok - created stub google_calendar connection");

    // 2. Store an ENCRYPTED fake token in the credential row (server-only).
    const connectionRow = await prisma.integrationConnection.findUnique({
      where: { userId_provider: { userId: user.id, provider: "google_calendar" } },
      select: { id: true },
    });
    assert.ok(connectionRow, "connection row should exist");
    await prisma.integrationCredential.create({
      data: {
        connectionId: connectionRow.id,
        tokenType: "oauth",
        encryptedAccessToken: encryptToken(FAKE_ACCESS_TOKEN),
        encryptedRefreshToken: encryptToken(FAKE_REFRESH_TOKEN),
      },
    });
    console.log("  ok - stored encrypted fake tokens");

    // 3. The stored ciphertext must NOT equal the plaintext token.
    const rawCred = await prisma.integrationCredential.findUnique({
      where: { connectionId: connectionRow.id },
      select: { encryptedAccessToken: true, encryptedRefreshToken: true },
    });
    assert.ok(rawCred?.encryptedAccessToken, "access token ciphertext stored");
    assert.notEqual(rawCred?.encryptedAccessToken, FAKE_ACCESS_TOKEN);
    assert.ok(!rawCred?.encryptedAccessToken?.includes(FAKE_ACCESS_TOKEN));
    console.log("  ok - tokens are stored encrypted (ciphertext != plaintext)");

    // 4. Tokens decrypt ONLY inside the server helper, back to the original.
    const decryptedAccess = decryptToken(rawCred!.encryptedAccessToken!);
    assert.equal(decryptedAccess, FAKE_ACCESS_TOKEN, "server can decrypt its own token");
    console.log("  ok - server-side decrypt roundtrips the fake token");

    // 5. NO app-facing helper returns any token value.
    const connections = await listUserIntegrationConnections(user.id);
    const status = await getUserIntegrationStatus(user.id);
    const one = await getConnectionForUserProvider(user.id, "google_calendar");
    const blob = JSON.stringify({ connections, status, one });
    assert.ok(!blob.includes(FAKE_ACCESS_TOKEN), "no access token in helper output");
    assert.ok(!blob.includes(FAKE_REFRESH_TOKEN), "no refresh token in helper output");
    console.log("  ok - no token values are returned by any helper");

    // 6. Status reflects the connection and connected-provider names.
    const gcal = status.find((s) => s.provider === "google_calendar");
    assert.ok(gcal?.connected, "google_calendar should read as connected");
    const names = await listConnectedProviderNames(user.id);
    assert.ok(names.includes("Google Calendar"), "connected name should list");
    console.log("  ok - status + connected names reflect the connection");

    // 7. Record audit rows (event + action) — these survive a disconnect.
    await recordIntegrationEvent({
      userId: user.id,
      provider: "google_calendar",
      eventType: "test.stub.event",
      connectionId: connectionRow.id,
      safeSummary: { note: "synthetic" },
    });
    await recordIntegrationAction({
      userId: user.id,
      provider: "google_calendar",
      actionType: "test.stub.action",
      status: "skipped",
      connectionId: connectionRow.id,
      requestSummary: { note: "synthetic" },
    });
    console.log("  ok - recorded audit event + action");

    // 8. Disconnect flips status, clears credentials, keeps the audit trail.
    const changed = await disconnectIntegrationConnection(user.id, "google_calendar");
    assert.equal(changed, true, "disconnect should report a change");
    const afterStatus = await getUserIntegrationStatus(user.id);
    const gcalAfter = afterStatus.find((s) => s.provider === "google_calendar");
    assert.equal(gcalAfter?.connected, false, "should read disconnected");
    const credAfter = await prisma.integrationCredential.findUnique({
      where: { connectionId: connectionRow.id },
    });
    assert.equal(credAfter, null, "credentials should be cleared on disconnect");
    const eventCount = await prisma.integrationEvent.count({ where: { userId: user.id } });
    const actionCount = await prisma.integrationActionLog.count({ where: { userId: user.id } });
    assert.ok(eventCount >= 1 && actionCount >= 1, "audit trail must be preserved");
    console.log("  ok - disconnect cleared tokens but preserved audit logs");

    console.log("\nIntegration foundation check passed.");
  } finally {
    // Cleanup — deleting the user cascades connections/credentials/events/logs.
    await prisma.user.deleteMany({ where: { clerkUserId: CLERK } });
    await prisma.$disconnect();
    console.log("  ok - cleaned up all synthetic test rows");
  }
}

main().catch((err) => {
  console.error(
    "integration check failed:",
    err instanceof Error ? err.message : "unknown error",
  );
  process.exitCode = 1;
});
