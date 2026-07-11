import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { env } from "../src/config/env";
import { getProvider } from "../src/integrations/catalog";
import { getPrisma } from "../src/db/prisma";
import { getOrCreateUserByClerkId } from "../src/users/store";
import { upsertIntegrationConnection } from "../src/integrations/connections";
import {
  readCredentialSecrets,
  storeCredentialSecrets,
} from "../src/integrations/credentials";
import {
  getGoogleCalendarConnection,
  getValidGoogleCalendarAccessToken,
} from "../src/integrations/providers/googleCalendar/client";
import { isGoogleOAuthConfigured } from "../src/integrations/providers/googleCalendar/oauth";
import type { FetchLike } from "../src/integrations/providers/googleCalendar/oauth";
import {
  computeRange,
  normalizeGoogleEvent,
} from "../src/integrations/providers/googleCalendar/events";

/**
 * Manual helper for Section 11 Google Calendar (read-only).
 *
 * The OFFLINE part always runs: NO network, NO database, NO real Google
 * credentials. It verifies the read-only catalog, prints connect/callback
 * instructions (NO secrets), and exercises normalization + range computation with
 * FAKE data.
 *
 * The DB part runs ONLY when `DATABASE_URL` is set. It proves the token vault +
 * refresh helper end-to-end using a FAKE Google token endpoint (no real Google
 * call): it stores an EXPIRED access token + a fake refresh token, calls the
 * refresh helper, and asserts the stored access token was updated (encrypted).
 * It cleans up everything it creates and never prints a token.
 *
 * Run with: `npm run test:google-calendar`.
 */

const CALLBACK_PATH = "/v1/integrations/google_calendar/callback";
const CONNECT_PATH = "/v1/me/integrations/google_calendar/connect";
const EVENTS_PATH = "/v1/me/integrations/google_calendar/events";

function offlineChecks(): void {
  console.log("Google Calendar (Section 11) — offline manual check\n");

  // 1. Provider catalog is present and READ-ONLY.
  const gcal = getProvider("google_calendar");
  assert.ok(gcal, "google_calendar must exist in the catalog");
  assert.equal(gcal.status, "available_readonly");
  for (const scope of gcal.defaultScopes) {
    assert.ok(/readonly/.test(scope), `scope must be read-only: ${scope}`);
  }
  for (const cap of gcal.capabilities) {
    assert.ok(!/write|create|edit|delete/i.test(cap), `write capability leaked: ${cap}`);
  }
  console.log("  ok - provider catalog is read-only");
  console.log(`       scopes: ${gcal.defaultScopes.join(", ")}`);
  console.log(`       capabilities: ${gcal.capabilities.join(", ")}`);

  // 2. Config presence (boolean only — never print env values/secrets).
  console.log(`\n  Google OAuth configured: ${isGoogleOAuthConfigured() ? "yes" : "no"}`);

  // 3. Local connect instructions (paths only, no secrets).
  console.log("\n  Local connect flow:");
  console.log(`   1. Start backend + ngrok. Register this redirect URI on the OAuth client:`);
  console.log(`        https://YOUR-NGROK-URL${CALLBACK_PATH}`);
  console.log(`   2. POST (Clerk bearer) ${CONNECT_PATH}  → returns { authorizationUrl }`);
  console.log(`   3. Open authorizationUrl, approve READ-ONLY consent.`);
  console.log(`   4. Callback shows a success page; tokens are stored ENCRYPTED server-side.`);
  console.log(`   5. GET (Clerk bearer) ${EVENTS_PATH}?range=today  → normalized events`);

  // 4. Normalization strips raw payload (fake event with a private description).
  const norm = normalizeGoogleEvent(
    {
      id: "fake-evt-1",
      status: "confirmed",
      summary: "Team sync",
      location: "Zoom",
      htmlLink: "https://calendar.google.com/fake",
      start: { dateTime: "2026-07-15T15:00:00-04:00" },
      end: { dateTime: "2026-07-15T15:30:00-04:00" },
      attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
      organizer: { email: "organizer@example.com" },
    } as never,
    "primary",
  );
  assert.equal(norm.attendeeCount, 2);
  assert.equal(norm.allDay, false);
  assert.ok(!("description" in norm), "normalized event must not carry a description");
  console.log("\n  ok - normalized (safe) event:");
  console.log(`       ${JSON.stringify(norm)}`);

  // 5. Deterministic range computation sample.
  const now = new Date("2026-07-15T12:00:00Z");
  const today = computeRange("today", now, "America/New_York");
  console.log("\n  ok - computeRange('today', America/New_York):");
  console.log(`       ${JSON.stringify(today)}`);
}

