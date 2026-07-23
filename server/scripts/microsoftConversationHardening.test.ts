import assert from "node:assert/strict";

import type { ActionProposalView, CreateProposalInput } from "../src/actions/proposals";
import {
  handleOutlookMailConversation,
  type OutlookConversationDeps,
} from "../src/integrations/providers/microsoft/mailConversation";
import {
  loadGroundedOutlookEntity,
  recordOutlookEntity,
  recordOutlookSelection,
  type OutlookContextStore,
} from "../src/integrations/providers/microsoft/mailContext";
import {
  analysisMatchesPresentationContract,
  analyzeOutlookMessages,
} from "../src/integrations/providers/microsoft/mailIntelligence";
import {
  extractOutlookIntent,
  parseOutlookIntent,
  type OutlookIntent,
} from "../src/integrations/providers/microsoft/mailIntent";
import type { OutlookMessage } from "../src/integrations/providers/microsoft/mailTypes";
import {
  extractOutlookCalendarIntent,
  parseOutlookCalendarIntent,
} from "../src/integrations/providers/microsoft/calendarIntent";
import {
  extractOneDriveIntent,
  parseOneDriveIntent,
} from "../src/integrations/providers/microsoft/oneDriveIntent";
import {
  routeInboundText,
  type InboundRouterDeps,
} from "../src/routes/inboundRouting";

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function message(
  id: string,
  subject = `Subject ${id}`,
  body = `Body ${id}`,
  receivedAt = "2026-07-21T12:00:00.000Z",
  isDraft = false,
): OutlookMessage {
  return {
    id,
    conversationId: `conversation-${id}`,
    internetMessageId: `<${id}@example.test>`,
    parentFolderId: isDraft ? "drafts" : "inbox",
    subject,
    from: { name: "Ayub Yusuf", address: "ayub@example.com" },
    sender: { name: "Ayub Yusuf", address: "ayub@example.com" },
    replyTo: [],
    to: [{ name: null, address: "owner@example.com" }],
    cc: [],
    bcc: [],
    receivedAt,
    sentAt: null,
    createdAt: receivedAt,
    modifiedAt: receivedAt,
    isRead: false,
    isDraft,
    importance: "normal",
    hasAttachments: false,
    preview: body,
    body,
    bodyType: "text",
    attachments: [],
  };
}

function contextMemory(now = new Date("2026-07-21T12:00:00.000Z")): OutlookContextStore & { rows: ActionProposalView[] } {
  const rows: ActionProposalView[] = [];
  let sequence = 0;
  return {
    rows,
    now,
    create: async (_userId: string, input: CreateProposalInput) => {
      sequence += 1;
      const createdAt = new Date(now.getTime() + sequence).toISOString();
      const row: ActionProposalView = {
        id: `context-${sequence}`,
        provider: input.provider ?? null,
        actionId: input.actionId,
        status: "proposed",
        riskLevel: input.riskLevel,
        confirmationRequired: input.confirmationRequired ?? true,
        previewText: input.previewText,
        input: input.input ?? null,
        expiresAt: new Date(now.getTime() + (input.ttlMs ?? 10 * 60 * 1_000)).toISOString(),
        confirmedAt: null,
        rejectedAt: null,
        executedAt: null,
        createdAt,
      };
      rows.unshift(row);
      return row;
    },
    listRecent: async (_userId: string, actionId: string) => rows.filter((row) => row.actionId === actionId),
  };
}

function connectedDeps(overrides: OutlookConversationDeps = {}): OutlookConversationDeps {
  return {
    listRecent: async () => [],
    getMicrosoftState: async () => ({ connected: true, accountEmail: "owner@example.com" }),
    getGmailState: async () => ({ connected: false }),
    getContexts: async () => [],
    createPendingIntent: async () => ({ id: "pending-mail-clarification" }),
    ...overrides,
  };
}

