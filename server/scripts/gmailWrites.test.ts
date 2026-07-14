import assert from "node:assert/strict";

import {
  MimeError,
  assertNoHeaderInjection,
  buildGmailRawPayload,
  buildMimeMessage,
  buildReplySubject,
  encodeHeaderWord,
  isValidEmailAddress,
  toBase64Url,
} from "../src/integrations/providers/gmail/mime";
import {
  GmailActionSchema,
  buildGmailExtractionPrompt,
  parseGmailAction,
} from "../src/integrations/providers/gmail/gmailActionExtract";
import {
  GMAIL_WRITE_REPLIES,
  buildReferences,
  cleanDisplaySubject,
  formatAmbiguousThreads,
  formatSendPreview,
  handleGmailClarification,
  handleGmailWrite,
  looksLikeGmailWrite,
  recipientLabel,
  resolveNewRecipient,
  resolveReplyTarget,
  senderMatchesName,
  truncateSnippet,
  wantsLatest,
  type GmailClarificationDeps,
  type GmailWriteDeps,
} from "../src/integrations/providers/gmail/gmailActions";
import {
  parseClarificationSelection,
  type PendingClarification,
  type ReplyClarificationData,
} from "../src/integrations/providers/gmail/gmailClarification";
import { HULA_SYSTEM_PROMPT, buildHulaSystemPrompt } from "../src/ai/prompts";
import { buildReplyContext } from "../src/integrations/providers/gmail/drafts";
import { executeAction } from "../src/actions/executor";
import { handleActionConfirmation, type ConfirmationDeps } from "../src/actions/confirmations";
import type { ActionPolicyContext } from "../src/actions/policy";
import type { ActionProposalView } from "../src/actions/proposals";
import type { GmailAction } from "../src/integrations/providers/gmail/gmailActionExtract";
import type {
  GmailReplyContext,
  NormalizedGmailMessage,
  RawGmailMessage,
} from "../src/integrations/providers/gmail/types";
import type { GmailRawPayload } from "../src/integrations/providers/gmail/drafts";
import type { RecordExecutionInput } from "../src/actions/executions";

/**
 * Offline tests for Section 16 Gmail DRAFT + SEND actions. Everything here is PURE
 * or uses injected fakes — NO database, NO real Gmail API, NO Anthropic. Draft
 * creation and sending are exercised via injected provider fns, so no test ever
 * touches a real mailbox or sends a real email. Run with: `npm test`.
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

/** Build a normalized inbox message for resolution tests. */
function msg(over: Partial<NormalizedGmailMessage>): NormalizedGmailMessage {
  return {
    id: over.id ?? "m1",
    threadId: over.threadId ?? "t1",
    fromName: over.fromName ?? "Rob Stone",
    fromAddress: over.fromAddress ?? "rob@example.com",
    subject: over.subject ?? "Lunch Friday?",
    receivedAt: over.receivedAt ?? "2026-07-13T10:00:00Z",
    unread: over.unread ?? false,
    important: over.important ?? false,
    labels: over.labels ?? ["INBOX"],
    snippet: over.snippet ?? "hey",
    source: "gmail",
  };
}

/** Decode a base64url `raw` payload back to its MIME string. */
function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

/** A connected + compose-scoped Gmail policy context. */
function gmailContext(userConfirmed?: boolean): ActionPolicyContext {
  return {
    connectedProviders: ["gmail"],
    grantedScopesByProvider: { gmail: [COMPOSE_SCOPE] },
    capabilitiesByProvider: { gmail: ["email.read", "email.draft", "email.send"] },
    userConfirmed,
  };
}

/** A read-only Gmail context (no compose scope / write capability). */
function readonlyGmailContext(userConfirmed?: boolean): ActionPolicyContext {
  return {
    connectedProviders: ["gmail"],
    grantedScopesByProvider: { gmail: ["https://www.googleapis.com/auth/gmail.readonly"] },
    capabilitiesByProvider: { gmail: ["email.read"] },
    userConfirmed,
  };
}

/** An extractor that always returns the given action (bypasses the model). */
function fixedExtract(action: GmailAction): GmailWriteDeps["extract"] {
  return async () => action;
}

// ==========================================================================
// MIME builder (pure)
// ==========================================================================

check("mime: email validation accepts/rejects correctly", () => {
  assert.equal(isValidEmailAddress("rob@example.com"), true);
  assert.equal(isValidEmailAddress("a.b+c@sub.domain.io"), true);
  assert.equal(isValidEmailAddress("no-at-sign"), false);
  assert.equal(isValidEmailAddress("bad@nodot"), false);
  assert.equal(isValidEmailAddress("a@b.com\nBcc: evil@x.com"), false);
  assert.equal(isValidEmailAddress(""), false);
  assert.equal(isValidEmailAddress(null), false);
});

check("mime: header injection is rejected", () => {
  assert.doesNotThrow(() => assertNoHeaderInjection("a clean value"));
  assert.throws(
    () => assertNoHeaderInjection("evil\r\nBcc: x@y.com"),
    (e: unknown) => e instanceof MimeError && e.reason === "header_injection",
  );
});

check("mime: valid plain-text MIME has the required headers", () => {
  const raw = buildMimeMessage({ to: "rob@example.com", subject: "Hi Rob", body: "Friday works." });
  assert.ok(/^To: rob@example\.com$/m.test(raw));
  assert.ok(/^Subject: Hi Rob$/m.test(raw));
  assert.ok(/^MIME-Version: 1\.0$/m.test(raw));
  assert.ok(/^Content-Type: text\/plain; charset="UTF-8"$/m.test(raw));
  assert.ok(/^Content-Transfer-Encoding: base64$/m.test(raw));
  // No CC/BCC anywhere, ever.
  assert.ok(!/^Cc:/im.test(raw));
  assert.ok(!/^Bcc:/im.test(raw));
  // Body is base64 of the plaintext.
  const bodyPart = raw.split("\r\n\r\n")[1] ?? "";
  assert.equal(Buffer.from(bodyPart.replace(/\r\n/g, ""), "base64").toString("utf8"), "Friday works.");
});

check("mime: Unicode subject + body survive intact", () => {
  const raw = buildMimeMessage({ to: "rob@example.com", subject: "Café ☕ — déjà vu", body: "Voilà: 🚀 café" });
  // Subject is RFC-2047 encoded-word.
  const subjLine = raw.split("\r\n").find((l) => l.startsWith("Subject: ")) ?? "";
  assert.ok(/^Subject: =\?UTF-8\?B\?/.test(subjLine), "non-ASCII subject is encoded");
  const decodedSubject = Buffer.from(subjLine.replace(/^Subject: =\?UTF-8\?B\?/, "").replace(/\?=$/, ""), "base64").toString("utf8");
  assert.equal(decodedSubject, "Café ☕ — déjà vu");
  const bodyPart = raw.split("\r\n\r\n")[1] ?? "";
  assert.equal(Buffer.from(bodyPart.replace(/\r\n/g, ""), "base64").toString("utf8"), "Voilà: 🚀 café");
});

