import assert from "node:assert/strict";

import {
  PENDING_PROPOSAL_REPROMPT,
  classifyConfirmationReply,
  handleActionConfirmation,
  handlePendingProposalReprompt,
  type ConfirmationDeps,
} from "../src/actions/confirmations";
import { ensureSignature } from "../src/integrations/providers/gmail/signature";
import {
  formatSendPreview,
  handleGmailWrite,
  type GmailWriteDeps,
} from "../src/integrations/providers/gmail/gmailActions";
import {
  classifyReadOne,
  excerptBody,
  extractReadSender,
  handleGmailReadOne,
  type GmailReadOneDeps,
} from "../src/integrations/providers/gmail/gmailReadOne";
import { extractPlainText } from "../src/integrations/providers/gmail/messageBody";
import { formatLatestAnswer } from "../src/integrations/providers/gmail/gmailQuestion";
import { executeAction } from "../src/actions/executor";
import type { ActionPolicyContext } from "../src/actions/policy";
import type { ActionProposalView } from "../src/actions/proposals";
import type { GmailAction } from "../src/integrations/providers/gmail/gmailActionExtract";
import type {
  GmailReplyContext,
  NormalizedGmailMessage,
} from "../src/integrations/providers/gmail/types";
import type { GmailMessageBody } from "../src/integrations/providers/gmail/messageBody";
import type { GmailRawPayload } from "../src/integrations/providers/gmail/drafts";
import type { RecordExecutionInput } from "../src/actions/executions";

/**
 * Offline reproductions for the Section 16 correctness fixes. Everything is PURE or
 * uses injected fakes — NO database, NO real Gmail API, NO Anthropic. Reproduces
 * the three live failures (false "sent", missing signature, list-vs-read routing)
 * and covers the confirmation vocabulary and list-format changes. Run: `npm test`.
 */

let passed = 0;
const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}
function asyncCheck(name: string, fn: () => Promise<void>): void {
  asyncChecks.push({ name, fn });
}

const COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

function msg(over: Partial<NormalizedGmailMessage>): NormalizedGmailMessage {
  return {
    id: over.id ?? "m1",
    threadId: over.threadId ?? "t1",
    fromName: over.fromName ?? "Robert Ellis",
    fromAddress: over.fromAddress ?? "robert@example.com",
    subject: over.subject ?? "ICTS Job Offer",
    receivedAt: over.receivedAt ?? "2026-07-13T10:00:00Z",
    unread: over.unread ?? false,
    important: over.important ?? false,
    labels: over.labels ?? ["INBOX"],
    snippet: over.snippet ?? "A relief officer is a zero-hour role",
    source: "gmail",
  };
}

function gmailContext(userConfirmed?: boolean): ActionPolicyContext {
  return {
    connectedProviders: ["gmail"],
    grantedScopesByProvider: { gmail: [COMPOSE_SCOPE] },
    capabilitiesByProvider: { gmail: ["email.read", "email.draft", "email.send"] },
    userConfirmed,
  };
}

// ==========================================================================
// FIX 2 — natural confirmation vocabulary (conservative, anchored)
// ==========================================================================

check("confirm-vocab: all approved standalone phrases confirm", () => {
  for (const phrase of [
    "yes", "yeah", "yea", "yep", "confirm", "send it", "go ahead", "looks good", "do it", "proceed",
    "Yea", "Send it!", "  go ahead  ", "sounds good", "ok",
  ]) {
    assert.equal(classifyConfirmationReply(phrase), "confirm", `should confirm: ${phrase}`);
  }
});

check("confirm-vocab: all approved standalone phrases cancel", () => {
  for (const phrase of [
    "no", "nope", "cancel", "don't send", "do not send", "stop", "reject", "No.", "don't",
  ]) {
    assert.equal(classifyConfirmationReply(phrase), "cancel", `should cancel: ${phrase}`);
  }
});

check("confirm-vocab: ordinary sentences never confirm/cancel by accident", () => {
  for (const phrase of [
    "yes but can you also draft a reply",
    "send an email to Rob",
    "I need to proceed with the plan later",
    "go ahead and tell me the weather",
    "no idea what you mean",
    "can you confirm the meeting time",
    "",
  ]) {
    assert.equal(classifyConfirmationReply(phrase), "none", `should be none: ${phrase}`);
  }
});

