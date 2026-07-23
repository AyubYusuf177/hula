import assert from "node:assert/strict";

import { handleActionConfirmation } from "../src/actions/confirmations";
import { resolveFollowupOwner } from "../src/actions/entityContextArbiter";
import { executeAction } from "../src/actions/executor";
import type { ActionProposalView, CreateProposalInput } from "../src/actions/proposals";
import { handleOutlookMailConversation } from "../src/integrations/providers/microsoft/mailConversation";
import {
  invalidateOutlookDraftEntity,
  loadGroundedOutlookEntity,
  recordOutlookEntity,
} from "../src/integrations/providers/microsoft/mailContext";
import type { OutlookMessage } from "../src/integrations/providers/microsoft/mailTypes";
import { handleEntityFollowup } from "../src/routes/entityFollowup";
import { routeInboundText } from "../src/routes/inboundRouting";

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function draft(id: string, body = `Body ${id}`, subject = "Disposable draft"): OutlookMessage {
  return {
    id,
    conversationId: `conversation-${id}`,
    internetMessageId: null,
    parentFolderId: "drafts",
    subject,
    from: null,
    sender: null,
    replyTo: [],
    to: [{ name: null, address: "person@example.com" }],
    cc: [], bcc: [], receivedAt: null, sentAt: null,
    createdAt: "2026-07-21T22:00:00Z", modifiedAt: "2026-07-21T22:00:00Z",
    isRead: true, isDraft: true, importance: "normal", hasAttachments: false,
    preview: body, body, bodyType: "text", attachments: [],
  };
}

function memory(now = new Date("2026-07-21T22:00:00Z")) {
  const rows: ActionProposalView[] = [];
  let sequence = 0;
  const store = {
    now,
    create: async (_userId: string, input: CreateProposalInput) => {
      sequence += 1;
      const row: ActionProposalView = {
        id: `row-${sequence}`, provider: input.provider ?? null, actionId: input.actionId,
        status: "proposed", riskLevel: input.riskLevel,
        confirmationRequired: input.confirmationRequired ?? true,
        previewText: input.previewText, input: input.input ?? null,
        expiresAt: new Date(now.getTime() + (input.ttlMs ?? 600_000)).toISOString(),
        confirmedAt: null, rejectedAt: null, executedAt: null,
        createdAt: new Date(now.getTime() + sequence).toISOString(),
      };
      rows.unshift(row);
      return row;
    },
    listRecent: async (_userId: string, actionId: string) => rows.filter((row) => row.actionId === actionId),
  };
  return { rows, store };
}

function connected() {
  return {
    getMicrosoftState: async () => ({ connected: true, accountEmail: "owner@example.com" }),
    getGmailState: async () => ({ connected: false }),
  };
}

async function createThroughConversation(state: ReturnType<typeof memory>, item: OutlookMessage) {
  let writes = 0;
  const result = await handleOutlookMailConversation("u", "Prepare an Outlook draft for person@example.com and do not send it.", {
    ...connected(), ...state.store,
    getContexts: async () => [],
    extract: async () => ({ provider: "outlook", operation: "create_draft", to: ["person@example.com"], draftSubject: item.subject, draftBody: item.body }),
    execute: async (_userId, actionId) => {
      assert.equal(actionId, "microsoft.mail.createDraft");
      writes += 1;
      return { ok: true, status: "succeeded", actionId, provider: "microsoft", userMessage: "Draft created in Outlook.", receipt: { draftId: item.id } };
    },
    get: async (_userId, id) => { assert.equal(id, item.id); return item; },
  });
  return { result, writes };
}

const microsoftPolicy = {
  connectedProviders: ["microsoft"],
  grantedScopesByProvider: { microsoft: ["Mail.ReadWrite", "Mail.Send"] },
  capabilitiesByProvider: { microsoft: ["outlook_mail.read", "outlook_mail.write", "outlook_mail.send"] },
};