check("mime: ASCII subject is left unencoded; encodeHeaderWord round-trips", () => {
  assert.equal(encodeHeaderWord("Plain Subject"), "Plain Subject");
  assert.ok(encodeHeaderWord("naïve").startsWith("=?UTF-8?B?"));
});

check("mime: base64url encoding is URL-safe and Gmail-shaped", () => {
  const b64 = toBase64Url("To: a@b.com\r\n\r\nhi ~~~ ??? >>>");
  assert.ok(!/[+/=]/.test(b64), "no +, /, or padding in base64url");
});

check("mime: an invalid recipient / empty body throws (never a partial message)", () => {
  assert.throws(
    () => buildMimeMessage({ to: "not-an-email", subject: "x", body: "y" }),
    (e: unknown) => e instanceof MimeError && e.reason === "invalid_recipient",
  );
  assert.throws(
    () => buildMimeMessage({ to: "a@b.com", subject: "x", body: "   " }),
    (e: unknown) => e instanceof MimeError && e.reason === "empty_body",
  );
});

check("mime: a subject carrying a newline is rejected (injection guard)", () => {
  assert.throws(
    () => buildMimeMessage({ to: "a@b.com", subject: "Hi\r\nBcc: evil@x.com", body: "y" }),
    (e: unknown) => e instanceof MimeError && e.reason === "header_injection",
  );
});

check("mime: reply headers are emitted; References chain is built", () => {
  const raw = buildMimeMessage({
    to: "rob@example.com",
    subject: "Re: Lunch Friday?",
    body: "Yes!",
    inReplyTo: "<abc@mail.example.com>",
    references: "<root@mail.example.com> <abc@mail.example.com>",
  });
  assert.ok(/^In-Reply-To: <abc@mail\.example\.com>$/m.test(raw));
  assert.ok(/^References: <root@mail\.example\.com> <abc@mail\.example\.com>$/m.test(raw));
});

check("mime: Re: subject is de-duplicated, never stacked", () => {
  assert.equal(buildReplySubject("Lunch Friday?"), "Re: Lunch Friday?");
  assert.equal(buildReplySubject("Re: Lunch Friday?"), "Re: Lunch Friday?");
  assert.equal(buildReplySubject("RE:  Lunch"), "RE:  Lunch");
  assert.equal(buildReplySubject(""), "Re:");
  assert.equal(buildReplySubject(null), "Re:");
});

check("mime: References helper combines existing chain + message id", () => {
  assert.equal(buildReferences("<a>", "<b>"), "<a> <b>");
  assert.equal(buildReferences(null, "<b>"), "<b>");
  assert.equal(buildReferences("<a>", null), "<a>");
  assert.equal(buildReferences(null, null), undefined);
});

check("mime: buildGmailRawPayload includes threadId only for replies", () => {
  const noThread = buildGmailRawPayload({ to: "a@b.com", subject: "s", body: "b" });
  assert.equal(noThread.threadId, undefined);
  const withThread = buildGmailRawPayload({ to: "a@b.com", subject: "s", body: "b" }, "thr_1");
  assert.equal(withThread.threadId, "thr_1");
});

// ==========================================================================
// Extraction schema / parsing
// ==========================================================================

check("extract: valid model JSON parses to a typed action", () => {
  const a = parseGmailAction(
    '{"action":"send_new_email","recipientName":"Rob","recipientEmail":null,"subject":"Lunch","body":"Friday works."}',
  );
  assert.equal(a?.action, "send_new_email");
  assert.equal(a?.recipientName, "Rob");
  assert.equal(a?.body, "Friday works.");
});

check("extract: tolerates fences/prose and rejects off-schema output", () => {
  assert.equal(parseGmailAction('```json\n{"action":"not_gmail_write"}\n```')?.action, "not_gmail_write");
  assert.equal(parseGmailAction("not json"), null);
  assert.equal(parseGmailAction('{"action":"frobnicate"}'), null);
  assert.equal(parseGmailAction(""), null);
});

check("extract: prompt pins JSON shape + the not_gmail_write escape hatch", () => {
  const p = buildGmailExtractionPrompt();
  assert.ok(/not_gmail_write/.test(p));
  assert.ok(/NEVER invent an email address/i.test(p));
  assert.ok(/send me the latest email/i.test(p), "prompt teaches read requests are not writes");
});

check("extract: schema accepts the escape hatch", () => {
  assert.equal(GmailActionSchema.safeParse({ action: "not_gmail_write" }).success, true);
});

// ==========================================================================
// Prefilter (intent / routing)
// ==========================================================================

check("prefilter: write phrasings match", () => {
  assert.equal(looksLikeGmailWrite("Send Rob an email saying Friday works"), true);
  assert.equal(looksLikeGmailWrite("email my accountant the figures"), true);
  assert.equal(looksLikeGmailWrite("Draft a response to Rob's latest email"), true);
  assert.equal(looksLikeGmailWrite("reply to Rob's latest email saying yes"), true);
});

check("prefilter: READ requests are NOT intercepted", () => {
  assert.equal(looksLikeGmailWrite("Send me the latest email from Rob"), false);
  assert.equal(looksLikeGmailWrite("What emails do I have from Rob?"), false);
  assert.equal(looksLikeGmailWrite("do I have any unread emails"), false);
  assert.equal(looksLikeGmailWrite("show me my latest emails"), false);
});

check("prefilter: calendar/memory/chatter are NOT intercepted", () => {
  assert.equal(looksLikeGmailWrite("schedule lunch with Adam tomorrow at 1pm"), false);
  assert.equal(looksLikeGmailWrite("remember my anniversary is June 3"), false);
  assert.equal(looksLikeGmailWrite("how are you today"), false);
  assert.equal(looksLikeGmailWrite(""), false);
});

// ==========================================================================
// Recipient resolution (pure)
// ==========================================================================

check("recipient: a literal address resolves immediately", () => {
  const r = resolveNewRecipient(
    { action: "send_new_email", recipientEmail: "rob@work.com", body: "hi", subject: "s" } as GmailAction,
    [],
  );
  assert.equal(r.kind, "one");
  if (r.kind === "one") assert.equal(r.recipient.address, "rob@work.com");
});

check("recipient: an unambiguous sender name resolves to their address", () => {
  const r = resolveNewRecipient(
    { action: "send_new_email", recipientName: "Rob" } as GmailAction,
    [msg({ fromName: "Rob Stone", fromAddress: "rob@example.com" })],
  );
  assert.equal(r.kind, "one");
  if (r.kind === "one") assert.equal(r.recipient.address, "rob@example.com");
});

check("recipient: an unknown name asks (never invents an address)", () => {
  const r = resolveNewRecipient(
    { action: "send_new_email", recipientName: "Zebediah" } as GmailAction,
    [msg({ fromName: "Rob Stone", fromAddress: "rob@example.com" })],
  );
  assert.equal(r.kind, "none");
});

