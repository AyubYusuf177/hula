import assert from "node:assert/strict";

import {
  GMAIL_SUMMARY_REPLIES,
  boundBodyForModel,
  formatSingleSummary,
  formatSummaryList,
  handleGmailSummary,
  looksLikeSummaryRequest,
  summaryHeader,
  type GmailSummaryDeps,
} from "../src/integrations/providers/gmail/gmailSummary";
import { endsWithCompleteSentence } from "../src/integrations/providers/gmail/gmailSummaryText";
import {
  buildSummaryIntentPrompt,
  parseGmailSummaryIntent,
  parseSummaryResult,
  type GmailSummaryIntent,
} from "../src/integrations/providers/gmail/gmailSummaryExtract";
import { classifyReadOne } from "../src/integrations/providers/gmail/gmailReadOne";
import { looksLikeGmailSearch } from "../src/integrations/providers/gmail/gmailSearchQuestion";
import { GmailError } from "../src/integrations/providers/gmail/client";
import { GMAIL_REPLIES } from "../src/integrations/providers/gmail/gmailQuestion";
import type { GmailSelectionData, LoadedGmailSelection } from "../src/integrations/providers/gmail/gmailSelection";
import type { NormalizedGmailMessage } from "../src/integrations/providers/gmail/types";

/**
 * Offline tests for grounded Gmail SUMMARIES (Phase 3.2 completion). PURE or
 * injected fakes — NO database, NO Gmail, NO Anthropic.
 *
 * Phase 3.2 previously reached only "summarise <sender>'s latest email". Everything
 * a real conversation uses fell through to the model, which cannot see the inbox.
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

const TZ = "America/New_York";
const NOW = new Date("2026-07-14T16:00:00Z");

function msg(over: Partial<NormalizedGmailMessage> = {}): NormalizedGmailMessage {
  return {
    id: "m1",
    threadId: "t1",
    fromName: "Robert Ellis",
    fromAddress: "robert@example.com",
    subject: "ICTS Job Offer",
    receivedAt: "2026-07-14T15:37:00Z",
    unread: false,
    important: false,
    labels: [],
    snippet: "s",
    source: "gmail",
    ...over,
  };
}

function selection(
  items: { id: string; label: string; subject: string; receivedAt?: string }[],
): LoadedGmailSelection {
  return {
    id: "sel_1",
    data: {
      kind: "gmail_selection",
      itemKind: "messages",
      items: items.map((i) => ({ ...i, threadId: `t_${i.id}`, receivedAt: i.receivedAt ?? null })),
    },
    expired: false,
    createdAt: new Date().toISOString(),
  };
}

/**
 * The EXACT strings real users were shown after Section 17 — each cut at 90
 * characters by the snippet formatter. Kept verbatim so the regression is nailed down.
 */
const LIVE_TRUNCATIONS = [
  "A LinkedIn notification promoting a puzzle game called Zip, inviting the recipient to conn…",
  "Olha, a Customer Success Manager at LoopMessage, notes that you’ve set up the sandbox (whi…",
  "Olha, a Customer Success Manager at LoopMessage, notes you’ve set up the sandbox (which is…",
] as const;

/**
 * The invariant: EVERY line of prose in a formatted reply is a finished sentence.
 *
 * Labels are excluded, because a sender or a timestamp is not a sentence. They are
 * identifiable by shape: our headers, a "Sender — Subject" line (the em-dash
 * separator is only ever ours), a numbered entry, or a timestamp. Everything else is
 * prose we generated and must stand on its own.
 */
function assertEveryLineIsComplete(reply: string): void {
  const labelish =
    /^(Here’s|One of these|\d+\. |Today, |Yesterday, |Received |[A-Z][a-z]{2} \d)|\s—\s/;
  for (const raw of reply.split("\n")) {
    const line = raw.trim();
    if (!line || labelish.test(line)) continue;
    const prose = line.replace(/^Action:\s*/, "");
    assert.equal(
      endsWithCompleteSentence(prose),
      true,
      `line must be a complete sentence: ${JSON.stringify(line)}`,
    );
  }
  assert.equal(reply.includes("…"), false, `no truncation marker may appear:\n${reply}`);
  for (const bad of LIVE_TRUNCATIONS) {
    assert.equal(reply.includes(bad), false, `the live failure must be impossible: ${bad}`);
  }
}

// --- Prefilter ------------------------------------------------------------