// ==========================================================================
// FIX 1 — false operational success made impossible
// ==========================================================================

/** A full proposal view for the fake store. */
function proposalView(over: Partial<ActionProposalView> = {}): ActionProposalView {
  return {
    id: over.id ?? "prop_1",
    provider: "gmail",
    actionId: "email.sendDraft",
    status: over.status ?? "proposed",
    riskLevel: "send",
    confirmationRequired: true,
    previewText: "Ready to send: ...",
    input: over.input ?? { to: "robert@example.com", toName: "Robert Ellis", subject: "Re: ICTS Job Offer", body: "Yes.", isReply: true },
    expiresAt: over.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    confirmedAt: null,
    rejectedAt: null,
    executedAt: null,
    createdAt: new Date().toISOString(),
  };
}

/** A confirmation deps fake backed by a single mutable proposal + a send counter. */
function confirmDeps(start: ActionProposalView | null): {
  deps: ConfirmationDeps;
  state: { proposal: ActionProposalView | null; sends: number };
} {
  const state = { proposal: start, sends: 0 };
  const deps: ConfirmationDeps = {
    getActiveProposal: async () =>
      state.proposal && state.proposal.status === "proposed" && Date.parse(state.proposal.expiresAt) > Date.now()
        ? state.proposal
        : null,
    confirmProposal: async (_u, id) => {
      if (state.proposal && state.proposal.id === id && state.proposal.status === "proposed") {
        state.proposal = { ...state.proposal, status: "confirmed" };
        return state.proposal;
      }
      return null;
    },
    rejectProposal: async (_u, id) => {
      if (state.proposal && state.proposal.id === id && state.proposal.status === "proposed") {
        state.proposal = { ...state.proposal, status: "rejected" };
        return state.proposal;
      }
      return null;
    },
    finalizeProposal: async (_u, _id, outcome) => {
      if (state.proposal && state.proposal.status === "confirmed") {
        state.proposal = { ...state.proposal, status: outcome };
      }
    },
    executeAction: async () => {
      state.sends += 1;
      return { ok: true, status: "succeeded", actionId: "email.sendDraft", userMessage: "Reply sent to Robert Ellis." };
    },
  };
  return { deps, state };
}

asyncCheck("false-success: 'Yea' on an active send proposal confirms + sends exactly once", async () => {
  const { deps, state } = confirmDeps(proposalView());
  const r = await handleActionConfirmation("u", "Yea", deps);
  assert.equal(r.handled, true);
  assert.equal(r.outcome, "confirmed");
  assert.ok(/sent/i.test(r.reply ?? ""), "reports the real provider-confirmed success");
  assert.equal(state.sends, 1);
});

asyncCheck("false-success: a double confirmation sends exactly once", async () => {
  const { deps, state } = confirmDeps(proposalView());
  await handleActionConfirmation("u", "yea", deps);
  const second = await handleActionConfirmation("u", "yes", deps);
  assert.equal(second.handled, false, "no active proposal remains after the first confirm");
  assert.equal(state.sends, 1, "exactly one send");
});

asyncCheck("false-success: rejection sends nothing", async () => {
  const { deps, state } = confirmDeps(proposalView());
  const r = await handleActionConfirmation("u", "don't send", deps);
  assert.equal(r.outcome, "cancelled");
  assert.equal(state.sends, 0);
});