check("recipient: several distinct matches are ambiguous", () => {
  const r = resolveNewRecipient(
    { action: "send_new_email", recipientName: "Rob" } as GmailAction,
    [
      msg({ id: "1", fromName: "Rob Stone", fromAddress: "rob@example.com" }),
      msg({ id: "2", fromName: "Rob Miller", fromAddress: "rob.miller@corp.com" }),
    ],
  );
  assert.equal(r.kind, "many");
  if (r.kind === "many") assert.equal(r.candidates.length, 2);
});

check("recipient: senderMatchesName matches name tokens or address local-part", () => {
  assert.equal(senderMatchesName(msg({ fromName: "Rob Stone", fromAddress: "x@y.com" }), "Rob"), true);
  assert.equal(senderMatchesName(msg({ fromName: null, fromAddress: "sarah.lee@x.com" }), "Sarah"), true);
  assert.equal(senderMatchesName(msg({ fromName: "Rob Stone" }), "Dentist"), false);
});

check("recipient: no name and no email -> ask", () => {
  const r = resolveNewRecipient({ action: "send_new_email", body: "hi" } as GmailAction, [msg({})]);
  assert.equal(r.kind, "none");
});

// ==========================================================================
// Thread / reply resolution (pure)
// ==========================================================================

check("thread: one matching thread resolves to its newest message", () => {
  const r = resolveReplyTarget(
    { action: "send_reply", recipientName: "Rob" } as GmailAction,
    [
      msg({ id: "new", threadId: "t1", fromName: "Rob Stone", receivedAt: "2026-07-13T12:00:00Z" }),
      msg({ id: "old", threadId: "t1", fromName: "Rob Stone", receivedAt: "2026-07-10T12:00:00Z" }),
    ],
  );
  assert.equal(r.kind, "one");
  if (r.kind === "one") assert.equal(r.message.id, "new");
});

check("thread: no matching thread -> none", () => {
  const r = resolveReplyTarget(
    { action: "send_reply", recipientName: "Nobody" } as GmailAction,
    [msg({ fromName: "Rob Stone" })],
  );
  assert.equal(r.kind, "none");
});

check("thread: multiple distinct threads -> ambiguous", () => {
  const r = resolveReplyTarget(
    { action: "send_reply", recipientName: "Rob" } as GmailAction,
    [
      msg({ id: "a", threadId: "t1", fromName: "Rob Stone" }),
      msg({ id: "b", threadId: "t2", fromName: "Rob Stone" }),
    ],
  );
  assert.equal(r.kind, "many");
});

check("thread: reply context uses Reply-To over From, keeps References/Re:", () => {
  const raw: RawGmailMessage = {
    threadId: "t1",
    payload: {
      headers: [
        { name: "From", value: '"Rob Stone" <rob@example.com>' },
        { name: "Reply-To", value: "rob.replies@example.com" },
        { name: "Message-ID", value: "<abc@mail.example.com>" },
        { name: "References", value: "<root@mail.example.com>" },
        { name: "Subject", value: "Lunch Friday?" },
      ],
    },
  };
  const ctx = buildReplyContext(raw);
  assert.equal(ctx.replyToAddress, "rob.replies@example.com");
  assert.equal(ctx.messageIdHeader, "<abc@mail.example.com>");
  assert.equal(ctx.references, "<root@mail.example.com>");
  assert.equal(ctx.subject, "Lunch Friday?");
  assert.equal(ctx.threadId, "t1");
});

check("thread: reply context falls back to From when no Reply-To", () => {
  const ctx = buildReplyContext({
    threadId: "t2",
    payload: { headers: [{ name: "From", value: "sam@corp.com" }, { name: "Message-ID", value: "<m@x>" }] },
  });
  assert.equal(ctx.replyToAddress, "sam@corp.com");
});

// ==========================================================================
// Preview / formatting (pure)
// ==========================================================================

check("preview: send preview shows To, Subject, and the FULL body", () => {
  const body = "Line one.\nLine two, in full.";
  const preview = formatSendPreview({ to: "rob@example.com", toName: "Rob", subject: "Lunch", body, isReply: false });
  assert.ok(/^Ready to send:/m.test(preview));
  assert.ok(/^To: Rob <rob@example\.com>$/m.test(preview));
  assert.ok(/^Subject: Lunch$/m.test(preview));
  assert.ok(preview.includes(body), "full body shown, not summarized");
  assert.ok(/Reply ‘send it’ to continue or ‘cancel’ to stop\./.test(preview));
});

check("preview: reply preview identifies the thread", () => {
  const preview = formatSendPreview({
    to: "rob@example.com",
    toName: null,
    subject: "Re: Lunch Friday?",
    body: "Yes!",
    isReply: true,
    threadSubject: "Lunch Friday?",
  });
  assert.ok(/reply in “Lunch Friday\?”/.test(preview));
  assert.ok(/^To: rob@example\.com$/m.test(preview));
});

check("format: recipientLabel prefers name then address", () => {
  assert.equal(recipientLabel({ address: "a@b.com", name: "Al" }), "Al <a@b.com>");
  assert.equal(recipientLabel({ address: "a@b.com", name: null }), "a@b.com");
});

// ==========================================================================
// handleGmailWrite orchestration (injected fakes)
// ==========================================================================

/** Deps that capture executor + proposal calls, connected + write-capable. */
function makeDeps(over: Partial<GmailWriteDeps> = {}): {
  deps: GmailWriteDeps;
  calls: {
    executed: { actionId: string; input: Record<string, unknown> }[];
    proposed: { input: unknown; preview: string }[];
    clarified: { data: unknown; preview: string }[];
  };
} {
  const calls = {
    executed: [] as { actionId: string; input: Record<string, unknown> }[],
    proposed: [] as { input: unknown; preview: string }[],
    clarified: [] as { data: unknown; preview: string }[],
  };
  const deps: GmailWriteDeps = {
    writeCapability: async () => "connected_write",
    getTimezone: async () => "Europe/London",
    execute: async (_u, actionId, input) => {
      calls.executed.push({ actionId, input });
      return { ok: true, userMessage: "Draft created in Gmail.\nTo: Rob <rob@example.com>\nSubject: Lunch" };
    },
    createProposal: async (_u, input) => {
      calls.proposed.push({ input: input.input, preview: input.previewText });
      return { id: "prop_1" };
    },
    createClarification: async (_u, data, preview) => {
      calls.clarified.push({ data, preview });
      return { id: "clar_1" };
    },
    ...over,
  };
  return { deps, calls };
}

asyncCheck("write: create_new_draft executes immediately (no proposal)", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create_new_draft", recipientEmail: "rob@example.com", subject: "Lunch", body: "Friday works." } as GmailAction),
  });
  const r = await handleGmailWrite("u", "draft an email to rob@example.com about lunch", deps);
  assert.equal(r.handled, true);
  assert.equal(calls.executed.length, 1);
  assert.equal(calls.executed[0]!.actionId, "email.createDraft");
  assert.equal(calls.proposed.length, 0, "a draft never creates a send proposal");
  assert.ok(/Draft created in Gmail/.test(r.reply ?? ""));
});

