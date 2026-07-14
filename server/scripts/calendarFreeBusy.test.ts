import assert from "node:assert/strict";

import {
  DEFAULT_WORKING_WINDOW,
  computeFreeWindows,
  conflictsIn,
  isIntervalFree,
  mergeIntervals,
  queryFreeBusy,
  workingWindowsIn,
  type TimeInterval,
} from "../src/integrations/providers/googleCalendar/freeBusy";
import {
  CALENDAR_READ_REPLIES,
  handleCalendarAvailability,
  looksLikeAvailabilityQuestion,
  rangeFromIntent,
  windowFromIntent,
} from "../src/integrations/providers/googleCalendar/calendarReads";
import { GoogleCalendarError } from "../src/integrations/providers/googleCalendar/client";
import type { CalendarReadIntent } from "../src/integrations/providers/googleCalendar/calendarIntentExtract";
import type { CalendarReadDeps } from "../src/integrations/providers/googleCalendar/calendarReads";

/**
 * Offline tests for AVAILABILITY / FREE-BUSY (Section 18). NO database, NO real
 * Google, NO Anthropic — pure functions and injected fakes only.
 *
 * The property this file defends: Hula never fabricates availability. "You're
 * free" is only ever said on the back of a SUCCESSFUL free/busy query. A query
 * that failed, or a calendar Google could not read, produces "I couldn't check"
 * — never silence and never a guess.
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
// 2026-07-13T12:00:00Z == 08:00 Mon in America/New_York (EDT, UTC-4).
const NOW = new Date("2026-07-13T12:00:00Z");

function iv(start: string, end: string): TimeInterval {
  return { start, end };
}

// --- Interval merging ----------------------------------------------------

check("merge: overlapping busy blocks become one", () => {
  // 2:00–3:00 and 2:30–4:00 is ONE busy block. Without merging, the gap-finder
  // would emit a phantom "free" window between two overlapping meetings.
  const merged = mergeIntervals([
    iv("2026-07-13T14:00:00Z", "2026-07-13T15:00:00Z"),
    iv("2026-07-13T14:30:00Z", "2026-07-13T16:00:00Z"),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.start, "2026-07-13T14:00:00.000Z");
  assert.equal(merged[0]!.end, "2026-07-13T16:00:00.000Z");
});

check("merge: touching blocks merge (there is no free time between them)", () => {
  const merged = mergeIntervals([
    iv("2026-07-13T14:00:00Z", "2026-07-13T15:00:00Z"),
    iv("2026-07-13T15:00:00Z", "2026-07-13T16:00:00Z"),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.end, "2026-07-13T16:00:00.000Z");
});

check("merge: disjoint blocks stay separate, and unsorted input is sorted", () => {
  const merged = mergeIntervals([
    iv("2026-07-13T17:00:00Z", "2026-07-13T18:00:00Z"),
    iv("2026-07-13T14:00:00Z", "2026-07-13T15:00:00Z"),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.start, "2026-07-13T14:00:00.000Z");
  assert.equal(merged[1]!.start, "2026-07-13T17:00:00.000Z");
});

check("merge: malformed and zero-length intervals are dropped", () => {
  assert.deepEqual(
    mergeIntervals([
      iv("nonsense", "2026-07-13T15:00:00Z"),
      iv("2026-07-13T15:00:00Z", "2026-07-13T15:00:00Z"),
      iv("2026-07-13T16:00:00Z", "2026-07-13T15:00:00Z"),
    ]),
    [],
  );
});

// --- Conflict detection --------------------------------------------------

check("free: half-open — a meeting ending at 3 does NOT clash with one at 3", () => {
  const busy = [iv("2026-07-13T14:00:00Z", "2026-07-13T15:00:00Z")];
  assert.equal(isIntervalFree(iv("2026-07-13T15:00:00Z", "2026-07-13T16:00:00Z"), busy), true);
  assert.equal(isIntervalFree(iv("2026-07-13T13:00:00Z", "2026-07-13T14:00:00Z"), busy), true);
});

check("free: any real overlap is a clash", () => {
  const busy = [iv("2026-07-13T14:00:00Z", "2026-07-13T15:00:00Z")];
  assert.equal(isIntervalFree(iv("2026-07-13T14:30:00Z", "2026-07-13T15:30:00Z"), busy), false);
  assert.equal(isIntervalFree(iv("2026-07-13T13:30:00Z", "2026-07-13T14:30:00Z"), busy), false);
  // Fully contained inside a busy block.
  assert.equal(isIntervalFree(iv("2026-07-13T14:10:00Z", "2026-07-13T14:20:00Z"), busy), false);
});

check("conflictsIn: names the blocks that actually overlap", () => {
  const busy = [
    iv("2026-07-13T14:00:00Z", "2026-07-13T15:00:00Z"),
    iv("2026-07-13T18:00:00Z", "2026-07-13T19:00:00Z"),
  ];
  const clashes = conflictsIn(iv("2026-07-13T14:30:00Z", "2026-07-13T16:00:00Z"), busy);
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0]!.start, "2026-07-13T14:00:00Z");
});

// --- Working windows + timezone/DST --------------------------------------

check("window: a bounded working window per local day, in the user's timezone", () => {
  // Mon 13 Jul 2026, 9am–5pm EDT == 13:00Z–21:00Z.
  const windows = workingWindowsIn(
    "2026-07-13T00:00:00Z",
    "2026-07-14T00:00:00Z",
    TZ,
    DEFAULT_WORKING_WINDOW,
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.start, "2026-07-13T13:00:00.000Z");
  assert.equal(windows[0]!.end, "2026-07-13T21:00:00.000Z");
});

check("window: DST boundary — 9am stays 9am LOCAL across the spring-forward", () => {
  // US DST 2026 begins Sun 8 Mar. Sat 7 Mar is EST (UTC-5): 9am == 14:00Z.
  // Mon 9 Mar is EDT (UTC-4): 9am == 13:00Z. A naive +24h walk would drift.
  const windows = workingWindowsIn(
    "2026-03-07T00:00:00Z",
    "2026-03-10T00:00:00Z",
    TZ,
    DEFAULT_WORKING_WINDOW,
  );
  const starts = windows.map((w) => w.start);
  assert.ok(starts.includes("2026-03-07T14:00:00.000Z"), "Sat 7 Mar 9am EST == 14:00Z");
  assert.ok(starts.includes("2026-03-09T13:00:00.000Z"), "Mon 9 Mar 9am EDT == 13:00Z");
});

check("window: DST boundary — the autumn fall-back keeps 9am local", () => {
  // US DST 2026 ends Sun 1 Nov. Fri 30 Oct is EDT (9am == 13:00Z);
  // Mon 2 Nov is EST (9am == 14:00Z).
  const windows = workingWindowsIn(
    "2026-10-30T00:00:00Z",
    "2026-11-03T00:00:00Z",
    TZ,
    DEFAULT_WORKING_WINDOW,
  );
  const starts = windows.map((w) => w.start);
  assert.ok(starts.includes("2026-10-30T13:00:00.000Z"), "Fri 30 Oct 9am EDT == 13:00Z");
  assert.ok(starts.includes("2026-11-02T14:00:00.000Z"), "Mon 2 Nov 9am EST == 14:00Z");
});

check("window: a narrowed window ('afternoon') is honoured", () => {
  const windows = workingWindowsIn(
    "2026-07-13T00:00:00Z",
    "2026-07-14T00:00:00Z",
    TZ,
    { startHour: 12, endHour: 17 },
  );
  assert.equal(windows[0]!.start, "2026-07-13T16:00:00.000Z"); // 12:00 EDT
  assert.equal(windows[0]!.end, "2026-07-13T21:00:00.000Z"); // 17:00 EDT
});

// --- Free-window computation ---------------------------------------------

check("free windows: busy blocks are subtracted from the working window", () => {
  // Mon 9–5 EDT, busy 10–11 and 14–15 local.
  const free = computeFreeWindows({
    from: "2026-07-13T00:00:00Z",
    to: "2026-07-14T00:00:00Z",
    busy: [
      iv("2026-07-13T14:00:00Z", "2026-07-13T15:00:00Z"), // 10–11 EDT
      iv("2026-07-13T18:00:00Z", "2026-07-13T19:00:00Z"), // 14–15 EDT
    ],
    timeZone: TZ,
    minMinutes: 30,
    notBefore: "2026-07-13T00:00:00Z",
  });
  assert.deepEqual(
    free.map((w) => [w.start, w.end]),
    [
      ["2026-07-13T13:00:00.000Z", "2026-07-13T14:00:00.000Z"], // 9–10
      ["2026-07-13T15:00:00.000Z", "2026-07-13T18:00:00.000Z"], // 11–14
      ["2026-07-13T19:00:00.000Z", "2026-07-13T21:00:00.000Z"], // 15–17
    ],
  );
});

check("free windows: gaps shorter than the minimum are not offered", () => {
  // A 30-minute gap cannot host the "free hour" the user asked for.
  const free = computeFreeWindows({
    from: "2026-07-13T00:00:00Z",
    to: "2026-07-14T00:00:00Z",
    busy: [
      iv("2026-07-13T13:00:00Z", "2026-07-13T15:00:00Z"), // 9–11
      iv("2026-07-13T15:30:00Z", "2026-07-13T21:00:00Z"), // 11:30–17
    ],
    timeZone: TZ,
    minMinutes: 60,
    notBefore: "2026-07-13T00:00:00Z",
  });
  assert.equal(free.length, 0, "a 30-minute gap must not be offered as a free hour");
});

check("free windows: a fully free day returns the whole working window", () => {
  const free = computeFreeWindows({
    from: "2026-07-13T00:00:00Z",
    to: "2026-07-14T00:00:00Z",
    busy: [],
    timeZone: TZ,
    minMinutes: 60,
    notBefore: "2026-07-13T00:00:00Z",
  });
  assert.equal(free.length, 1);
  assert.equal(free[0]!.start, "2026-07-13T13:00:00.000Z");
  assert.equal(free[0]!.end, "2026-07-13T21:00:00.000Z");
});

check("free windows: a slot already in the past is never offered", () => {
  // `notBefore` = 14:00Z (10am EDT) — the 9–10 slot has gone.
  const free = computeFreeWindows({
    from: "2026-07-13T00:00:00Z",
    to: "2026-07-14T00:00:00Z",
    busy: [],
    timeZone: TZ,
    minMinutes: 30,
    notBefore: "2026-07-13T14:00:00Z",
  });
  assert.equal(free[0]!.start, "2026-07-13T14:00:00.000Z");
});

check("free windows: overlapping busy blocks never produce a phantom gap", () => {
  const free = computeFreeWindows({
    from: "2026-07-13T00:00:00Z",
    to: "2026-07-14T00:00:00Z",
    busy: [
      iv("2026-07-13T13:00:00Z", "2026-07-13T16:00:00Z"),
      iv("2026-07-13T14:00:00Z", "2026-07-13T15:00:00Z"), // fully inside
    ],
    timeZone: TZ,
    minMinutes: 30,
    notBefore: "2026-07-13T00:00:00Z",
  });
  assert.deepEqual(free.map((w) => w.start), ["2026-07-13T16:00:00.000Z"]);
});

// --- The freeBusy provider call -----------------------------------------

/** A fake connected-connection + fetch harness is overkill here; we fake at the
 *  handler seam instead. These tests cover the RESPONSE parsing rules. */
