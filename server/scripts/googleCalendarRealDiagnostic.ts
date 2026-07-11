import { getPrisma } from "../src/db/prisma";
import { runGoogleCalendarDiagnostic } from "../src/integrations/providers/googleCalendar/diagnostic";

/**
 * Manual REAL Google Calendar read-path diagnostic (Section 13).
 *
 * Unlike the offline `googleCalendar.manual.ts`, this runs the ACTUAL staged
 * read path against Google for one already-connected user, using that user's
 * stored (encrypted) credentials. It exists to reveal WHY a real request fails
 * — the safe exception name/cause code — without ever exposing a secret.
 *
 * It prints ONLY booleans, the failing stage, safe error/cause codes, and the
 * event count. It NEVER prints a token, an encrypted credential, a raw Google
 * response body, or any OAuth secret.
 *
 * Usage (from the `server/` directory):
 *
 *     npm run test:google-calendar-real -- <clerkUserId | hulaUserId>
 *
 * Requires DATABASE_URL, INTEGRATION_TOKEN_ENCRYPTION_KEY, and the GOOGLE_OAUTH_*
 * env to be set (the same env the server runs with). The user must already have
 * a connected Google Calendar. This hits the real Google API for that one user.
 */

/** Resolve an existing Hula user id from either a Hula id or a Clerk id. */
async function resolveUserId(arg: string): Promise<string | null> {
  const user = await getPrisma().user.findFirst({
    where: { OR: [{ id: arg }, { clerkUserId: arg }] },
    select: { id: true },
  });
  return user?.id ?? null;
}

async function main(): Promise<void> {
  const arg = process.argv[2]?.trim();
  if (!arg) {
    console.error("Usage: npm run test:google-calendar-real -- <clerkUserId | hulaUserId>");
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — cannot load the user's connection.");
    process.exitCode = 1;
    return;
  }

  const prisma = getPrisma();
  try {
    const userId = await resolveUserId(arg);
    if (!userId) {
      // Never echo the raw argument (could be a real id) beyond a safe note.
      console.error("No Hula user found for the supplied id.");
      process.exitCode = 1;
      return;
    }

    console.log("Google Calendar — REAL read-path diagnostic\n");
    // The real diagnostic uses the default (global) fetch → hits real Google.
    const d = await runGoogleCalendarDiagnostic(userId);

    // Print SAFE fields only. No tokens, no encrypted values, no raw bodies.
    console.log(`  connected:                ${d.connected}`);
    console.log(`  credentialPresent:        ${d.credentialPresent}`);
    console.log(`  credentialDecryptable:    ${d.credentialDecryptable}`);
    console.log(`  scopeGranted:             ${d.scopeGranted}`);
    console.log(`  accessTokenPresent:       ${d.accessTokenPresent}`);
    console.log(`  refreshTokenPresent:      ${d.refreshTokenPresent}`);
    console.log(`  nodeFetchAvailable:       ${d.nodeFetchAvailable}`);
    console.log(`  googleReachable:          ${d.googleReachable}`);
    console.log(`  primaryCalendarAccessible:${d.primaryCalendarAccessible}`);
    console.log(`  eventReadAccessible:      ${d.eventReadAccessible}`);
    console.log(`  eventCount:               ${d.eventCount}`);
    console.log(`  errorStage:               ${d.errorStage}`);
    console.log(`  errorCode:                ${d.errorCode}`);
    console.log(`  safeErrorName:            ${d.safeErrorName}`);
    console.log(`  safeCauseCode:            ${d.safeCauseCode}`);

    if (!d.errorCode) {
      console.log("\n  ok - the full read path succeeded (empty calendar is a success).");
    } else {
      console.log(`\n  read path stopped at stage "${d.errorStage}" with code "${d.errorCode}".`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(
    "Google Calendar real diagnostic failed:",
    err instanceof Error ? err.message : "unknown error",
  );
  process.exitCode = 1;
});