asyncCheck("write: send_new_email creates a proposal and does NOT send", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "send_new_email", recipientEmail: "rob@example.com", subject: "Lunch", body: "Friday works." } as GmailAction),
  });
  const r = await handleGmailWrite("u", "send rob@example.com an email about lunch", deps);
  assert.equal(r.handled, true);
  assert.equal(calls.executed.length, 0, "no send before approval");
  assert.equal(calls.proposed.length, 1);
  const proposed = calls.proposed[0]!;
  assert.ok(/Ready to send:/.test(proposed.preview));
  assert.ok(/Friday works\./.test(proposed.preview));
  assert.equal(r.reply, proposed.preview, "the preview shown IS the persisted preview");
  // The persisted input carries the resolved recipient + body for a later send.
  const input = proposed.input as Record<string, unknown>;
  assert.equal(input.to, "rob@example.com");
  assert.equal(input.body, "Friday works.");
  assert.equal(input.isReply, false);
});

asyncCheck("write: send_reply resolves the thread + creates a reply proposal", async () => {
  const replyCtx: GmailReplyContext = {
    threadId: "t1",
    messageIdHeader: "<abc@mail>",
    references: "<root@mail>",
    replyToAddress: "rob@example.com",
    replyToName: "Rob Stone",
    subject: "Lunch Friday?",
  };
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "send_reply", recipientName: "Rob", body: "Yes, Friday works." } as GmailAction),
    fetchMessages: async () => [msg({ id: "m9", threadId: "t1", fromName: "Rob Stone" })],
    fetchReplyContext: async () => replyCtx,
  });
  const r = await handleGmailWrite("u", "reply to Rob's latest email saying yes", deps);
  assert.equal(calls.proposed.length, 1);
  const input = calls.proposed[0]!.input as Record<string, unknown>;
  assert.equal(input.to, "rob@example.com");
  assert.equal(input.isReply, true);
  assert.equal(input.threadId, "t1");
  assert.equal(input.inReplyTo, "<abc@mail>");
  assert.equal(input.references, "<root@mail> <abc@mail>");
  assert.equal(input.subject, "Re: Lunch Friday?");
  assert.ok(/reply in “Lunch Friday\?”/.test(r.reply ?? ""));
});

asyncCheck("write: create_reply_draft executes immediately as a reply draft", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create_reply_draft", recipientName: "Rob", body: "Sounds good." } as GmailAction),
    fetchMessages: async () => [msg({ id: "m9", threadId: "t1", fromName: "Rob Stone" })],
    fetchReplyContext: async () => ({
      threadId: "t1",
      messageIdHeader: "<abc@mail>",
      references: null,
      replyToAddress: "rob@example.com",
      replyToName: "Rob Stone",
      subject: "Lunch Friday?",
    }),
  });
  await handleGmailWrite("u", "draft a reply to Rob's email", deps);
  assert.equal(calls.executed.length, 1);
  assert.equal(calls.executed[0]!.actionId, "email.createDraft");
  assert.equal(calls.executed[0]!.input.isReply, true);
});

asyncCheck("write: missing body asks (no execute, no proposal)", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "send_new_email", recipientEmail: "rob@example.com", subject: "Lunch" } as GmailAction),
  });
  const r = await handleGmailWrite("u", "send rob@example.com an email", deps);
  assert.equal(r.reply, GMAIL_WRITE_REPLIES.needBody);
  assert.equal(calls.executed.length, 0);
  assert.equal(calls.proposed.length, 0);
});

asyncCheck("write: missing subject on a new email asks", async () => {
  const { deps } = makeDeps({
    extract: fixedExtract({ action: "send_new_email", recipientEmail: "rob@example.com", body: "hi" } as GmailAction),
  });
  const r = await handleGmailWrite("u", "send rob@example.com an email", deps);
  assert.equal(r.reply, GMAIL_WRITE_REPLIES.needSubject);
});

asyncCheck("write: unresolved recipient name asks for the address", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "send_new_email", recipientName: "Zed", subject: "Hi", body: "yo" } as GmailAction),
    fetchMessages: async () => [msg({ fromName: "Rob Stone" })],
  });
  const r = await handleGmailWrite("u", "send Zed an email", deps);
  assert.equal(r.reply, GMAIL_WRITE_REPLIES.needRecipient);
  assert.equal(calls.proposed.length, 0);
});

asyncCheck("write: ambiguous recipient asks to clarify", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "send_new_email", recipientName: "Rob", subject: "Hi", body: "yo" } as GmailAction),
    fetchMessages: async () => [
      msg({ id: "1", fromName: "Rob Stone", fromAddress: "rob@example.com" }),
      msg({ id: "2", fromName: "Rob Miller", fromAddress: "rob.miller@corp.com" }),
    ],
  });
  const r = await handleGmailWrite("u", "send Rob an email", deps);
  assert.ok(/Who did you mean/.test(r.reply ?? ""));
  assert.equal(calls.proposed.length, 0, "ambiguity never proposes a send");
});

asyncCheck("write: reply with no matching thread -> not found", async () => {
  const { deps } = makeDeps({
    extract: fixedExtract({ action: "send_reply", recipientName: "Ghost", body: "hi" } as GmailAction),
    fetchMessages: async () => [msg({ fromName: "Rob Stone" })],
  });
  const r = await handleGmailWrite("u", "reply to Ghost's email", deps);
  assert.equal(r.reply, GMAIL_WRITE_REPLIES.threadNotFound);
});

asyncCheck("gate: not connected -> honest connect message", async () => {
  const { deps, calls } = makeDeps({
    writeCapability: async () => "not_connected",
    extract: fixedExtract({ action: "send_new_email", recipientEmail: "r@x.com", subject: "s", body: "b" } as GmailAction),
  });
  const r = await handleGmailWrite("u", "send r@x.com an email", deps);
  assert.equal(r.reply, GMAIL_WRITE_REPLIES.notConnected);
  assert.equal(calls.proposed.length, 0);
});

asyncCheck("gate: read-only connection -> reconnect message", async () => {
  const { deps } = makeDeps({
    writeCapability: async () => "connected_readonly",
    extract: fixedExtract({ action: "send_new_email", recipientEmail: "r@x.com", subject: "s", body: "b" } as GmailAction),
  });
  const r = await handleGmailWrite("u", "send r@x.com an email", deps);
  assert.equal(r.reply, GMAIL_WRITE_REPLIES.reconnect);
});

asyncCheck("fallthrough: not_gmail_write returns handled:false (read not intercepted)", async () => {
  const { deps } = makeDeps({ extract: fixedExtract({ action: "not_gmail_write" } as GmailAction) });
  const r = await handleGmailWrite("u", "send me the latest email from Rob", deps);
  assert.equal(r.handled, false);
});