check("intent: window and range derive correctly from a read intent", () => {
  const intent: CalendarReadIntent = {
    intent: "availability",
    dateFrom: "2026-07-17",
    dateTo: "2026-07-17",
    query: null,
    attendee: null,
    location: null,
    checkTime: null,
    durationMinutes: 60,
    windowStartHour: 12,
    windowEndHour: 17,
  };
  assert.deepEqual(windowFromIntent(intent), { startHour: 12, endHour: 17 });
  const range = rangeFromIntent(intent, NOW, TZ);
  assert.equal(range.timeMin, "2026-07-17T04:00:00.000Z"); // local midnight EDT
  assert.equal(range.timeMax, "2026-07-18T04:00:00.000Z"); // exclusive next midnight
});

check("intent: an invalid window falls back to the bounded default", () => {
  const intent: CalendarReadIntent = {
    intent: "availability",
    dateFrom: null,
    dateTo: null,
    query: null,
    attendee: null,
    location: null,
    checkTime: null,
    durationMinutes: null,
    windowStartHour: 18,
    windowEndHour: 9, // end <= start is not a window
  };
  assert.deepEqual(windowFromIntent(intent), DEFAULT_WORKING_WINDOW);
});

// --- Prefilter -----------------------------------------------------------

check("prefilter: availability questions are recognised", () => {
  for (const t of [
    "Am I free tomorrow at 3?",
    "am i busy friday",
    "When am I free Friday afternoon?",
    "Find me a free hour next week",
    "Do I have a conflict at 10?",
    "any free slots thursday?",
  ]) {
    assert.equal(looksLikeAvailabilityQuestion(t), true, t);
  }
});

