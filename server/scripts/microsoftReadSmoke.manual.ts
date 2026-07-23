import { analyzeOutlookMessages } from "../src/integrations/providers/microsoft/mailIntelligence";
import { extractOutlookIntent, type OutlookIntent } from "../src/integrations/providers/microsoft/mailIntent";
import type { OutlookMessage } from "../src/integrations/providers/microsoft/mailTypes";
import { extractOutlookCalendarIntent } from "../src/integrations/providers/microsoft/calendarIntent";
import { analyzeDriveDocument } from "../src/integrations/providers/googleDrive/documentIntelligence";
import type { DriveDocumentContent } from "../src/integrations/providers/googleDrive/types";

function message(body: string): OutlookMessage {
  return {
    id: "synthetic-outlook", conversationId: "synthetic-conversation", internetMessageId: null, parentFolderId: "synthetic",
    subject: "Synthetic smoke", from: { address: "sender@example.test", name: "Synthetic Sender" }, sender: null,
    replyTo: [], to: [{ address: "owner@example.test", name: null }], cc: [], bcc: [], receivedAt: "2026-07-21T12:00:00Z",
    sentAt: null, createdAt: "2026-07-21T12:00:00Z", modifiedAt: "2026-07-21T12:00:00Z", isRead: false,
    isDraft: false, importance: "normal", hasAttachments: false, preview: body, body, bodyType: "text", attachments: [],
  };
}

function oneDriveEvidence(): DriveDocumentContent {
  const text = "Project Atlas launches on Friday. Maya must approve the final checklist before launch.";
  return {
    fileId: "synthetic-drive:synthetic-item",
    title: "Synthetic OneDrive Project Atlas.md",
    mimeType: "text/markdown",
    sections: text.split(" ").length ? [{ kind: "paragraph", text }] : [],
    text,
    originalCharacters: text.length,
    processedCharacters: text.length,
    truncated: false,
    complete: true,
  };
}

async function main(): Promise<void> {
  let passed = 0;
  const outlook = await analyzeOutlookMessages({
    question: "What’s the gist and is anything required?",
    messages: [message("Please review the launch checklist by Friday.")],
  });
  if (!/review|checklist|Friday/i.test(outlook.answer + outlook.explicitActionItems.join(" ") + outlook.explicitDeadlines.join(" "))) {
    throw new Error("outlook_smoke_not_grounded");
  }
  console.log("  ok - Outlook grounded analysis");
  passed += 1;

  async function mailIntent(
    label: string,
    text: string,
    operation: OutlookIntent["operation"],
    hasContext: boolean,
    validate?: (intent: OutlookIntent) => boolean,
  ): Promise<void> {
    const intent = await extractOutlookIntent({ text, hasContext, timezone: "Europe/London" });
    if (!intent || intent.provider !== "outlook" || intent.operation !== operation || (validate && !validate(intent))) {
      throw new Error(`outlook_mail_intent_smoke_failed:${label}`);
    }
    console.log(`  ok - Outlook mail intent: ${label}`);
    passed += 1;
  }

  await mailIntent(
    "create disposable draft",
    "Draft an Outlook email to test@example.com saying this is disposable and do not send it.",
    "create_draft",
    false,
    (intent) =>
      intent.to?.[0] === "test@example.com" &&
      intent.draftBody?.toLowerCase().includes("disposable") === true &&
      Boolean(intent.draftSubject?.trim()),
  );
  await mailIntent(
    "create prepared draft",
    "Prepare an Outlook note for test@example.com saying Thursday works, but don’t send it.",
    "create_draft",
    false,
    (intent) =>
      intent.to?.[0] === "test@example.com" &&
      intent.draftBody?.toLowerCase().includes("thursday works") === true &&
      Boolean(intent.draftSubject?.trim()),
  );
  await mailIntent(
    "compose unsent draft",
    "Compose an Outlook note to test@example.com but leave it as a draft.",
    "create_draft",
    false,
  );
  await mailIntent(
    "write send",
    "Write test@example.com something saying Thursday works.",
    "send",
    true,
    (intent) =>
      intent.to?.[0] === "test@example.com" &&
      intent.draftBody?.toLowerCase().includes("thursday works") === true &&
      Boolean(intent.draftSubject?.trim()),
  );
  await mailIntent(
    "send",
    "Email test@example.com from Outlook saying hello.",
    "send",
    false,
    (intent) => intent.to?.[0] === "test@example.com" && intent.draftBody?.toLowerCase().includes("hello") === true,
  );
  await mailIntent("reply", "Write back saying Thursday works.", "reply", true, (intent) => Boolean(intent.draftBody));
  await mailIntent(
    "forward",
    "Pass this Outlook message on to person@example.com.",
    "forward",
    true,
    (intent) => intent.to?.[0] === "person@example.com",
  );
  await mailIntent("mark unread", "Make this unread again.", "mark_unread", true);
  await mailIntent("mark read", "I’ve seen that Outlook email.", "mark_read", true);

  const revision = await extractOutlookIntent({
    text: "Make the pending email a draft instead.",
    hasContext: true,
    pendingMailOperation: "send",
    pendingMailProvider: "outlook",
    timezone: "Europe/London",
  });
  if (
    !revision ||
    revision.provider !== "outlook" ||
    revision.operation !== "create_draft" ||
    revision.proposalRevision !== true
  ) {
    throw new Error("outlook_mail_intent_smoke_failed:proposal_revision");
  }
  console.log("  ok - Outlook mail intent: proposal revision to draft");
  passed += 1;

  const calendar = await extractOutlookCalendarIntent({
    text: "What have I got in my Outlook calendar tomorrow?",
    now: new Date("2026-07-21T12:00:00Z"),
    timeZone: "Europe/London",
    hasContext: false,
  });
  if (calendar?.provider !== "outlook_calendar" || calendar.operation !== "list") {
    throw new Error("calendar_smoke_intent_failed");
  }
  console.log("  ok - Outlook Calendar semantic interpretation");
  passed += 1;

  const oneDrive = await analyzeDriveDocument({
    content: oneDriveEvidence(),
    mode: "question",
    question: "Who must approve the checklist?",
  });
  if (!/Maya/i.test(oneDrive)) throw new Error("onedrive_smoke_not_grounded");
  console.log("  ok - OneDrive supported-text grounded Q&A");
  passed += 1;

  console.log(`Microsoft real Anthropic read-only smoke: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "microsoft_read_smoke_failed");
  process.exitCode = 1;
});