asyncCheck("fallthrough: prefilter miss never spends a model call", async () => {
  let extracted = false;
  const { deps } = makeDeps({
    extract: async () => {
      extracted = true;
      return { action: "not_gmail_write" } as GmailAction;
    },
  });
  const r = await handleGmailWrite("u", "what's on my calendar today", deps);
  assert.equal(r.handled, false);
  assert.equal(extracted, false);
});

asyncCheck("fallthrough: model unavailable (null) returns handled:false", async () => {
  const { deps } = makeDeps({ extract: async () => null });
  const r = await handleGmailWrite("u", "send Rob an email saying hi", deps);
  assert.equal(r.handled, false);
});

// ==========================================================================
// Executor Gmail adapters (draft create + send) — injected provider fns
// ==========================================================================

/** Capture provider calls + ledger entries for an executor run. */
function execDeps(over: {
  ctx?: () => ActionPolicyContext;
  send?: (u: string, p: GmailRawPayload) => Promise<{ messageId: string; threadId: string }>;
  draft?: (u: string, p: GmailRawPayload) => Promise<{ draftId: string; messageId: string; threadId: string }>;
} = {}) {
  const recorded: RecordExecutionInput[] = [];
  const sent: GmailRawPayload[] = [];
  const drafted: GmailRawPayload[] = [];
  return {
    recorded,
    sent,
    drafted,
    deps: {
      buildContext: async (_u: string, opts: { userConfirmed?: boolean }) =>
        over.ctx ? over.ctx() : gmailContext(opts?.userConfirmed),
      record: async (_u: string, i: RecordExecutionInput) => {
        recorded.push(i);
        return "exec_x";
      },
      sendGmailMessage: over.send ?? (async (_u: string, p: GmailRawPayload) => {
        sent.push(p);
        return { messageId: "sent_1", threadId: "t1" };
      }),
      createGmailDraft: over.draft ?? (async (_u: string, p: GmailRawPayload) => {
        drafted.push(p);
        return { draftId: "d_1", messageId: "m_1", threadId: "t1" };
      }),
    },
  };
}

const NEW_SEND_INPUT = {
  to: "rob@example.com",
  toName: "Rob",
  subject: "Lunch",
  body: "Friday works.",
  isReply: false,
};

asyncCheck("executor: a confirmed send builds MIME and sends exactly once", async () => {
  const d = execDeps();
  const r = await executeAction("u", "email.sendDraft", { input: NEW_SEND_INPUT, userConfirmed: true }, d.deps);
  assert.equal(r.ok, true);
  assert.equal(r.userMessage, "Email sent to Rob.");
  assert.equal(d.sent.length, 1, "exactly one send");
  // The wire payload matches the approved fields.
  const mime = decodeRaw(d.sent[0]!.raw);
  assert.ok(/^To: rob@example\.com$/m.test(mime));
  assert.ok(/^Subject: Lunch$/m.test(mime));
  const body = mime.split("\r\n\r\n")[1] ?? "";
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "Friday works.");
  // No token/secret leaks in the result or ledger.
  assert.ok(!/Bearer|ya29\.|access_token|refresh/i.test(JSON.stringify({ r, recorded: d.recorded })));
});

asyncCheck("executor: send WITHOUT confirmation is blocked (never sends)", async () => {
  const d = execDeps();
  const r = await executeAction("u", "email.sendDraft", { input: NEW_SEND_INPUT }, d.deps);
  assert.equal(r.ok, false);
  assert.equal(d.sent.length, 0, "no send without explicit confirmation");
});

asyncCheck("executor: read-only Gmail cannot send (needs reconnect)", async () => {
  const d = execDeps({ ctx: () => readonlyGmailContext(true) });
  const r = await executeAction("u", "email.sendDraft", { input: NEW_SEND_INPUT, userConfirmed: true }, d.deps);
  assert.equal(r.ok, false);
  assert.equal(d.sent.length, 0);
});

asyncCheck("executor: a provider failure never reports success", async () => {
  const d = execDeps({
    send: async () => {
      const { GmailError } = await import("../src/integrations/providers/gmail/client");
      throw new GmailError("provider_unavailable", "boom", 503);
    },
  });
  const r = await executeAction("u", "email.sendDraft", { input: NEW_SEND_INPUT, userConfirmed: true }, d.deps);
  assert.equal(r.ok, false);
  assert.ok(!/sent/i.test(r.userMessage), "must not claim it sent");
  assert.equal(d.recorded.at(-1)?.status, "failed");
});

asyncCheck("executor: a draft creation runs immediately (no confirmation)", async () => {
  const d = execDeps();
  const r = await executeAction("u", "email.createDraft", { input: NEW_SEND_INPUT }, d.deps);
  assert.equal(r.ok, true);
  assert.ok(/Draft created in Gmail/.test(r.userMessage));
  assert.equal(d.drafted.length, 1);
  assert.equal(d.sent.length, 0, "creating a draft never sends");
});

asyncCheck("executor: a reply send carries threadId + In-Reply-To", async () => {
  const d = execDeps();
  const replyInput = {
    to: "rob@example.com",
    toName: "Rob",
    subject: "Re: Lunch Friday?",
    body: "Yes!",
    isReply: true,
    threadId: "t1",
    inReplyTo: "<abc@mail>",
    references: "<root@mail> <abc@mail>",
  };
  const r = await executeAction("u", "email.sendDraft", { input: replyInput, userConfirmed: true }, d.deps);
  assert.equal(r.userMessage, "Reply sent to Rob.");
  assert.equal(d.sent[0]!.threadId, "t1");
  const mime = decodeRaw(d.sent[0]!.raw);
  assert.ok(/^In-Reply-To: <abc@mail>$/m.test(mime));
  assert.ok(/^References: <root@mail> <abc@mail>$/m.test(mime));
});

asyncCheck("executor: missing required fields never sends (honest failure)", async () => {
  const d = execDeps();
  const r = await executeAction("u", "email.sendDraft", { input: { to: "", body: "", isReply: false }, userConfirmed: true }, d.deps);
  assert.equal(r.ok, false);
  assert.equal(d.sent.length, 0);
});

// ==========================================================================
// Send confirmation lifecycle (proposal transition + idempotency)
// ==========================================================================

/** A full proposal view for the fake store. */
function proposalView(over: Partial<ActionProposalView> = {}): ActionProposalView {
  return {
    id: over.id ?? "prop_1",
    provider: over.provider ?? "gmail",
    actionId: over.actionId ?? "email.sendDraft",
    status: over.status ?? "proposed",
    riskLevel: over.riskLevel ?? "send",
    confirmationRequired: true,
    previewText: over.previewText ?? "Ready to send: ...",
    input: over.input ?? NEW_SEND_INPUT,
    expiresAt: over.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    confirmedAt: null,
    rejectedAt: null,
    executedAt: null,
    createdAt: new Date().toISOString(),
  };
}

