import assert from "node:assert/strict";

import { handleActionConfirmation } from "../src/actions/confirmations";
import { executeAction, type ExecuteActionOptions } from "../src/actions/executor";
import type { ActionProposalView, CreateProposalInput } from "../src/actions/proposals";
import {
  completeOutlookSubject,
  fallbackOutlookSubject,
} from "../src/integrations/providers/microsoft/mailComposition";
import {
  handleOutlookMailConversation,
  handleOutlookMailProposalRevision,
  type OutlookConversationDeps,
} from "../src/integrations/providers/microsoft/mailConversation";
import {
  invalidateOutlookDraftEntity,
  loadGroundedOutlookEntity,
  type OutlookContextStore,
} from "../src/integrations/providers/microsoft/mailContext";
import { executeOutlookMailMutation } from "../src/integrations/providers/microsoft/mailOperations";
import type { MicrosoftGraphRequestOptions } from "../src/integrations/providers/microsoft/graph";
import { MicrosoftGraphError } from "../src/integrations/providers/microsoft/graph";
import { handleEntityFollowup } from "../src/routes/entityFollowup";
import { routeInboundText, type InboundRouterDeps } from "../src/routes/inboundRouting";

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function rawDraft(
  id: string,
  input: { to: string[]; subject: string; body: string },
): Record<string, unknown> {
  return {
    id,
    conversationId: `conversation-${id}`,
    parentFolderId: "drafts",
    subject: input.subject,
    from: null,
    sender: null,
    replyTo: [],
    toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
    ccRecipients: [],
    bccRecipients: [],
    receivedDateTime: null,
    sentDateTime: null,
    createdDateTime: "2026-07-23T09:00:00.000Z",
    lastModifiedDateTime: "2026-07-23T09:00:00.000Z",
    isRead: true,
    isDraft: true,
    importance: "normal",
    hasAttachments: false,
    bodyPreview: input.body,
    body: { contentType: "text", content: input.body },
  };
}

function contextMemory(now = new Date("2026-07-23T09:00:00.000Z")) {
  const rows: ActionProposalView[] = [];
  let sequence = 0;
  const store: OutlookContextStore = {
    now,
    create: async (_userId: string, input: CreateProposalInput) => {
      const row: ActionProposalView = {
        id: `context-${++sequence}`,
        provider: input.provider ?? null,
        actionId: input.actionId,
        status: "proposed",
        riskLevel: input.riskLevel,
        confirmationRequired: input.confirmationRequired ?? false,
        previewText: input.previewText,
        input: input.input ?? null,
        expiresAt: new Date(now.getTime() + (input.ttlMs ?? 600_000)).toISOString(),
        confirmedAt: null,
        rejectedAt: null,
        executedAt: null,
        createdAt: new Date(now.getTime() + sequence).toISOString(),
      };
      rows.unshift(row);
      return row;
    },
    listRecent: async (_userId: string, actionId: string) =>
      rows.filter((row) => row.actionId === actionId),
  };
  return { rows, store };
}

function confirmable(
  id: string,
  input: CreateProposalInput,
  now = new Date("2026-07-23T09:00:00.000Z"),
): ActionProposalView {
  return {
    id,
    provider: input.provider ?? null,
    actionId: input.actionId,
    status: "proposed",
    riskLevel: input.riskLevel,
    confirmationRequired: input.confirmationRequired ?? true,
    previewText: input.previewText,
    input: input.input ?? null,
    expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    confirmedAt: null,
    rejectedAt: null,
    executedAt: null,
    createdAt: now.toISOString(),
  };
}

const microsoftPolicy = {
  connectedProviders: ["microsoft"],
  grantedScopesByProvider: { microsoft: ["Mail.ReadWrite", "Mail.Send"] },
  capabilitiesByProvider: {
    microsoft: ["outlook_mail.read", "outlook_mail.write", "outlook_mail.send"],
  },
};

