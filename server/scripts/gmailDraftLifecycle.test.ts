import assert from "node:assert/strict";

import {
  GMAIL_DRAFT_REPLIES,
  draftMatchesHint,
  formatDeleteDraftPreview,
  formatDraftDetail,
  formatDraftList,
  handleGmailDraftLifecycle,
  looksLikeDraftCommand,
  type GmailDraftLifecycleDeps,
} from "../src/integrations/providers/gmail/gmailDraftLifecycle";
import {
  buildDraftCommandPrompt,
  parseGmailDraftCommand,
  type GmailDraftCommand,
} from "../src/integrations/providers/gmail/gmailDraftExtract";
import {
  parseGmailSelectionData,
  parseOrdinalReference,
  resolveSelectionItem,
  type GmailSelectionData,
  type LoadedGmailSelection,
} from "../src/integrations/providers/gmail/gmailSelection";
import { normalizeGmailDraft } from "../src/integrations/providers/gmail/drafts";
import type { GmailDraftDetail } from "../src/integrations/providers/gmail/drafts";
import { GmailError } from "../src/integrations/providers/gmail/client";
import { classifyConfirmationReply } from "../src/actions/confirmations";
import type { CreateProposalInput } from "../src/actions/proposals";
import type { NormalizedGmailDraft } from "../src/integrations/providers/gmail/types";