asyncCheck("confirm: YES sends exactly once and reports success", async () => {
  let proposal: ActionProposalView | null = proposalView();
  let sends = 0;
  const deps: ConfirmationDeps = {
    getActiveProposal: async () => (proposal && proposal.status === "proposed" ? proposal : null),
    confirmProposal: async (_u, id) => {
      if (proposal && proposal.id === id && proposal.status === "proposed") {
        proposal = { ...proposal, status: "confirmed" };
        return proposal;
      }
      return null;
    },
    finalizeProposal: async (_u, _id, outcome) => {
      if (proposal && proposal.status === "confirmed") proposal = { ...proposal, status: outcome };
    },
    executeAction: async () => {
      sends += 1;
      return { ok: true, status: "succeeded", actionId: "email.sendDraft", userMessage: "Email sent to Rob." };
    },
  };
  const first = await handleActionConfirmation("u", "yes", deps);
  assert.equal(first.outcome, "confirmed");
  assert.ok(/sent/i.test(first.reply ?? ""));
  assert.equal(sends, 1);
  // A duplicate "yes" (or duplicate webhook) finds no active proposal -> no send.
  const second = await handleActionConfirmation("u", "yes", deps);
  assert.equal(second.handled, false);
  assert.equal(sends, 1, "sends exactly once");
});

asyncCheck("confirm: NO cancels and never sends", async () => {
  let proposal: ActionProposalView | null = proposalView();
  let sends = 0;
  const deps: ConfirmationDeps = {
    getActiveProposal: async () => (proposal && proposal.status === "proposed" ? proposal : null),
    rejectProposal: async (_u, id) => {
      if (proposal && proposal.id === id && proposal.status === "proposed") {
        proposal = { ...proposal, status: "rejected" };
        return proposal;
      }
      return null;
    },
    executeAction: async () => {
      sends += 1;
      return { ok: true, status: "succeeded", actionId: "email.sendDraft", userMessage: "sent" };
    },
  };
  const r = await handleActionConfirmation("u", "no", deps);
  assert.equal(r.outcome, "cancelled");
  assert.equal(sends, 0);
});

asyncCheck("confirm: an expired proposal never sends", async () => {
  const expired = proposalView({ expiresAt: new Date(Date.now() - 1000).toISOString() });
  let sends = 0;
  const deps: ConfirmationDeps = {
    // Mirrors getActiveProposal: an expired row is not returned as active.
    getActiveProposal: async () => (Date.parse(expired.expiresAt) > Date.now() ? expired : null),
    executeAction: async () => {
      sends += 1;
      return { ok: true, status: "succeeded", actionId: "email.sendDraft", userMessage: "sent" };
    },
  };
  const r = await handleActionConfirmation("u", "yes", deps);
  assert.equal(r.handled, false);
  assert.equal(sends, 0);
});

asyncCheck("confirm: a non-confirmation message falls through", async () => {
  const r = await handleActionConfirmation("u", "what's the weather", {});
  assert.equal(r.handled, false);
});

// ==========================================================================
// Privacy sweep
// ==========================================================================

asyncCheck("safety: no reply from any write flow leaks token/MIME material", async () => {
  const { deps } = makeDeps({
    extract: fixedExtract({ action: "send_new_email", recipientEmail: "rob@example.com", subject: "s", body: "b" } as GmailAction),
  });
  const r = await handleGmailWrite("u", "send rob@example.com an email", deps);
  assert.ok(!/Bearer|ya29\.|access_token|refresh_token/i.test(JSON.stringify(r)));
});

// ==========================================================================
// FIX 1 — explicit "latest" resolution (deterministic, never the model)
// ==========================================================================

check("latest: wantsLatest is true only for explicit recency phrasing", () => {
  assert.equal(wantsLatest("draft a reply to Rob's latest email"), true);
  assert.equal(wantsLatest("reply to Rob's most recent email"), true);
  assert.equal(wantsLatest("reply to the newest email from Rob"), true);
  // Unqualified reply must NOT auto-select.
  assert.equal(wantsLatest("reply to Rob saying yes"), false);
  // Bare "last" (and last-week/month) must NOT count as latest.
  assert.equal(wantsLatest("reply to Rob's email from last week"), false);
  assert.equal(wantsLatest("reply to last month's email from Rob"), false);
  assert.equal(wantsLatest(undefined), false);
});

check("latest: two Rob threads + preferLatest selects the NEWEST thread", () => {
  const r = resolveReplyTarget(
    { action: "send_reply", recipientName: "Rob" } as GmailAction,
    [
      msg({ id: "new", threadId: "t2", fromName: "Rob Stone", receivedAt: "2026-07-13T12:00:00Z" }),
      msg({ id: "old", threadId: "t1", fromName: "Rob Stone", receivedAt: "2026-07-10T09:00:00Z" }),
    ],
    { preferLatest: true },
  );
  assert.equal(r.kind, "one");
  if (r.kind === "one") assert.equal(r.message.id, "new");
});

check("latest: two Rob threads WITHOUT preferLatest stays ambiguous", () => {
  const r = resolveReplyTarget(
    { action: "send_reply", recipientName: "Rob" } as GmailAction,
    [
      msg({ id: "a", threadId: "t1", fromName: "Rob Stone" }),
      msg({ id: "b", threadId: "t2", fromName: "Rob Stone" }),
    ],
    { preferLatest: false },
  );
  assert.equal(r.kind, "many");
});

check("latest: a single match + preferLatest takes the normal one-match path", () => {
  const r = resolveReplyTarget(
    { action: "send_reply", recipientName: "Rob" } as GmailAction,
    [msg({ id: "only", threadId: "t1", fromName: "Rob Stone" })],
    { preferLatest: true },
  );
  assert.equal(r.kind, "one");
  if (r.kind === "one") assert.equal(r.message.id, "only");
});

check("latest: zero matches + preferLatest is still not found", () => {
  const r = resolveReplyTarget(
    { action: "send_reply", recipientName: "Nobody" } as GmailAction,
    [msg({ fromName: "Rob Stone" })],
    { preferLatest: true },
  );
  assert.equal(r.kind, "none");
});

asyncCheck("latest: 'reply to Rob's latest email' auto-picks newest (no clarification)", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create_reply_draft", recipientName: "Rob", body: "Yes." } as GmailAction),
    fetchMessages: async () => [
      msg({ id: "new", threadId: "t2", fromName: "Rob Stone", receivedAt: "2026-07-13T12:00:00Z" }),
      msg({ id: "old", threadId: "t1", fromName: "Rob Stone", receivedAt: "2026-07-10T09:00:00Z" }),
    ],
    fetchReplyContext: async (_u, messageId) => ({
      threadId: messageId === "new" ? "t2" : "t1",
      messageIdHeader: "<abc@mail>",
      references: null,
      replyToAddress: "rob@example.com",
      replyToName: "Rob Stone",
      subject: "Lunch Friday?",
    }),
  });
  const r = await handleGmailWrite("u", "draft a reply to Rob's latest email saying yes", deps);
  assert.equal(r.handled, true);
  assert.equal(calls.clarified.length, 0, "explicit latest never asks to clarify");
  assert.equal(calls.executed.length, 1, "it drafts against the newest thread");
  assert.equal(calls.executed[0]!.input.threadId, "t2");
});