asyncCheck("false-success: an expired proposal never sends", async () => {
  const { deps, state } = confirmDeps(proposalView({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const r = await handleActionConfirmation("u", "yea", deps);
  assert.equal(r.handled, false);
  assert.equal(state.sends, 0);
});

// --- Executor: provider result is validated before any success claim -----

function execDeps(over: {
  send?: (u: string, p: GmailRawPayload) => Promise<{ messageId: string; threadId: string }>;
} = {}) {
  const recorded: RecordExecutionInput[] = [];
  const sent: GmailRawPayload[] = [];
  return {
    recorded,
    sent,
    deps: {
      buildContext: async (_u: string, opts: { userConfirmed?: boolean }) => gmailContext(opts?.userConfirmed),
      record: async (_u: string, i: RecordExecutionInput) => {
        recorded.push(i);
        return "exec_x";
      },
      sendGmailMessage:
        over.send ??
        (async (_u: string, p: GmailRawPayload) => {
          sent.push(p);
          return { messageId: "sent_1", threadId: "t1" };
        }),
      createGmailDraft: async (_u: string, p: GmailRawPayload) => {
        sent.push(p);
        return { draftId: "d_1", messageId: "m_1", threadId: "t1" };
      },
    },
  };
}

const SEND_INPUT = { to: "robert@example.com", toName: "Robert Ellis", subject: "Re: ICTS Job Offer", body: "Yes.", isReply: true, threadId: "t1" };

asyncCheck("false-success: a MALFORMED send result (no message id) is NOT a success", async () => {
  const d = execDeps({ send: async () => ({ messageId: "", threadId: "" }) });
  const r = await executeAction("u", "email.sendDraft", { input: SEND_INPUT, userConfirmed: true }, d.deps);
  assert.equal(r.ok, false, "no validated id => not ok");
  assert.ok(!/sent/i.test(r.userMessage), "must never claim it sent");
  assert.equal(d.recorded.at(-1)?.status, "failed");
});

asyncCheck("false-success: a provider throw is NOT a success", async () => {
  const d = execDeps({
    send: async () => {
      const { GmailError } = await import("../src/integrations/providers/gmail/client");
      throw new GmailError("provider_unavailable", "boom", 503);
    },
  });
  const r = await executeAction("u", "email.sendDraft", { input: SEND_INPUT, userConfirmed: true }, d.deps);
  assert.equal(r.ok, false);
  assert.ok(!/sent/i.test(r.userMessage));
});

// --- Safety net: an unrecognised reply never reaches the brain -----------

asyncCheck("safety-net: an active proposal turns an unrecognised reply into a deterministic re-prompt", async () => {
  const r = await handlePendingProposalReprompt("u", { getActiveProposal: async () => proposalView() });
  assert.equal(r.handled, true);
  assert.equal(r.reply, PENDING_PROPOSAL_REPROMPT);
  assert.ok(!/sent|done/i.test(r.reply ?? ""), "the re-prompt never claims an action happened");
});

asyncCheck("safety-net: with NO active proposal the message falls through to the brain", async () => {
  const r = await handlePendingProposalReprompt("u", { getActiveProposal: async () => null });
  assert.equal(r.handled, false);
});

asyncCheck("safety-net: a lookup failure falls through (never fabricates)", async () => {
  const r = await handlePendingProposalReprompt("u", {
    getActiveProposal: async () => {
      throw new Error("db down");
    },
  });
  assert.equal(r.handled, false);
});

// ==========================================================================
// FIX 3 — complete professional signatures (deterministic, never invented)
// ==========================================================================

check("signature: a closing with no name gets the real name appended", () => {
  const body = "Hi Rob,\n\nThank you for the offer. I'm happy to accept the Relief Officer role. Please let me know the next steps.\n\nBest regards";
  const signed = ensureSignature(body, "Ayub Yusuf");
  assert.ok(signed.endsWith("Best regards\n\nAyub Yusuf"), signed);
});

check("signature: 'Kind regards,' variant is completed", () => {
  const signed = ensureSignature("Sounds great.\n\nKind regards,", "Ayub Yusuf");
  assert.ok(signed.endsWith("Kind regards,\n\nAyub Yusuf"));
});

check("signature: a body already containing the name is untouched (no duplication)", () => {
  const dictated = "Hi Rob, this is Ayub Yusuf. Friday works.\n\nBest regards";
  assert.equal(ensureSignature(dictated, "Ayub Yusuf"), dictated);
});

check("signature: an already-complete signature is untouched", () => {
  const complete = "Thanks!\n\nBest regards,\nAyub Yusuf";
  assert.equal(ensureSignature(complete, "Ayub Yusuf"), complete);
});

check("signature: no display name never invents one", () => {
  const body = "Thanks.\n\nBest regards";
  assert.equal(ensureSignature(body, null), body);
  assert.equal(ensureSignature(body, "   "), body);
});

check("signature: a body with no closing is never appended to", () => {
  const casual = "Sounds good, see you Friday!";
  assert.equal(ensureSignature(casual, "Ayub Yusuf"), casual);
});

check("signature: a closing already followed by a DIFFERENT name is not doubled", () => {
  const body = "Thanks.\n\nBest regards,\nThe ICTS Team";
  assert.equal(ensureSignature(body, "Ayub Yusuf"), body);
});

/** Write deps that capture executor/proposal calls with a fixed display name. */
function sigDeps(action: GmailAction, over: Partial<GmailWriteDeps> = {}): {
  deps: GmailWriteDeps;
  calls: { executed: Record<string, unknown>[]; proposed: Record<string, unknown>[] };
} {
  const calls = { executed: [] as Record<string, unknown>[], proposed: [] as Record<string, unknown>[] };
  const deps: GmailWriteDeps = {
    writeCapability: async () => "connected_write",
    getDisplayName: async () => "Ayub Yusuf",
    getTimezone: async () => "Europe/London",
    extract: async () => action,
    execute: async (_u, _a, input) => {
      calls.executed.push(input);
      return { ok: true, userMessage: "Draft created in Gmail." };
    },
    createProposal: async (_u, input) => {
      calls.proposed.push(input.input as Record<string, unknown>);
      return { id: "prop_1" };
    },
    ...over,
  };
  return { deps, calls };
}

const UNSIGNED_BODY = "Hi Rob,\n\nHappy to accept. Please share the next steps.\n\nBest regards";

asyncCheck("signature: a SEND proposal carries the signed body + the preview shows the name", async () => {
  const { deps, calls } = sigDeps({ action: "send_new_email", recipientEmail: "robert@example.com", subject: "Acceptance", body: UNSIGNED_BODY } as GmailAction);
  const r = await handleGmailWrite("u", "send robert@example.com an email accepting", deps);
  assert.equal(calls.proposed.length, 1);
  assert.ok(String(calls.proposed[0]!.body).endsWith("Best regards\n\nAyub Yusuf"));
  assert.ok(/Best regards\n\nAyub Yusuf/.test(r.reply ?? ""), "preview shows the signed name");
});

asyncCheck("signature: a DRAFT executes with the identical signed body", async () => {
  const { deps, calls } = sigDeps({ action: "create_new_draft", recipientEmail: "robert@example.com", subject: "Acceptance", body: UNSIGNED_BODY } as GmailAction);
  await handleGmailWrite("u", "draft robert@example.com an email accepting", deps);
  assert.equal(calls.executed.length, 1);
  assert.ok(String(calls.executed[0]!.body).endsWith("Best regards\n\nAyub Yusuf"));
});

asyncCheck("signature: draft and send produce the SAME final body", async () => {
  const draft = sigDeps({ action: "create_new_draft", recipientEmail: "r@x.com", subject: "S", body: UNSIGNED_BODY } as GmailAction);
  const send = sigDeps({ action: "send_new_email", recipientEmail: "r@x.com", subject: "S", body: UNSIGNED_BODY } as GmailAction);
  await handleGmailWrite("u", "draft r@x.com an email", draft.deps);
  await handleGmailWrite("u", "send r@x.com an email", send.deps);
  assert.equal(draft.calls.executed[0]!.body, send.calls.proposed[0]!.body);
});

asyncCheck("signature: a reply with no display name is sent unchanged (never invented)", async () => {
  const replyCtx: GmailReplyContext = {
    threadId: "t1", messageIdHeader: "<a@mail>", references: null,
    replyToAddress: "robert@example.com", replyToName: "Robert Ellis", subject: "ICTS Job Offer",
  };
  const { deps, calls } = sigDeps(
    { action: "send_reply", recipientName: "Robert", body: "Happy to accept.\n\nBest regards" } as GmailAction,
    { getDisplayName: async () => null, fetchMessages: async () => [msg({ fromName: "Robert Ellis" })], fetchReplyContext: async () => replyCtx },
  );
  await handleGmailWrite("u", "reply to Robert's latest email", deps);
  assert.equal(calls.proposed.length, 1);
  assert.ok(!/Ayub/.test(String(calls.proposed[0]!.body)), "no name invented");
  assert.ok(String(calls.proposed[0]!.body).endsWith("Best regards"));
});

// ==========================================================================
// FIX 4 — email LIST vs READ-ONE vs SUMMARISE-ONE
// ==========================================================================

check("read-intent: plain list queries are NOT read-one", () => {
  assert.equal(classifyReadOne("What are my latest emails?"), null);
  assert.equal(classifyReadOne("Show my recent emails."), null);
  assert.equal(classifyReadOne("do I have any unread emails"), null);
});

check("read-intent: content questions classify as read", () => {
  assert.deepEqual(classifyReadOne("What does Rob's latest email say?"), { mode: "read", senderName: "rob" });
  assert.deepEqual(classifyReadOne("Read the newest email from Rob."), { mode: "read", senderName: "rob" });
  assert.equal(classifyReadOne("Read my latest email")?.mode, "read");
});

check("read-intent: content questions classify as summarise", () => {
  assert.deepEqual(classifyReadOne("Summarise Rob's most recent email."), { mode: "summarise", senderName: "rob" });
  assert.deepEqual(classifyReadOne("What is Rob's latest email about?"), { mode: "summarise", senderName: "rob" });
});

check("read-intent: draft/send requests are NOT read-one (they are writes)", () => {
  assert.equal(classifyReadOne("Draft a reply to Rob's latest email."), null);
  assert.equal(classifyReadOne("Send a reply to Rob's latest email."), null);
});

check("read-intent: sender extraction (possessive, 'from', multi-word, none)", () => {
  assert.equal(extractReadSender("what does Rob's latest email say"), "rob");
  assert.equal(extractReadSender("read the newest email from Robert Ellis"), "robert ellis");
  assert.equal(extractReadSender("read my latest email"), null);
  assert.equal(extractReadSender("what's it about"), null);
});

/** Read-one deps: injected messages + body + summariser (no network/DB). */
function readDeps(over: Partial<GmailReadOneDeps> = {}): {
  deps: GmailReadOneDeps;
  calls: { bodyOf: string[]; summarisedBodies: string[] };
} {
  const calls = { bodyOf: [] as string[], summarisedBodies: [] as string[] };
  const deps: GmailReadOneDeps = {
    getTimezone: async () => "Europe/London",
    fetchMessages: async () => [
      msg({ id: "new", threadId: "t2", fromName: "Robert Ellis", receivedAt: "2026-07-13T11:59:00Z", subject: "ICTS Job Offer" }),
      msg({ id: "old", threadId: "t1", fromName: "Robert Ellis", receivedAt: "2026-07-10T09:00:00Z", subject: "Re: ICTS Job Offer" }),
    ],
    fetchBody: async (_u, messageId) => {
      calls.bodyOf.push(messageId);
      return { text: "A relief officer is a zero-hour, non-guaranteed role. We would like to offer it to you.", snippet: "A relief officer is a zero-hour role" } as GmailMessageBody;
    },
    summarise: async ({ body }) => {
      calls.summarisedBodies.push(body);
      return "Robert is offering you the zero-hour Relief Officer role.";
    },
    ...over,
  };
  return { deps, calls };
}

asyncCheck("read-one: 'what does Rob's latest email say' reads the NEWEST matching body", async () => {
  const { deps, calls } = readDeps();
  const r = await handleGmailReadOne("u", "what does Rob's latest email say?", deps);
  assert.equal(r.handled, true);
  assert.equal(r.mode, "read");
  assert.deepEqual(calls.bodyOf, ["new"], "fetched the newest thread's message body");
  assert.ok(/relief officer is a zero-hour/.test(r.reply ?? ""), "answer is grounded in the real body");
});

asyncCheck("read-one: summarise feeds the REAL body to the summariser (no hallucination)", async () => {
  const { deps, calls } = readDeps();
  const r = await handleGmailReadOne("u", "summarise Rob's latest email", deps);
  assert.equal(r.mode, "summarise");
  assert.equal(calls.summarisedBodies.length, 1);
  assert.ok(/relief officer/i.test(calls.summarisedBodies[0]!), "summariser got the actual body");
  assert.ok(/Relief Officer role/.test(r.reply ?? ""));
});

asyncCheck("read-one: two matches WITHOUT 'latest' asks to clarify (no body fetched)", async () => {
  const { deps, calls } = readDeps();
  const r = await handleGmailReadOne("u", "what does Rob's email say?", deps);
  assert.ok(/Which do you mean/.test(r.reply ?? ""));
  assert.equal(calls.bodyOf.length, 0, "never reads a body until the thread is disambiguated");
});

asyncCheck("read-one: 'Ron' does not resolve a Rob/Robert message", async () => {
  const { deps, calls } = readDeps();
  const r = await handleGmailReadOne("u", "what does Ron's latest email say?", deps);
  assert.ok(/couldn’t find a recent email from ron/i.test(r.reply ?? ""));
  assert.equal(calls.bodyOf.length, 0);
});

asyncCheck("read-one: not-connected degrades honestly", async () => {
  const { deps } = readDeps({
    fetchMessages: async () => {
      const { GmailError } = await import("../src/integrations/providers/gmail/client");
      throw new GmailError("not_connected", "no gmail");
    },
  });
  const r = await handleGmailReadOne("u", "what does Rob's latest email say?", deps);
  assert.ok(/isn’t connected/i.test(r.reply ?? ""));
});

check("read-one: excerptBody truncates a very long body and never leaks raw MIME", () => {
  const long = "x".repeat(5000);
  const out = excerptBody(long);
  assert.ok(out.length < 1600);
  assert.ok(out.includes("…"));
});

// ==========================================================================
// messageBody: plain-text extraction (pure)
// ==========================================================================

check("body: prefers a text/plain part over html", () => {
  const raw = {
    payload: {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("Hello in plain text").toString("base64url") } },
        { mimeType: "text/html", body: { data: Buffer.from("<p>Hello in <b>html</b></p>").toString("base64url") } },
      ],
    },
  };
  assert.equal(extractPlainText(raw), "Hello in plain text");
});