check("prefilter: ordinary messages are NOT availability questions", () => {
  for (const t of [
    "what's on my calendar today",
    "schedule gym tomorrow at 7pm",
    "remind me to call mum",
    "hey",
    "",
  ]) {
    assert.equal(looksLikeAvailabilityQuestion(t), false, t);
  }
});

// --- The availability handler --------------------------------------------

function availDeps(over: Partial<CalendarReadDeps> = {}): CalendarReadDeps {
  return {
    getTimezone: async () => TZ,
    now: NOW,
    contextStore: { create: async () => ({ id: "sel" }), listRecent: async () => [] },
    ...over,
  };
}

function fixedIntent(over: Partial<CalendarReadIntent>): CalendarReadDeps["extract"] {
  return async () => ({
    intent: "availability",
    dateFrom: null,
    dateTo: null,
    query: null,
    attendee: null,
    location: null,
    checkTime: null,
    durationMinutes: null,
    windowStartHour: null,
    windowEndHour: null,
    ...over,
  });
}

asyncCheck("availability: 'am I free at 3?' answers YES from real free/busy", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "am I free tomorrow at 3?",
    availDeps({
      extract: fixedIntent({ dateFrom: "2026-07-14", dateTo: "2026-07-14", checkTime: "15:00" }),
      freeBusy: async () => [],
    }),
  );
  assert.equal(r.handled, true);
  assert.match(r.reply!, /free at 3:00\s?PM/i);
});

