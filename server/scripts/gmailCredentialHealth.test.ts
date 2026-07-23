import assert from "node:assert/strict";

import { getProvider } from "../src/integrations/catalog";
import { storeRefreshedCredential, type CredentialSecrets } from "../src/integrations/credentials";
import {
  GmailError,
  getValidGmailAccessToken,
  requestWithAuthRetry,
} from "../src/integrations/providers/gmail/client";
import { classifyGmailQuestion } from "../src/integrations/providers/gmail/gmailQuestion";
import { GMAIL_PROVIDER } from "../src/integrations/providers/gmail/types";
import { GOOGLE_CALENDAR_PROVIDER } from "../src/integrations/providers/googleCalendar/types";
import { GOOGLE_DRIVE_PROVIDER } from "../src/integrations/providers/googleDrive/types";
import { toIntegrationStatusItem, type IntegrationConnectionView } from "../src/integrations/connections";
import { resolveOAuthCallbackReplay } from "../src/integrations/oauthReplay";

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function connection(status: IntegrationConnectionView["status"]): IntegrationConnectionView {
  return {
    provider: "gmail", status, displayName: "Gmail", providerAccountEmail: "person@example.com",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"], capabilities: ["email.read"],
    connectedAt: status === "connected" ? "2026-07-21T22:13:53Z" : null,
    disconnectedAt: null, lastSyncedAt: null, updatedAt: "2026-07-21T22:13:53Z",
  };
}

const gmailEntry = {
  provider: "gmail",
  displayName: "Gmail",
  category: "communication" as const,
  status: "available_readonly" as const,
  authType: "oauth2" as const,
  requiredCapabilities: ["email.read"],
};

async function main(): Promise<void> {
  await check("refresh omission preserves the existing refresh token contract", async () => {
    const captured: { value?: CredentialSecrets } = {};
    await storeRefreshedCredential("gmail-connection", {
      accessToken: "new-access", refreshToken: null, expiresIn: 3600,
    }, {
      now: new Date("2026-07-21T22:00:00Z"),
      store: async (_id, secrets) => { captured.value = secrets; },
    });
    assert.equal(captured.value?.accessToken, "new-access");
    assert.equal(captured.value?.refreshToken, undefined);
    assert.equal(captured.value?.accessTokenExpiresAt?.toISOString(), "2026-07-21T23:00:00.000Z");
  });

  await check("a rotated refresh token is persisted with the new access token", async () => {
    const captured: { value?: CredentialSecrets } = {};
    await storeRefreshedCredential("gmail-connection", {
      accessToken: "new-access", refreshToken: "rotated-refresh", expiresIn: 3600,
    }, { store: async (_id, secrets) => { captured.value = secrets; } });
    assert.equal(captured.value?.refreshToken, "rotated-refresh");
    assert.equal(captured.value?.accessToken, "new-access");
  });

  await check("terminal invalid_grant invokes the health transition exactly once", async () => {
    let terminalTransitions = 0;
    await assert.rejects(requestWithAuthRetry({
      getAccessToken: async () => "old",
      refresh: async () => "new",
      doGet: async () => { throw new GmailError("auth_failed", "401", 401); },
      onInvalidGrant: async () => { terminalTransitions += 1; },
    }), (error: unknown) => error instanceof GmailError && error.reason === "invalid_grant");
    assert.equal(terminalTransitions, 1);
  });

  await check("an expired Gmail connection short-circuits before credential reads or refresh attempts", async () => {
    let credentialReads = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(getValidGmailAccessToken("gmail-connection", undefined, {
        getStatus: async () => "expired",
        readSecrets: async () => { credentialReads += 1; return null; },
      }), (error: unknown) => error instanceof GmailError && error.reason === "invalid_grant");
    }
    assert.equal(credentialReads, 0);
  });

  await check("integration status exposes expired as reconnect-required, not connected", () => {
    const status = toIntegrationStatusItem(gmailEntry, connection("expired"));
    assert.equal(status.connectionStatus, "expired");
    assert.equal(status.connected, false);
  });

  await check("successful reconnect restores connected status", () => {
    const status = toIntegrationStatusItem(gmailEntry, connection("connected"));
    assert.equal(status.connectionStatus, "connected");
    assert.equal(status.connected, true);
  });

  await check("Gmail, Calendar, and Drive use distinct provider/credential ownership keys", () => {
    assert.equal(new Set([GMAIL_PROVIDER, GOOGLE_CALENDAR_PROVIDER, GOOGLE_DRIVE_PROVIDER]).size, 3);
    assert.equal(getProvider(GMAIL_PROVIDER)?.provider, "gmail");
    assert.equal(getProvider(GOOGLE_CALENDAR_PROVIDER)?.provider, "google_calendar");
    assert.equal(getProvider(GOOGLE_DRIVE_PROVIDER)?.provider, "google_drive");
  });

  await check("refresh persistence targets only the supplied connection ID", async () => {
    const touched: string[] = [];
    await storeRefreshedCredential("gmail-row", { accessToken: "a", refreshToken: "r" }, {
      store: async (id) => { touched.push(id); },
    });
    assert.deepEqual(touched, ["gmail-row"]);
  });

  await check("a stale replay cannot report success from an older connection", async () => {
    const replay = await resolveOAuthCallbackReplay("state", "gmail", {
      now: new Date("2026-07-21T22:14:00Z"),
      findConsumedState: async () => ({ userId: "u", provider: "gmail", appReturnUrl: null, consumedAt: new Date("2026-07-21T22:13:59Z") }),
      getConnection: async () => ({ status: "connected", connectedAt: new Date("2026-07-14T00:00:00Z") }),
    });
    assert.equal(replay, null);
  });

  await check("Gmail connection status statements do not trigger inbox listing", () => {
    for (const text of ["Gmail is connected", "Gmail is now reconnected.", "Gmail looks fixed"]) {
      assert.equal(classifyGmailQuestion(text), "none");
    }
  });

  await check("normal Gmail read questions still classify after the status guard", () => {
    assert.equal(classifyGmailQuestion("Show my latest Gmail messages"), "latest");
    assert.equal(classifyGmailQuestion("Do I have any emails?"), "latest");
    assert.equal(classifyGmailQuestion("Anything unread in Gmail?"), "unread");
  });

  await check("a healthy unexpired credential performs no refresh", async () => {
    let reads = 0;
    const token = await getValidGmailAccessToken("gmail-connection", undefined, {
      getStatus: async () => "connected",
      readSecrets: async () => {
        reads += 1;
        return { accessToken: "still-valid", refreshToken: "refresh", accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000) };
      },
    });
    assert.equal(token, "still-valid");
    assert.equal(reads, 1);
  });

  console.log(`\nGmail credential-health tests: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