check("body: falls back to stripped html when no plain part exists", () => {
  const raw = {
    payload: { mimeType: "text/html", body: { data: Buffer.from("<p>Hi <b>Rob</b></p>").toString("base64url") } },
  };
  assert.ok(/Hi\s+Rob/.test(extractPlainText(raw)));
  assert.ok(!/</.test(extractPlainText(raw)), "tags stripped");
});

check("body: an empty payload yields empty text (caller uses the snippet)", () => {
  assert.equal(extractPlainText({ payload: {} }), "");
});

// ==========================================================================
// FIX 5 — enriched recent-email list (sender, subject, time, snippet)
// ==========================================================================

check("list-format: latest list includes sender, cleaned subject, time, snippet; newest-first", () => {
  const now = new Date("2026-07-13T13:00:00Z");
  const out = formatLatestAnswer(
    [
      msg({ id: "1", fromName: "Robert Ellis", subject: "Re: Re: ICTS Job Offer", receivedAt: "2026-07-13T11:59:00Z", unread: true, snippet: "A relief officer is a zero-hour, non-guaranteed role we sometimes staff for events and cover" }),
      msg({ id: "2", fromName: "Bank", subject: "Statement ready", receivedAt: "2026-07-12T08:00:00Z", snippet: "Your July statement is ready" }),
    ],
    "Europe/London",
    now,
  );
  assert.ok(/1\. Robert Ellis — Re: ICTS Job Offer/.test(out), "sender + collapsed Re: subject");
  assert.ok(/2\. Bank — Statement ready/.test(out));
  assert.ok(/Received/.test(out), "received time present");
  assert.ok(/Unread\./.test(out), "unread flagged");
  assert.ok(/“A relief officer is a zero-hour/.test(out), "snippet present");
  assert.ok(out.includes("…"), "long snippet truncated");
  assert.ok(!/Content-Type|MIME-Version|<html/i.test(out), "never a raw body");
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} Gmail correctness-fix tests passed.`);
}

void run().catch((err) => {
  console.error("Gmail fix tests failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