asyncCheck("availability: 'am I free at 3?' answers NO and names the clash", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "am I free tomorrow at 3?",
    availDeps({
      extract: fixedIntent({ dateFrom: "2026-07-14", dateTo: "2026-07-14", checkTime: "15:00" }),
      // 15:00 EDT == 19:00Z.
      freeBusy: async () => [iv("2026-07-14T19:00:00Z", "2026-07-14T20:00:00Z")],
    }),
  );
  assert.match(r.reply!, /^No —/);
  assert.match(r.reply!, /3:00\s?PM/i);
});

asyncCheck("availability: 'when am I free Friday afternoon?' lists real windows", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "when am I free Friday afternoon?",
    availDeps({
      extract: fixedIntent({
        dateFrom: "2026-07-17",
        dateTo: "2026-07-17",
        windowStartHour: 12,
        windowEndHour: 17,
        durationMinutes: 60,
      }),
      // Busy 13:00–14:00 EDT (17:00–18:00Z).
      freeBusy: async () => [iv("2026-07-17T17:00:00Z", "2026-07-17T18:00:00Z")],
    }),
  );
  assert.match(r.reply!, /Here’s when you’re free/);
  assert.match(r.reply!, /12:00\s?PM–1:00\s?PM/i);
  assert.match(r.reply!, /2:00\s?PM–5:00\s?PM/i);
});