asyncCheck("latest: 'reply to Rob' WITHOUT latest persists a clarification", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create_reply_draft", recipientName: "Rob", body: "Yes." } as GmailAction),
    fetchMessages: async () => [
      msg({ id: "a", threadId: "t1", fromName: "Rob Stone", subject: "ICTS Job Offer" }),
      msg({ id: "b", threadId: "t2", fromName: "Rob Stone", subject: "RE: ICTS Job Offer" }),
    ],
  });
  const r = await handleGmailWrite("u", "reply to Rob saying yes", deps);
  assert.equal(calls.clarified.length, 1, "ambiguity persists a pending clarification");
  assert.equal(calls.executed.length, 0, "nothing is drafted until they choose");
  assert.ok(/Which one should I reply to/.test(r.reply ?? ""));
});

// ==========================================================================
// FIX 2 — ambiguous email display (distinguishable, no full body)
// ==========================================================================

check("display: cleanDisplaySubject collapses a repeated Re: prefix only", () => {
  assert.equal(cleanDisplaySubject("Re: Re: Lunch Friday?"), "Re: Lunch Friday?");
  assert.equal(cleanDisplaySubject("ICTS Job Offer"), "ICTS Job Offer");
  assert.equal(cleanDisplaySubject(""), "(no subject)");
  // A DIFFERENT prefix is never rewritten.
  assert.equal(cleanDisplaySubject("Fwd: Re: Notes"), "Fwd: Re: Notes");
});

check("display: truncateSnippet shortens long snippets and never returns a body", () => {
  assert.equal(truncateSnippet("short one"), "short one");
  const long = "A relief officer is a zero-hour, non-guaranteed role that we occasionally staff for events and cover.";
  const t = truncateSnippet(long);
  assert.ok(t.length <= 81, "truncated to the snippet cap");
  assert.ok(t.endsWith("…"));
  assert.equal(truncateSnippet(null), "");
});

check("display: formatAmbiguousThreads includes number, subject, received, snippet", () => {
  const now = new Date("2026-07-13T13:00:00Z");
  const out = formatAmbiguousThreads(
    [
      msg({ id: "1", threadId: "t1", fromName: "Robert Ellis", subject: "ICTS Job Offer", receivedAt: "2026-07-13T12:01:00Z", snippet: "A relief officer is a zero-hour, non-guaranteed role we sometimes need to cover shifts" }),
      msg({ id: "2", threadId: "t2", fromName: "Robert Ellis", subject: "RE: EXTERNAL: Re: ICTS Job Offer", receivedAt: "2026-07-13T10:54:00Z", snippet: "Please be aware, we have conducted your initial screening" }),
    ],
    "Europe/London",
    now,
  );
  // Numbered options.
  assert.ok(/1\. /.test(out) && /2\. /.test(out));
  // Sender named (uniform sender goes in the header).
  assert.ok(/Robert Ellis/.test(out));
  // Subjects present.
  assert.ok(/ICTS Job Offer/.test(out));
  // Received timestamp present.
  assert.ok(/Received/.test(out));
  // Truncated snippet present (quoted) and cut off.
  assert.ok(/“A relief officer is a zero-hour/.test(out));
  assert.ok(out.includes("…"), "long snippet is truncated");
  // Never the full body (there is no body field to leak; assert no raw email markers).
  assert.ok(!/Content-Type|MIME-Version|<html/i.test(out));
  // Ends with a selection instruction.
  assert.ok(/Reply with 1 or 2\./.test(out));
});

// ==========================================================================
// FIX 3 — numbered selection & correction (handleGmailClarification)
// ==========================================================================

check("select: parseClarificationSelection reads numbers, options, ordinals, corrections", () => {
  assert.deepEqual(parseClarificationSelection("1"), { index: 1 });
  assert.deepEqual(parseClarificationSelection("2."), { index: 2 });
  assert.deepEqual(parseClarificationSelection("option 2"), { index: 2 });
  assert.deepEqual(parseClarificationSelection("the second one"), { index: 2 });
  assert.deepEqual(parseClarificationSelection("actually 2"), { index: 2 });
  assert.deepEqual(parseClarificationSelection("sorry, I meant 2"), { index: 2 });
  // Not a selection.
  assert.equal(parseClarificationSelection("what's the weather"), null);
  assert.equal(parseClarificationSelection(""), null);
});

/** Build a pending clarification for the injected loader. */
function pending(over: Partial<ReplyClarificationData> = {}, expired = false): PendingClarification {
  return {
    id: "clar_1",
    expired,
    data: {
      kind: "gmail_reply_clarification",
      action: over.action ?? "create_reply_draft",
      body: over.body ?? "Sounds good.",
      candidates: over.candidates ?? [
        { index: 1, messageId: "m1", threadId: "t1", sender: "Rob Stone", subject: "ICTS Job Offer" },
        { index: 2, messageId: "m2", threadId: "t2", sender: "Rob Stone", subject: "RE: ICTS Job Offer" },
      ],
      resolvedIndex: over.resolvedIndex ?? null,
    },
  };
}

/** Clarification deps: injected loader + capture of resolve/finish calls. */
function makeClarDeps(
  pendingState: PendingClarification | null,
  over: Partial<GmailClarificationDeps> = {},
): {
  deps: GmailClarificationDeps;
  calls: { executed: { input: Record<string, unknown> }[]; proposed: { input: unknown }[]; marked: number[] };
} {
  const calls = {
    executed: [] as { input: Record<string, unknown> }[],
    proposed: [] as { input: unknown }[],
    marked: [] as number[],
  };
  const deps: GmailClarificationDeps = {
    writeCapability: async () => "connected_write",
    loadClarification: async () => pendingState,
    // fetchReplyContext maps the chosen messageId to a distinct thread + RAW subject
    // (proving the reply uses thread metadata, not the display subject).
    fetchReplyContext: async (_u, messageId) => ({
      threadId: messageId === "m2" ? "t2" : "t1",
      messageIdHeader: messageId === "m2" ? "<m2@mail>" : "<m1@mail>",
      references: null,
      replyToAddress: "rob@example.com",
      replyToName: "Rob Stone",
      subject: "ICTS Job Offer",
    }),
    execute: async (_u, _a, input) => {
      calls.executed.push({ input });
      return { ok: true, userMessage: "Reply draft created in Gmail.\nTo: Rob Stone <rob@example.com>" };
    },
    createProposal: async (_u, input) => {
      calls.proposed.push({ input: input.input });
      return { id: "prop_x" };
    },
    markResolved: async (_u, _id, _d, idx) => {
      calls.marked.push(idx);
    },
    ...over,
  };
  return { deps, calls };
}

asyncCheck("select: no pending clarification falls through unchanged", async () => {
  const { deps } = makeClarDeps(null);
  const r = await handleGmailClarification("u", "2", deps);
  assert.equal(r.handled, false);
});

