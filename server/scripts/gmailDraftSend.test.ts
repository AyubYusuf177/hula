import assert from "node:assert/strict";

import {
  classifyConfirmationReply,
  handleActionConfirmation,
  type ConfirmationDeps,
} from "../src/actions/confirmations";
import {
  GMAIL_DRAFT_SEND_REPLIES,
  GMAIL_WRITE_REPLIES,
  handleGmailDraftFollowup,
  handleGmailWrite,
  noMatchingRecipientReply,
  type GmailDraftFollowupDeps,
  type GmailWriteDeps,
} from "../src/integrations/providers/gmail/gmailActions";
import {
  classifyDraftSend,
  draftRecipientMatches,
  parseDraftRecipientHint,
  parseLastDraftData,
  type LastDraftData,
  type LoadedLastDraft,
} from "../src/integrations/providers/gmail/gmailDraftContext";
import {
  BLOCKED_BRAIN_REPLY,
  containsFabricatedActionSuccess,
  sanitizeBrainReply,
} from "../src/ai/operationalGuard";
import type { ActionProposalView } from "../src/actions/proposals";
import type { GmailAction } from "../src/integrations/providers/gmail/gmailActionExtract";

/**
 * Section 16 email-action reliability fixes — offline reproductions.
 *
 * Everything is PURE or uses injected fakes: NO database, NO real Gmail API, NO
 * Anthropic, and NO real email ever sent. Reproduces the two live failures
 * ("Send the draft" false success; "Yh" not confirming) and locks in the
 * operational-honesty boundary. Run: `npm test`.
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

// ==========================================================================
// FAILURE 2 — natural confirmation vocabulary
// ==========================================================================

const APPROVALS = [
  "yes", "y", "yh", "yeah", "yea", "yep", "sure", "okay", "ok", "absolutely",
  "send", "send it", "send that", "go ahead", "go for it", "looks good",
  "sounds good", "confirm", "do it", "proceed",
];
const CANCELS = [
  "no", "nope", "nah", "cancel", "cancel it", "don't send", "do not send",
  "stop", "leave it", "forget it",
];

check("confirm-vocab: every approved phrase classifies as confirm", () => {
  for (const phrase of APPROVALS) {
    assert.equal(classifyConfirmationReply(phrase), "confirm", `"${phrase}" should confirm`);
  }
});

check("confirm-vocab: 'Yh' (the live failure) confirms", () => {
  assert.equal(classifyConfirmationReply("Yh"), "confirm");
});

check("confirm-vocab: every approved cancellation classifies as cancel", () => {
  for (const phrase of CANCELS) {
    assert.equal(classifyConfirmationReply(phrase), "cancel", `"${phrase}" should cancel`);
  }
});

check("confirm-vocab: capitalization, punctuation, and whitespace are normalized", () => {
  assert.equal(classifyConfirmationReply("  YES!  "), "confirm");
  assert.equal(classifyConfirmationReply("Yh."), "confirm");
  assert.equal(classifyConfirmationReply("Send it!!"), "confirm");
  assert.equal(classifyConfirmationReply("  Cancel.  "), "cancel");
  assert.equal(classifyConfirmationReply("NOPE"), "cancel");
});

check("confirm-vocab: ordinary long sentences never accidentally confirm/cancel", () => {
  const sentences = [
    "yes I was thinking we could also add a second paragraph about the timeline",
    "can you send me the latest email from Rob please",
    "no worries, I'll figure out the schedule myself later on tonight",
    "sure would be nice if the weather improved this weekend for the trip",
    "what should I say to the recruiter about the start date",
  ];
  for (const s of sentences) {
    assert.equal(classifyConfirmationReply(s), "none", `"${s}" must not classify`);
  }
});

// Injectable proposal/executor fakes for the confirmation orchestrator.
function activeProposal(over: Partial<ActionProposalView> = {}): ActionProposalView {
  return {
    id: over.id ?? "prop_1",
    provider: "gmail",
    actionId: over.actionId ?? "email.sendDraft",
    status: "proposed",
    riskLevel: "send",
    confirmationRequired: true,
    previewText: "Ready to send…",
    input: over.input ?? { to: "rob@example.com", body: "Hi", subject: "Re: x", isReply: true },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    confirmedAt: null,
    rejectedAt: null,
    executedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function confirmDeps(over: Partial<ConfirmationDeps> = {}): {
  deps: ConfirmationDeps;
  calls: { executed: number; confirmed: number; finalized: string[] };
} {
  const calls = { executed: 0, confirmed: 0, finalized: [] as string[] };
  let confirmedOnce = false;
  const deps: ConfirmationDeps = {
    getActiveProposal: async () => activeProposal(),
    confirmProposal: async () => {
      if (confirmedOnce) return null; // guarded transition — a double yes is a no-op
      confirmedOnce = true;
      calls.confirmed += 1;
      return activeProposal({ status: "confirmed" });
    },
    rejectProposal: async () => activeProposal({ status: "rejected" }),
    finalizeProposal: async (_u, _id, outcome) => {
      calls.finalized.push(outcome);
    },
    executeAction: async () => {
      calls.executed += 1;
      return {
        ok: true,
        status: "succeeded" as const,
        actionId: "email.sendDraft",
        userMessage: "Reply sent to Rob <rob@example.com>.",
      };
    },
    ...over,
  };
  return { deps, calls };
}

asyncCheck("confirm: 'Yh' on an active send proposal confirms + sends exactly once", async () => {
  const { deps, calls } = confirmDeps();
  const r = await handleActionConfirmation("u", "Yh", deps);
  assert.equal(r.handled, true);
  assert.equal(r.outcome, "confirmed");
  assert.equal(calls.executed, 1, "send happens exactly once");
  assert.ok(/sent to Rob/i.test(r.reply ?? ""));
});

asyncCheck("confirm: an approval with NO active proposal does nothing (falls through)", async () => {
  const { deps } = confirmDeps({ getActiveProposal: async () => null });
  const r = await handleActionConfirmation("u", "send it", deps);
  assert.equal(r.handled, false);
});

asyncCheck("confirm: rejection ('leave it') sends nothing", async () => {
  const { deps, calls } = confirmDeps();
  const r = await handleActionConfirmation("u", "leave it", deps);
  assert.equal(r.outcome, "cancelled");
  assert.equal(calls.executed, 0);
});

// ==========================================================================
// FAILURE 1 — "send the draft": classification + parsing (pure)
// ==========================================================================

check("draft-send: explicit phrasings classify as explicit", () => {
  for (const t of [
    "send the draft",
    "send that draft",
    "send the draft to Rob",
    "go ahead and send the draft",
    "email the draft",
    "send my last draft",
    "send the reply draft",
    "send my last email",
  ]) {
    assert.equal(classifyDraftSend(t), "explicit", `"${t}"`);
  }
});

check("draft-send: bare references classify as weak", () => {
  for (const t of ["send it", "send that", "send this", "send the reply"]) {
    assert.equal(classifyDraftSend(t), "weak", `"${t}"`);
  }
});

check("draft-send: composes with dictated content are NOT draft follow-ups", () => {
  for (const t of [
    "send Rob an email saying I'll be there",
    "send an email to Rob that says hello",
    "draft a reply to Rob's email accepting the role",
    "what's on my calendar",
  ]) {
    assert.equal(classifyDraftSend(t), "none", `"${t}"`);
  }
});

check("draft-send: parses an optional recipient hint from 'to <name>'", () => {
  assert.equal(parseDraftRecipientHint("send the draft to Rob"), "Rob");
  assert.equal(parseDraftRecipientHint("send the draft to rob@example.com"), "rob@example.com");
  assert.equal(parseDraftRecipientHint("send the draft"), null);
  assert.equal(parseDraftRecipientHint("send it"), null);
});

check("draft-send: recipient hint matches name tokens and address local-part", () => {
  const data: LastDraftData = {
    kind: "gmail_last_draft",
    draftId: "d1",
    messageId: "m1",
    threadId: "t1",
    to: "rob.ellis@example.com",
    toName: "Robert Ellis",
    subject: "Re: Offer",
    isReply: true,
    action: "create_reply_draft",
  };
  assert.equal(draftRecipientMatches(data, "Rob"), true, "local-part 'rob'");
  assert.equal(draftRecipientMatches(data, "Robert"), true, "name token");
  assert.equal(draftRecipientMatches(data, "Ellis"), true, "surname token");
  assert.equal(draftRecipientMatches(data, "rob.ellis@example.com"), true, "exact address");
  assert.equal(draftRecipientMatches(data, "Sarah"), false, "no match");
});

check("draft-send: parseLastDraftData rejects a non-last-draft payload", () => {
  assert.equal(parseLastDraftData(null), null);
  assert.equal(parseLastDraftData({ kind: "gmail_reply_clarification" }), null);
  assert.equal(parseLastDraftData({ kind: "gmail_last_draft" }), null, "missing ids");
  const ok = parseLastDraftData({
    kind: "gmail_last_draft",
    draftId: "d1",
    to: "a@b.com",
    subject: "hi",
    action: "create_new_draft",
  });
  assert.ok(ok && ok.draftId === "d1");
});

// ==========================================================================
// FAILURE 1 — handleGmailDraftFollowup (injected fakes; never touches Gmail)
// ==========================================================================

function ref(over: Partial<LastDraftData> = {}, row: Partial<LoadedLastDraft> = {}): LoadedLastDraft {
  return {
    id: row.id ?? "ld_1",
    status: row.status ?? "proposed",
    expired: row.expired ?? false,
    createdAt: row.createdAt ?? new Date().toISOString(),
    data: {
      kind: "gmail_last_draft",
      draftId: over.draftId ?? "draft_abc",
      messageId: over.messageId ?? "msg_abc",
      threadId: over.threadId ?? "thread_abc",
      to: over.to ?? "rob@example.com",
      toName: over.toName ?? "Robert Ellis",
      subject: over.subject ?? "Re: ICTS Job Offer",
      isReply: over.isReply ?? true,
      action: over.action ?? "create_reply_draft",
    },
  };
}

function followupDeps(over: Partial<GmailDraftFollowupDeps> = {}): {
  deps: GmailDraftFollowupDeps;
  calls: {
    verified: string[];
    sent: string[];
    marked: string[];
    released: string[];
    claimed: string[];
  };
} {
  const calls = {
    verified: [] as string[],
    sent: [] as string[],
    marked: [] as string[],
    released: [] as string[],
    claimed: [] as string[],
  };
  const claimedIds = new Set<string>();
  const deps: GmailDraftFollowupDeps = {
    writeCapability: async () => "connected_write",
    loadDrafts: async () => [ref()],
    claim: async (_u, id) => {
      calls.claimed.push(id);
      if (claimedIds.has(id)) return false; // second claim loses (idempotent)
      claimedIds.add(id);
      return true;
    },
    markSent: async (_u, id) => {
      calls.marked.push(id);
    },
    release: async (_u, id) => {
      calls.released.push(id);
      claimedIds.delete(id);
    },
    verifyDraft: async (_u, draftId) => {
      calls.verified.push(draftId);
      return true;
    },
    sendDraft: async (_u, draftId) => {
      calls.sent.push(draftId);
      return { messageId: "sent_msg_1", threadId: "thread_abc" };
    },
    ...over,
  };
  return { deps, calls };
}

asyncCheck("followup: 'send the draft to Rob' re-fetches, sends the ACTUAL draft once, marks sent", async () => {
  const { deps, calls } = followupDeps();
  const r = await handleGmailDraftFollowup("u", "send the draft to Rob", deps);
  assert.equal(r.handled, true);
  assert.equal(calls.verified.length, 1, "re-fetched before sending");
  assert.deepEqual(calls.verified, ["draft_abc"]);
  assert.equal(calls.sent.length, 1, "sent exactly once via draft-send");
  assert.deepEqual(calls.sent, ["draft_abc"], "the real draft id, never reconstructed");
  assert.deepEqual(calls.marked, ["ld_1"], "reference marked sent");
  assert.equal(calls.released.length, 0);
  assert.ok(/Draft sent to Robert Ellis/.test(r.reply ?? ""), r.reply);
});

asyncCheck("followup: 'send it' resolves the single active draft", async () => {
  const { deps, calls } = followupDeps();
  const r = await handleGmailDraftFollowup("u", "send it", deps);
  assert.equal(r.handled, true);
  assert.equal(calls.sent.length, 1);
});

asyncCheck("followup: NO draft + explicit request → honest, no send", async () => {
  const { deps, calls } = followupDeps({ loadDrafts: async () => [] });
  const r = await handleGmailDraftFollowup("u", "send the draft", deps);
  assert.equal(r.handled, true);
  assert.equal(r.reply, GMAIL_DRAFT_SEND_REPLIES.noDraft);
  assert.equal(calls.sent.length, 0);
});

asyncCheck("followup: NO draft + weak 'send it' → falls through (never hijacked)", async () => {
  const { deps, calls } = followupDeps({ loadDrafts: async () => [] });
  const r = await handleGmailDraftFollowup("u", "send it", deps);
  assert.equal(r.handled, false);
  assert.equal(calls.sent.length, 0);
});

asyncCheck("followup: already-sent draft → 'already sent', no send", async () => {
  const { deps, calls } = followupDeps({
    loadDrafts: async () => [ref({}, { status: "executed" })],
  });
  const r = await handleGmailDraftFollowup("u", "send the draft", deps);
  assert.equal(r.reply, GMAIL_DRAFT_SEND_REPLIES.alreadySent);
  assert.equal(calls.sent.length, 0);
});

asyncCheck("followup: repeated 'send it' cannot send twice (atomic claim)", async () => {
  // A single mutable reference list shared across both calls; first send flips it
  // to executed and the claim guard also refuses a second claim.
  let row = ref();
  const { deps, calls } = followupDeps({
    loadDrafts: async () => [row],
    markSent: async () => {
      row = ref({}, { status: "executed" });
    },
  });
  const r1 = await handleGmailDraftFollowup("u", "send it", deps);
  const r2 = await handleGmailDraftFollowup("u", "send it", deps);
  assert.ok(/Draft sent/.test(r1.reply ?? ""));
  assert.equal(r2.reply, GMAIL_DRAFT_SEND_REPLIES.alreadySent);
  assert.equal(calls.sent.length, 1, "provider draft-send invoked exactly once");
});

asyncCheck("followup: expired draft context does not send", async () => {
  const { deps, calls } = followupDeps({
    loadDrafts: async () => [ref({}, { expired: true })],
  });
  const r = await handleGmailDraftFollowup("u", "send the draft", deps);
  assert.equal(r.reply, GMAIL_DRAFT_SEND_REPLIES.noDraft);
  assert.equal(calls.sent.length, 0);
});

asyncCheck("followup: multiple active drafts → asks which, no send", async () => {
  const { deps, calls } = followupDeps({
    loadDrafts: async () => [
      ref({ to: "rob@example.com", toName: "Rob" }, { id: "ld_1" }),
      ref({ to: "sam@example.com", toName: "Sam" }, { id: "ld_2" }),
    ],
  });
  const r = await handleGmailDraftFollowup("u", "send the draft", deps);
  assert.equal(r.reply, GMAIL_DRAFT_SEND_REPLIES.multiple);
  assert.equal(calls.sent.length, 0);
});

asyncCheck("followup: recipient hint disambiguates among multiple drafts", async () => {
  const { deps, calls } = followupDeps({
    loadDrafts: async () => [
      ref({ to: "rob@example.com", toName: "Robert Ellis" }, { id: "ld_1" }),
      ref({ to: "sam@example.com", toName: "Sam Jones" }, { id: "ld_2" }),
    ],
  });
  const r = await handleGmailDraftFollowup("u", "send the draft to Sam", deps);
  assert.ok(/Draft sent to Sam Jones/.test(r.reply ?? ""), r.reply);
  assert.equal(calls.sent.length, 1);
});

asyncCheck("followup: hint matching nothing → honest, no unrelated draft sent", async () => {
  const { deps, calls } = followupDeps({
    loadDrafts: async () => [ref({ to: "rob@example.com", toName: "Rob" })],
  });
  const r = await handleGmailDraftFollowup("u", "send the draft to Zed", deps);
  assert.equal(r.reply, noMatchingRecipientReply("Zed"));
  assert.equal(calls.sent.length, 0);
});

asyncCheck("followup: a provider throw is NOT a success (released, not marked)", async () => {
  const { deps, calls } = followupDeps({
    sendDraft: async () => {
      const { GmailError } = await import("../src/integrations/providers/gmail/client");
      throw new GmailError("provider_unavailable", "boom", 503);
    },
  });
  const r = await handleGmailDraftFollowup("u", "send the draft", deps);
  assert.equal(r.reply, GMAIL_DRAFT_SEND_REPLIES.sendUnconfirmed);
  assert.equal(calls.marked.length, 0, "never marked sent on failure");
  assert.deepEqual(calls.released, ["ld_1"], "claim released for safe retry");
});

asyncCheck("followup: a MALFORMED provider result (no message id) is NOT a success", async () => {
  const { deps, calls } = followupDeps({
    sendDraft: async () => ({ messageId: "", threadId: "t" }),
  });
  const r = await handleGmailDraftFollowup("u", "send the draft", deps);
  assert.equal(r.reply, GMAIL_DRAFT_SEND_REPLIES.sendUnconfirmed);
  assert.equal(calls.marked.length, 0);
  assert.deepEqual(calls.released, ["ld_1"]);
});

asyncCheck("followup: a draft that no longer exists in Gmail → honest, no send", async () => {
  const { deps, calls } = followupDeps({ verifyDraft: async () => false });
  const r = await handleGmailDraftFollowup("u", "send the draft", deps);
  assert.equal(r.reply, GMAIL_DRAFT_SEND_REPLIES.draftGone);
  assert.equal(calls.sent.length, 0, "never sends a draft we couldn't re-fetch");
  assert.deepEqual(calls.released, ["ld_1"]);
});

asyncCheck("followup: read-only capability asks the user to reconnect", async () => {
  const { deps, calls } = followupDeps({ writeCapability: async () => "connected_readonly" });
  const r = await handleGmailDraftFollowup("u", "send the draft", deps);
  assert.equal(r.reply, GMAIL_WRITE_REPLIES.reconnect);
  assert.equal(calls.sent.length, 0);
});

asyncCheck("followup: not-connected degrades honestly", async () => {
  const { deps, calls } = followupDeps({ writeCapability: async () => "not_connected" });
  const r = await handleGmailDraftFollowup("u", "send the draft", deps);
  assert.equal(r.reply, GMAIL_WRITE_REPLIES.notConnected);
  assert.equal(calls.sent.length, 0);
});

asyncCheck("followup: another user's draft can never be resolved (scoped load empty)", async () => {
  // The loader is user-scoped in production; here an empty load means the current
  // user has no draft, so an explicit request is answered honestly and no other
  // user's draft is ever reachable.
  const { deps, calls } = followupDeps({ loadDrafts: async () => [] });
  const r = await handleGmailDraftFollowup("u", "send my last draft", deps);
  assert.equal(r.reply, GMAIL_DRAFT_SEND_REPLIES.noDraft);
  assert.equal(calls.sent.length, 0);
});

asyncCheck("followup: a load failure falls through (never fabricates a send)", async () => {
  const { deps, calls } = followupDeps({
    loadDrafts: async () => {
      throw new Error("db down");
    },
  });
  const r = await handleGmailDraftFollowup("u", "send the draft", deps);
  assert.equal(r.handled, false);
  assert.equal(calls.sent.length, 0);
});

asyncCheck("followup: an unrelated message is not intercepted", async () => {
  const { deps } = followupDeps();
  const r = await handleGmailDraftFollowup("u", "what's the weather like tomorrow", deps);
  assert.equal(r.handled, false);
});

// ==========================================================================
// FAILURE 1 — creating a draft persists a reference from a VALIDATED receipt
// ==========================================================================

asyncCheck("write: a created draft persists a last-draft reference from the receipt", async () => {
  const recorded: LastDraftData[] = [];
  const deps: GmailWriteDeps = {
    writeCapability: async () => "connected_write",
    extract: async () =>
      ({
        action: "create_new_draft",
        recipientEmail: "rob@example.com",
        subject: "Lunch",
        body: "Friday works.",
      }) as GmailAction,
    execute: async () => ({
      ok: true,
      userMessage: "Draft created in Gmail.\nTo: rob@example.com\nSubject: Lunch",
      receipt: { draftId: "draft_xyz", messageId: "m_xyz", threadId: "t_xyz" },
    }),
    recordLastDraft: async (_u, data) => {
      recorded.push(data);
      return { id: "ld_new" };
    },
  };
  const r = await handleGmailWrite("u", "draft an email to rob@example.com about lunch", deps);
  assert.equal(r.handled, true);
  assert.equal(recorded.length, 1, "reference persisted");
  assert.equal(recorded[0]!.draftId, "draft_xyz", "from the validated receipt only");
  assert.equal(recorded[0]!.to, "rob@example.com");
});

asyncCheck("write: a SEND (not a draft) never persists a last-draft reference", async () => {
  const recorded: LastDraftData[] = [];
  const deps: GmailWriteDeps = {
    writeCapability: async () => "connected_write",
    extract: async () =>
      ({
        action: "send_new_email",
        recipientEmail: "rob@example.com",
        subject: "Lunch",
        body: "Friday works.",
      }) as GmailAction,
    createProposal: async () => ({ id: "prop_1" }),
    recordLastDraft: async (_u, data) => {
      recorded.push(data);
      return { id: "ld_new" };
    },
  };
  await handleGmailWrite("u", "send rob@example.com an email about lunch", deps);
  assert.equal(recorded.length, 0, "a send proposes; it does not create a stored draft ref");
});

// ==========================================================================
// OPERATIONAL HONESTY — brain output can never claim an external action
// ==========================================================================

check("honesty: the exact live fabrication ('Reply sent to Robert Ellis.') is blocked", () => {
  assert.equal(containsFabricatedActionSuccess("Reply sent to Robert Ellis."), true);
  const s = sanitizeBrainReply("Reply sent to Robert Ellis.");
  assert.equal(s.blocked, true);
  assert.equal(s.text, BLOCKED_BRAIN_REPLY);
});

check("honesty: assorted fabricated successes are blocked", () => {
  for (const t of [
    "Email sent to rob@example.com.",
    "Draft sent.",
    "Your email has been sent.",
    "I've sent your email to Rob.",
    "I have just sent the draft.",
    "I've added that to your calendar.",
    "Your reminder is set for 5pm.",
    "I've created the event for tomorrow.",
    "I deleted the meeting.",
  ]) {
    assert.equal(containsFabricatedActionSuccess(t), true, `should block: "${t}"`);
  }
});

check("honesty: safe replies are NOT blocked", () => {
  for (const t of [
    "I can draft that for you — want me to?",
    "I'll send it once you confirm.",
    "Want me to send the draft?",
    "You can check your Sent folder to confirm it went through.",
    "Sounds good — let me know if you'd like any changes.",
    "Here's a draft you could use: 'Thanks for the offer…'",
    "Do you want me to create a calendar event for that?",
  ]) {
    assert.equal(containsFabricatedActionSuccess(t), false, `should allow: "${t}"`);
  }
});

check("honesty: a real receipt-backed handler string is unaffected (guard only wraps the brain)", () => {
  // The guard is applied ONLY to generic brain output in the webhook; deterministic
  // handlers return their own receipt-gated strings and never pass through it. This
  // documents that the guard is not applied to handler output.
  const handlerReply = "Draft sent to Robert Ellis.";
  // If it WERE run through the guard it would be caught — which is exactly why the
  // guard must never wrap deterministic, receipt-backed handler output.
  assert.equal(containsFabricatedActionSuccess(handlerReply), true);
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} Gmail draft-send + confirmation tests passed.`);
}

void run().catch((err) => {
  console.error("Gmail draft-send tests failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