check("prefilter: every phrasing from the brief is recognised", () => {
  for (const t of [
    "Summarize my 5 most recent emails",
    "Summarize my unread emails from today",
    "Which of these need my attention?",
    "Summarize them",
    "Summarize the second one",
    "What does Robert want from me?",
    "Give me a quick inbox overview",
    "Which emails need a reply?",
  ]) {
    assert.equal(looksLikeSummaryRequest(t), true, `must recognise: ${t}`);
  }
});

check("prefilter: pronoun/ordinal references work without an email noun", () => {
  // The systemic bug: once a list is shown the user stops naming emails.
  assert.equal(looksLikeSummaryRequest("Summarize them"), true);
  assert.equal(looksLikeSummaryRequest("Summarize the second one"), true);
  assert.equal(looksLikeSummaryRequest("Which of these need my attention?"), true);
});

check("prefilter: ordinary chat and other domains never match", () => {
  for (const t of ["hey how are you", "thanks!", "what's on my calendar today", "send Rob an email", ""]) {
    assert.equal(looksLikeSummaryRequest(t), false, `must not match: ${t}`);
  }
});

check("prefilter: does not steal the existing single-email read path", () => {
  // `gmailReadOne` runs FIRST and owns these; summary only takes what it declines.
  for (const t of ["what does Rob's latest email say", "summarise Rob's most recent email"]) {
    assert.notEqual(classifyReadOne(t), null, `readOne must still own: ${t}`);
  }
  // And the summary phrasings are NOT claimed by readOne or search.
  for (const t of ["Summarize them", "Which of these need my attention?"]) {
    assert.equal(classifyReadOne(t), null, `readOne must decline: ${t}`);
    assert.equal(looksLikeGmailSearch(t), false, `search must decline: ${t}`);
  }
});

// --- Extraction -----------------------------------------------------------

check("extract: intents parse; off-schema returns null", () => {
  assert.equal(parseGmailSummaryIntent('{"action":"summarize","ordinal":2}')?.ordinal, 2);
  assert.equal(parseGmailSummaryIntent('{"action":"triage","useLastResults":true}')?.action, "triage");
  assert.equal(parseGmailSummaryIntent('{"action":"bogus"}'), null);
  assert.equal(parseGmailSummaryIntent('{"action":"summarize","limit":99}'), null);
  assert.equal(parseGmailSummaryIntent("nope"), null);
});

check("extract: the prompt separates summaries from actions and other domains", () => {
  const p = buildSummaryIntentPrompt("2026-07-14", TZ);
  assert.ok(/not_summary/.test(p));
  assert.ok(/Drafting, sending, replying, starring.*NOT a summary/is.test(p));
  assert.ok(/calendar event is NOT a summary/i.test(p));
});

check("summariser: 'none' actions are normalised away, not printed", () => {
  assert.deepEqual(parseSummaryResult('{"summary":"All good.","action":"none"}'), {
    summary: "All good.",
    action: "",
  });
  assert.deepEqual(parseSummaryResult('{"summary":"x","action":"No action needed."}')?.action, "");
  assert.deepEqual(parseSummaryResult('{"summary":"x","action":"Reply by Friday."}')?.action, "Reply by Friday.");
});

check("summariser: an unparseable or empty reply is a failure, not an invention", () => {
  assert.equal(parseSummaryResult("not json"), null);
  assert.equal(parseSummaryResult('{"action":"x"}'), null, "no summary -> failure");
  assert.equal(parseSummaryResult(""), null);
});

// --- Formatting -----------------------------------------------------------

check("format: the header matches the mode", () => {
  assert.equal(summaryHeader({ action: "summarize" }, 3), "Here’s your inbox summary:");
  assert.equal(summaryHeader({ action: "summarize" }, 1), "Here’s the gist:");
  assert.ok(/needs you/.test(summaryHeader({ action: "triage" }, 2)));
});

check("format: matches the agreed professional summary layout", () => {
  const out = formatSummaryList(
    [
      {
        message: msg(),
        result: { summary: "The training team will contact you about the next stage.", action: "" },
      },
      {
        message: msg({ id: "m2", fromName: "Accurate CS", subject: "Background Screening" }),
        result: {
          summary: "You need to complete an online screening form.",
          action: "Complete the requested information.",
        },
      },
    ],
    TZ,
    NOW,
    "Here’s your inbox summary:",
  );
  assert.ok(out.startsWith("Here’s your inbox summary:\n\n"), out);
  assert.ok(/1\. Robert Ellis — ICTS Job Offer/.test(out));
  assert.ok(/   The training team will contact you about the next stage\./.test(out));
  assert.ok(/2\. Accurate CS — Background Screening/.test(out));
  assert.ok(/   Action: Complete the requested information\./.test(out));
  // Only ONE action line — the first email implies none, so none is printed.
  assert.equal((out.match(/Action:/g) ?? []).length, 1);
});

