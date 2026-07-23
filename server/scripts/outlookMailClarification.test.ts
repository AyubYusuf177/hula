import assert from "node:assert/strict";

import type { CreateProposalInput } from "../src/actions/proposals";
import {
  handleOutlookMailConversation,
  type OutlookConversationDeps,
} from "../src/integrations/providers/microsoft/mailConversation";
import {
  OUTLOOK_MAIL_CLARIFICATION_ACTION_ID,
  parsePendingOutlookMailIntentData,
  type PendingOutlookMailIntent,
  type PendingOutlookMailIntentData,
} from "../src/integrations/providers/microsoft/mailClarification";
import type { OutlookIntent } from "../src/integrations/providers/microsoft/mailIntent";
import type { OutlookMessage } from "../src/integrations/providers/microsoft/mailTypes";

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function message(id: string, options: { draft?: boolean; body?: string } = {}): OutlookMessage {
  const body = options.body ?? "Thursday works.";
  return {
    id,
    conversationId: `conversation-${id}`,
    internetMessageId: null,
    parentFolderId: options.draft ? "drafts" : "inbox",
    subject: "Meeting",
    from: options.draft ? null : { address: "sender@example.com", name: "Sender" },
    sender: options.draft ? null : { address: "sender@example.com", name: "Sender" },
    replyTo: [],
    to: [{ address: "test@example.com", name: null }],
    cc: [],
    bcc: [],
    receivedAt: options.draft ? null : "2026-07-22T10:00:00Z",
    sentAt: null,
    createdAt: "2026-07-22T10:00:00Z",
    modifiedAt: "2026-07-22T10:00:00Z",
    isRead: true,
    isDraft: options.draft === true,
    importance: "normal",
    hasAttachments: false,
    preview: body,
    body,
    bodyType: "text",
    attachments: [],
  };
}

function pendingStore() {
  let current: PendingOutlookMailIntent | null = null;
  let sequence = 0;
  return {
    read: () => current,
    seed(data: PendingOutlookMailIntentData, expired = false): void {
      current = { id: `pending-${++sequence}`, data, expired };
    },
    deps: {
      loadPendingIntent: async () => current,
      createPendingIntent: async (_userId: string, input: {
        intent: OutlookIntent;
        missingFields: PendingOutlookMailIntentData["missingFields"];
        ambiguityReason: string;
        entityRef?: PendingOutlookMailIntentData["entityRef"];
      }) => {
        current = {
          id: `pending-${++sequence}`,
          expired: false,
          data: {
            kind: "outlook_mail_pending_intent",
            intent: input.intent,
            missingFields: input.missingFields,
            ambiguityReason: input.ambiguityReason,
            entityRef: input.entityRef ?? null,
            contextEstablishedAt: Date.parse("2026-07-22T10:00:00Z"),
          },
        };
        return { id: current.id };
      },
      updatePendingIntent: async (_userId: string, id: string, data: PendingOutlookMailIntentData) => {
        assert.equal(current?.id, id);
        current = { id, data, expired: false };
      },
      consumePendingIntent: async (_userId: string, id: string) => {
        if (!current || current.id !== id || current.expired) return false;
        current = null;
        return true;
      },
      expirePendingIntent: async (_userId: string, id: string) => {
        if (current?.id === id) current = null;
      },
    } satisfies Pick<OutlookConversationDeps,
      "loadPendingIntent" | "createPendingIntent" | "updatePendingIntent" |
      "consumePendingIntent" | "expirePendingIntent">,
  };
}

function baseDeps(store: ReturnType<typeof pendingStore>, options: {
  extract: (text: string) => OutlookIntent | null;
  onExecute?: (actionId: string, input: Record<string, unknown>) => void;
  onGet?: (id: string) => OutlookMessage;
}): OutlookConversationDeps {
  return {
    ...store.deps,
    listRecent: async () => [],
    getMicrosoftState: async () => ({ connected: true, accountEmail: "owner@example.com" }),
    getGmailState: async () => ({ connected: true }),
    getTimezone: async () => "Europe/London",
    extract: async ({ text }) => options.extract(text),
    execute: async (_userId, actionId, execution) => {
      const input = execution?.input ?? {};
      options.onExecute?.(actionId, input);
      return {
        ok: true,
        status: "succeeded",
        actionId,
        provider: "microsoft",
        userMessage: actionId === "microsoft.mail.createDraft"
          ? "Draft created in Outlook."
          : "Reply draft created in Outlook.",
        receipt: { draftId: "created-draft", messageId: "created-draft" },
      };
    },
    get: async (_userId, id) => options.onGet?.(id) ?? message(id, { draft: id === "created-draft" }),
    create: async (_userId: string, proposal: CreateProposalInput) => ({
      id: "context", provider: proposal.provider ?? null, actionId: proposal.actionId,
      status: "proposed", riskLevel: proposal.riskLevel,
      confirmationRequired: proposal.confirmationRequired ?? false,
      previewText: proposal.previewText, input: proposal.input ?? null,
      expiresAt: "2026-07-22T11:00:00Z", confirmedAt: null, rejectedAt: null,
      executedAt: null, createdAt: "2026-07-22T10:00:00Z",
    }),
  };
}