function semanticRaw(operation: OutlookIntent["operation"], variant = 0): string {
  const base: Record<string, unknown> = variant % 3 === 0
    ? { provider: "outlook", operation }
    : variant % 3 === 1
      ? { service: "Microsoft 365", action: operation }
      : { provider: "outlook_mail", intent: operation };
  if (operation === "create_draft") {
    return JSON.stringify(variant % 2 === 0
      ? { ...base, to: "person@example.com", subject: variant % 4 ? undefined : "Project update", body: "Thursday works for me." }
      : { ...base, operation: undefined, action: "compose", recipient: { email: "person@example.com" }, draftBody: "Thursday works for me.", draftSubject: "Project update" });
  }
  if (operation === "send") return JSON.stringify({ ...base, operation: variant % 2 ? "send_email" : operation, recipients: "person@example.com", body: "We shipped." });
  if (operation === "create_reply_draft" || operation === "create_reply_all_draft") return JSON.stringify({ ...base, operation, body: "Thursday works." });
  if (operation === "create_forward_draft") return JSON.stringify({ ...base, operation: "forward_draft", recipient: "person@example.com", body: "For your information." });
  if (operation === "reply" || operation === "reply_all") return JSON.stringify({ ...base, operation, body: "Thursday works." });
  if (operation === "forward") return JSON.stringify({ ...base, operation: "forward_email", recipient: "person@example.com", body: "For your information." });
  if (operation === "update_draft") return JSON.stringify({ ...base, operation: "edit_draft", content: "The new time is 4pm." });
  if (operation === "delete_draft") return JSON.stringify({ ...base, operation: "remove_draft" });
  if (operation === "send_draft") return JSON.stringify({ ...base, operation: "send_existing_draft" });
  if (operation === "mark_read") return JSON.stringify({ ...base, operation: "mark_as_read" });
  if (operation === "mark_unread") return JSON.stringify({ ...base, operation: "mark_as_unread" });
  return JSON.stringify(base);
}

const draftParaphrases = [
  "Draft an Outlook email to person@example.com saying Thursday works.",
  "Write person@example.com an email in Outlook and tell them Thursday works, but don’t send it.",
  "Compose a note to person@example.com saying I’ll call tomorrow.",
  "Prepare an Outlook email for person@example.com. Subject: Launch. Say we’re ready.",
  "Write this up as an email to person@example.com but leave it as a draft.",
  "Make me a draft telling person@example.com we approved the checklist.",
  "In Outlook, put together an unsent note for person@example.com: Thursday is fine.",
  "Subject first: Project Update. Draft to person@example.com saying it is complete.",
  "For person@example.com, compose ‘I can make 4pm’ in Outlook—save it, don’t send.",
  "Could you prepare, but not send, an Outlook message to person@example.com saying yes?",
];

const actionParaphrases: readonly [OutlookIntent["operation"], string[]][] = [
  ["send", [
    "Email person@example.com from Outlook saying Thursday works.",
    "Send person@example.com a message saying we shipped.",
    "Shoot person@example.com an Outlook email saying I’ll be there at 4.",
    "From Microsoft mail, tell person@example.com the launch is approved.",
    "Please email person@example.com now: the checklist passed.",
  ]],
  ["create_reply_draft", ["Draft a reply saying Thursday works.", "Compose a response but don’t send it." ]],
  ["create_reply_all_draft", ["Prepare a reply to everyone and leave it as a draft." ]],
  ["create_forward_draft", ["Draft a forward to person@example.com but don’t send it." ]],
  ["send_draft", ["Send the Outlook draft.", "Go ahead and send that saved draft." ]],
  ["reply", ["Tell him Thursday works.", "Write back saying yes.", "Respond that I’ll check tonight.", "Reply with ‘approved’." ]],
  ["reply_all", ["Reply to everyone saying I’ll send it tonight.", "Write back to all with the revised time.", "Respond to everybody: approved." ]],
  ["forward", ["Forward this to person@example.com.", "Pass this Outlook email on to person@example.com.", "Send a copy of this message to person@example.com." ]],
  ["update_draft", ["Change the draft to say 4pm instead.", "Edit that unsent email with the new time.", "Update this draft: the launch is Friday." ]],
  ["delete_draft", ["Delete that draft.", "Remove the unsent Outlook email.", "Discard this draft." ]],
  ["mark_read", ["I’ve read that.", "Mark the second one as read." ]],
  ["mark_unread", ["Make this unread again.", "Mark the second one unread." ]],
];