check("format: the live truncation cannot be reproduced (multi-email)", () => {
  // The REAL summaries behind the two truncated lines users were shown.
  const linkedin =
    "A LinkedIn notification promoting a puzzle game called Zip, inviting the recipient to connect with friends and play the daily puzzle.";
  const loop =
    "Olha, a Customer Success Manager at LoopMessage, notes that you’ve set up the sandbox and explains what to do next.";
  const out = formatSummaryList(
    [
      {
        message: msg({ fromName: "LinkedIn", subject: "New puzzle skill" }),
        result: { summary: linkedin, action: "" },
      },
      {
        message: msg({ id: "m2", fromName: "Olha Ivasiuk", subject: "LoopMessage setup" }),
        result: { summary: loop, action: "" },
      },
    ],
    TZ,
    NOW,
    "Here’s your inbox summary:",
  );
  assert.ok(out.includes(linkedin), `must show the FULL summary:\n${out}`);
  assert.ok(out.includes(loop), `must show the FULL summary:\n${out}`);
  assertEveryLineIsComplete(out);
  // Readable spacing: the entries are separated by a blank line.
  assert.ok(/\n\n2\. Olha Ivasiuk — LoopMessage setup/.test(out), out);
});

check("format: a summary with nothing complete degrades honestly, never to a fragment", () => {
  for (const fragment of LIVE_TRUNCATIONS) {
    const out = formatSummaryList(
      [{ message: msg(), result: { summary: fragment, action: "" } }],
      TZ,
      NOW,
      "Here’s the gist:",
    );
    assert.ok(out.includes(GMAIL_SUMMARY_REPLIES.unreadable), out);
    assertEveryLineIsComplete(out);
  }
});

// --- Single-email formatting ----------------------------------------------

check("format: ONE email is an answer, not a one-item list", () => {
  const out = formatSingleSummary(
    {
      message: msg({
        fromName: "Olha Ivasiuk",
        subject: "You’re set up to test — here’s what’s next with LoopMessage",
        receivedAt: "2026-07-14T18:02:00Z",
      }),
      result: {
        summary:
          "Olha confirms that your LoopMessage sandbox is ready and explains the next steps for testing the service.",
        action: "Follow the testing instructions if you want to continue setup.",
      },
    },
    TZ,
    NOW,
  );
  const expected = [
    "Olha Ivasiuk — You’re set up to test — here’s what’s next with LoopMessage",
    "Received today at 2:02 PM",
    "",
    "Olha confirms that your LoopMessage sandbox is ready and explains the next steps for testing the service.",
    "",
    "Action: Follow the testing instructions if you want to continue setup.",
  ].join("\n");
  assert.equal(out, expected, out);
  assert.equal(/^\s*1\./m.test(out), false, "a single email is never numbered '1.'");
  assertEveryLineIsComplete(out);
});

check("format: a single email with no action implied prints no Action line", () => {
  const out = formatSingleSummary(
    { message: msg(), result: { summary: "LinkedIn is promoting its Zip puzzle.", action: "" } },
    TZ,
    NOW,
  );
  assert.equal(out.includes("Action:"), false, "an action is never manufactured");
  assertEveryLineIsComplete(out);
});

check("format: an unknown received time omits the line rather than inventing one", () => {
  const out = formatSingleSummary(
    { message: msg({ receivedAt: null }), result: { summary: "All good.", action: "" } },
    TZ,
    NOW,
  );
  assert.equal(out.includes("Received"), false, out);
});

// --- Model input ----------------------------------------------------------

check("input: the body is bounded and quoted history removed before the model", () => {
  const body = [
    "The sandbox is ready when you are.",
    "",
    "On Mon, 13 Jul 2026 at 14:02, Ayub <ayub@example.com> wrote:",
    "> How do I start?",
  ].join("\n");
  assert.equal(boundBodyForModel(body), "The sandbox is ready when you are.");
  // Still hard-bounded, and cut on a word boundary so the model never sees half a word.
  const huge = "word ".repeat(2000);
  const bounded = boundBodyForModel(huge, 100);
  assert.ok(bounded.length <= 100, `must stay bounded, got ${bounded.length}`);
  assert.equal(/\bwor$/.test(bounded), false, "never a half word");
});

