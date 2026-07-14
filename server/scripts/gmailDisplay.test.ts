import assert from "node:assert/strict";

import {
  decodeSafeEntities,
  displayFlags,
  displayPreview,
  displayReceived,
  displaySender,
  displaySubject,
  displayWhen,
  formatEmailList,
  sanitizeDisplay,
  sanitizeSummaryText,
  truncateAtWord,
} from "../src/integrations/providers/gmail/gmailDisplay";
import { endsWithCompleteSentence } from "../src/integrations/providers/gmail/gmailSummaryText";
import type { NormalizedGmailMessage } from "../src/integrations/providers/gmail/types";

/**
 * Offline tests for Gmail DISPLAY formatting (Section 17 real-device fix). PURE —
 * no database, no network.
 *
 * Driven by what actually shipped: a wall of raw metadata with literal HTML
 * entities ("Don&#39;t"). Sender names, subjects and snippets are all
 * attacker-controlled, so decoding them for display must not open a hole.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const TZ = "America/New_York";
const NOW = new Date("2026-07-14T16:00:00Z"); // 12:00 in New York

function msg(over: Partial<NormalizedGmailMessage> = {}): NormalizedGmailMessage {
  return {
    id: "m1",
    threadId: "t1",
    fromName: "Robert Ellis",
    fromAddress: "robert@example.com",
    subject: "Re: ICTS Job Offer",
    receivedAt: "2026-07-14T15:37:00Z",
    unread: false,
    important: false,
    labels: [],
    snippet: "Training will contact you with the next steps.",
    source: "gmail",
    ...over,
  };
}

// --- Entity decoding ------------------------------------------------------

check("entities: the exact live failure decodes", () => {
  // "Don&#39;t" appeared literally in the shipped output.
  assert.equal(decodeSafeEntities("Don&#39;t forget"), "Don't forget");
});

check("entities: the named allowlist decodes", () => {
  assert.equal(decodeSafeEntities("a &amp; b"), "a & b");
  assert.equal(decodeSafeEntities("&lt;tag&gt;"), "<tag>");
  assert.equal(decodeSafeEntities("&quot;hi&quot;"), '"hi"');
  assert.equal(decodeSafeEntities("it&rsquo;s"), "it’s");
  assert.equal(decodeSafeEntities("a&nbsp;b"), "a b");
  assert.equal(decodeSafeEntities("&hellip;"), "…");
});

check("entities: hex and decimal numeric forms decode", () => {
  assert.equal(decodeSafeEntities("&#x27;"), "'");
  assert.equal(decodeSafeEntities("&#8217;"), "’");
});

check("entities: unknown entities are left as literal text, not guessed", () => {
  assert.equal(decodeSafeEntities("&frobnicate;"), "&frobnicate;");
  assert.equal(decodeSafeEntities("&"), "&");
});

check("entities: a numeric escape for a control character is DROPPED", () => {
  // The attack: decode a newline to forge extra output lines that look like ours.
  assert.equal(decodeSafeEntities("a&#10;b"), "ab");
  assert.equal(decodeSafeEntities("a&#0;b"), "ab");
  assert.equal(decodeSafeEntities("a&#x0A;b"), "ab");
});

// --- Sanitisation ---------------------------------------------------------

check("sanitize: newlines cannot forge a fake list entry", () => {
  // A crafted subject trying to look like one of our own numbered results.
  const out = sanitizeDisplay("Hi\n2. Bank — Urgent: send money", 200);
  assert.equal(out.includes("\n"), false, "no newline may survive");
  assert.equal(out, "Hi 2. Bank — Urgent: send money");
});

check("sanitize: entity-encoded newlines cannot forge one either", () => {
  // Decoding happens BEFORE stripping, so this must not slip through.
  const out = sanitizeDisplay("Hi&#10;2. Bank — Urgent", 200);
  assert.equal(out.includes("\n"), false);
});

check("sanitize: control characters are stripped and length is bounded", () => {
  // The control characters are written as ESCAPES, never as literal bytes: a raw
  // NUL in the source makes Git treat this whole file as binary, so the test
  // becomes unreviewable. The string value is identical either way.
  assert.equal(sanitizeDisplay("a\u0000b\u001Fc", 200), "a b c");
  assert.equal(sanitizeDisplay("x".repeat(500), 50).length, 51, "50 chars + ellipsis");
  assert.equal(sanitizeDisplay("", 50), "");
  assert.equal(sanitizeDisplay(null, 50), "");
});

// --- Bounding: labels vs prose --------------------------------------------

check("truncate: a bounded LABEL cuts on a word boundary, not mid-word", () => {
  // The live bug in miniature: a label must never end "…recipie…".
  assert.equal(truncateAtWord("inviting the recipient to connect", 20), "inviting the…");
  // A cut that already lands between words keeps every whole word.
  assert.equal(truncateAtWord("inviting the recipient to connect", 22), "inviting the recipient…");
  assert.equal(truncateAtWord("short", 22), "short", "under budget is untouched");
  // No boundary at all: an unbroken run (a URL, a hash) has nowhere to cut.
  assert.equal(truncateAtWord("x".repeat(80), 10), `${"x".repeat(10)}…`);
});

check("summary text: PROSE is bounded by whole sentences, never sliced", () => {
  const s = "Olha confirms your sandbox is ready. She explains how to begin testing today.";
  // A budget that lands INSIDE the second sentence: it is dropped whole. The old
  // formatter would have cut it mid-word here.
  const out = sanitizeSummaryText(s, 50);
  assert.equal(out, "Olha confirms your sandbox is ready.", out);
  assert.equal(out.includes("…"), false, "prose never gets a truncation marker");
  assert.equal(endsWithCompleteSentence(out), true);
});

check("summary text: an already-truncated fragment is refused, not printed", () => {
  const live =
    "Olha, a Customer Success Manager at LoopMessage, notes you’ve set up the sandbox (which is…";
  assert.equal(sanitizeSummaryText(live, 260), "");
});

// --- Single-email timestamp ------------------------------------------------

check("received: reads as prose for a single-email reply", () => {
  assert.equal(displayReceived("2026-07-14T15:37:00Z", TZ, NOW), "Received today at 11:37 AM");
  assert.equal(displayReceived("2026-07-13T13:03:00Z", TZ, NOW), "Received yesterday at 9:03 AM");
  assert.equal(displayReceived("2026-07-07T13:03:00Z", TZ, NOW), "Received Tue 7 Jul at 9:03 AM");
  assert.equal(displayReceived(null, TZ, NOW), "", "unknown time prints no line");
  assert.equal(displayReceived("not-a-date", TZ, NOW), "");
});

// --- Field display --------------------------------------------------------

check("sender: prefers the name, falls back to the address", () => {
  assert.equal(displaySender(msg()), "Robert Ellis");
  assert.equal(displaySender(msg({ fromName: null })), "robert@example.com");
  assert.equal(displaySender(msg({ fromName: null, fromAddress: null })), "Unknown sender");
});

check("subject: collapses repeated reply prefixes for display only", () => {
  assert.equal(displaySubject(msg({ subject: "Re: Re: Offer" })), "Re: Offer");
  assert.equal(displaySubject(msg({ subject: "Fwd: Fwd: Fwd: X" })), "Fwd: X");
  assert.equal(displaySubject(msg({ subject: null })), "(no subject)");
  // A single Re: is meaningful and stays.
  assert.equal(displaySubject(msg({ subject: "Re: Offer" })), "Re: Offer");
});

check("preview: decodes and truncates the snippet", () => {
  assert.equal(displayPreview("You&#39;ve been invited"), "You've been invited");
  assert.ok(displayPreview("x".repeat(300)).endsWith("…"));
});

check("when: renders human timestamps relative to today", () => {
  assert.equal(displayWhen("2026-07-14T15:37:00Z", TZ, NOW), "Today, 11:37 AM");
  assert.equal(displayWhen("2026-07-13T13:03:00Z", TZ, NOW), "Yesterday, 9:03 AM");
  assert.ok(/^Tue 7 Jul, /.test(displayWhen("2026-07-07T13:03:00Z", TZ, NOW)));
  assert.equal(displayWhen(null, TZ, NOW), "", "unknown time renders nothing");
  assert.equal(displayWhen("not-a-date", TZ, NOW), "");
});

check("flags: only states that tell the user something appear", () => {
  assert.deepEqual(displayFlags(msg()), [], "read + unstarred is noise");
  assert.deepEqual(displayFlags(msg({ unread: true })), ["Unread"]);
  assert.deepEqual(displayFlags(msg({ labels: ["STARRED"] })), ["Starred"]);
  assert.deepEqual(displayFlags(msg(), { hasAttachments: true }), ["Attachment"]);
});

// --- List layout ----------------------------------------------------------

check("list: matches the agreed professional layout", () => {
  const out = formatEmailList(
    [
      { message: msg() },
      {
        message: msg({
          id: "m2",
          fromName: "Accurate CS",
          subject: "Background Screening Invitation",
          receivedAt: "2026-07-14T15:29:00Z",
          unread: true,
          snippet: "You&#39;ve been invited to complete your screening information.",
        }),
      },
    ],
    TZ,
    NOW,
  );
  const expected = [
    "1. Robert Ellis — Re: ICTS Job Offer",
    "   Today, 11:37 AM",
    "   Training will contact you with the next steps.",
    "",
    "2. Accurate CS — Background Screening Invitation",
    "   Today, 11:29 AM · Unread",
    "   You've been invited to complete your screening information.",
  ].join("\n");
  assert.equal(out, expected, out);
});

check("list: a grounded summary is shown IN FULL, not sliced at 90 characters", () => {
  // The exact shipped failure: this summary is 131 characters, and every character
  // of it is real. It used to arrive as "...to conn…".
  const summary =
    "A LinkedIn notification promoting a puzzle game called Zip, inviting the recipient to connect with friends and play the daily puzzle.";
  const out = formatEmailList([{ message: msg(), preview: summary }], TZ, NOW);
  assert.ok(out.includes(summary), out);
  assert.equal(out.includes("…"), false, "no summary may carry a truncation marker");
  assert.equal(
    out.includes("inviting the recipient to conn…"),
    false,
    "the live truncation must be impossible",
  );
});

check("list: an action line is separated from what the email said", () => {
  const out = formatEmailList(
    [{ message: msg(), preview: "They need your screening form.", action: "Complete the form." }],
    TZ,
    NOW,
  );
  assert.ok(out.includes("   They need your screening form."));
  assert.ok(out.includes("   Action: Complete the form."));
  // The action must be its own line so it is never read as a fact from the email.
  assert.ok(out.indexOf("Action:") > out.indexOf("They need"));
});

check("list: no ids or raw metadata ever reach the output", () => {
  const out = formatEmailList([{ message: msg({ id: "SECRET_ID", threadId: "SECRET_T" }) }], TZ, NOW);
  assert.equal(out.includes("SECRET_ID"), false);
  assert.equal(out.includes("SECRET_T"), false);
  assert.equal(out.includes("gmail"), false, "the source slug is internal");
});

check("list: a crafted email cannot inject a fake numbered entry", () => {
  const out = formatEmailList(
    [{ message: msg({ fromName: "Rob\n9. Bank — Send money now", subject: "Hi" }) }],
    TZ,
    NOW,
  );
  // Exactly ONE numbered line: ours.
  assert.equal((out.match(/^\d+\. /gm) ?? []).length, 1, out);
});

console.log(`\nAll ${passed} Gmail display (Section 17 fix) tests passed.`);
