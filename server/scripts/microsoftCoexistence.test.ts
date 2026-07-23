import assert from "node:assert/strict";

import { resolveFollowupOwner } from "../src/actions/entityContextArbiter";
import { handleEntityFollowup } from "../src/routes/entityFollowup";
import { handleUnsupportedTeamsRequest } from "../src/routes/inboundRouting";
import { handleOutlookMailConversation } from "../src/integrations/providers/microsoft/mailConversation";
import { handleOutlookCalendarConversation } from "../src/integrations/providers/microsoft/calendarConversation";
import { handleOneDriveConversation } from "../src/integrations/providers/microsoft/oneDriveConversation";
import { normalizeOneDriveItem } from "../src/integrations/providers/microsoft/oneDriveOperations";

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function oneDriveItem() {
  const item = normalizeOneDriveItem({
    id: "atlas", name: "Project Atlas.md", size: 20,
    parentReference: { driveId: "microsoft-drive", id: "root" },
    file: { mimeType: "text/markdown" }, webUrl: "https://onedrive.live.com/atlas",
  });
  assert.ok(item);
  return item;
}

async function main(): Promise<void> {
  await check("mail: Gmail context → explicit Outlook request keeps Outlook", async () => {
    const result = await handleOutlookMailConversation("u", "Find Outlook email from Sarah", {
      getMicrosoftState: async () => ({ connected: true }), getGmailState: async () => ({ connected: true }),
      getContexts: async () => [{ kind: "gmail_email", actionId: "email.entityContext", at: 20, names: [] }],
      extract: async () => ({ provider: "outlook", operation: "search", sender: "Sarah", count: 5 }),
      list: async () => ({ items: [], nextLink: null, hasMore: false, fetchedCount: 0 }), create: async () => ({ id: "ctx" }),
    });
    assert.equal(result.handled, true);
    assert.match(result.reply ?? "", /Outlook/);
  });

  await check("files: Outlook context → explicit Google Drive is declined by OneDrive", async () => {
    const result = await handleOneDriveConversation("u", "Find Google Drive Hula Drive Test", {
      getMicrosoftState: async () => ({ connected: true }), getGoogleState: async () => ({ connected: true }),
      getContexts: async () => [{ kind: "outlook_message", actionId: "microsoft.mail.entityContext", at: 20, names: [] }],
    });
    assert.equal(result.handled, false);
  });

  await check("files: Drive context → explicit OneDrive re-grounds Microsoft file", async () => {
    const result = await handleOneDriveConversation("u", "Find OneDrive file Project Atlas.md", {
      getMicrosoftState: async () => ({ connected: true }), getGoogleState: async () => ({ connected: true }),
      getContexts: async () => [{ kind: "drive_file", actionId: "drive.entityContext", at: 30, names: ["Old"] }],
      extract: async () => ({ provider: "onedrive", operation: "search", query: "Project Atlas.md", count: 5 }),
      search: async () => ({ items: [oneDriveItem()], hasMore: false }), create: async () => ({ id: "ctx" }),
    });
    assert.match(result.reply ?? "", /Project Atlas/);
  });

  await check("calendar: OneDrive context → explicit Outlook Calendar wins", async () => {
    const result = await handleOutlookCalendarConversation("u", "What’s on Outlook calendar tomorrow?", {
      getMicrosoftState: async () => ({ connected: true }), getGoogleState: async () => ({ connected: true }),
      getContexts: async () => [{ kind: "onedrive_file", actionId: "microsoft.onedrive.entityContext", at: 30, names: [] }],
      getTimezone: async () => "Europe/London",
      extract: async () => ({ provider: "outlook_calendar", operation: "list", range: "tomorrow", count: 10 }),
      listEvents: async () => ({ events: [], hasMore: false, fetchedCount: 0 }), create: async () => ({ id: "ctx" }),
    });
    assert.equal(result.handled, true);
    assert.match(result.reply ?? "", /Outlook calendar/);
  });

  await check("calendar: selected Microsoft event routes a bare move back to Microsoft", async () => {
    const result = await handleEntityFollowup("u", "Move it to 4", {
      resolveOwner: async () => ({ kind: "owner", owner: "outlook_calendar_event", reason: "context" }),
      outlookCalendar: async () => ({ handled: true, reply: "Microsoft event proposal" }),
    });
    assert.equal(result.routeSource, "outlookCalendar");
  });

  await check("files: selected OneDrive item routes a bare summary back to Microsoft", async () => {
    const result = await handleEntityFollowup("u", "Summarize it", {
      resolveOwner: async () => ({ kind: "owner", owner: "onedrive_file", reason: "context" }),
      oneDrive: async () => ({ handled: true, reply: "OneDrive summary" }),
    });
    assert.equal(result.routeSource, "oneDrive");
  });

  await check("ambiguity: dual calendars clarify independent of connection order", async () => {
    for (const states of [[true, true], [true, true]] as const) {
      const result = await handleOutlookCalendarConversation("u", "What have I got tomorrow?", {
        getMicrosoftState: async () => ({ connected: states[0] }), getGoogleState: async () => ({ connected: states[1] }), getContexts: async () => [],
      });
      assert.match(result.reply ?? "", /Google Calendar or Outlook Calendar/);
    }
  });

  await check("ambiguity: dual file providers clarify instead of combined search", async () => {
    const result = await handleOneDriveConversation("u", "Find my Project Atlas file", {
      getMicrosoftState: async () => ({ connected: true }), getGoogleState: async () => ({ connected: true }), getContexts: async () => [],
    });
    assert.match(result.reply ?? "", /Google Drive or OneDrive/);
  });

  await check("stale context: expired Outlook event plus bare move has no owner", async () => {
    const owner = await resolveFollowupOwner("u", "Move it", {
      now: new Date("2026-07-21T12:00:00Z"),
      listRecent: async (_u, actionId) => actionId === "microsoft.calendar.entityContext" ? [{
        id: "old", provider: "microsoft", actionId, status: "proposed", riskLevel: "read", confirmationRequired: false,
        previewText: "", input: { kind: "outlook_calendar_entity", ref: { provider: "microsoft", service: "outlook_calendar", eventId: "old", subject: "Old" } },
        expiresAt: "2026-07-21T10:00:00Z", confirmedAt: null, rejectedAt: null, executedAt: null, createdAt: "2026-07-21T09:00:00Z",
      }] : [],
    });
    assert.deepEqual(owner, { kind: "none" });
  });

  await check("Teams chat: explicit unsupported request never routes to stale Slack", async () => {
    const guard = await handleUnsupportedTeamsRequest("u", "Post this in Teams");
    assert.equal(guard.handled, true);
    assert.match(guard.reply ?? "", /Teams chat and channel messaging aren’t supported/);
  });

  console.log(`\nMicrosoft coexistence tests: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