// --- Orchestration --------------------------------------------------------

function deps(
  over: Partial<GmailSummaryDeps> & {
    intent?: GmailSummaryIntent | null;
    sel?: LoadedGmailSelection | null;
  } = {},
): { deps: GmailSummaryDeps; calls: { fetched: string[]; recorded: GmailSelectionData[] } } {
  const calls = { fetched: [] as string[], recorded: [] as GmailSelectionData[] };
  const d: GmailSummaryDeps = {
    now: NOW,
    getTimezone: async () => TZ,
    extract: async () =>
      over.intent === undefined ? { action: "summarize", useLastResults: true } : over.intent,
    fetchBody: async (_u, id) => {
      calls.fetched.push(id);
      return { text: `Body of ${id}.`, snippet: "", attachments: [] };
    },
    summarise: async ({ body }) => ({ summary: body, action: "" }),
    loadSelection: async () =>
      over.sel === undefined ? selection([{ id: "m1", label: "Rob", subject: "x" }]) : over.sel,
    recordSelection: async (_u, data) => {
      calls.recorded.push(data);
      return { id: "sel_new" };
    },
    search: async () => [msg()],
    ...over,
  };
  return { deps: d, calls };
}

asyncCheck("summary: 'summarize my 5 most recent emails' searches and bounds the set", async () => {
  let askedFor = 0;
  const { deps: d, calls } = deps({
    intent: { action: "summarize", limit: 5 },
    sel: null,
    search: async (_u, _c, opts) => {
      askedFor = opts?.maxResults ?? 0;
      return Array.from({ length: 5 }, (_, i) => msg({ id: `m${i}` }));
    },
  });
  const r = await handleGmailSummary("u", "Summarize my 5 most recent emails", d);
  assert.equal(askedFor, 5);
  assert.equal(r.summarised, 5);
  assert.equal(calls.fetched.length, 5, "one body fetch per email");
});

asyncCheck("summary: the fan-out is hard-capped regardless of what comes back", async () => {
  const { deps: d, calls } = deps({
    intent: { action: "summarize" },
    sel: null,
    // A provider ignoring the cap.
    search: async () => Array.from({ length: 20 }, (_, i) => msg({ id: `m${i}` })),
  });
  await handleGmailSummary("u", "Give me a quick inbox overview", d);
  assert.ok(calls.fetched.length <= 5, `fan-out must stay bounded, got ${calls.fetched.length}`);
});

asyncCheck("summary: 'unread from today' maps to real criteria", async () => {
  let used: Record<string, unknown> = {};
  const { deps: d } = deps({
    intent: { action: "summarize", unreadOnly: true, todayOnly: true },
    sel: null,
    search: async (_u, c) => {
      used = c as Record<string, unknown>;
      return [msg()];
    },
  });
  await handleGmailSummary("u", "Summarize my unread emails from today", d);
  assert.equal(used.unread, true);
  assert.equal(used.newerThanDays, 1, "today -> a 1-day window");
});

asyncCheck("summary: each email is summarised in isolation (no fact bleed)", async () => {
  // One model call per email is the mechanism — batching is how facts bleed.
  const seen: string[] = [];
  const { deps: d } = deps({
    intent: { action: "summarize", useLastResults: true },
    sel: selection([
      { id: "m1", label: "Rob", subject: "A" },
      { id: "m2", label: "Sue", subject: "B" },
    ]),
    summarise: async ({ body, sender }) => {
      seen.push(`${sender}:${body}`);
      return { summary: body, action: "" };
    },
  });
  await handleGmailSummary("u", "Summarize them", d);
  assert.deepEqual(seen, ["Rob:Body of m1.", "Sue:Body of m2."]);
  // Each call saw exactly ONE body.
  for (const s of seen) assert.equal((s.match(/Body of/g) ?? []).length, 1);
});

// --- The two real conversations that failed on device ----------------------