function earlyDeclines(outlookMail: InboundRouterDeps["outlookMail"]): InboundRouterDeps {
  const decline = async () => ({ handled: false as const });
  return {
    transportKeyword: decline,
    memory: decline,
    reminder: decline,
    confirmation: decline,
    entityFollowup: decline,
    teamsUnsupported: decline,
    slack: decline,
    oneDrive: decline,
    drive: decline,
    notion: decline,
    asanaWrite: decline,
    asanaRead: decline,
    outlookMail,
    pendingReprompt: decline,
  };
}

async function runDraftProperty(text: string, variant: number): Promise<void> {
  let executedAction = "";
  const executedInput: { value: Record<string, unknown> | null } = { value: null };
  let proposals = 0;
  const result = await handleOutlookMailConversation("u", text, connectedDeps({
    generateIntent: async () => semanticRaw("create_draft", variant),
    execute: async (_userId, actionId, options) => {
      executedAction = actionId;
      executedInput.value = options?.input ?? null;
      return {
        ok: true,
        status: "succeeded",
        actionId,
        provider: "microsoft",
        userMessage: "Draft created.",
        receipt: { draftId: `draft-${variant}` },
      };
    },
    get: async () => message(`draft-${variant}`, "Project update", "Thursday works for me.", "2026-07-21T12:00:00Z", true),
    propose: async () => { proposals += 1; },
  }));
  assert.equal(result.handled, true);
  assert.equal(executedAction, "microsoft.mail.createDraft");
  assert.equal(executedInput.value?.body, "Thursday works for me.");
  assert.deepEqual(executedInput.value?.to, ["person@example.com"]);
  assert.equal(proposals, 0);
  assert.doesNotMatch(result.reply ?? "", /what subject/i);
}

async function comparisonFixture(options: {
  question?: string;
  intent?: Record<string, unknown>;
  firstAnswer?: string;
  finalAnswer?: string;
  substantive?: boolean;
} = {}) {
  const memory = contextMemory();
  const alpha = message(
    "alpha",
    options.substantive ? "Launch approval" : "Hula test 3",
    options.substantive ? "Please approve the launch checklist by Friday." : "Hula test 3",
    "2026-07-21T12:00:27Z",
  );
  const beta = message(
    "beta",
    options.substantive ? "Launch timing changed" : "Hula test 2",
    options.substantive ? "The launch moved to Monday; no approval is requested." : "Hula test 2",
    "2026-07-21T12:00:00Z",
  );
  const gamma = message("gamma", "Unrelated private email", "This must never enter the comparison.");
  await recordOutlookSelection("u", [alpha, beta, gamma], memory);
  await recordOutlookEntity("u", beta, memory);
  let prompt = "";
  let calls = 0;
  const result = await handleOutlookMailConversation("u", options.question ?? "Compare it with the first one.", connectedDeps({
    ...memory,
    arbitrated: true,
    generateIntent: async () => JSON.stringify(options.intent ?? { provider: "outlook", operation: "compare", ordinal: 1 }),
    getContexts: async () => [{ kind: "outlook_message", actionId: "microsoft.mail.entityContext", at: 1, names: [] }],
    get: async (_userId, id) => [alpha, beta, gamma].find((item) => item.id === id)!,
    generateAnalysis: async (params) => {
      prompt = params.system;
      calls += 1;
      return JSON.stringify({
        answer: calls === 1 && options.firstAnswer ? options.firstAnswer : options.finalAnswer ?? "They are both brief test confirmations with no request or action required; only the wording and 27-second arrival time differ.",
        explicitActionItems: [],
        explicitDeadlines: [],
        inference: "",
        replyNeeded: "no",
      });
    },
  }));
  return { result, prompt, calls, memory, alpha, beta, gamma };
}

