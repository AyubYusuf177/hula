import assert from "node:assert/strict";

import { explicitEntityKinds, resolveFollowupOwner } from "../src/actions/entityContextArbiter";
import type { ActionProposalView, CreateProposalInput } from "../src/actions/proposals";
import { handleOutlookMailConversation } from "../src/integrations/providers/microsoft/mailConversation";
import { explicitMailProvider } from "../src/integrations/providers/microsoft/mailIntent";
import { handleEntityFollowup } from "../src/routes/entityFollowup";
import { routeInboundText, type InboundRouterDeps } from "../src/routes/inboundRouting";
import type { OutlookMessage } from "../src/integrations/providers/microsoft/mailTypes";

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const cases = [
  {
    text: "Draft an Outlook email to test@example.com saying this is disposable and do not send it.",
    to: "test@example.com",
    body: "this is disposable",
  },
  {
    text: "Draft an Outlook email to sarah@example.com saying Thursday works.",
    to: "sarah@example.com",
    body: "Thursday works.",
  },
  {
    text: "Write maya@example.com an Outlook email saying I’ll call tomorrow, but leave it as a draft.",
    to: "maya@example.com",
    body: "I’ll call tomorrow.",
  },
  {
    text: "Prepare an Outlook message for john@example.com saying the launch is approved.",
    to: "john@example.com",
    body: "The launch is approved.",
  },
  {
    text: "Compose an email in Outlook to maya@example.com with subject Update saying we shipped, don’t send it yet.",
    to: "maya@example.com",
    body: "We shipped.",
    subject: "Update",
  },
  {
    text: "Make me an Outlook draft to alex@example.com saying 4pm works.",
    to: "alex@example.com",
    body: "4pm works.",
  },
  {
    text: "Write this as an Outlook email to sam@example.com but don’t send it; say the checklist is approved.",
    to: "sam@example.com",
    body: "The checklist is approved.",
  },
  {
    text: "OUTLOOK: prepare a note for team@example.com — body: Ready for launch. Leave unsent.",
    to: "team@example.com",
    body: "Ready for launch.",
  },
] as const;

function draft(id: string, to: string, body: string, subject = "(No subject)"): OutlookMessage {
  return {
    id, conversationId: `conversation-${id}`, internetMessageId: null, parentFolderId: "drafts",
    subject, from: null, sender: null, replyTo: [], to: [{ address: to, name: null }], cc: [], bcc: [],
    receivedAt: null, sentAt: null, createdAt: "2026-07-22T12:00:00Z", modifiedAt: "2026-07-22T12:00:00Z",
    isRead: true, isDraft: true, importance: "normal", hasAttachments: false,
    preview: body, body, bodyType: "text", attachments: [],
  };
}

async function routeCase(input: typeof cases[number]): Promise<{
  route: string | null;
  creates: number;
  sends: number;
  mutation: Record<string, unknown> | null;
  reply: string | undefined;
}> {
  const contextRows: ActionProposalView[] = [];
  let creates = 0;
  let sends = 0;
  const captured: { mutation?: Record<string, unknown> } = {};
  const decline = async () => ({ handled: false as const });
  const outlook = (userId: string, text: string | undefined) => handleOutlookMailConversation(userId, text, {
    arbitrated: undefined,
    listRecent: async () => contextRows,
    create: async (_userId: string, proposal: CreateProposalInput) => {
      contextRows.unshift({
        id: `context-${contextRows.length + 1}`, provider: proposal.provider ?? null, actionId: proposal.actionId,
        status: "proposed", riskLevel: proposal.riskLevel, confirmationRequired: proposal.confirmationRequired ?? false,
        previewText: proposal.previewText, input: proposal.input ?? null,
        expiresAt: "2026-07-22T13:00:00Z", confirmedAt: null, rejectedAt: null, executedAt: null,
        createdAt: "2026-07-22T12:00:00Z",
      });
      return contextRows[0]!;
    },
    loadPendingIntent: async () => null,
    getMicrosoftState: async () => ({ connected: true, accountEmail: "owner@example.com" }),
    getGmailState: async () => ({ connected: true }),
    getTimezone: async () => "Europe/London",
    generateIntent: async () => JSON.stringify({
      provider: "outlook",
      operation: "create_draft",
      to: [input.to],
      cc: null,
      bcc: null,
      draftBody: input.body,
      draftSubject: "subject" in input ? input.subject : null,
    }),
    execute: async (_userId, actionId, options) => {
      if (actionId === "microsoft.mail.createDraft") creates += 1;
      if (actionId === "microsoft.mail.send") sends += 1;
      captured.mutation = options?.input ?? {};
      return {
        ok: true,
        status: "succeeded",
        actionId,
        provider: "microsoft",
        userMessage: "Draft created in Outlook.",
        receipt: { draftId: "draft-1", messageId: "draft-1" },
      };
    },
    get: async () => draft("draft-1", input.to, input.body, "subject" in input ? input.subject : undefined),
  });
  const deps: InboundRouterDeps = {
    transportKeyword: decline,
    confirmation: decline,
    entityFollowup: (userId, text) => handleEntityFollowup(userId, text, {
      listRecent: async () => contextRows,
      outlook: (u, t) => outlook(u, t),
    }),
    memory: decline,
    reminder: decline,
    teamsUnsupported: decline,
    slack: decline,
    oneDrive: decline,
    drive: decline,
    notion: decline,
    asanaWrite: decline,
    asanaRead: decline,
    outlookMail: outlook,
  };
  const routed = await routeInboundText("u", input.text, deps);
  return {
    route: routed?.source ?? null,
    creates,
    sends,
    mutation: captured.mutation ?? null,
    reply: routed?.reply,
  };
}