async function main(): Promise<void> {
  await check("create draft reads back the provider ID and makes that exact draft active", async () => {
    const state = memory();
    const created = await createThroughConversation(state, draft("A"));
    assert.equal(created.writes, 1);
    assert.equal((await loadGroundedOutlookEntity("u", "draft", state.store))?.ref.id, "A");
  });

  await check("edit follow-up resolves and mutates authoritative draft A only", async () => {
    const state = memory();
    await recordOutlookEntity("u", draft("A"), state.store);
    const captured: { input?: Record<string, unknown> } = {};
    let gets = 0;
    const result = await handleOutlookMailConversation("u", "Change that draft to say 4pm instead.", {
      ...connected(), ...state.store, arbitrated: true,
      getContexts: async () => [{ kind: "outlook_draft", actionId: "microsoft.mail.lastDraft", at: 1, names: [] }],
      extract: async () => ({ provider: "outlook", operation: "update_draft", draftBody: "4pm instead." }),
      get: async (_userId, id) => { gets += 1; assert.equal(id, "A"); return draft("A"); },
      execute: async (_userId, actionId, options) => {
        assert.equal(actionId, "microsoft.mail.updateDraft");
        captured.input = options?.input;
        return { ok: true, status: "succeeded", actionId, provider: "microsoft", userMessage: "Updated.", receipt: { draftId: "A" } };
      },
    });
    assert.equal(result.handled, true);
    assert.equal(captured.input?.draftId, "A");
    assert.ok(gets >= 2, "target and post-write context both use authoritative reads");
  });

  await check("creating draft B replaces A as the active draft", async () => {
    const state = memory();
    await createThroughConversation(state, draft("A"));
    await createThroughConversation(state, draft("B"));
    assert.equal((await loadGroundedOutlookEntity("u", "draft", state.store))?.ref.id, "B");
  });

  await check("full inbound route sends Delete that draft to Outlook B and never memory", async () => {
    const state = memory();
    await recordOutlookEntity("u", draft("A"), state.store);
    await recordOutlookEntity("u", draft("B"), state.store);
    let memoryCalls = 0;
    const captured: { proposal?: CreateProposalInput } = {};
    const decline = async () => ({ handled: false as const });
    const outlook = (userId: string, text: string | undefined) => handleOutlookMailConversation(userId, text, {
      ...connected(), ...state.store, arbitrated: true,
      getContexts: async () => [{ kind: "outlook_draft", actionId: "microsoft.mail.lastDraft", at: 2, names: [] }],
      extract: async () => ({ provider: "outlook", operation: "delete_draft" }),
      get: async (_userId, id) => { assert.equal(id, "B"); return draft("B"); },
      getActiveProposal: async () => null,
      propose: async (_userId, input) => { captured.proposal = input; },
    });
    const routed = await routeInboundText("u", "Delete that draft.", {
      transportKeyword: decline,
      confirmation: decline,
      entityFollowup: (userId, text) => handleEntityFollowup(userId, text, {
        listRecent: state.store.listRecent,
        now: state.store.now,
        outlook,
      }),
      memory: async () => { memoryCalls += 1; return { handled: true, reply: "memory stole it" }; },
      pendingReprompt: decline,
    });
    assert.equal(routed?.source, "outlookMail");
    assert.equal(captured.proposal?.input?.draftId, "B");
    assert.equal(memoryCalls, 0);
  });

  await check("verified draft delete records an invalidation tombstone", async () => {
    let invalidated = "";
    const result = await executeAction("u", "microsoft.mail.deleteDraft", {
      userConfirmed: true, input: { operation: "delete_draft", draftId: "B" },
    }, {
      buildContext: async () => ({ ...microsoftPolicy, userConfirmed: true }),
      record: async () => "execution",
      executeOutlookMailMutation: async () => ({ operation: "delete_draft", draftId: "B", messageId: "B", conversationId: "c", verification: "verified" }),
      invalidateOutlookDraftEntity: async (_userId, id) => { invalidated = id; },
    });
    assert.equal(result.ok, true);
    assert.equal(invalidated, "B");
  });

  await check("verified send-draft invalidates the unsent identity", async () => {
    let invalidated = "";
    const result = await executeAction("u", "microsoft.mail.send", {
      userConfirmed: true, input: { operation: "send_draft", draftId: "A" },
    }, {
      buildContext: async () => ({ ...microsoftPolicy, userConfirmed: true }),
      record: async () => "execution",
      executeOutlookMailMutation: async () => ({ operation: "send_draft", draftId: "A", messageId: "sent-A", conversationId: "c", verification: "verified" }),
      invalidateOutlookDraftEntity: async (_userId, id) => { invalidated = id; },
    });
    assert.equal(result.ok, true);
    assert.equal(invalidated, "A");
  });

  await check("a sent/deleted tombstone prevents fallback to any older draft", async () => {
    const state = memory();
    await recordOutlookEntity("u", draft("A"), state.store);
    await recordOutlookEntity("u", draft("B"), state.store);
    await invalidateOutlookDraftEntity("u", "B", state.store);
    assert.equal(await loadGroundedOutlookEntity("u", "draft", state.store), null);
    assert.equal((await resolveFollowupOwner("u", "Delete that draft.", { listRecent: state.store.listRecent, now: state.store.now })).kind, "none");
  });

  await check("delete then follow-up fails closed without fabricating a live draft", async () => {
    const state = memory();
    await recordOutlookEntity("u", draft("B"), state.store);
    await invalidateOutlookDraftEntity("u", "B", state.store);
    const result = await handleEntityFollowup("u", "Delete that draft.", {
      listRecent: state.store.listRecent,
      now: state.store.now,
    });
    assert.equal(result.handled, true);
    assert.match(result.reply ?? "", /which one/i);
  });

  await check("multiple similar drafts remain distinguished by immutable provider ID", async () => {
    const state = memory();
    await recordOutlookEntity("u", draft("A", "first", "Same subject"), state.store);
    await recordOutlookEntity("u", draft("B", "second", "Same subject"), state.store);
    const active = await loadGroundedOutlookEntity("u", "draft", state.store);
    assert.equal(active?.ref.id, "B");
    assert.equal(active?.message?.body, "second");
  });

  await check("duplicate confirmation sends one draft and returns an idempotent receipt", async () => {
    const proposal: ActionProposalView = {
      id: "proposal", provider: "microsoft", actionId: "microsoft.mail.send", status: "proposed", riskLevel: "send", confirmationRequired: true,
      previewText: "Send draft?", input: { operation: "send_draft", draftId: "B" }, expiresAt: "2026-07-22T12:00:00Z", confirmedAt: null, rejectedAt: null, executedAt: null, createdAt: "2026-07-21T22:00:00Z",
    };
    let active = true;
    let sends = 0;
    const deps = {
      getActiveProposal: async () => active ? proposal : null,
      getRecentResolvedProposal: async () => ({ ...proposal, status: "executed" as const, executedAt: "2026-07-21T22:00:01Z" }),
      confirmProposal: async () => { active = false; return { ...proposal, status: "confirmed" as const }; },
      finalizeProposal: async () => {},
      executeAction: async () => { sends += 1; return { ok: true, status: "succeeded" as const, actionId: proposal.actionId, userMessage: "Sent." }; },
    };
    await handleActionConfirmation("u", "Yes", deps);
    const duplicate = await handleActionConfirmation("u", "Yes", deps);
    assert.equal(sends, 1);
    assert.equal(duplicate.handled, true);
    assert.match(duplicate.reply ?? "", /already completed/);
  });

  console.log(`\nOutlook draft lifecycle hardening tests: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