async function main(): Promise<void> {
  const subjectBodies = [
    "Thursday at 4pm works for me.",
    "I’ll send the launch status update tonight.",
    "Thanks for your help with the project.",
    "The checklist is approved.",
    "Confirmed.",
    "The customer review is complete and the team can proceed with the scheduled release tomorrow morning.",
  ];
  for (const [index, body] of subjectBodies.entries()) {
    await check(`subject fallback ${index + 1}: meaningful body produces a short grounded subject`, () => {
      const subject = fallbackOutlookSubject(body);
      assert.ok(subject.length > 0 && subject.length <= 72);
      const bodyTokens = new Set(body.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
      for (const token of subject.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        assert.ok(bodyTokens.has(token), `${token} must come from the body`);
      }
    });
  }

  await check("explicit subject wins exactly over any inferred/fallback value", () => {
    const completed = completeOutlookSubject({
      body: "This body discusses something else.",
      subject: "Project Update",
      subjectWasExplicit: true,
    });
    assert.deepEqual(completed, { subject: "Project Update", source: "explicit" });
  });

  await check("model subject is retained and labelled without a fallback rewrite", () => {
    const completed = completeOutlookSubject({
      body: "Thursday works for me.",
      subject: "Thursday Confirmation",
    });
    assert.deepEqual(completed, { subject: "Thursday Confirmation", source: "model" });
  });

  await check("delete verification accepts immediate authoritative absence", async () => {
    let deletes = 0;
    let gets = 0;
    const receipt = await executeOutlookMailMutation("u", {
      operation: "delete_draft", draftId: "target",
    }, {
      request: async (_userId, options) => {
        if ((options.method ?? "GET") === "DELETE") {
          deletes += 1;
          return undefined as never;
        }
        gets += 1;
        if (gets === 1) return rawDraft("target", { to: ["test@example.com"], subject: "Test", body: "Body" }) as never;
        throw new MicrosoftGraphError("not_found", 404);
      },
      sleep: async () => {},
    });
    assert.equal(receipt.verification, "verified");
    assert.equal(deletes, 1);
    assert.equal(gets, 2);
  });

  await check("delete verification accepts a soft delete that keeps the immutable ID in Deleted Items", async () => {
    let deletes = 0;
    const calls: string[] = [];
    const receipt = await executeOutlookMailMutation("u", {
      operation: "delete_draft", draftId: "immutable-draft-1",
    }, {
      request: async (_userId, options) => {
        const method = options.method ?? "GET";
        calls.push(`${method} ${options.path}`);
        if (method === "DELETE") {
          deletes += 1;
          return undefined as never;
        }
        if (options.path?.includes("/mailFolders/drafts/")) {
          return rawDraft("immutable-draft-1", {
            to: ["test@example.com"], subject: "Disposable", body: "this is disposable",
          }) as never;
        }
        return {
          ...rawDraft("immutable-draft-1", {
            to: ["test@example.com"], subject: "Disposable", body: "this is disposable",
          }),
          parentFolderId: "deleted-items-folder",
        } as never;
      },
      sleep: async () => {},
    });
    assert.equal(receipt.verification, "verified");
    assert.equal(receipt.draftId, "immutable-draft-1");
    assert.equal(deletes, 1);
    assert.deepEqual(calls, [
      "GET /me/mailFolders/drafts/messages/immutable-draft-1",
      "DELETE /me/messages/immutable-draft-1",
      "GET /me/messages/immutable-draft-1",
    ]);
    assert.equal(calls.some((call) => /permanentDelete/i.test(call)), false);
  });

  await check("delete verification accepts authoritative Drafts-scoped absence", async () => {
    let gets = 0;
    let deletes = 0;
    const receipt = await executeOutlookMailMutation("u", {
      operation: "delete_draft", draftId: "target",
    }, {
      request: async (_userId, options) => {
        if ((options.method ?? "GET") === "DELETE") {
          deletes += 1;
          return undefined as never;
        }
        gets += 1;
        if (gets === 1) {
          return {
            ...rawDraft("target", { to: ["test@example.com"], subject: "Test", body: "Body" }),
            parentFolderId: null,
          } as never;
        }
        if (options.path === "/me/messages/target") {
          return {
            ...rawDraft("target", { to: ["test@example.com"], subject: "Test", body: "Body" }),
            parentFolderId: null,
          } as never;
        }
        throw new MicrosoftGraphError("not_found", 404);
      },
      sleep: async () => {},
    });
    assert.equal(receipt.verification, "verified");
    assert.equal(deletes, 1);
    assert.equal(gets, 3);
  });

  await check("delete verification tolerates bounded stale reads then proves absence", async () => {
    let deletes = 0;
    let gets = 0;
    const delays: number[] = [];
    const receipt = await executeOutlookMailMutation("u", {
      operation: "delete_draft", draftId: "target",
    }, {
      request: async (_userId, options) => {
        if ((options.method ?? "GET") === "DELETE") {
          deletes += 1;
          return undefined as never;
        }
        gets += 1;
        if (gets < 4) return rawDraft("target", { to: ["test@example.com"], subject: "Test", body: "Body" }) as never;
        throw new MicrosoftGraphError("not_found", 404);
      },
      sleep: async (ms) => { delays.push(ms); },
    });
    assert.equal(receipt.verification, "verified");
    assert.equal(deletes, 1);
    assert.equal(gets, 4);
    assert.deepEqual(delays, [300, 900]);
  });

  await check("delete verification never turns a still-visible draft into success", async () => {
    let deletes = 0;
    await assert.rejects(executeOutlookMailMutation("u", {
      operation: "delete_draft", draftId: "target",
    }, {
      request: async (_userId, options) => {
        if ((options.method ?? "GET") === "DELETE") {
          deletes += 1;
          return undefined as never;
        }
        return rawDraft("target", { to: ["test@example.com"], subject: "Test", body: "Body" }) as never;
      },
      sleep: async () => {},
    }), (error: unknown) =>
      error instanceof MicrosoftGraphError && error.reason === "verification_inconclusive");
    assert.equal(deletes, 1);
  });

  await check("delete provider failure is not retried or reported as verified", async () => {
    let deletes = 0;
    await assert.rejects(executeOutlookMailMutation("u", {
      operation: "delete_draft", draftId: "target",
    }, {
      request: async (_userId, options) => {
        if ((options.method ?? "GET") === "DELETE") {
          deletes += 1;
          throw new MicrosoftGraphError("permission_denied", 403);
        }
        return rawDraft("target", { to: ["test@example.com"], subject: "Test", body: "Body" }) as never;
      },
      sleep: async () => {},
    }), (error: unknown) =>
      error instanceof MicrosoftGraphError && error.reason === "permission_denied");
    assert.equal(deletes, 1);
  });

  await check("delete provider failure produces no success receipt or context invalidation", async () => {
    let invalidations = 0;
    const result = await executeAction("u", "microsoft.mail.deleteDraft", {
      userConfirmed: true,
      input: { operation: "delete_draft", draftId: "target" },
    }, {
      buildContext: async () => ({ ...microsoftPolicy, userConfirmed: true }),
      record: async () => "execution",
      executeOutlookMailMutation: async () => {
        throw new MicrosoftGraphError("permission_denied", 403);
      },
      invalidateOutlookDraftEntity: async () => {
        invalidations += 1;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.receipt, undefined);
    assert.doesNotMatch(result.userMessage, /^Deleted the Outlook draft/);
    assert.equal(invalidations, 0);
  });

  await check("delete verification timeout remains honest uncertainty", async () => {
    let deletes = 0;
    let gets = 0;
    await assert.rejects(executeOutlookMailMutation("u", {
      operation: "delete_draft", draftId: "target",
    }, {
      request: async (_userId, options) => {
        if ((options.method ?? "GET") === "DELETE") {
          deletes += 1;
          return undefined as never;
        }
        gets += 1;
        if (gets === 1) return rawDraft("target", { to: ["test@example.com"], subject: "Test", body: "Body" }) as never;
        throw new MicrosoftGraphError("timeout");
      },
      sleep: async () => {},
    }), (error: unknown) =>
      error instanceof MicrosoftGraphError && error.reason === "timeout");
    assert.equal(deletes, 1);
  });

  for (const phrase of [
    "An Outlook draft.",
    "Actually save it as a draft.",
    "Don’t send it.",
    "Make that a draft instead.",
  ]) {
    await check(`proposal revision preserves slots and creates one draft: ${phrase}`, async () => {
      const proposal = confirmable("send-proposal", {
        provider: "microsoft",
        actionId: "microsoft.mail.send",
        riskLevel: "send",
        confirmationRequired: true,
        input: {
          operation: "send",
          to: ["test@example.com"],
          body: "Thursday works.",
          subject: "Thursday",
        },
        previewText: "Send?",
      });
      let active: ActionProposalView | null = proposal;
      let superseded = 0;
      let creates = 0;
      let sends = 0;
      let mutation: Record<string, unknown> | null = null;
      const result = await handleOutlookMailProposalRevision("u", phrase, {
        now: new Date("2026-07-23T09:01:00Z"),
        getActiveProposal: async () => active,
        supersedeProposal: async () => {
          if (!active) return false;
          active = null;
          superseded += 1;
          return true;
        },
        extract: async () => ({
          provider: "outlook",
          operation: "create_draft",
          proposalRevision: true,
        }),
        execute: async (_userId, actionId, options) => {
          if (actionId === "microsoft.mail.createDraft") creates += 1;
          if (actionId === "microsoft.mail.send") sends += 1;
          mutation = options?.input ?? null;
          return {
            ok: true, status: "succeeded", actionId, provider: "microsoft",
            userMessage: "Draft created in Outlook.",
            receipt: { draftId: "revised-draft", messageId: "revised-draft" },
          };
        },
        get: async () => {
          const value = rawDraft("revised-draft", {
            to: ["test@example.com"], subject: "Thursday", body: "Thursday works.",
          });
          return {
            id: "revised-draft", conversationId: "c", internetMessageId: null,
            parentFolderId: "drafts", subject: "Thursday", from: null, sender: null,
            replyTo: [], to: [{ address: "test@example.com", name: null }], cc: [], bcc: [],
            receivedAt: null, sentAt: null, createdAt: null, modifiedAt: null,
            isRead: true, isDraft: true, importance: "normal", hasAttachments: false,
            preview: "Thursday works.", body: (value.body as { content: string }).content,
            bodyType: "text", attachments: [],
          };
        },
        create: async () => ({}),
      });
      assert.equal(result.reply, "Draft created in Outlook.");
      assert.equal(superseded, 1);
      assert.equal(creates, 1);
      assert.equal(sends, 0);
      assert.deepEqual(mutation && mutation["to"], ["test@example.com"]);
      assert.equal(mutation && mutation["body"], "Thursday works.");
      assert.equal(mutation && mutation["subject"], "Thursday");
    });
  }

  await check("unrelated text cannot revise or consume a pending mail proposal", async () => {
    let proposalReads = 0;
    const result = await handleOutlookMailProposalRevision("u", "What is on my calendar tomorrow?", {
      getActiveProposal: async () => {
        proposalReads += 1;
        throw new Error("the semantic gate should decline before storage");
      },
    });
    assert.equal(result.handled, false);
    assert.equal(proposalReads, 0);
  });

  await check("a self-contained new draft cannot inherit or supersede pending send slots", async () => {
    const proposal = confirmable("send-proposal", {
      provider: "microsoft",
      actionId: "microsoft.mail.send",
      riskLevel: "send",
      confirmationRequired: true,
      input: {
        operation: "send",
        to: ["old@example.com"],
        body: "Old proposal body.",
        subject: "Old proposal",
      },
      previewText: "Send old proposal?",
    });
    let superseded = 0;
    let mutations = 0;
    const result = await handleOutlookMailProposalRevision(
      "u",
      "Draft an Outlook email to new@example.com saying this is a separate note and do not send it.",
      {
        getActiveProposal: async () => proposal,
        supersedeProposal: async () => {
          superseded += 1;
          return true;
        },
        extract: async () => ({
          provider: "outlook",
          operation: "create_draft",
          to: ["new@example.com"],
          draftBody: "this is a separate note",
          proposalRevision: false,
        }),
        execute: async () => {
          mutations += 1;
          throw new Error("a new request is not a revision");
        },
      },
    );
    assert.equal(result.handled, false);
    assert.equal(superseded, 0);
    assert.equal(mutations, 0);
  });

  await check("an expired proposal cannot be revived by draft correction language", async () => {
    const expired = {
      ...confirmable("expired-send", {
        provider: "microsoft",
        actionId: "microsoft.mail.send",
        riskLevel: "send",
        confirmationRequired: true,
        input: {
          operation: "send",
          to: ["test@example.com"],
          body: "Thursday works.",
          subject: "Thursday",
        },
        previewText: "Send?",
      }),
      expiresAt: "2026-07-23T08:59:00.000Z",
    };
    let superseded = 0;
    let mutations = 0;
    const result = await handleOutlookMailProposalRevision("u", "Make it a draft instead.", {
      now: new Date("2026-07-23T09:01:00.000Z"),
      getActiveProposal: async () => expired,
      supersedeProposal: async () => {
        superseded += 1;
        return true;
      },
      execute: async () => {
        mutations += 1;
        throw new Error("expired proposal must not execute");
      },
    });
    assert.equal(result.handled, false);
    assert.equal(superseded, 0);
    assert.equal(mutations, 0);
  });

  await check("explicit Outlook correction can safely convert a Gmail send proposal", async () => {
    const gmailProposal = confirmable("gmail-send", {
      provider: "gmail",
      actionId: "email.sendDraft",
      riskLevel: "send",
      confirmationRequired: true,
      input: {
        to: "test@outlook.com",
        subject: "Thursday",
        body: "Thursday works.",
        isReply: false,
      },
      previewText: "Send from Gmail?",
    });
    let superseded = 0;
    let creates = 0;
    let mutation: Record<string, unknown> | null = null;
    const result = await handleOutlookMailProposalRevision(
      "u",
      "Actually use Outlook and leave it as a draft.",
      {
        now: new Date("2026-07-23T09:01:00.000Z"),
        getActiveProposal: async () => gmailProposal,
        supersedeProposal: async () => {
          superseded += 1;
          return true;
        },
        extract: async () => ({
          provider: "outlook",
          operation: "create_draft",
          proposalRevision: true,
        }),
        execute: async (_userId, actionId, options) => {
          creates += actionId === "microsoft.mail.createDraft" ? 1 : 0;
          mutation = options?.input ?? null;
          return {
            ok: true, status: "succeeded", actionId, provider: "microsoft",
            userMessage: "Draft created in Outlook.",
            receipt: { draftId: "outlook-draft", messageId: "outlook-draft" },
          };
        },
        get: async () => ({
          id: "outlook-draft", conversationId: "c", internetMessageId: null,
          parentFolderId: "drafts", subject: "Thursday", from: null, sender: null,
          replyTo: [], to: [{ address: "test@outlook.com", name: null }], cc: [], bcc: [],
          receivedAt: null, sentAt: null, createdAt: null, modifiedAt: null,
          isRead: true, isDraft: true, importance: "normal", hasAttachments: false,
          preview: "Thursday works.", body: "Thursday works.", bodyType: "text", attachments: [],
        }),
        create: async () => ({}),
      },
    );
    assert.equal(result.reply, "Draft created in Outlook.");
    assert.equal(superseded, 1);
    assert.equal(creates, 1);
    assert.deepEqual(mutation && mutation["to"], ["test@outlook.com"]);
    assert.equal(mutation && mutation["body"], "Thursday works.");
  });

  await check("production route: create/delete/send-proposal/revise preserves exact state", async () => {
    const context = contextMemory();
    const drafts = new Map<string, Record<string, unknown>>();
    drafts.set("unrelated", rawDraft("unrelated", {
      to: ["other@example.com"], subject: "Unrelated", body: "Do not touch",
    }));
    let created = 0;
    let deleted = 0;
    let sent = 0;
    const graphCalls: string[] = [];
    let active: ActionProposalView | null = null;
    let recent: ActionProposalView | null = null;

    const request = async (
      _userId: string,
      options: MicrosoftGraphRequestOptions,
    ): Promise<never> => {
      const method = options.method ?? "GET";
      graphCalls.push(`${method} ${options.path}`);
      if (method === "POST" && options.path === "/me/messages") {
        const rawBody = options.body ?? {};
        const graphBody = rawBody.body as { content?: unknown } | undefined;
        const recipients = Array.isArray(rawBody.toRecipients)
          ? rawBody.toRecipients.flatMap((item) => {
            const address = (item as { emailAddress?: { address?: unknown } }).emailAddress?.address;
            return typeof address === "string" ? [address] : [];
          })
          : [];
        const id = `created-${++created}`;
        const value = rawDraft(id, {
          to: recipients,
          subject: typeof rawBody.subject === "string" ? rawBody.subject : "",
          body: typeof graphBody?.content === "string" ? graphBody.content : "",
        });
        drafts.set(id, value);
        return value as never;
      }
      const match = options.path?.match(
        /^\/me\/(?:mailFolders\/(drafts)\/)?messages\/(.+)$/,
      );
      const folder = match?.[1];
      const id = match?.[2];
      if (!id) throw new Error(`unexpected Graph path ${options.path}`);
      const decoded = decodeURIComponent(id);
      if (method === "DELETE") {
        deleted += 1;
        const found = drafts.get(decoded);
        if (!found) throw new MicrosoftGraphError("not_found", 404);
        drafts.set(decoded, { ...found, parentFolderId: "deleted-items-folder" });
        return undefined as never;
      }
      const found = drafts.get(decoded);
      if (!found || (folder === "drafts" && found.parentFolderId !== "drafts")) {
        throw new MicrosoftGraphError("not_found", 404);
      }
      return found as never;
    };

    const recordProposal = async (_userId: string, input: CreateProposalInput) => {
      active = confirmable(`proposal-${Date.now()}-${created}`, input);
      return active;
    };
    const executor = async (
      userId: string,
      actionId: string,
      options?: ExecuteActionOptions,
    ) => executeAction(userId, actionId, options, {
      buildContext: async () => ({
        ...microsoftPolicy,
        userConfirmed: options?.userConfirmed === true,
      }),
      record: async () => "execution",
      executeOutlookMailMutation: (u, input) =>
        executeOutlookMailMutation(u, input, { request, sleep: async () => {} }),
      invalidateOutlookDraftEntity: (u, id) =>
        invalidateOutlookDraftEntity(u, id, context.store),
    });

    const outlookDeps: OutlookConversationDeps = {
      ...context.store,
      request,
      getMicrosoftState: async () => ({ connected: true, accountEmail: "owner@example.com" }),
      getGmailState: async () => ({ connected: false }),
      getContexts: async () => [],
      loadPendingIntent: async () => null,
      getActiveProposal: async () => active,
      supersedeProposal: async (_userId, id) => {
        if (!active || active.id !== id || active.status !== "proposed") return false;
        recent = { ...active, status: "cancelled", rejectedAt: new Date().toISOString() };
        active = null;
        return true;
      },
      propose: recordProposal,
      execute: executor,
      generateIntent: async ({ messages, system }) => {
        const value = messages[0]?.content ?? "";
        if (/^delete/i.test(value)) return JSON.stringify({ provider: "outlook", operation: "delete_draft" });
        if (/^write/i.test(value)) {
          return JSON.stringify({
            provider: "outlook", operation: "send", to: ["test@example.com"],
            draftBody: "Thursday works.",
          });
        }
        if (/outlook draft/i.test(value) && /Active pending email proposal: outlook \/ send/.test(system)) {
          return JSON.stringify({
            provider: "outlook", operation: "create_draft", proposalRevision: true,
          });
        }
        return JSON.stringify({
          provider: "outlook", operation: "create_draft", to: ["test@example.com"],
          draftBody: "this is disposable",
        });
      },
    };

    const decline = async () => ({ handled: false as const });
    const confirm = (userId: string, text: string | undefined) =>
      handleActionConfirmation(userId, text, {
        getActiveProposal: async () => active,
        getRecentResolvedProposal: async () => recent,
        confirmProposal: async (_u, id) => {
          if (!active || active.id !== id || active.status !== "proposed") return null;
          const confirmed = { ...active, status: "confirmed" as const };
          active = null;
          recent = confirmed;
          return confirmed;
        },
        rejectProposal: async (_u, id) => {
          if (!active || active.id !== id) return null;
          recent = { ...active, status: "rejected" as const, rejectedAt: new Date().toISOString() };
          active = null;
          return recent;
        },
        finalizeProposal: async () => {
          if (recent) recent = { ...recent, status: "executed", executedAt: new Date().toISOString() };
        },
        executeAction: async (u, actionId, options) => {
          const result = await executor(u, actionId, options);
          if (actionId === "microsoft.mail.send" && result.ok) sent += 1;
          return result;
        },
      });
    const outlook = (userId: string, text: string | undefined) =>
      handleOutlookMailConversation(userId, text, outlookDeps);
    const routerDeps: InboundRouterDeps = {
      transportKeyword: decline,
      mailProposalRevision: (u, t) => handleOutlookMailProposalRevision(u, t, outlookDeps),
      confirmation: confirm,
      entityFollowup: (u, t) => handleEntityFollowup(u, t, {
        ...context.store,
        outlook,
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
      pendingReprompt: decline,
    };

    const first = await routeInboundText(
      "u",
      "Draft an Outlook email to test@example.com saying this is disposable and do not send it.",
      routerDeps,
    );
    assert.equal(first?.source, "outlookMail");
    assert.equal(created, 1);
    assert.equal(sent, 0);
    const firstDraft = drafts.get("created-1");
    assert.ok(typeof firstDraft?.subject === "string" && firstDraft.subject.length > 0);
    assert.equal((await loadGroundedOutlookEntity("u", "draft", context.store))?.ref.id, "created-1");

    const deleteProposal = await routeInboundText("u", "Delete that draft.", routerDeps);
    assert.match(deleteProposal?.reply ?? "", /Subject: (?!\(No subject\))/);
    const deleteActive = active as ActionProposalView | null;
    assert.equal(deleteActive?.input?.draftId, "created-1");
    const confirmedDelete = await routeInboundText("u", "Yes.", routerDeps);
    assert.match(confirmedDelete?.reply ?? "", /Deleted the Outlook draft/);
    assert.equal(deleted, 1);
    assert.equal(drafts.get("created-1")?.parentFolderId, "deleted-items-folder");
    assert.equal(drafts.has("unrelated"), true);
    assert.equal(await loadGroundedOutlookEntity("u", "draft", context.store), null);
    const duplicateDeleteYes = await routeInboundText("u", "Yes.", routerDeps);
    assert.match(duplicateDeleteYes?.reply ?? "", /already completed/);
    assert.equal(deleted, 1);
    assert.equal(graphCalls.filter((call) => call === "DELETE /me/messages/created-1").length, 1);
    assert.equal(graphCalls.some((call) => /permanentDelete/i.test(call)), false);

    const sendProposal = await routeInboundText(
      "u",
      "Write test@example.com something saying Thursday works.",
      routerDeps,
    );
    assert.match(sendProposal?.reply ?? "", /Send from your Outlook account/);
    assert.ok(active);
    const sendActive = active as ActionProposalView | null;
    assert.equal(sendActive?.actionId, "microsoft.mail.send");
    assert.equal(sendActive?.input?.operation, "send");
    assert.equal(sent, 0);
    const proposedSubject = sendActive?.input?.subject;
    assert.ok(typeof proposedSubject === "string" && proposedSubject.length > 0);

    const revision = await routeInboundText("u", "An Outlook draft.", routerDeps);
    assert.equal(revision?.source, "mailProposalRevision");
    assert.match(revision?.reply ?? "", /Draft created in Outlook/);
    assert.equal(created, 2);
    assert.equal(sent, 0);
    assert.equal(active, null);
    const revised = drafts.get("created-2");
    assert.equal(
      ((revised?.toRecipients as Array<{ emailAddress: { address: string } }>)[0]?.emailAddress.address),
      "test@example.com",
    );
    assert.equal((revised?.body as { content: string }).content, "Thursday works.");
    assert.ok(typeof revised?.subject === "string" && revised.subject.length > 0);

    const delayedYes = await routeInboundText("u", "Yes.", routerDeps);
    assert.match(delayedYes?.reply ?? "", /already cancelled/);
    assert.equal(sent, 0);
    assert.equal(created, 2);
  });

  console.log(`\nOutlook final blocker tests: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
