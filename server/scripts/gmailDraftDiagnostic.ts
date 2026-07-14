import { getPrisma } from "../src/db/prisma";
import { getConnectionForUserProvider } from "../src/integrations/connections";
import {
  createGmailDraft,
  deleteGmailDraft,
  getGmailDraft,
  sendGmailMessage,
} from "../src/integrations/providers/gmail/drafts";
import { fetchGmailIdentity } from "../src/integrations/providers/gmail/messages";
import {
  getValidGmailAccessToken,
  getGmailConnection,
} from "../src/integrations/providers/gmail/client";
import { buildGmailRawPayload } from "../src/integrations/providers/gmail/mime";
import { GMAIL_COMPOSE_SCOPE, GMAIL_PROVIDER } from "../src/integrations/providers/gmail/types";

/**
 * Manual REAL Gmail WRITE diagnostic (Section 16).
 *
 * SAFE BY DEFAULT: it verifies one already-connected, compose-scoped user can
 * create a real Gmail draft, reads it back, and DELETES the temporary draft during
 * cleanup. It does NOT send an email unless you explicitly opt in.
 *
 * It prints ONLY booleans, safe status text, and the temporary draft's own title —
 * NEVER a token, encrypted credential, raw Gmail body, raw MIME, or OAuth secret.
 *
 * Usage (from the `server/` directory):
 *
 *   npm run test:gmail-write-real -- <clerkUserId | hulaUserId>
 *   npm run test:gmail-write-real -- <clerkUserId | hulaUserId> --send you@example.com
 *
 * The DEFAULT run only drafts + deletes. `--send <recipient>` ACTUALLY sends one
 * real email to the recipient you name (use your own address) — a deliberate,
 * separately-flagged action. Requires DATABASE_URL, INTEGRATION_TOKEN_ENCRYPTION_KEY,
 * and the GOOGLE_OAUTH_* env. The user must have RECONNECTED Gmail since Section 16
 * so the gmail.compose scope is granted. Hits the real Gmail API for that one user.
 */

const DRAFT_TITLE = "Hula Gmail Draft — Safe to Delete";

/** Resolve an existing Hula user id from either a Hula id or a Clerk id. */
async function resolveUserId(arg: string): Promise<string | null> {
  const user = await getPrisma().user.findFirst({
    where: { OR: [{ id: arg }, { clerkUserId: arg }] },
    select: { id: true },
  });
  return user?.id ?? null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const idArg = args.find((a) => !a.startsWith("--"))?.trim();
  const sendIndex = args.indexOf("--send");
  const sendRecipient =
    sendIndex !== -1 ? (args[sendIndex + 1] ?? "").trim() : "";
  const doSend = sendIndex !== -1;

  if (!idArg) {
    console.error(
      "Usage: npm run test:gmail-write-real -- <clerkUserId | hulaUserId> [--send <recipient>]",
    );
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — cannot load the user's connection.");
    process.exitCode = 1;
    return;
  }
  if (doSend && !sendRecipient) {
    console.error("--send requires a recipient address you control (e.g. --send you@example.com).");
    process.exitCode = 1;
    return;
  }

  const userId = await resolveUserId(idArg);
  if (!userId) {
    console.error("No Hula user found for the supplied id.");
    process.exitCode = 1;
    return;
  }

  console.log("Gmail — REAL draft/send diagnostic\n");

  // Pre-flight: connected + compose scope (never prints tokens).
  const conn = await getConnectionForUserProvider(userId, GMAIL_PROVIDER);
  const connected = conn?.status === "connected";
  const composeScope = Boolean(conn?.grantedScopes.includes(GMAIL_COMPOSE_SCOPE));
  console.log(`connected:         ${connected}`);
  console.log(`composeScopeGrant: ${composeScope}`);
  if (!connected) {
    console.error("\nUser has no connected Gmail. Connect it in Hula first.");
    process.exitCode = 1;
    return;
  }
  if (!composeScope) {
    console.error(
      "\nConnection is read-only (no gmail.compose scope). The user must RECONNECT " +
        "Gmail in Hula to grant compose access before drafts/sends will work.",
    );
    process.exitCode = 1;
    return;
  }

  // Determine the draft recipient: the authenticated user's own address.
  let selfEmail: string | null = null;
  try {
    const gmailConn = await getGmailConnection(userId);
    if (gmailConn) {
      const token = await getValidGmailAccessToken(gmailConn.id);
      const identity = await fetchGmailIdentity(token);
      selfEmail = identity.email;
    }
  } catch {
    selfEmail = null;
  }
  const draftTo = selfEmail ?? conn?.providerAccountEmail ?? null;
  if (!draftTo) {
    console.error("\nCould not resolve the account's own email for the test draft.");
    process.exitCode = 1;
    return;
  }
  console.log(`draftRecipient:    ${draftTo}`);

  let createdDraftId: string | null = null;
  try {
    // 1. Create a fully-populated temporary draft --------------------------
    const payload = buildGmailRawPayload({
      to: draftTo,
      subject: DRAFT_TITLE,
      body:
        "This is a temporary draft created by the Hula Section 16 diagnostic. " +
        "It is safe to delete.",
    });
    const draft = await createGmailDraft(userId, payload);
    createdDraftId = draft.draftId;
    console.log(`\ncreateDraft:       ok`);

    // 2. Fetch it back ------------------------------------------------------
    const fetched = await getGmailDraft(userId, draft.draftId);
    console.log(`fetchDraft:        ${fetched.id === draft.draftId ? "found" : "MISSING"}`);

    // 3. Optional real send (explicit opt-in only) --------------------------
    if (doSend) {
      console.log(
        `\n!! --send set: sending ONE real email to ${sendRecipient} !!`,
      );
      const sendPayload = buildGmailRawPayload({
        to: sendRecipient,
        subject: DRAFT_TITLE,
        body: "This is a REAL test email from the Hula Section 16 diagnostic.",
      });
      const sent = await sendGmailMessage(userId, sendPayload);
      console.log(`send:              ${sent.messageId ? "ok" : "FAILED"}`);
    } else {
      console.log("send:              skipped (safe default — pass --send <you> to send)");
    }

    console.log("\nDiagnostic complete.");
  } catch (err) {
    console.error(
      "\nDiagnostic failed at some stage:",
      err instanceof Error ? err.message : "unknown error",
    );
    process.exitCode = 1;
  } finally {
    // Cleanup guarantee — always remove the temporary draft.
    if (createdDraftId) {
      try {
        await deleteGmailDraft(userId, createdDraftId);
        console.log("cleanup:           removed the temporary draft.");
      } catch {
        console.error(
          `cleanup:           COULD NOT delete the temporary draft "${DRAFT_TITLE}". ` +
            "Please delete it manually from Gmail Drafts.",
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