/**
 * Offline tests for the Gmail DRAFT LIFECYCLE (Section 17 / Phase 3.4) — list,
 * inspect, edit, delete. Everything here is PURE or uses injected fakes: NO
 * database, NO real Gmail API, NO Anthropic.
 *
 * The properties worth breaking a build over:
 *  - CANCEL and DELETE are different operations. Cancel touches no Gmail data.
 *  - EDIT never sends, and never blanks a draft on a rewrite failure.
 *  - Every edit/delete RE-FETCHES the draft rather than trusting a stale reference.
 *  - Editing a REPLY draft preserves its threading headers.
 *  - Deleting requires an explicit confirmation and cannot run twice.
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

function draft(over: Partial<NormalizedGmailDraft> = {}): NormalizedGmailDraft {
  return {
    draftId: "d1",
    messageId: "m1",
    threadId: null,
    to: "rob@example.com",
    toName: "Rob",
    subject: "Friday",
    snippet: "Friday works",
    source: "gmail",
    ...over,
  };
}

function detail(over: Partial<GmailDraftDetail> = {}): GmailDraftDetail {
  return {
    draft: draft(),
    body: "Friday works for me.",
    inReplyTo: null,
    references: null,
    ...over,
  };
}

// ==========================================================================
// Ordinal references (PURE)
// ==========================================================================

check("ordinal: word ordinals resolve to a position", () => {
  assert.deepEqual(parseOrdinalReference("the second one"), { position: 2 });
  assert.deepEqual(parseOrdinalReference("open the first draft"), { position: 1 });
  assert.deepEqual(parseOrdinalReference("summarise the third one"), { position: 3 });
});

check("ordinal: numeric and explicit indexes resolve", () => {
  assert.deepEqual(parseOrdinalReference("the 2nd"), { position: 2 });
  assert.deepEqual(parseOrdinalReference("number 3"), { position: 3 });
  assert.deepEqual(parseOrdinalReference("option 2"), { position: 2 });
  assert.deepEqual(parseOrdinalReference("draft 3"), { position: 3 });
  assert.deepEqual(parseOrdinalReference("2"), { position: 2 });
  assert.deepEqual(parseOrdinalReference("#2"), { position: 2 });
});

check("ordinal: 'the last one' resolves to the end of the list", () => {
  assert.deepEqual(parseOrdinalReference("send the last one"), { last: true });
});

check("ordinal: a number inside a sentence is NOT a position", () => {
  // The dangerous false positive: "change 5pm to 6pm" must never be read as
  // "item 5" and act on the fifth email.
  assert.equal(parseOrdinalReference("change 5pm to 6pm"), null);
  assert.equal(parseOrdinalReference("make it 20% shorter"), null);
  assert.equal(parseOrdinalReference("tell him I'll be 10 minutes late"), null);
});

check("ordinal: ordinary messages name no position", () => {
  assert.equal(parseOrdinalReference("hello"), null);
  assert.equal(parseOrdinalReference(""), null);
  assert.equal(parseOrdinalReference("send it"), null);
});

check("ordinal: out-of-range positions are rejected, never clamped", () => {
  // Clamping to the nearest item would act on an email the user never picked.
  const data: GmailSelectionData = {
    kind: "gmail_selection",
    itemKind: "messages",
    items: [
      { id: "a", threadId: null, label: "Rob", subject: "x" },
      { id: "b", threadId: null, label: "Sue", subject: "y" },
    ],
  };
  assert.equal(resolveSelectionItem(data, { position: 5 }), null);
  assert.equal(resolveSelectionItem(data, { position: 0 }), null);
  assert.equal(resolveSelectionItem(data, { position: 1 })?.id, "a");
  assert.equal(resolveSelectionItem(data, { position: 2 })?.id, "b");
  assert.equal(resolveSelectionItem(data, { last: true })?.id, "b");
});

check("selection: malformed stored payloads are rejected", () => {
  assert.equal(parseGmailSelectionData(null), null);
  assert.equal(parseGmailSelectionData({ kind: "other" }), null);
  assert.equal(parseGmailSelectionData({ kind: "gmail_selection", itemKind: "bogus" }), null);
  assert.equal(parseGmailSelectionData({ kind: "gmail_selection", itemKind: "drafts", items: [] }), null);
  const ok = parseGmailSelectionData({
    kind: "gmail_selection",
    itemKind: "drafts",
    items: [{ id: "d1", threadId: null, label: "Rob", subject: "x" }],
  });
  assert.equal(ok?.items[0]?.id, "d1");
});

// ==========================================================================
// Extraction — the cancel/delete distinction
// ==========================================================================

check("extract: draft commands parse", () => {
  assert.equal(parseGmailDraftCommand('{"action":"list_drafts"}')?.action, "list_drafts");
  assert.equal(
    parseGmailDraftCommand('{"action":"edit_draft","editInstruction":"make it shorter"}')
      ?.editInstruction,
    "make it shorter",
  );
  assert.equal(parseGmailDraftCommand('{"action":"delete_draft","ordinal":2}')?.ordinal, 2);
});

check("extract: malformed / off-schema JSON returns null", () => {
  assert.equal(parseGmailDraftCommand("not json"), null);
  assert.equal(parseGmailDraftCommand('{"action":"nuke_inbox"}'), null);
  assert.equal(parseGmailDraftCommand('{"action":"delete_draft","ordinal":99}'), null);
  assert.equal(parseGmailDraftCommand(""), null);
});

check("extract: the prompt tells the model cancel is NOT a draft command", () => {
  const p = buildDraftCommandPrompt();
  assert.ok(/not_draft_command/.test(p));
  assert.ok(/"cancel".*NOT a draft command/is.test(p), "cancel/delete must be separated");
  assert.ok(/verbatim/i.test(p), "the model must not rewrite the email itself");
});

check("cancel: cancellation vocabulary never reads as a draft command", () => {
  // The load-bearing separation. These are owned by the confirmation flow, which
  // runs EARLIER in the cascade; if any of them classified as a draft command they
  // could reach the delete path and destroy real mail.
  for (const t of ["no", "cancel", "never mind", "no thanks", "stop", "leave it", "forget it"]) {
    assert.equal(classifyConfirmationReply(t), "cancel", `${t} must be a cancellation`);
    assert.equal(
      looksLikeDraftCommand(t),
      false,
      `${t} must NOT reach the draft lifecycle handler`,
    );
  }
});

check("prefilter: matches draft commands and edit phrasings", () => {
  for (const t of [
    "show me my drafts",
    "open the second draft",
    "delete that draft",
    "make it shorter",
    "change Friday to Monday",
    "make that more professional",
  ]) {
    assert.equal(looksLikeDraftCommand(t), true, `should match: ${t}`);
  }
});

check("prefilter: ordinary chat never matches", () => {
  for (const t of ["hey how are you", "thanks!", "what's on my calendar", ""]) {
    assert.equal(looksLikeDraftCommand(t), false, `should not match: ${t}`);
  }
});

// ==========================================================================
// Formatting
// ==========================================================================

check("format: the draft list is numbered and addressable", () => {
  const out = formatDraftList([draft(), draft({ draftId: "d2", toName: "Sue", subject: "Invoice" })]);
  assert.ok(/You have 2 drafts:/.test(out));
  assert.ok(/1\. To Rob — Friday/.test(out));
  assert.ok(/2\. To Sue — Invoice/.test(out));
});

check("format: an empty draft list is stated plainly", () => {
  assert.equal(formatDraftList([]), GMAIL_DRAFT_REPLIES.noDrafts);
});

check("format: inspecting a draft shows its real body, bounded", () => {
  const out = formatDraftDetail(detail());
  assert.ok(/Draft to Rob/.test(out));
  assert.ok(/Subject: Friday/.test(out));
  assert.ok(/Friday works for me\./.test(out));

  const long = formatDraftDetail(detail({ body: "x".repeat(5000) }));
  assert.ok(long.includes("…"), "a long body must be truncated");
  assert.ok(long.length < 1500);
});

check("format: an empty draft says so rather than looking broken", () => {
  assert.ok(/This draft is empty/.test(formatDraftDetail(detail({ body: "" }))));
});

check("format: the delete preview says it cannot be undone", () => {
  const out = formatDeleteDraftPreview(draft());
  assert.ok(/I’ll delete the draft to Rob/.test(out));
  assert.ok(/can’t undo/i.test(out), "irreversibility must be stated up front");
  assert.ok(/want me to go ahead\?/i.test(out));
  assert.ok(!/^Deleted/.test(out), "must not read as already done");
});

check("hint: recipient hints match by name and address", () => {
  assert.equal(draftMatchesHint(draft(), "Rob"), true);
  assert.equal(draftMatchesHint(draft(), "rob@example.com"), true);
  assert.equal(draftMatchesHint(draft(), "Sarah"), false);
});

check("normalize: a draft's To header and ids are extracted safely", () => {
  const d = normalizeGmailDraft({
    id: "d9",
    message: {
      id: "m9",
      threadId: "t9",
      snippet: "hi",
      payload: {
        headers: [
          { name: "To", value: "Rob Smith <rob@example.com>" },
          { name: "Subject", value: "Friday" },
        ],
      },
    },
  });
  assert.equal(d.draftId, "d9");
  assert.equal(d.threadId, "t9");
  assert.equal(d.to, "rob@example.com");
  assert.equal(d.toName, "Rob Smith");
  assert.equal(d.subject, "Friday");
});

// ==========================================================================
// Orchestration
// ==========================================================================

interface Calls {
  listed: number;
  fetched: string[];
  proposed: CreateProposalInput[];
  executed: { actionId: string; input: Record<string, unknown> }[];
  selections: GmailSelectionData[];
}

function deps(
  over: Partial<GmailDraftLifecycleDeps> & {
    command?: GmailDraftCommand | null;
    drafts?: NormalizedGmailDraft[];
    selection?: LoadedGmailSelection | null;
    detail?: GmailDraftDetail;
  } = {},
): { deps: GmailDraftLifecycleDeps; calls: Calls } {
  const calls: Calls = {
    listed: 0,
    fetched: [],
    proposed: [],
    executed: [],
    selections: [],
  };
  const d: GmailDraftLifecycleDeps = {
    extract: async () => (over.command === undefined ? { action: "list_drafts" } : over.command),
    list: async () => {
      calls.listed += 1;
      return over.drafts ?? [draft()];
    },
    getDetail: async (_u, id) => {
      calls.fetched.push(id);
      return over.detail ?? detail();
    },
    rewrite: async () => "Monday works for me.",
    propose: async (_u, input) => {
      calls.proposed.push(input);
      return {
        id: "prop_1",
        provider: input.provider ?? null,
        actionId: input.actionId,
        status: "proposed",
        riskLevel: input.riskLevel,
        confirmationRequired: input.confirmationRequired ?? true,
        previewText: input.previewText,
        input: input.input ?? null,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        confirmedAt: null,
        rejectedAt: null,
        executedAt: null,
        createdAt: new Date().toISOString(),
      };
    },
    execute: async (_u, actionId, options) => {
      calls.executed.push({ actionId, input: options?.input ?? {} });
      return {
        ok: true,
        status: "succeeded" as const,
        actionId,
        userMessage: "Updated the draft to Rob.",
      };
    },
    recordSelection: async (_u, data) => {
      calls.selections.push(data);
      return { id: "sel_1" };
    },
    loadSelection: async () => (over.selection === undefined ? null : over.selection),
    ...over,
  };
  return { deps: d, calls };
}

function draftSelection(ids: string[]): LoadedGmailSelection {
  return {
    id: "sel_1",
    data: {
      kind: "gmail_selection",
      itemKind: "drafts",
      items: ids.map((id, i) => ({
        id,
        threadId: null,
        label: `Person${i + 1}`,
        subject: `Subject${i + 1}`,
      })),
    },
    expired: false,
    createdAt: new Date().toISOString(),
  };
}

// --- List ---

asyncCheck("list: shows drafts and remembers them for positional follow-ups", async () => {
  const { deps: d, calls } = deps({
    command: { action: "list_drafts" },
    drafts: [draft(), draft({ draftId: "d2", toName: "Sue" })],
  });
  const r = await handleGmailDraftLifecycle("u", "show me my drafts", d);
  assert.equal(r.action, "list_drafts");
  assert.ok(/You have 2 drafts:/.test(r.reply ?? ""));
  const sel = calls.selections[0]!;
  assert.equal(sel.itemKind, "drafts");
  assert.deepEqual(sel.items.map((i) => i.id), ["d1", "d2"], "order must match the display");
});

asyncCheck("list: an empty list is not remembered", async () => {
  const { deps: d, calls } = deps({ command: { action: "list_drafts" }, drafts: [] });
  const r = await handleGmailDraftLifecycle("u", "show me my drafts", d);
  assert.equal(r.reply, GMAIL_DRAFT_REPLIES.noDrafts);
  assert.equal(calls.selections.length, 0);
});

// --- Open / inspect ---

asyncCheck("open: a position resolves against the remembered list and re-fetches", async () => {
  const { deps: d, calls } = deps({
    command: { action: "open_draft", ordinal: 2 },
    selection: draftSelection(["d1", "d2"]),
  });
  const r = await handleGmailDraftLifecycle("u", "open the second draft", d);
  assert.equal(r.action, "open_draft");
  assert.deepEqual(calls.fetched, ["d2"], "must inspect the draft at position 2");
  assert.equal(calls.listed, 0, "a position must not trigger a re-list");
  assert.ok(/Draft to Rob/.test(r.reply ?? ""));
});

asyncCheck("open: a position with no remembered list asks rather than guessing", async () => {
  const { deps: d, calls } = deps({
    command: { action: "open_draft", ordinal: 2 },
    selection: null,
  });
  const r = await handleGmailDraftLifecycle("u", "open the second draft", d);
  assert.equal(r.reply, GMAIL_DRAFT_REPLIES.noneToOpen);
  assert.equal(calls.fetched.length, 0);
});

asyncCheck("open: an out-of-range position is refused, not clamped", async () => {
  const { deps: d, calls } = deps({
    command: { action: "open_draft", ordinal: 5 },
    selection: draftSelection(["d1", "d2"]),
  });
  const r = await handleGmailDraftLifecycle("u", "open the fifth draft", d);
  assert.equal(r.reply, GMAIL_DRAFT_REPLIES.outOfRange);
  assert.equal(calls.fetched.length, 0, "must never touch a draft the user didn't pick");
});

asyncCheck("open: a single draft needs no disambiguation", async () => {
  const { deps: d, calls } = deps({ command: { action: "open_draft" }, drafts: [draft()] });
  const r = await handleGmailDraftLifecycle("u", "read that draft", d);
  assert.deepEqual(calls.fetched, ["d1"]);
  assert.ok(/Friday works for me/.test(r.reply ?? ""));
});

asyncCheck("open: several drafts and no reference -> ask, never pick", async () => {
  const { deps: d, calls } = deps({
    command: { action: "open_draft" },
    drafts: [draft(), draft({ draftId: "d2", toName: "Sue" })],
  });
  const r = await handleGmailDraftLifecycle("u", "read that draft", d);
  assert.ok(/You have 2 drafts:/.test(r.reply ?? ""));
  assert.equal(calls.fetched.length, 0, "must not open an arbitrary draft");
});

asyncCheck("open: a recipient hint resolves the right draft", async () => {
  const { deps: d, calls } = deps({
    command: { action: "open_draft", recipientHint: "Sue" },
    drafts: [draft(), draft({ draftId: "d2", toName: "Sue", to: "sue@example.com" })],
  });
  await handleGmailDraftLifecycle("u", "open the draft to Sue", d);
  assert.deepEqual(calls.fetched, ["d2"]);
});

// --- Edit ---

asyncCheck("edit: re-fetches, rewrites, and updates the SAME draft — never sends", async () => {
  const { deps: d, calls } = deps({
    command: { action: "edit_draft", editInstruction: "change Friday to Monday" },
  });
  const r = await handleGmailDraftLifecycle("u", "change Friday to Monday", d);
  assert.equal(r.action, "edit_draft");
  assert.deepEqual(calls.fetched, ["d1"], "must re-fetch before editing");
  assert.equal(calls.executed.length, 1);
  assert.equal(calls.executed[0]?.actionId, "email.updateDraft");
  assert.equal(calls.executed[0]?.input.draftId, "d1");
  assert.ok(calls.executed[0]?.input.raw, "must build replacement MIME");
  // The rule from the brief: never send when the user asked only to edit.
  assert.equal(
    calls.executed.some((e) => e.actionId === "email.sendDraft"),
    false,
    "an edit must NEVER send",
  );
  assert.equal(calls.proposed.length, 0, "an edit needs no confirmation");
});

asyncCheck("edit: a reply draft keeps its threading headers", async () => {
  // Gmail's update REPLACES the draft, so dropping these would silently detach the
  // reply from its thread and deliver it as a stray new email.
  const { deps: d, calls } = deps({
    command: { action: "edit_draft", editInstruction: "make it shorter" },
    detail: detail({
      draft: draft({ threadId: "thread_9" }),
      inReplyTo: "<orig@mail>",
      references: "<a@mail> <orig@mail>",
    }),
  });
  await handleGmailDraftLifecycle("u", "make it shorter", d);
  const input = calls.executed[0]!.input;
  assert.equal(input.threadId, "thread_9", "thread must be preserved");
  const raw = Buffer.from(String(input.raw), "base64url").toString("utf8");
  assert.ok(/In-Reply-To:\s*<orig@mail>/i.test(raw), "In-Reply-To must survive the edit");
  assert.ok(/References:.*<orig@mail>/i.test(raw), "References chain must survive the edit");
});

asyncCheck("edit: a failed rewrite never blanks the real draft", async () => {
  // An empty model reply is a FAILURE, not an instruction to erase the draft.
  const { deps: d, calls } = deps({
    command: { action: "edit_draft", editInstruction: "make it shorter" },
    rewrite: async () => "",
  });
  const r = await handleGmailDraftLifecycle("u", "make it shorter", d);
  assert.equal(r.reply, GMAIL_DRAFT_REPLIES.editFailed);
  assert.equal(calls.executed.length, 0, "must not write an empty body over the draft");
});

asyncCheck("edit: a whitespace-only rewrite is also treated as a failure", async () => {
  const { deps: d, calls } = deps({
    command: { action: "edit_draft", editInstruction: "make it shorter" },
    rewrite: async () => "   \n  ",
  });
  const r = await handleGmailDraftLifecycle("u", "make it shorter", d);
  assert.equal(r.reply, GMAIL_DRAFT_REPLIES.editFailed);
  assert.equal(calls.executed.length, 0);
});

asyncCheck("edit: a draft deleted since we last saw it fails honestly", async () => {
  const { deps: d, calls } = deps({
    command: { action: "edit_draft", editInstruction: "make it shorter" },
    getDetail: async () => {
      throw new GmailError("mailbox_not_found", "gone", 404);
    },
  });
  const r = await handleGmailDraftLifecycle("u", "make it shorter", d);
  assert.equal(r.reply, GMAIL_DRAFT_REPLIES.draftGone);
  assert.equal(calls.executed.length, 0);
});

asyncCheck("edit: an edit at a position targets that exact draft", async () => {
  const { deps: d, calls } = deps({
    command: { action: "edit_draft", ordinal: 2, editInstruction: "make it shorter" },
    selection: draftSelection(["d1", "d2"]),
  });
  await handleGmailDraftLifecycle("u", "make the second one shorter", d);
  assert.deepEqual(calls.fetched, ["d2"]);
  assert.equal(calls.executed[0]?.input.draftId, "d1", "executor targets the re-fetched draft id");
});

// --- Delete ---

asyncCheck("delete: previews and proposes, but deletes NOTHING yet", async () => {
  const { deps: d, calls } = deps({ command: { action: "delete_draft" } });
  const r = await handleGmailDraftLifecycle("u", "delete that draft", d);
  assert.equal(r.action, "delete_draft");
  assert.ok(/I’ll delete the draft to Rob/.test(r.reply ?? ""));
  assert.ok(/can’t undo/i.test(r.reply ?? ""));
  assert.equal(calls.executed.length, 0, "nothing may be deleted before confirmation");

  const p = calls.proposed[0]!;
  assert.equal(p.actionId, "email.deleteDraft");
  assert.equal(p.confirmationRequired, true);
  assert.equal((p.input as Record<string, unknown>).draftId, "d1");
});

asyncCheck("delete: re-fetches so the preview describes the live draft", async () => {
  const { deps: d, calls } = deps({ command: { action: "delete_draft" } });
  await handleGmailDraftLifecycle("u", "delete that draft", d);
  assert.deepEqual(calls.fetched, ["d1"]);
});

asyncCheck("delete: a position deletes exactly the draft at that position", async () => {
  const { deps: d, calls } = deps({
    command: { action: "delete_draft", ordinal: 2 },
    selection: draftSelection(["d1", "d2"]),
  });
  await handleGmailDraftLifecycle("u", "delete the second draft", d);
  assert.deepEqual(calls.fetched, ["d2"], "must re-fetch the picked draft");
  assert.equal(calls.proposed.length, 1);
});

asyncCheck("delete: an already-gone draft is not proposed for deletion", async () => {
  const { deps: d, calls } = deps({
    command: { action: "delete_draft" },
    getDetail: async () => {
      throw new GmailError("mailbox_not_found", "gone", 404);
    },
  });
  const r = await handleGmailDraftLifecycle("u", "delete that draft", d);
  assert.equal(r.reply, GMAIL_DRAFT_REPLIES.draftGone);
  assert.equal(calls.proposed.length, 0, "must not arm a deletion for a dead id");
});

asyncCheck("delete: several drafts and no reference -> ask, propose nothing", async () => {
  const { deps: d, calls } = deps({
    command: { action: "delete_draft" },
    drafts: [draft(), draft({ draftId: "d2", toName: "Sue" })],
  });
  const r = await handleGmailDraftLifecycle("u", "delete that draft", d);
  assert.ok(/You have 2 drafts:/.test(r.reply ?? ""));
  assert.equal(calls.proposed.length, 0, "an ambiguous deletion must never be armed");
});

asyncCheck("edit: updates in place and never creates a second draft", async () => {
  // This is what makes "send it" after an edit send the EDITED text. Gmail's
  // drafts.send sends whatever the draft currently holds server-side, and the
  // stored send-reference is keyed by draft id — so the edit MUST update that same
  // id. Creating a new draft instead would orphan the reference and send the OLD
  // body, which is exactly the "send the correct edited draft" failure.
  const { deps: d, calls } = deps({
    command: { action: "edit_draft", editInstruction: "make it shorter" },
  });
  await handleGmailDraftLifecycle("u", "make it shorter", d);
  assert.equal(calls.executed.length, 1);
  assert.equal(calls.executed[0]?.actionId, "email.updateDraft", "must UPDATE, not create");
  assert.equal(
    calls.executed.some((e) => e.actionId === "email.createDraft"),
    false,
    "a second draft would orphan the send-reference",
  );
  assert.equal(
    calls.executed[0]?.input.draftId,
    "d1",
    "the edited draft id must be the SAME id the send path will use",
  );
});

// --- The calendar-ambiguity guard ---

asyncCheck("edit: with NO drafts, an edit request falls through untouched", async () => {
  // "change Friday to Monday" is ambiguous between editing a draft and moving a
  // calendar event, and no wording can settle it. The disambiguator is whether a
  // draft exists at all: with none, this MUST fall through so the calendar handler
  // downstream behaves exactly as it did before Section 17.
  const { deps: d, calls } = deps({
    command: { action: "edit_draft", editInstruction: "change Friday to Monday" },
    drafts: [],
  });
  const r = await handleGmailDraftLifecycle("u", "change Friday to Monday", d);
  assert.equal(r.handled, false, "must not swallow a possible calendar request");
  assert.equal(calls.executed.length, 0);
});

asyncCheck("edit: with a draft present, the same words edit the draft", async () => {
  // The mirror of the test above — the brief's own conversational flow:
  // "Reply to Rob..." -> "Change Friday to Monday." must edit the pending draft.
  const { deps: d, calls } = deps({
    command: { action: "edit_draft", editInstruction: "change Friday to Monday" },
    drafts: [draft()],
  });
  const r = await handleGmailDraftLifecycle("u", "change Friday to Monday", d);
  assert.equal(r.handled, true);
  assert.equal(calls.executed[0]?.actionId, "email.updateDraft");
});

asyncCheck("delete/open: with NO drafts, the user is told plainly", async () => {
  // Unlike edit, these name a draft explicitly, so "you have none" is the honest
  // answer rather than a fall-through.
  for (const action of ["delete_draft", "open_draft"] as const) {
    const { deps: d, calls } = deps({ command: { action }, drafts: [] });
    const r = await handleGmailDraftLifecycle("u", "delete that draft", d);
    assert.equal(r.handled, true, `${action} must answer`);
    assert.equal(r.reply, GMAIL_DRAFT_REPLIES.noDrafts);
    assert.equal(calls.proposed.length, 0);
  }
});

// --- Fall-through ---

asyncCheck("fallthrough: not_draft_command falls through unchanged", async () => {
  const { deps: d } = deps({ command: { action: "not_draft_command" } });
  const r = await handleGmailDraftLifecycle("u", "make it shorter", d);
  assert.equal(r.handled, false);
});

asyncCheck("fallthrough: model unavailable falls through rather than guessing", async () => {
  const { deps: d, calls } = deps({ command: null });
  const r = await handleGmailDraftLifecycle("u", "delete that draft", d);
  assert.equal(r.handled, false);
  assert.equal(calls.proposed.length, 0);
});

asyncCheck("fallthrough: a prefilter miss never calls the model", async () => {
  let extracted = false;
  const { deps: d } = deps({
    extract: async () => {
      extracted = true;
      return { action: "list_drafts" };
    },
  });
  const r = await handleGmailDraftLifecycle("u", "hey how are you", d);
  assert.equal(r.handled, false);
  assert.equal(extracted, false);
});

asyncCheck("provider: a not-connected Gmail replies honestly", async () => {
  const { deps: d } = deps({
    command: { action: "list_drafts" },
    list: async () => {
      throw new GmailError("not_connected", "nope");
    },
  });
  const r = await handleGmailDraftLifecycle("u", "show me my drafts", d);
  assert.equal(r.reply, GMAIL_DRAFT_REPLIES.notConnected);
});

asyncCheck("provider: an insufficient scope asks the user to reconnect", async () => {
  const { deps: d } = deps({
    command: { action: "list_drafts" },
    list: async () => {
      throw new GmailError("insufficient_scope", "nope", 403);
    },
  });
  const r = await handleGmailDraftLifecycle("u", "show me my drafts", d);
  assert.equal(r.reply, GMAIL_DRAFT_REPLIES.reconnect);
});

asyncCheck("safety: no reply leaks token material", async () => {
  const { deps: d } = deps({ command: { action: "delete_draft" } });
  const r = await handleGmailDraftLifecycle("u", "delete that draft", d);
  assert.ok(!/Bearer|ya29\.|access_token|refresh_token/i.test(JSON.stringify(r)));
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} Gmail draft lifecycle (Section 17) tests passed.`);
}

void run().catch((err) => {
  console.error(
    "Gmail draft lifecycle tests failed:",
    err instanceof Error ? err.message : "unknown error",
  );
  process.exitCode = 1;
});
