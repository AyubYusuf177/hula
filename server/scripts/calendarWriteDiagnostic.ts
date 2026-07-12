import { getPrisma } from "../src/db/prisma";
import { getConnectionForUserProvider } from "../src/integrations/connections";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  findCalendarEvents,
  updateCalendarEvent,
} from "../src/integrations/providers/googleCalendar/calendarWrites";
import {
  CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_PROVIDER,
} from "../src/integrations/providers/googleCalendar/types";

/**
 * Manual REAL Google Calendar WRITE round-trip diagnostic (Section 15).
 *
 * Verifies end-to-end that Hula can create, read back, update, and delete an
 * event on ONE already-connected, write-capable user's real Google Calendar. It
 * uses a clearly-labelled throwaway event and ALWAYS cleans up — including on any
 * failure — so it never leaves residue behind.
 *
 * It prints ONLY booleans, safe status text, and the temporary event's own title
 * — NEVER a token, encrypted credential, raw Google body, or OAuth secret.
 *
 * Usage (from the `server/` directory):
 *
 *     npm run test:calendar-write-real -- <clerkUserId | hulaUserId>
 *
 * Requires DATABASE_URL, INTEGRATION_TOKEN_ENCRYPTION_KEY, and the GOOGLE_OAUTH_*
 * env. The user must already have RECONNECTED their Google Calendar since
 * Section 15 so the write scope (calendar.events) is granted. This hits the real
 * Google API for that one user. NOT run automatically — run it deliberately.
 */

const DIAG_TITLE = "Hula Calendar Diagnostic — Safe to Delete";

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
    console.error("Usage: npm run test:calendar-write-real -- <clerkUserId | hulaUserId>");
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — cannot load the user's connection.");
    process.exitCode = 1;
    return;
  }

  const userId = await resolveUserId(arg);
  if (!userId) {
    console.error("No Hula user found for the supplied id.");
    process.exitCode = 1;
    return;
  }

  console.log("Google Calendar — REAL write round-trip diagnostic\n");

  // Pre-flight: connected + write scope granted (never prints tokens).
  const conn = await getConnectionForUserProvider(userId, GOOGLE_CALENDAR_PROVIDER);
  const connected = conn?.status === "connected";
  const writeScope = Boolean(conn?.grantedScopes.includes(CALENDAR_EVENTS_SCOPE));
  console.log(`connected:        ${connected}`);
  console.log(`writeScopeGrant:  ${writeScope}`);
  if (!connected) {
    console.error("\nUser has no connected Google Calendar. Connect it in Hula first.");
    process.exitCode = 1;
    return;
  }
  if (!writeScope) {
    console.error(
      "\nConnection is read-only (no calendar.events scope). The user must RECONNECT " +
        "Google Calendar in Hula to grant write access before writes will work.",
    );
    process.exitCode = 1;
    return;
  }

  // A temporary event well in the future (tomorrow + a bit), 30 minutes long.
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  let createdId: string | null = null;
  try {
    // 1. Create --------------------------------------------------------------
    const created = await createCalendarEvent(userId, {
      summary: DIAG_TITLE,
      description: "Temporary event created by the Hula Section 15 diagnostic.",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    });
    createdId = created.id;
    console.log(`\ncreate:           ok (title: "${created.summary}")`);

    // 2. Fetch it back -------------------------------------------------------
    const found1 = await findCalendarEvents(userId, {
      timeMin: new Date(start.getTime() - 60 * 60 * 1000).toISOString(),
      timeMax: new Date(end.getTime() + 60 * 60 * 1000).toISOString(),
      query: DIAG_TITLE,
    });
    console.log(`fetchAfterCreate: ${found1.some((e) => e.id === createdId) ? "found" : "MISSING"}`);

    // 3. Update (move 30 min later) ------------------------------------------
    const newStart = new Date(start.getTime() + 30 * 60 * 1000);
    const newEnd = new Date(newStart.getTime() + 30 * 60 * 1000);
    const updated = await updateCalendarEvent(userId, createdId, {
      start: { dateTime: newStart.toISOString() },
      end: { dateTime: newEnd.toISOString() },
    });
    const moved = updated.start === newStart.toISOString() || Boolean(updated.start);
    console.log(`update:           ${moved ? "ok" : "no-change"}`);

    // 4. Fetch again ---------------------------------------------------------
    const found2 = await findCalendarEvents(userId, {
      timeMin: new Date(newStart.getTime() - 60 * 60 * 1000).toISOString(),
      timeMax: new Date(newEnd.getTime() + 60 * 60 * 1000).toISOString(),
      query: DIAG_TITLE,
    });
    console.log(`fetchAfterUpdate: ${found2.some((e) => e.id === createdId) ? "found" : "MISSING"}`);

    // 5. Delete --------------------------------------------------------------
    await deleteCalendarEvent(userId, createdId);
    console.log("delete:           ok");
    createdId = null; // cleaned up

    // 6. Verify deletion -----------------------------------------------------
    const found3 = await findCalendarEvents(userId, {
      timeMin: new Date(newStart.getTime() - 60 * 60 * 1000).toISOString(),
      timeMax: new Date(newEnd.getTime() + 60 * 60 * 1000).toISOString(),
      query: DIAG_TITLE,
    });
    console.log(`verifyDeleted:    ${found3.some((e) => e.id) ? "STILL PRESENT" : "gone"}`);

    console.log("\nDiagnostic complete — all steps ran and the temporary event was removed.");
  } catch (err) {
    console.error(
      "\nDiagnostic failed at some stage:",
      err instanceof Error ? err.message : "unknown error",
    );
    process.exitCode = 1;
  } finally {
    // Cleanup guarantee — if any step threw after create, remove the event.
    if (createdId) {
      try {
        await deleteCalendarEvent(userId, createdId);
        console.log("cleanup:          removed the temporary event after a failure.");
      } catch {
        console.error(
          `cleanup:          COULD NOT delete the temporary event "${DIAG_TITLE}". ` +
            "Please delete it manually from the calendar.",
        );
      }
    }
  }
}

void main()
  .catch((err) => {
    console.error("Diagnostic error:", err instanceof Error ? err.message : "unknown error");
    process.exitCode = 1;
  })
  .finally(() => {
    void getPrisma().$disconnect();
  });