async function main(): Promise<void> {
  await check("contract: the exact live single-recipient representation normalizes safely", () => {
    const intent = parseOutlookIntent('{"provider":"outlook","operation":"create_draft","to":"person@example.com","draftSubject":"Hula Section 24 Draft","draftBody":"Thursday works for me."}');
    assert.equal(intent?.operation, "create_draft");
    assert.deepEqual(intent?.to, ["person@example.com"]);
  });

  await check("contract: harmless provider, operation, recipient, subject, and body aliases normalize", () => {
    const intent = parseOutlookIntent('{"service":"Microsoft 365","action":"compose","recipient":{"email":"person@example.com"},"subject":"Launch","body":"We are ready."}');
    assert.equal(intent?.provider, "outlook");
    assert.equal(intent?.operation, "create_draft");
    assert.deepEqual(intent?.to, ["person@example.com"]);
    assert.equal(intent?.draftSubject, "Launch");
    assert.equal(intent?.draftBody, "We are ready.");
  });

  await check("contract: malformed-but-repairable intent gets one bounded representation repair", async () => {
    let calls = 0;
    const intent = await extractOutlookIntent({
      text: "Prepare an Outlook note for person@example.com.",
      generate: async (params) => {
        calls += 1;
        if (calls === 1) return '{"provider":"outlook","operation":"make_something","to":"person@example.com"}';
        assert.equal(params.messages.length, 3);
        assert.match(params.messages[2]?.content ?? "", /Repair only the JSON representation/);
        return semanticRaw("create_draft", 1);
      },
    });
    assert.equal(calls, 2);
    assert.equal(intent?.operation, "create_draft");
  });

  await check("contract: ambiguous mutation vocabulary is not silently reinterpreted", () => {
    assert.equal(parseOutlookIntent('{"provider":"outlook","operation":"write","to":"person@example.com","body":"Hello"}'), null);
  });

  await check("calendar contract: provider/action aliases and one attendee normalize before validation", () => {
    const intent = parseOutlookCalendarIntent('{"provider":"microsoft","action":"schedule_event","title":"Review","start":"2026-07-22T14:00:00Z","attendee":"person@example.com","isOnlineMeeting":"yes"}');
    assert.equal(intent?.provider, "outlook_calendar");
    assert.equal(intent?.operation, "create");
    assert.deepEqual(intent?.attendees, ["person@example.com"]);
    assert.equal(intent?.teamsMeeting, true);
  });

  await check("calendar contract: malformed output gets one bounded semantic-preserving repair", async () => {
    let calls = 0;
    const intent = await extractOutlookCalendarIntent({
      text: "Schedule an Outlook meeting tomorrow at 2.",
      generate: async () => {
        calls += 1;
        return calls === 1
          ? '{"provider":"microsoft","operation":"do_calendar_thing"}'
          : '{"provider":"outlook_calendar","operation":"create","title":"Meeting","start":"2026-07-22T14:00:00Z"}';
      },
    });
    assert.equal(calls, 2);
    assert.equal(intent?.operation, "create");
  });

  await check("OneDrive contract: provider/action and filename aliases normalize before validation", () => {
    const intent = parseOneDriveIntent('{"provider":"microsoft","action":"open_file","fileName":"Project Atlas.md"}');
    assert.equal(intent?.provider, "onedrive");
    assert.equal(intent?.operation, "get");
    assert.equal(intent?.name, "Project Atlas.md");
  });

  await check("OneDrive contract: malformed output gets one bounded read-only repair", async () => {
    let calls = 0;
    const intent = await extractOneDriveIntent({
      text: "Pull up Project Atlas from OneDrive.",
      generate: async () => {
        calls += 1;
        return calls === 1
          ? '{"provider":"onedrive","operation":"do_file_thing"}'
          : '{"provider":"onedrive","operation":"search","query":"Project Atlas"}';
      },
    });
    assert.equal(calls, 2);
    assert.equal(intent?.operation, "search");
  });

  await check("missing fields: a draft with no body asks only for content and performs no write", async () => {
    let writes = 0;
    const result = await handleOutlookMailConversation("u", "Draft an Outlook note to person@example.com.", connectedDeps({
      generateIntent: async () => '{"provider":"outlook","operation":"create_draft","to":"person@example.com"}',
      execute: async () => { writes += 1; throw new Error("must not write"); },
    }));
    assert.equal(writes, 0);
    assert.match(result.reply ?? "", /what should.*say/i);
  });

  await check("missing fields: a named recipient without an address asks only for the exact address", async () => {
    const result = await handleOutlookMailConversation("u", "Draft Sarah an Outlook email saying hello.", connectedDeps({
      generateIntent: async () => '{"provider":"outlook","operation":"create_draft","draftBody":"Hello."}',
    }));
    assert.match(result.reply ?? "", /exact email address/i);
    assert.doesNotMatch(result.reply ?? "", /interpret|schema|parser/i);
  });

  for (const [index, text] of draftParaphrases.entries()) {
    await check(`draft paraphrase property ${index + 1}: complete semantic draft creates one unsent draft`, () => runDraftProperty(text, index));
  }

  let paraphraseVariant = 0;
  for (const [operation, phrases] of actionParaphrases) {
    for (const text of phrases) {
      const variant = paraphraseVariant;
      paraphraseVariant += 1;
      await check(`${operation} paraphrase property ${variant + 1}: production parser preserves semantic class`, async () => {
        const intent = await extractOutlookIntent({
          text,
          hasContext: operation !== "send",
          generate: async (params) => {
            assert.equal(params.messages[0]?.content, text);
            return semanticRaw(operation, variant);
          },
        });
        assert.equal(intent?.operation, operation);
      });
    }
  }

  await check("action contract: send is proposal-only before confirmation", async () => {
    let writes = 0;
    const proposal: { value: CreateProposalInput | null } = { value: null };
    await handleOutlookMailConversation("u", "Email person@example.com from Outlook saying we shipped.", connectedDeps({
      generateIntent: async () => semanticRaw("send", 1),
      execute: async () => { writes += 1; throw new Error("must not write"); },
      getActiveProposal: async () => null,
      propose: async (_userId, input) => { proposal.value = input; },
    }));
    assert.equal(writes, 0);
    assert.equal(proposal.value?.actionId, "microsoft.mail.send");
  });

  for (const operation of ["reply", "reply_all", "forward"] as const) {
    await check(`action contract: ${operation} uses selected message and remains proposal-gated`, async () => {
      const memory = contextMemory();
      await recordOutlookEntity("u", message("source"), memory);
      let proposals = 0;
      let writes = 0;
      const command = operation === "forward"
        ? "Forward this to person@example.com."
        : operation === "reply_all"
          ? "Reply to everyone saying yes."
          : "Reply saying yes.";
      const result = await handleOutlookMailConversation("u", command, connectedDeps({
        ...memory,
        arbitrated: true,
        generateIntent: async () => semanticRaw(operation, 2),
        getContexts: async () => [{ kind: "outlook_message", actionId: "microsoft.mail.entityContext", at: 1, names: [] }],
        getActiveProposal: async () => null,
        propose: async () => { proposals += 1; },
        execute: async () => { writes += 1; throw new Error("must not write"); },
      }));
      assert.equal(result.handled, true);
      assert.equal(proposals, 1);
      assert.equal(writes, 0);
    });
  }

  for (const operation of ["create_reply_draft", "create_reply_all_draft", "create_forward_draft"] as const) {
    await check(`action contract: ${operation} creates only an unsent contextual draft`, async () => {
      const memory = contextMemory();
      await recordOutlookEntity("u", message("source"), memory);
      let writes = 0;
      let proposals = 0;
      const result = await handleOutlookMailConversation("u", "Prepare a reply or forward draft without sending.", connectedDeps({
        ...memory,
        arbitrated: true,
        generateIntent: async () => semanticRaw(operation, 2),
        getContexts: async () => [{ kind: "outlook_message", actionId: "microsoft.mail.entityContext", at: 1, names: [] }],
        get: async (_userId, id) => id === "source" ? message("source") : message("draft", "Draft", "Thursday works.", "2026-07-21T12:00:00Z", true),
        execute: async (_userId, actionId) => {
          assert.equal(actionId, "microsoft.mail.createDraft");
          writes += 1;
          return { ok: true, status: "succeeded", actionId, provider: "microsoft", userMessage: "Draft created.", receipt: { draftId: "draft" } };
        },
        propose: async () => { proposals += 1; },
      }));
      assert.equal(result.handled, true);
      assert.equal(writes, 1);
      assert.equal(proposals, 0);
    });
  }

  await check("action contract: send existing draft remains proposal-gated", async () => {
    const memory = contextMemory();
    await recordOutlookEntity("u", message("draft", "Saved draft", "Ready to send.", "2026-07-21T12:00:00Z", true), memory);
    let proposals = 0;
    let writes = 0;
    const result = await handleOutlookMailConversation("u", "Send the Outlook draft.", connectedDeps({
      ...memory,
      arbitrated: true,
      generateIntent: async () => semanticRaw("send_draft", 1),
      getContexts: async () => [{ kind: "outlook_draft", actionId: "microsoft.mail.lastDraft", at: 1, names: [] }],
      get: async () => message("draft", "Saved draft", "Ready to send.", "2026-07-21T12:00:00Z", true),
      getActiveProposal: async () => null,
      propose: async () => { proposals += 1; },
      execute: async () => { writes += 1; throw new Error("must not send before confirmation"); },
    }));
    assert.equal(result.handled, true);
    assert.equal(proposals, 1);
    assert.equal(writes, 0);
  });

  for (const operation of ["update_draft", "delete_draft", "mark_read", "mark_unread"] as const) {
    await check(`action contract: ${operation} resolves typed context without phrase-specific routing`, async () => {
      const memory = contextMemory();
      const target = message("target", "Draft", "Old body", "2026-07-21T12:00:00Z", operation.includes("draft"));
      await recordOutlookEntity("u", target, memory);
      let writes = 0;
      let proposals = 0;
      const result = await handleOutlookMailConversation("u", `Please ${operation.replaceAll("_", " ")} it.`, connectedDeps({
        ...memory,
        arbitrated: true,
        generateIntent: async () => semanticRaw(operation, 1),
        getContexts: async () => [{ kind: operation.includes("draft") ? "outlook_draft" : "outlook_message", actionId: "context", at: 1, names: [] }],
        get: async () => target,
        execute: async (_userId, actionId) => {
          writes += 1;
          return { ok: true, status: "succeeded", actionId, provider: "microsoft", userMessage: "Done." };
        },
        getActiveProposal: async () => null,
        propose: async () => { proposals += 1; },
      }));
      assert.equal(result.handled, true);
      if (operation === "delete_draft") {
        assert.equal(proposals, 1);
        assert.equal(writes, 0);
      } else {
        assert.equal(writes, 1);
      }
    });
  }

  const routeParaphrases = [draftParaphrases[0]!, draftParaphrases[3]!, draftParaphrases[6]!, draftParaphrases[9]!];
  for (const [index, text] of routeParaphrases.entries()) {
    await check(`production route ${index + 1}: inbound router reaches real Outlook parser and creates only a draft`, async () => {
      let writes = 0;
      const routed = await routeInboundText("u", text, earlyDeclines((userId, value) => handleOutlookMailConversation(userId, value, connectedDeps({
        generateIntent: async () => semanticRaw("create_draft", index),
        execute: async (_userId, actionId) => {
          assert.equal(actionId, "microsoft.mail.createDraft");
          writes += 1;
          return { ok: true, status: "succeeded", actionId, provider: "microsoft", userMessage: "Draft created.", receipt: { draftId: `route-${index}` } };
        },
        get: async () => message(`route-${index}`, "", "Thursday works.", "2026-07-21T12:00:00Z", true),
        propose: async () => { throw new Error("draft must not propose a send"); },
      }))));
      assert.equal(routed?.source, "outlookMail");
      assert.match(routed?.reply ?? "", /Draft created/);
      assert.equal(writes, 1);
    });
  }

  await check("comparison A: opened second is compared with displayed first and internal vocabulary is repaired", async () => {
    const fixture = await comparisonFixture({
      firstAnswer: "RESULT 2 is the active selection and its labels are mismatched with RESULT 1.",
    });
    assert.equal(fixture.calls, 2);
    assert.ok(fixture.prompt.indexOf("Hula test 2") < fixture.prompt.indexOf("Hula test 3"));
    assert.equal(analysisMatchesPresentationContract({ answer: fixture.result.reply ?? "", explicitActionItems: [], explicitDeadlines: [], inference: "", replyNeeded: "no" }), true);
  });

  await check("comparison B: displayed ordinals remain authoritative when the first timestamp is later", async () => {
    const fixture = await comparisonFixture();
    assert.match(fixture.prompt, /displayed order remains authoritative even when timestamps differ/i);
    assert.doesNotMatch(fixture.result.reply ?? "", /mismatch/i);
  });

  await check("comparison C: trivial messages produce a concise natural comparison", async () => {
    const fixture = await comparisonFixture();
    assert.ok((fixture.result.reply ?? "").split(/\s+/).length < 50);
    assert.doesNotMatch(fixture.result.reply ?? "", /RESULT|active selection|selection metadata/i);
  });

  await check("comparison D: substantive messages compare requests and changed information", async () => {
    const fixture = await comparisonFixture({
      substantive: true,
      finalAnswer: "The first email asks for launch-checklist approval by Friday; the email you opened changes the launch to Monday and says no approval is needed.",
    });
    assert.match(fixture.result.reply ?? "", /approval by Friday/i);
    assert.match(fixture.result.reply ?? "", /Monday/i);
  });

  await check("comparison E: comparison does not replace the originally opened entity", async () => {
    const fixture = await comparisonFixture();
    assert.equal((await loadGroundedOutlookEntity("u", "message", fixture.memory))?.ref.id, "beta");
  });

  await check("comparison F: explicit pair comparison uses exactly the displayed pair", async () => {
    const fixture = await comparisonFixture({
      question: "Compare these two.",
      intent: { provider: "outlook", operation: "compare", ordinal: 1, secondOrdinal: 2 },
    });
    assert.match(fixture.prompt, /Hula test 3/);
    assert.match(fixture.prompt, /Hula test 2/);
  });

  await check("comparison G: unrelated result-set messages never enter pair evidence", async () => {
    const fixture = await comparisonFixture();
    assert.doesNotMatch(fixture.prompt, /Unrelated private email|must never enter/);
  });

  await check("response quality contract: schema-valid internal narration is rejected before presentation", async () => {
    let calls = 0;
    const result = await analyzeOutlookMessages({
      question: "Compare these two.",
      messages: [message("one"), message("two")],
      generate: async () => {
        calls += 1;
        return JSON.stringify({
          answer: calls === 1 ? "The active entity is RESULT 2." : "Both emails are brief confirmations; only their wording differs.",
          explicitActionItems: [], explicitDeadlines: [], inference: "", replyNeeded: "no",
        });
      },
    });
    assert.equal(calls, 2);
    assert.match(result.answer, /brief confirmations/);
  });

  console.log(`\nMicrosoft conversation hardening tests: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