/** A fake Google token endpoint returning a NEW access token on refresh. */
function fakeRefreshFetch(newAccessToken: string): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ access_token: newAccessToken, expires_in: 3600 }),
  });
}

async function dbChecks(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("\nSKIP: DATABASE_URL not set — skipping DB-backed refresh check.");
    return;
  }

  console.log("\nGoogle Calendar — DB-backed token vault + refresh check\n");

  const STAMP = Date.now();
  const CLERK = `clerk_section11_gcal_${STAMP}`;
  const OLD_ACCESS = `fake_expired_access_${STAMP}`;
  const FAKE_REFRESH = `fake_refresh_${STAMP}`;
  const NEW_ACCESS = `fake_refreshed_access_${STAMP}`;

  // Throwaway, in-process only. Never printed.
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  // Fake OAuth config so the refresh helper can build a request (no real call).
  env.GOOGLE_OAUTH_CLIENT_ID = "fake-id.apps.googleusercontent.com";
  env.GOOGLE_OAUTH_CLIENT_SECRET = "fake-secret";
  env.GOOGLE_OAUTH_REDIRECT_URI = `https://example.test${CALLBACK_PATH}`;

  const prisma = getPrisma();
  const user = await getOrCreateUserByClerkId(CLERK);

  try {
    await upsertIntegrationConnection(user.id, {
      provider: "google_calendar",
      status: "connected",
      grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      capabilities: ["read_calendar_events"],
    });
    const connection = await getGoogleCalendarConnection(user.id);
    assert.ok(connection, "connection should exist");

    // Store an already-EXPIRED access token + a refresh token (encrypted).
    await storeCredentialSecrets(connection.id, {
      accessToken: OLD_ACCESS,
      refreshToken: FAKE_REFRESH,
      accessTokenExpiresAt: new Date(Date.now() - 60_000), // expired
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });

    // Ciphertext must not equal plaintext.
    const rawCred = await prisma.integrationCredential.findUnique({
      where: { connectionId: connection.id },
      select: { encryptedAccessToken: true },
    });
    assert.ok(rawCred?.encryptedAccessToken && !rawCred.encryptedAccessToken.includes(OLD_ACCESS));
    console.log("  ok - tokens stored encrypted at rest");

    // Refresh helper should swap the expired token for the fake new one.
    const token = await getValidGoogleCalendarAccessToken(
      connection.id,
      fakeRefreshFetch(NEW_ACCESS),
    );
    assert.equal(token, NEW_ACCESS, "helper returns the refreshed access token");

    const after = await readCredentialSecrets(connection.id);
    assert.equal(after?.accessToken, NEW_ACCESS, "stored access token was updated");
    assert.equal(after?.refreshToken, FAKE_REFRESH, "refresh token is preserved");
    console.log("  ok - refresh helper updated the stored access token");
  } finally {
    await prisma.user.deleteMany({ where: { clerkUserId: CLERK } });
    await prisma.$disconnect();
    console.log("  ok - cleaned up synthetic rows");
  }
}

async function main(): Promise<void> {
  offlineChecks();
  await dbChecks();
  console.log("\nGoogle Calendar manual check complete. No real Google API was called.");
}

main().catch((err) => {
  console.error(
    "Google Calendar manual check failed:",
    err instanceof Error ? err.message : "unknown error",
  );
  process.exitCode = 1;
});