asyncCheck("availability: a fully-booked window says so, rather than inventing a slot", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "find me a free hour friday",
    availDeps({
      extract: fixedIntent({
        dateFrom: "2026-07-17",
        dateTo: "2026-07-17",
        durationMinutes: 60,
      }),
      freeBusy: async () => [iv("2026-07-17T13:00:00Z", "2026-07-17T21:00:00Z")],
    }),
  );
  assert.match(r.reply!, /couldn’t find a free 60-minute slot/i);
});

asyncCheck("availability: a free/busy FAILURE never becomes 'you're free'", async () => {
  // The single most important test in this file. An unreachable Google must
  // produce "I couldn't check", never a fabricated availability answer.
  const r = await handleCalendarAvailability(
    "u",
    "am I free tomorrow at 3?",
    availDeps({
      extract: fixedIntent({ dateFrom: "2026-07-14", dateTo: "2026-07-14", checkTime: "15:00" }),
      freeBusy: async () => {
        throw new GoogleCalendarError("provider_unavailable", "boom", 503);
      },
    }),
  );
  assert.equal(r.handled, true);
  assert.equal(r.reply, CALENDAR_READ_REPLIES.availabilityUnavailable);
  assert.ok(!/free/i.test(r.reply!.replace(/availability/gi, "")), "must not claim freedom");
});

asyncCheck("availability: a not-connected calendar is reported honestly", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "am I free tomorrow at 3?",
    availDeps({
      extract: fixedIntent({ dateFrom: "2026-07-14", dateTo: "2026-07-14", checkTime: "15:00" }),
      freeBusy: async () => {
        throw new GoogleCalendarError("not_connected", "no");
      },
    }),
  );
  assert.equal(r.reply, CALENDAR_READ_REPLIES.notConnected);
});

asyncCheck("availability: insufficient scope asks for a reconnect", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "am I free tomorrow at 3?",
    availDeps({
      extract: fixedIntent({ dateFrom: "2026-07-14", dateTo: "2026-07-14", checkTime: "15:00" }),
      freeBusy: async () => {
        throw new GoogleCalendarError("insufficient_scope", "no", 403);
      },
    }),
  );
  assert.equal(r.reply, CALENDAR_READ_REPLIES.reconnect);
});

asyncCheck("availability: a non-availability message falls through untouched", async () => {
  const r = await handleCalendarAvailability("u", "what's for lunch", availDeps());
  assert.equal(r.handled, false);
});

asyncCheck("availability: the model declining leaves the message to others", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "am I free tomorrow at 3?",
    availDeps({ extract: async () => null }),
  );
  assert.equal(r.handled, false);
});

asyncCheck("availability: no reply leaks token material", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "am I free tomorrow at 3?",
    availDeps({
      extract: fixedIntent({ dateFrom: "2026-07-14", dateTo: "2026-07-14", checkTime: "15:00" }),
      freeBusy: async () => [],
    }),
  );
  assert.ok(!/Bearer|ya29\.|access_token|refresh_token/i.test(JSON.stringify(r)));
});

// `queryFreeBusy` is exported and exercised against fakes in the provider tests;
// referenced here so an accidental removal of the export breaks this suite too.
check("freeBusy: the provider query helper is exported", () => {
  assert.equal(typeof queryFreeBusy, "function");
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} Calendar free/busy (Section 18) tests passed.`);
}

void run().catch((err) => {
  console.error("Calendar free/busy tests failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
