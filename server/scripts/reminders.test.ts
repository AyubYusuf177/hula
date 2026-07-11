import assert from "node:assert/strict";

import {
  cleanReminderTitle,
  classifyReminderCommand,
  createConfirmation,
  formatReminderList,
  formatReminderWhen,
  parseCreate,
  reminderMatchesQuery,
  REMINDER_REPLIES,
} from "../src/reminders/reminders";
import { computeNextRun, extractTime, formatClock } from "../src/reminders/parse";
import type { ReminderView } from "../src/reminders/types";

/**
 * Offline tests for Section 9 reminders. Everything here is PURE — NO database,
 * network, or Anthropic call. Covers command classification (create / list /
 * cancel / cancel-all / none), deterministic date/time parsing, recurrence,
 * clarification on ambiguous asks, too-frequent rejection, title extraction,
 * matching, phrasing, and next-run advancement. Run with: `npm test`.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// A fixed "now" so tz/date maths is deterministic. This is a Wednesday.
// 2026-07-15T12:00:00Z. In America/New_York (UTC-4 in July) that's 08:00 local.
const NOW = new Date("2026-07-15T12:00:00Z");
const TZ = "America/New_York";

// --- Command classification ----------------------------------------------

check("classify: 'remind me …' is a create command", () => {
  const cmd = classifyReminderCommand("Remind me to go gym tomorrow at 7pm");
  assert.equal(cmd.intent, "create");
  assert.equal(cmd.intent === "create" && cmd.body, "to go gym tomorrow at 7pm");
});

check("classify: 'can you remind me …' strips the opener", () => {
  const cmd = classifyReminderCommand("Can you remind me in 30 minutes to call Rob");
  assert.equal(cmd.intent === "create" && cmd.body, "in 30 minutes to call Rob");
});

check("classify: 'follow up with me …' is a create command", () => {
  const cmd = classifyReminderCommand("Follow up with me tomorrow about the invoice");
  assert.equal(cmd.intent, "create");
  assert.ok(cmd.intent === "create" && cmd.body.startsWith("follow up"));
});

check("classify: 'what reminders do I have?' is list", () => {
  assert.equal(classifyReminderCommand("What reminders do I have?").intent, "list");
  assert.equal(classifyReminderCommand("show my reminders").intent, "list");
  assert.equal(classifyReminderCommand("list my reminders").intent, "list");
});

check("classify: 'cancel all reminders' is cancel-all", () => {
  assert.deepEqual(classifyReminderCommand("Cancel all reminders"), {
    intent: "cancel",
    scope: "all",
  });
  assert.deepEqual(classifyReminderCommand("stop reminding me"), {
    intent: "cancel",
    scope: "all",
  });
});

check("classify: 'cancel my gym reminder' is cancel-match with query", () => {
  const cmd = classifyReminderCommand("Cancel my gym reminder");
  assert.equal(cmd.intent, "cancel");
  assert.equal(cmd.intent === "cancel" && cmd.scope === "match" && cmd.query, "gym");
});

check("classify: 'stop reminding me about the form' is cancel-match", () => {
  const cmd = classifyReminderCommand("Stop reminding me about the form");
  assert.equal(cmd.intent === "cancel" && cmd.scope === "match" && cmd.query, "form");
});

check("classify: ordinary message is none", () => {
  assert.equal(classifyReminderCommand("What's the weather like?").intent, "none");
  assert.equal(classifyReminderCommand("Plan a quick dinner for me").intent, "none");
});

check("classify: memory phrasing is NOT a reminder (none)", () => {
  // Memory commands are handled upstream; they must not look like reminders.
  assert.equal(classifyReminderCommand("Remember I prefer concise replies").intent, "none");
  assert.equal(classifyReminderCommand("Forget my gym note").intent, "none");
});

// --- Date/time parsing ---------------------------------------------------

check("parse: 'in 10 minutes' → +10min, no recurrence", () => {
  const { parse } = extractTime("in 10 minutes to call Rob", NOW, TZ);
  assert.ok(parse.ok);
  if (parse.ok) {
    assert.equal(parse.dueAt.getTime(), NOW.getTime() + 10 * 60_000);
    assert.equal(parse.recurrenceRule, null);
    assert.equal(parse.humanWhen, "in 10 minutes");
  }
});

check("parse: 'in 2 hours' → +2h", () => {
  const { parse } = extractTime("in 2 hours", NOW, TZ);
  assert.ok(parse.ok);
  if (parse.ok) assert.equal(parse.dueAt.getTime(), NOW.getTime() + 2 * 3_600_000);
});

check("parse: 'tomorrow at 7pm' → next day 19:00 local", () => {
  const { parse } = extractTime("go gym tomorrow at 7pm", NOW, TZ);
  assert.ok(parse.ok);
  if (parse.ok) {
    assert.equal(parse.recurrenceRule, null);
    // 2026-07-16 19:00 America/New_York (UTC-4) === 2026-07-16T23:00:00Z
    assert.equal(parse.dueAt.toISOString(), "2026-07-16T23:00:00.000Z");
    assert.equal(parse.humanWhen, "tomorrow at 7:00 PM");
  }
});

check("parse: 'today at 6pm' → same day 18:00 local", () => {
  const { parse } = extractTime("submit the form today at 6pm", NOW, TZ);
  assert.ok(parse.ok);
  // 2026-07-15 18:00 EDT === 22:00Z (after 08:00 local now, so valid)
  if (parse.ok) assert.equal(parse.dueAt.toISOString(), "2026-07-15T22:00:00.000Z");
});

check("parse: 'tonight' → same day 20:00 local", () => {
  const { parse } = extractTime("submit the form tonight", NOW, TZ);
  assert.ok(parse.ok);
  if (parse.ok) {
    assert.equal(parse.dueAt.toISOString(), "2026-07-16T00:00:00.000Z"); // 20:00 EDT
    assert.equal(parse.humanWhen, "tonight at 8:00 PM");
  }
});

check("parse: 'every Monday at 9am' → weekly, next Monday 09:00 local", () => {
  const { parse } = extractTime("plan my week every Monday at 9am", NOW, TZ);
  assert.ok(parse.ok);
  if (parse.ok) {
    assert.equal(parse.recurrenceRule, "weekly");
    // NOW is Wed 2026-07-15; next Monday is 2026-07-20 09:00 EDT === 13:00Z.
    assert.equal(parse.dueAt.toISOString(), "2026-07-20T13:00:00.000Z");
    assert.equal(parse.humanWhen, "every Monday at 9:00 AM");
  }
});

check("parse: 'every day at 8am' → daily", () => {
  const { parse } = extractTime("every day at 8am", NOW, TZ);
  assert.ok(parse.ok);
  if (parse.ok) {
    assert.equal(parse.recurrenceRule, "daily");
    // 08:00 EDT today === 12:00Z === NOW, which is not > now, so it rolls to tomorrow.
    assert.equal(parse.dueAt.toISOString(), "2026-07-16T12:00:00.000Z");
    assert.equal(parse.humanWhen, "every day at 8:00 AM");
  }
});

check("parse: too-frequent recurrence is rejected", () => {
  const a = extractTime("every minute", NOW, TZ);
  assert.equal(a.parse.ok, false);
  if (!a.parse.ok) assert.equal(a.parse.reason, "too_frequent");
  const b = extractTime("every 5 minutes", NOW, TZ);
  assert.equal(b.parse.ok, false);
  const c = extractTime("every hour", NOW, TZ);
  assert.equal(c.parse.ok, false);
});

check("parse: no time phrase → needs_time", () => {
  const { parse } = extractTime("call Rob", NOW, TZ);
  assert.equal(parse.ok, false);
  if (!parse.ok) assert.equal(parse.reason, "needs_time");
});

check("parse: UTC fallback when no timezone is set", () => {
  const { parse } = extractTime("tomorrow at 7pm", NOW, undefined);
  assert.ok(parse.ok);
  // 2026-07-16 19:00 UTC (no tz) === 19:00Z
  if (parse.ok) assert.equal(parse.dueAt.toISOString(), "2026-07-16T19:00:00.000Z");
});

// --- parseCreate (title + time together) ---------------------------------

check("parseCreate: 'to go gym tomorrow at 7pm' → title 'go gym'", () => {
  const r = parseCreate("to go gym tomorrow at 7pm", NOW, TZ);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.title, "go gym");
    assert.equal(r.recurrenceRule, null);
  }
});

check("parseCreate: 'in 30 minutes to call Rob' → title 'call Rob'", () => {
  const r = parseCreate("in 30 minutes to call Rob", NOW, TZ);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.title, "call Rob");
});

check("parseCreate: 'plan my week every Monday at 9am' → title 'plan my week'", () => {
  const r = parseCreate("plan my week every Monday at 9am", NOW, TZ);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.title, "plan my week");
    assert.equal(r.recurrenceRule, "weekly");
  }
});

check("parseCreate: 'to call Rob' (no time) → needs_time", () => {
  const r = parseCreate("to call Rob", NOW, TZ);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "needs_time");
});

check("parseCreate: time but no task → needs_task", () => {
  const r = parseCreate("tomorrow at 7pm", NOW, TZ);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "needs_task");
});

// --- Title cleaning ------------------------------------------------------

check("cleanReminderTitle strips leading joiners and caps", () => {
  assert.equal(cleanReminderTitle("to go gym"), "go gym");
  assert.equal(cleanReminderTitle("about the form"), "the form");
  assert.equal(cleanReminderTitle("  submit the report please"), "submit the report");
  assert.equal(cleanReminderTitle(""), null);
});

// --- Matching ------------------------------------------------------------

check("reminderMatchesQuery matches on overlapping keywords", () => {
  assert.equal(reminderMatchesQuery("go to the gym", "gym"), true);
  assert.equal(reminderMatchesQuery("submit the form", "form"), true);
  assert.equal(reminderMatchesQuery("go to the gym", "dentist"), false);
  assert.equal(reminderMatchesQuery("go to the gym", ""), false);
});

// --- Phrasing ------------------------------------------------------------

check("createConfirmation reads naturally", () => {
  assert.equal(
    createConfirmation("tomorrow at 7:00 PM", "go gym"),
    "Got it — I’ll remind you tomorrow at 7:00 PM: go gym.",
  );
});

check("formatReminderList: empty → friendly empty state", () => {
  assert.equal(formatReminderList([]), REMINDER_REPLIES.listEmpty);
});

check("formatReminderList: numbers each active reminder", () => {
  const views: ReminderView[] = [
    {
      id: "1",
      title: "go gym",
      body: null,
      status: "scheduled",
      dueAt: "2026-07-16T23:00:00.000Z",
      nextRunAt: "2026-07-16T23:00:00.000Z",
      recurrenceRule: null,
      timezone: TZ,
      createdAt: NOW.toISOString(),
    },
    {
      id: "2",
      title: "plan my week",
      body: null,
      status: "scheduled",
      dueAt: "2026-07-20T13:00:00.000Z",
      nextRunAt: "2026-07-20T13:00:00.000Z",
      recurrenceRule: "weekly",
      timezone: TZ,
      createdAt: NOW.toISOString(),
    },
  ];
  const out = formatReminderList(views);
  assert.ok(out.startsWith("Your active reminders:"));
  assert.ok(out.includes("1. go gym — Jul 16 at 7:00 PM"));
  assert.ok(out.includes("2. plan my week — every Monday at 9:00 AM"));
});

check("formatReminderWhen: daily reads as 'every day at …'", () => {
  const view: ReminderView = {
    id: "3",
    title: "meditate",
    body: null,
    status: "scheduled",
    dueAt: "2026-07-16T12:00:00.000Z",
    nextRunAt: "2026-07-16T12:00:00.000Z",
    recurrenceRule: "daily",
    timezone: TZ,
    createdAt: NOW.toISOString(),
  };
  assert.equal(formatReminderWhen(view), "every day at 8:00 AM");
});

// --- Recurrence advancement ----------------------------------------------

check("computeNextRun: daily advances one day past now", () => {
  const current = new Date("2026-07-16T12:00:00Z");
  const next = computeNextRun(current, "daily", new Date("2026-07-16T12:00:01Z"));
  assert.equal(next.toISOString(), "2026-07-17T12:00:00.000Z");
});

check("computeNextRun: weekly advances one week and skips missed runs", () => {
  const current = new Date("2026-07-20T13:00:00Z");
  // If the worker was down for two weeks, next run must still be in the future.
  const next = computeNextRun(current, "weekly", new Date("2026-08-01T00:00:00Z"));
  assert.equal(next.toISOString(), "2026-08-03T13:00:00.000Z");
});

// --- Clock formatting ----------------------------------------------------

check("formatClock: 12-hour AM/PM", () => {
  assert.equal(formatClock(19, 0), "7:00 PM");
  assert.equal(formatClock(9, 5), "9:05 AM");
  assert.equal(formatClock(0, 0), "12:00 AM");
  assert.equal(formatClock(12, 30), "12:30 PM");
});

console.log(`\n${passed} reminder checks passed.`);