/** The real inbox behind the live failure, wired end-to-end through the handler. */
const LIVE_INBOX = [
  {
    id: "m_linkedin",
    label: "LinkedIn",
    subject: "New puzzle skill",
    receivedAt: "2026-07-14T17:31:00Z",
    body: "Zip is our new daily puzzle. Connect with friends and see who solves it fastest.",
    summary:
      "LinkedIn is promoting its new Zip puzzle game and invites you to play it daily with friends.",
    action: "",
  },
  {
    id: "m_olha",
    label: "Olha Ivasiuk",
    subject: "You’re set up to test — here’s what’s next with LoopMessage",
    receivedAt: "2026-07-14T18:02:00Z",
    body: [
      "Hi! You've set up the sandbox, which is free to use while you test.",
      "Here's how to send your first message.",
      "",
      "On Mon, 13 Jul 2026 at 09:00, Ayub <ayub@example.com> wrote:",
      "> Signed up, what now?",
    ].join("\n"),
    summary:
      "Olha confirms that your LoopMessage sandbox is ready and explains the next steps for testing the service.",
    action: "Follow the testing instructions if you want to continue setup.",
  },
] as const;

function liveDeps(intent: GmailSummaryIntent): {
  deps: GmailSummaryDeps;
  calls: { fetched: string[]; bodiesSeen: string[] };
} {
  const calls = { fetched: [] as string[], bodiesSeen: [] as string[] };
  return {
    calls,
    deps: {
      now: NOW,
      getTimezone: async () => TZ,
      extract: async () => intent,
      loadSelection: async () =>
        selection(LIVE_INBOX.map(({ id, label, subject, receivedAt }) => ({ id, label, subject, receivedAt }))),
      fetchBody: async (_u, id) => {
        calls.fetched.push(id);
        const row = LIVE_INBOX.find((e) => e.id === id);
        return { text: row?.body ?? "", snippet: "", attachments: [] };
      },
      // Stands in for the model: grounded, complete, and never called for real.
      summarise: async ({ body }) => {
        calls.bodiesSeen.push(body);
        const row = LIVE_INBOX.find((e) => {
          // split() always yields at least one element; the guard is for the type
          // checker, and needs no sentinel value to compare against.
          const firstLine = e.body.split("\n")[0];
          return firstLine !== undefined && body.startsWith(firstLine);
        });
        return row ? { summary: row.summary, action: row.action } : { summary: "", action: "" };
      },
      recordSelection: async () => ({ id: "sel_new" }),
      search: async () => [],
    },
  };
}

asyncCheck("live: 'Summarize them' resolves the last result set and reads properly", async () => {
  const { deps: d, calls } = liveDeps({ action: "summarize", useLastResults: true });
  const r = await handleGmailSummary("u", "Summarize them", d);

  assert.equal(r.handled, true);
  assert.equal(r.summarised, 2);
  assert.deepEqual(calls.fetched, ["m_linkedin", "m_olha"], "summarises the list just shown");

  const reply = r.reply ?? "";
  assert.ok(reply.startsWith("Here’s your inbox summary:\n\n"), reply);
  // Sender and clean subject, grounded in the right body, complete sentences.
  assert.ok(/^1\. LinkedIn — New puzzle skill$/m.test(reply), reply);
  assert.ok(reply.includes(LIVE_INBOX[0].summary), reply);
  assert.ok(/^2\. Olha Ivasiuk — You’re set up to test/m.test(reply), reply);
  assert.ok(reply.includes(LIVE_INBOX[1].summary), reply);
  assertEveryLineIsComplete(reply);

  // No ids, MIME, HTML or quoted history anywhere in the reply.
  for (const leak of ["m_linkedin", "m_olha", "t_m_olha", "text/html", "<", "wrote:", ">"]) {
    assert.equal(reply.includes(leak), false, `must not leak ${leak}:\n${reply}`);
  }
  // The quoted reply chain never reached the model either.
  for (const seen of calls.bodiesSeen) assert.equal(seen.includes("wrote:"), false, seen);
});

asyncCheck("live: 'Summarize the second one' answers only item 2, unnumbered", async () => {
  const { deps: d, calls } = liveDeps({ action: "summarize", ordinal: 2 });
  const r = await handleGmailSummary("u", "Summarize the second one", d);

  assert.equal(r.handled, true);
  assert.equal(r.summarised, 1);
  assert.deepEqual(calls.fetched, ["m_olha"], "ONLY item 2 is read");

  const reply = r.reply ?? "";
  // The shipped bug: "Here’s the gist:\n\n1. Olha Ivasiuk — …" then a cut-off summary.
  assert.equal(/^\s*1\./m.test(reply), false, `a single email is never numbered:\n${reply}`);
  assert.equal(reply.includes("Here’s the gist:"), false, reply);
  const expected = [
    "Olha Ivasiuk — You’re set up to test — here’s what’s next with LoopMessage",
    "Received today at 2:02 PM",
    "",
    LIVE_INBOX[1].summary,
    "",
    `Action: ${LIVE_INBOX[1].action}`,
  ].join("\n");
  assert.equal(reply, expected, reply);
  assertEveryLineIsComplete(reply);
});