async function main(): Promise<void> {
  await check("provider/operation clarification preserves recipient, body, subject, cc, and bcc", async () => {
    const store = pendingStore();
    const executions: Array<{ actionId: string; input: Record<string, unknown> }> = [];
    const deps = baseDeps(store, {
      extract: (text) => text === "An Outlook draft."
        ? {
          provider: "outlook", operation: "create_draft",
          // A clarification-only model call may echo or infer superficial slots;
          // it may never replace trustworthy fields from the original turn.
          to: ["wrong@example.com"], draftBody: "Wrong body",
        }
        : {
          provider: "unknown", operation: "send", to: ["test@example.com"],
          cc: ["cc@example.com"], bcc: ["audit@example.com"],
          draftSubject: "Meeting", draftBody: "Thursday works.",
        },
      onExecute: (actionId, input) => executions.push({ actionId, input }),
    });
    const first = await handleOutlookMailConversation(
      "u",
      "Write test@example.com something saying Thursday works.",
      deps,
    );
    assert.equal(first.handled, true);
    assert.match(first.reply ?? "", /Outlook draft|prepare it to send/i);
    assert.equal(executions.length, 0);
    assert.deepEqual(store.read()?.data.intent.to, ["test@example.com"]);
    assert.equal(store.read()?.data.intent.draftBody, "Thursday works.");

    const second = await handleOutlookMailConversation("u", "An Outlook draft.", deps);
    assert.equal(second.reply, "Draft created in Outlook.");
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.actionId, "microsoft.mail.createDraft");
    assert.deepEqual(executions[0]?.input.to, ["test@example.com"]);
    assert.deepEqual(executions[0]?.input.cc, ["cc@example.com"]);
    assert.deepEqual(executions[0]?.input.bcc, ["audit@example.com"]);
    assert.equal(executions[0]?.input.subject, "Meeting");
    assert.equal(executions[0]?.input.body, "Thursday works.");
  });

  await check("duplicate clarification response cannot create a second draft", async () => {
    const store = pendingStore();
    let creates = 0;
    const deps = baseDeps(store, {
      extract: (text) => text === "Outlook draft"
        ? { provider: "outlook", operation: "create_draft" }
        : { provider: "unknown", operation: "send", to: ["test@example.com"], draftBody: "Hello" },
      onExecute: (actionId) => { if (actionId === "microsoft.mail.createDraft") creates += 1; },
    });
    await handleOutlookMailConversation("u", "Write test@example.com saying hello.", deps);
    await handleOutlookMailConversation("u", "Outlook draft", deps);
    await handleOutlookMailConversation("u", "Outlook draft", deps);
    assert.equal(creates, 1);
  });

  await check("body-only clarification fills only the missing body", async () => {
    const store = pendingStore();
    let input: Record<string, unknown> | null = null;
    const deps = baseDeps(store, {
      extract: (text) => text === "Thursday works for me."
        ? { provider: "not_mail", operation: "not_mail" }
        : { provider: "outlook", operation: "create_draft", to: ["test@example.com"] },
      onExecute: (_actionId, value) => { input = value; },
    });
    const first = await handleOutlookMailConversation("u", "Draft an Outlook email to test@example.com.", deps);
    assert.equal(first.reply, "What should the Outlook message say?");
    const second = await handleOutlookMailConversation("u", "Thursday works for me.", deps);
    assert.equal(second.reply, "Draft created in Outlook.");
    assert.deepEqual(input && input["to"], ["test@example.com"]);
    assert.equal(input && input["body"], "Thursday works for me.");
  });

  await check("stable message reference survives reply-draft clarification", async () => {
    const store = pendingStore();
    const source = message("source-message");
    store.seed({
      kind: "outlook_mail_pending_intent",
      intent: { provider: "unknown", operation: "reply", draftBody: "Thursday works." },
      missingFields: ["provider", "operation"],
      ambiguityReason: "mail_provider_or_operation",
      entityRef: {
        provider: "microsoft", service: "outlook_mail", itemKind: "message",
        id: source.id, conversationId: source.conversationId, parentFolderId: source.parentFolderId,
        senderAddress: source.sender?.address ?? null, senderName: source.sender?.name ?? null,
        subject: source.subject, receivedAt: source.receivedAt, isRead: source.isRead,
      },
      contextEstablishedAt: Date.parse("2026-07-22T10:00:00Z"),
    });
    let mutation: Record<string, unknown> | null = null;
    const gets: string[] = [];
    const deps = baseDeps(store, {
      extract: () => ({ provider: "outlook", operation: "create_reply_draft" }),
      onExecute: (_actionId, input) => { mutation = input; },
      onGet: (id) => {
        gets.push(id);
        return id === source.id ? source : message(id, { draft: true });
      },
    });
    await handleOutlookMailConversation("u", "An Outlook reply draft.", deps);
    assert.equal(mutation && mutation["sourceMessageId"], "source-message");
    assert.equal(mutation && mutation["body"], "Thursday works.");
    assert.equal(gets[0], "source-message");
  });

  await check("unrelated later turn does not consume pending mail state", async () => {
    const store = pendingStore();
    const data: PendingOutlookMailIntentData = {
      kind: "outlook_mail_pending_intent",
      intent: { provider: "unknown", operation: "send", to: ["test@example.com"], draftBody: "Hello" },
      missingFields: ["provider", "operation"], ambiguityReason: "mail_provider_or_operation",
      entityRef: null, contextEstablishedAt: Date.parse("2026-07-22T10:00:00Z"),
    };
    store.seed(data);
    const result = await handleOutlookMailConversation("u", "What is on my calendar tomorrow?", baseDeps(store, {
      extract: () => { throw new Error("mail extraction must not run"); },
    }));
    assert.equal(result.handled, false);
    assert.deepEqual(store.read()?.data, data);
  });

  await check("expired clarification is discarded before interpretation", async () => {
    const store = pendingStore();
    store.seed({
      kind: "outlook_mail_pending_intent",
      intent: { provider: "outlook", operation: "create_draft", to: ["old@example.com"] },
      missingFields: ["body"], ambiguityReason: "required_mail_fields", entityRef: null,
      contextEstablishedAt: Date.parse("2026-07-22T09:00:00Z"),
    }, true);
    const result = await handleOutlookMailConversation("u", "Thursday works.", baseDeps(store, {
      extract: () => { throw new Error("expired mail state must not trigger extraction"); },
    }));
    assert.equal(result.handled, false);
    assert.equal(store.read(), null);
  });

  await check("new self-contained request supersedes stale pending slots", async () => {
    const store = pendingStore();
    store.seed({
      kind: "outlook_mail_pending_intent",
      intent: { provider: "outlook", operation: "create_draft", to: ["old@example.com"], draftBody: "Old body" },
      missingFields: ["subject"], ambiguityReason: "required_mail_fields", entityRef: null,
      contextEstablishedAt: Date.parse("2026-07-22T10:00:00Z"),
    });
    let mutation: Record<string, unknown> | null = null;
    await handleOutlookMailConversation(
      "u",
      "Draft an Outlook email to new@example.com saying New body and do not send it.",
      baseDeps(store, {
        extract: () => ({ provider: "outlook", operation: "create_draft", to: ["new@example.com"], draftBody: "New body" }),
        onExecute: (_actionId, input) => { mutation = input; },
      }),
    );
    assert.deepEqual(mutation && mutation["to"], ["new@example.com"]);
    assert.equal(mutation && mutation["body"], "New body");
  });

  await check("typed pending state round-trip preserves all trusted slots", () => {
    const parsed = parsePendingOutlookMailIntentData({
      kind: "outlook_mail_pending_intent",
      intent: {
        provider: "outlook", operation: "create_draft", to: ["to@example.com"],
        cc: ["cc@example.com"], bcc: ["bcc@example.com"], draftSubject: "Subject",
        draftBody: "Body",
      },
      missingFields: ["operation"], ambiguityReason: "operation_ambiguous", entityRef: null,
      contextEstablishedAt: Date.parse("2026-07-22T10:00:00Z"),
    });
    assert.deepEqual(parsed?.intent.to, ["to@example.com"]);
    assert.deepEqual(parsed?.intent.cc, ["cc@example.com"]);
    assert.deepEqual(parsed?.intent.bcc, ["bcc@example.com"]);
    assert.equal(parsed?.intent.draftSubject, "Subject");
    assert.equal(parsed?.intent.draftBody, "Body");
  });

  await check("pending clarification records use the isolated non-confirmation action identity", () => {
    assert.equal(OUTLOOK_MAIL_CLARIFICATION_ACTION_ID, "microsoft.mail.pendingIntent");
  });

  console.log(`\nOutlook mail clarification tests: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