async function main(): Promise<void> {
  await check("recipient domains are data and never become Gmail/Outlook provider signals", async () => {
    assert.deepEqual(explicitEntityKinds("Draft an Outlook email to test@gmail.com and do not send it"), ["outlook_draft"]);
    assert.equal((await resolveFollowupOwner("u", "Draft an Outlook email to test@gmail.com and do not send it", {
      listRecent: async () => [],
    })).kind, "owner");
    assert.deepEqual(explicitEntityKinds("Email person@outlook.com saying hello"), []);
    assert.equal(explicitMailProvider("Write test@gmail.com something saying hello."), null);
    assert.equal(explicitMailProvider("Write an Outlook email to test@gmail.com saying hello."), "outlook");
    assert.equal(explicitMailProvider("Write a Gmail email to test@outlook.com saying hello."), "gmail");
  });

  for (const [index, input] of cases.entries()) {
    await check(`production route create-draft paraphrase ${index + 1}`, async () => {
      const result = await routeCase(input);
      assert.equal(result.route, "outlookMail");
      assert.equal(result.creates, 1);
      assert.equal(result.sends, 0);
      assert.equal(result.mutation?.operation, "create_draft");
      assert.deepEqual(result.mutation?.to, [input.to]);
      assert.equal(result.mutation?.body, input.body);
      assert.doesNotMatch(result.reply ?? "", /Do you mean|What should .* say|which provider/i);
    });
  }

  await check("explicit Outlook send remains confirmation-gated and never becomes a draft", async () => {
    let proposals = 0;
    let immediateWrites = 0;
    const result = await handleOutlookMailConversation("u", "Email test@example.com from Outlook saying hello.", {
      listRecent: async () => [],
      loadPendingIntent: async () => null,
      getMicrosoftState: async () => ({ connected: true, accountEmail: "owner@example.com" }),
      getGmailState: async () => ({ connected: true }),
      getTimezone: async () => "Europe/London",
      generateIntent: async () => JSON.stringify({ provider: "outlook", operation: "send", to: ["test@example.com"], draftBody: "hello" }),
      getActiveProposal: async () => null,
      propose: async () => { proposals += 1; },
      execute: async () => { immediateWrites += 1; throw new Error("send must not execute before confirmation"); },
    });
    assert.equal(result.handled, true);
    assert.equal(proposals, 1);
    assert.equal(immediateWrites, 0);
    assert.match(result.reply ?? "", /Reply Yes/);
  });

  await check("fresh Outlook draft ownership still beats generic memory deletion", async () => {
    const row: ActionProposalView = {
      id: "draft-context", provider: "microsoft", actionId: "microsoft.mail.lastDraft", status: "proposed",
      riskLevel: "read", confirmationRequired: false, previewText: "draft", expiresAt: "2026-07-22T13:00:00Z",
      confirmedAt: null, rejectedAt: null, executedAt: null, createdAt: "2026-07-22T12:00:00Z",
      input: {
        kind: "outlook_entity", contextEstablishedAt: Date.parse("2026-07-22T12:00:00Z"),
        ref: { provider: "microsoft", service: "outlook_mail", itemKind: "draft", id: "draft-B", conversationId: null, parentFolderId: "drafts", senderAddress: null, senderName: null, subject: "B", receivedAt: null, isRead: true },
      },
    };
    const owner = await resolveFollowupOwner("u", "Delete that draft.", {
      now: new Date("2026-07-22T12:01:00Z"),
      listRecent: async (_u, actionId) => actionId === "microsoft.mail.lastDraft" ? [row] : [],
    });
    assert.deepEqual(owner, { kind: "owner", owner: "outlook_draft", reason: "context" });
  });

  console.log(`\nOutlook draft intent route tests: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
