import assert from "node:assert/strict";

import {
  clampToCompleteSentences,
  endsWithCompleteSentence,
  splitSentences,
} from "../src/integrations/providers/gmail/gmailSummaryText";
import { stripQuotedReply } from "../src/integrations/providers/gmail/messageBody";

/**
 * Offline tests for SUMMARY TEXT shaping (Section 17 real-device fix). PURE — no
 * database, no network, no model.
 *
 * Driven by a real iMessage failure: complete, grounded summaries were rendered
 * through the snippet formatter, which sliced them at 90 characters. Users read
 * "...inviting the recipient to conn…" and "...the sandbox (which is…".
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

/**
 * The EXACT strings real users were shown. Every one is 90 characters — the old
 * `PREVIEW_MAX`. They exist here so this can never quietly come back.
 */
export const LIVE_TRUNCATIONS = [
  "A LinkedIn notification promoting a puzzle game called Zip, inviting the recipient to conn…",
  "Olha, a Customer Success Manager at LoopMessage, notes that you’ve set up the sandbox (whi…",
  "Olha, a Customer Success Manager at LoopMessage, notes you’ve set up the sandbox (which is…",
] as const;

// --- Completeness ---------------------------------------------------------

check("complete: the exact live failures are rejected as incomplete", () => {
  for (const bad of LIVE_TRUNCATIONS) {
    assert.equal(endsWithCompleteSentence(bad), false, `must reject: ${bad}`);
  }
});

check("complete: the dangling constructions from the brief are rejected", () => {
  for (const bad of [
    "Olha says the sandbox is ready, which is…",
    "LinkedIn is promoting Zip, inviting you to…",
    "The email closes with links…",
    // Cut mid-word, no ellipsis at all.
    "Olha notes you have set up the sandbox (which is",
    "It invites the recipient to conn",
    "A summary with no ending",
    "Ends with an ellipsis...",
  ]) {
    assert.equal(endsWithCompleteSentence(bad), false, `must reject: ${bad}`);
  }
});

check("complete: real finished sentences are accepted", () => {
  for (const good of [
    "Olha confirms your sandbox is ready and explains the next steps.",
    "Does he want an answer by Friday?",
    "Reply if you still want the slot!",
    'She wrote "we are ready to go."',
    "LinkedIn is promoting its Zip puzzle (a daily game).",
  ]) {
    assert.equal(endsWithCompleteSentence(good), true, `must accept: ${good}`);
  }
});

check("complete: a finished sentence is judged by its punctuation, not its last word", () => {
  // Regression: an earlier "words that cannot end a sentence" list threw these away.
  // Every one is a complete, grounded summary a real email produces.
  for (const good of [
    "Training will contact you.",
    "The email explains what to do next and asks for your address.",
    "He wants to know if you are still interested in it.",
    "Accurate CS needs your screening form, and the deadline is Friday.",
    "That is all there is to it.",
  ]) {
    assert.equal(endsWithCompleteSentence(good), true, `must accept: ${good}`);
    assert.equal(clampToCompleteSentences(good, 260), good, `must print in full: ${good}`);
  }
});

// --- Sentence splitting ---------------------------------------------------

check("split: sentences keep their punctuation", () => {
  assert.deepEqual(splitSentences("One thing. Two things! Three?"), [
    "One thing.",
    "Two things!",
    "Three?",
  ]);
  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(splitSentences("No terminator here"), ["No terminator here"]);
});

check("split: abbreviations, initials and decimals are not sentence ends", () => {
  // Splitting here would drop half the summary as junk.
  assert.deepEqual(splitSentences("Olha J. Ivasiuk at Loop Inc. says hello."), [
    "Olha J. Ivasiuk at Loop Inc. says hello.",
  ]);
  assert.deepEqual(splitSentences("Dr. Patel replied. She agreed."), [
    "Dr. Patel replied.",
    "She agreed.",
  ]);
  assert.deepEqual(splitSentences("The fee is 3.5 percent."), ["The fee is 3.5 percent."]);
});

// --- Clamping -------------------------------------------------------------