asyncCheck("summary: a named sender resolves via search", async () => {
  let used: Record<string, unknown> = {};
  const { deps: d, calls } = deps({
    intent: { action: "summarize", senderName: "Robert" },
    sel: null,
    search: async (_u, c) => {
      used = c as Record<string, unknown>;
      return [msg({ id: "m_rob" })];
    },
  });
  const r = await handleGmailSummary("u", "What does Robert want from me?", d);
  assert.equal(used.from, "Robert");
  assert.deepEqual(calls.fetched, ["m_rob"]);
  // One email -> the single-email answer, not a one-item list.
  assert.ok(/^Robert Ellis — ICTS Job Offer$/m.test(r.reply ?? ""), r.reply);
  assert.equal(/^\s*1\./m.test(r.reply ?? ""), false, r.reply);
});

asyncCheck("summary: an ambiguous sender asks concisely, summarises nothing", async () => {
  const { deps: d, calls } = deps({
    intent: { action: "summarize", senderName: "Robert" },
    sel: null,
    search: async () => [
      msg({ id: "a", threadId: "t_a", subject: "Offer" }),
      msg({ id: "b", threadId: "t_b", subject: "Invoice" }),
    ],
  });
  const r = await handleGmailSummary("u", "What does Robert want from me?", d);
  assert.ok(/which one did you mean/i.test(r.reply ?? ""), r.reply);
  assert.equal(calls.fetched.length, 0, "must not summarise a guess");
});

asyncCheck("summary: an out-of-range position is refused", async () => {
  const { deps: d, calls } = deps({
    intent: { action: "summarize", ordinal: 9 },
    sel: selection([{ id: "m1", label: "Rob", subject: "x" }]),
  });
  const r = await handleGmailSummary("u", "Summarize the ninth one", d);
  assert.equal(r.reply, GMAIL_SUMMARY_REPLIES.outOfRange);
  assert.equal(calls.fetched.length, 0);
});

asyncCheck("summary: the shown set is re-recorded so 'the second one' keeps working", async () => {
  const { deps: d, calls } = deps({
    intent: { action: "summarize", limit: 2 },
    sel: null,
    search: async () => [msg({ id: "x1" }), msg({ id: "x2" })],
  });
  await handleGmailSummary("u", "Summarize my 2 most recent emails", d);
  assert.deepEqual(calls.recorded[0]?.items.map((i) => i.id), ["x1", "x2"]);
});

asyncCheck("summary: a provider failure is honest, never a fabricated summary", async () => {
  for (const [reason, expected] of [
    ["not_connected", GMAIL_REPLIES.notConnected],
    ["insufficient_scope", GMAIL_REPLIES.reconnect],
  ] as const) {
    const { deps: d } = deps({
      intent: { action: "summarize", useLastResults: true },
      fetchBody: async () => {
        throw new GmailError(reason, "x");
      },
    });
    const r = await handleGmailSummary("u", "Summarize them", d);
    assert.equal(r.reply, expected, `${reason} -> wrong reply`);
  }
});

asyncCheck("summary: not_summary and model-unavailable fall through", async () => {
  for (const intent of [{ action: "not_summary" } as GmailSummaryIntent, null]) {
    const { deps: d } = deps({ intent });
    const r = await handleGmailSummary("u", "Summarize them", d);
    assert.equal(r.handled, false);
  }
});

asyncCheck("summary: a prefilter miss never calls the model", async () => {
  let extracted = false;
  const { deps: d } = deps({
    extract: async () => {
      extracted = true;
      return { action: "summarize" };
    },
  });
  const r = await handleGmailSummary("u", "hey how are you", d);
  assert.equal(r.handled, false);
  assert.equal(extracted, false);
});

asyncCheck("safety: no reply leaks token material", async () => {
  const { deps: d } = deps();
  const r = await handleGmailSummary("u", "Summarize them", d);
  assert.ok(!/Bearer|ya29\.|access_token|refresh_token/i.test(JSON.stringify(r)));
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} Gmail summary (Phase 3.2) tests passed.`);
}

void run().catch((err) => {
  console.error("Gmail summary tests failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