asyncCheck("select: a pending clarification but a non-selection message falls through", async () => {
  const { deps } = makeClarDeps(pending());
  const r = await handleGmailClarification("u", "what's on my calendar today", deps);
  assert.equal(r.handled, false);
});

asyncCheck("select: '1' selects the first thread and drafts it", async () => {
  const { deps, calls } = makeClarDeps(pending());
  const r = await handleGmailClarification("u", "1", deps);
  assert.equal(r.handled, true);
  assert.equal(calls.executed.length, 1);
  assert.equal(calls.executed[0]!.input.threadId, "t1");
  assert.equal(calls.marked[0], 1);
});

asyncCheck("select: 'option 2' selects the second thread; reply uses thread metadata", async () => {
  const { deps, calls } = makeClarDeps(pending());
  await handleGmailClarification("u", "option 2", deps);
  assert.equal(calls.executed.length, 1);
  const input = calls.executed[0]!.input;
  assert.equal(input.threadId, "t2");
  // The reply subject derives from the RAW thread subject, NOT the display subject
  // ("RE: ICTS Job Offer") stored on the candidate.
  assert.equal(input.subject, buildReplySubject("ICTS Job Offer"));
  assert.notEqual(input.subject, "RE: ICTS Job Offer");
});

asyncCheck("select: 'the second one' selects the second thread", async () => {
  const { deps, calls } = makeClarDeps(pending());
  await handleGmailClarification("u", "the second one", deps);
  assert.equal(calls.executed[0]!.input.threadId, "t2");
});

asyncCheck("select: a selected SEND option creates a confirmation proposal (never sends)", async () => {
  const { deps, calls } = makeClarDeps(pending({ action: "send_reply" }));
  const r = await handleGmailClarification("u", "2", deps);
  assert.equal(calls.executed.length, 0, "a send is never executed here");
  assert.equal(calls.proposed.length, 1, "it proposes a send for confirmation");
  assert.ok(/Ready to send:/.test(r.reply ?? ""));
});

asyncCheck("select: 'actually 2' after picking 1 resolves the correction while valid", async () => {
  // resolvedIndex=1 means option 1 was already drafted; a correction to 2 is valid.
  const { deps, calls } = makeClarDeps(pending({ resolvedIndex: 1 }));
  const r = await handleGmailClarification("u", "actually 2", deps);
  assert.equal(r.handled, true);
  assert.equal(calls.executed.length, 1);
  assert.equal(calls.executed[0]!.input.threadId, "t2");
  // Honest, non-destructive: the earlier draft is acknowledged, never silently deleted.
  assert.ok(/still in your Gmail drafts/i.test(r.reply ?? ""));
});

asyncCheck("select: re-selecting the SAME option does not act twice", async () => {
  const { deps, calls } = makeClarDeps(pending({ resolvedIndex: 2 }));
  const r = await handleGmailClarification("u", "2", deps);
  assert.equal(calls.executed.length, 0, "duplicate selection never drafts/sends again");
  assert.equal(calls.proposed.length, 0);
  assert.equal(r.reply, GMAIL_WRITE_REPLIES.clarifyAlreadyDone);
});

asyncCheck("select: an out-of-range number asks for a valid option", async () => {
  const { deps, calls } = makeClarDeps(pending());
  const r = await handleGmailClarification("u", "5", deps);
  assert.equal(r.handled, true);
  assert.ok(/not one of the options/.test(r.reply ?? ""));
  assert.equal(calls.executed.length, 0);
});

asyncCheck("select: an expired clarification asks the user to repeat", async () => {
  let expired = 0;
  const { deps, calls } = makeClarDeps(pending({}, true), {
    expireClarification: async () => {
      expired += 1;
    },
  });
  const r = await handleGmailClarification("u", "2", deps);
  assert.equal(r.reply, GMAIL_WRITE_REPLIES.clarifyExpired);
  assert.equal(calls.executed.length, 0);
  assert.equal(expired, 1, "the lapsed clarification is expired");
});

asyncCheck("select: a read-only reconnect is required before resolving", async () => {
  const { deps, calls } = makeClarDeps(pending(), { writeCapability: async () => "connected_readonly" });
  const r = await handleGmailClarification("u", "1", deps);
  assert.equal(r.reply, GMAIL_WRITE_REPLIES.reconnect);
  assert.equal(calls.executed.length, 0);
});

// ==========================================================================
// FIX 4 — stale Gmail capability claims removed from the brain prompt
// ==========================================================================

check("prompt: brain no longer claims Gmail drafts/sends are disabled", () => {
  const p = HULA_SYSTEM_PROMPT.toLowerCase();
  assert.ok(!/turned off/.test(p), "no 'turned off' write/send claim");
  assert.ok(!/only live capability/.test(p));
  assert.ok(!/draft or send email;/.test(p), "the old 'cannot draft or send email' list is gone");
  // It now reflects the real Gmail write capability.
  assert.ok(/draft new emails and replies/.test(p));
  assert.ok(/send new emails and replies/.test(p));
});

check("prompt: brain keeps provider-confirmation honesty and leaks no vendor detail", () => {
  const built = buildHulaSystemPrompt({
    firstName: "Ayub",
    channel: "imessage",
    connectedProviders: ["Gmail", "Google Calendar"],
  }).toLowerCase();
  // Honesty preserved: never claim done without confirmation; sends need go-ahead.
  assert.ok(/unless the system has confirmed/.test(built));
  assert.ok(/after they confirm/.test(built));
  // No backend/vendor leakage introduced.
  for (const term of ["sendblue", "clerk", "neon", "prisma", "anthropic", "ngrok", "postgres", "webhook"]) {
    assert.ok(!built.includes(term), `prompt must not mention "${term}"`);
  }
});

// ==========================================================================
// TYPO SAFETY — strict sender matching (no fuzzy substitution)
// ==========================================================================

check("typo: 'Ron' never matches a Rob/Robert message", () => {
  assert.equal(senderMatchesName(msg({ fromName: "Robert Ellis", fromAddress: "robert@x.com" }), "Ron"), false);
  assert.equal(senderMatchesName(msg({ fromName: "Rob Stone", fromAddress: "rob@example.com" }), "Ron"), false);
});

asyncCheck("typo: 'draft a reply to Ron's latest email' returns an honest not-found", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create_reply_draft", recipientName: "Ron", body: "Yes." } as GmailAction),
    fetchMessages: async () => [msg({ fromName: "Robert Ellis", fromAddress: "robert@x.com" })],
  });
  const r = await handleGmailWrite("u", "draft a reply to Ron's latest email saying yes", deps);
  assert.equal(r.reply, GMAIL_WRITE_REPLIES.threadNotFound);
  assert.equal(calls.executed.length, 0);
  assert.equal(calls.clarified.length, 0);
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} Gmail write (Section 16) tests passed.`);
}

void run().catch((err) => {
  console.error("Gmail write tests failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