check("clamp: the live failures can never be printed at all", () => {
  for (const bad of LIVE_TRUNCATIONS) {
    assert.equal(clampToCompleteSentences(bad, 260), "", `must not print: ${bad}`);
  }
});

check("clamp: a complete summary passes through untouched", () => {
  const s = "Olha confirms your LoopMessage sandbox is ready and explains how to begin testing.";
  assert.equal(clampToCompleteSentences(s, 260), s);
  assert.ok(s.length < 260);
});

check("clamp: over-budget prose drops WHOLE sentences, never characters", () => {
  const a = "Olha confirms your sandbox is ready.";
  const b = "She also explains how to begin testing the service today.";
  const out = clampToCompleteSentences(`${a} ${b}`, a.length + 10);
  assert.equal(out, a, "the second sentence is dropped whole");
  assert.equal(endsWithCompleteSentence(out), true);
  assert.equal(out.includes("…"), false, "no truncation marker");
});

check("clamp: bounded — output never exceeds the hard ceiling", () => {
  // A single sentence far over budget is refused rather than sliced.
  const monster = `${"word ".repeat(200).trim()}.`;
  assert.equal(clampToCompleteSentences(monster, 260), "");
  // Merely long (within the ceiling) is kept whole, because it is still readable.
  const longish = `${"word ".repeat(60).trim()}.`;
  const out = clampToCompleteSentences(longish, 260);
  assert.equal(out, longish);
  assert.ok(out.length <= Math.ceil(260 * 1.5), "still bounded");
});

check("clamp: unpunctuated text is dropped, never finished with an added full stop", () => {
  // "All good" and "...to conn" are indistinguishable here, so neither gets a full
  // stop: fabricating completeness is the failure this module prevents. The
  // summariser is instructed to punctuate, so this stays a theoretical case.
  assert.equal(clampToCompleteSentences("All good", 260), "");
  assert.equal(clampToCompleteSentences("The sandbox is ready, which is", 260), "");
  assert.equal(clampToCompleteSentences("It invites the recipient to conn", 260), "");
});

check("clamp: empty input yields empty output, never a placeholder", () => {
  assert.equal(clampToCompleteSentences("", 260), "");
  assert.equal(clampToCompleteSentences("   ", 260), "");
});

// --- Quoted reply history -------------------------------------------------

check("quotes: a Gmail-style reply chain is dropped, newest content kept", () => {
  const body = [
    "Thanks — the sandbox is ready when you are.",
    "",
    "On Mon, 13 Jul 2026 at 14:02, Ayub <ayub@example.com> wrote:",
    "> How do I start testing?",
    "> Thanks",
  ].join("\n");
  assert.equal(stripQuotedReply(body), "Thanks — the sandbox is ready when you are.");
});

check("quotes: Outlook header blocks and dividers are dropped", () => {
  const outlook = [
    "Confirming your slot for Thursday.",
    "",
    "From: Ayub <ayub@example.com>",
    "Sent: Monday, 13 July 2026 14:02",
    "To: Olha",
    "Subject: Re: setup",
    "",
    "Old content here.",
  ].join("\n");
  assert.equal(stripQuotedReply(outlook), "Confirming your slot for Thursday.");

  const divider = ["Newest reply.", "_____________", "Older thread."].join("\n");
  assert.equal(stripQuotedReply(divider), "Newest reply.");
});

check("quotes: prose mentioning 'From:' is not mistaken for a quote block", () => {
  const body = "From: me, a quick note. The sandbox works.";
  assert.equal(stripQuotedReply(body), body);
});

check("quotes: stripping NEVER deletes the whole message", () => {
  // Bottom-posted: the quote comes first. Removing it would leave nothing above, so
  // the original survives — losing the real content is the worse failure.
  const bottomPosted = ["> Do you want the slot?", "", "Yes please."].join("\n");
  assert.equal(stripQuotedReply(bottomPosted), bottomPosted.trim());
  // Entirely quoted.
  assert.equal(stripQuotedReply("> only a quote"), "> only a quote");
  assert.equal(stripQuotedReply(""), "");
});

console.log(`\nAll ${passed} Gmail summary text (Section 17 fix) tests passed.`);
