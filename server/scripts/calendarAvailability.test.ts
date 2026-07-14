import assert from "node:assert/strict";

import {
  dayLabel,
  dayPartLabel,
  describeQueriedInterval,
  handleCalendarAvailability,
  inferAvailabilityKind,
  resolveCheckTarget,
  subtractBusy,
  type CalendarReadDeps,
} from "../src/integrations/providers/googleCalendar/calendarReads";
import type { CalendarReadIntent } from "../src/integrations/providers/googleCalendar/calendarIntentExtract";
import type { TimeInterval } from "../src/integrations/providers/googleCalendar/freeBusy";
import type { NormalizedCalendarEvent } from "../src/integrations/providers/googleCalendar/types";

/**
 * Offline tests for AVAILABILITY SEMANTICS (Section 18 real-device fix). NO
 * database, NO real Google, NO Anthropic.
 *
 * THE REAL FAILURE. Friday was completely empty. The user asked "Am I free
 * Friday afternoon?" and Hula replied:
 *
 *   Here's when you're free:
 *   • 12:00 PM–5:00 PM
 *
 * Every number there was true, and the answer was still wrong. 12–5 was HULA'S
 * OWN internal query window for "afternoon", echoed back as though it were the
 * user's availability — so an entirely free Friday read as "you're only free
 * 12–5". And it answered a yes/no question with a slot list.
 *
 * The rule these tests pin: internal daypart bounds may shape the QUERY, but
 * must never be presented as the user's availability; and the answer must match
 * the question that was asked.
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
// Mon 13 Jul 2026 08:00 EDT. Friday is 2026-07-17.
const NOW = new Date("2026-07-13T12:00:00Z");
const FRIDAY = "2026-07-17";

function iv(start: string, end: string): TimeInterval {
  return { start, end };
}

function ev(over: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent {
  return {
    id: "e1",
    calendarId: "primary",
    summary: "Lunch",
    location: null,
    description: null,
    start: "2026-07-17T17:00:00.000Z",
    end: "2026-07-17T18:00:00.000Z",
    allDay: false,
    status: "confirmed",
    htmlLink: null,
    attendeeCount: null,
    attendees: [],
    organizerEmail: null,
    timeZone: null,
    conference: null,
    recurringEventId: null,
    isRecurringMaster: false,
    source: "google_calendar",
    ...over,
  };
}

function intent(over: Partial<CalendarReadIntent>): CalendarReadIntent {
  return {
    intent: "availability",
    availabilityKind: null,
    wholeDay: null,
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
  };
}

function deps(over: Partial<CalendarReadDeps> = {}): CalendarReadDeps {
  return {
    getTimezone: async () => TZ,
    now: NOW,
    contextStore: { create: async () => ({ id: "sel" }), listRecent: async () => [] },
    find: async () => [],
    ...over,
  };
}

function fixedIntent(over: Partial<CalendarReadIntent>): CalendarReadDeps["extract"] {
  return async () => intent(over);
}

// Friday afternoon in EDT (UTC-4): 12:00 -> 16:00Z, 17:00 -> 21:00Z.
const FRI_NOON_Z = "2026-07-17T16:00:00.000Z";
const FRI_5PM_Z = "2026-07-17T21:00:00.000Z";

// ==========================================================================
// Question form
// ==========================================================================

check("form: 'Am I free ...?' is a yes/no CHECK, not a slot search", () => {
  assert.equal(inferAvailabilityKind("Am I free Friday afternoon?"), "check");
  assert.equal(inferAvailabilityKind("am i busy friday"), "check");
  assert.equal(inferAvailabilityKind("Do I have a conflict at 10?"), "check");
  assert.equal(inferAvailabilityKind("Am I free all day Friday?"), "check");
});

check("form: 'When am I free ...?' / 'Find me ...' is a FIND", () => {
  assert.equal(inferAvailabilityKind("When am I free Friday afternoon?"), "find");
  assert.equal(inferAvailabilityKind("Find me a free hour next week"), "find");
  assert.equal(inferAvailabilityKind("show me my free slots thursday"), "find");
});

// ==========================================================================
// Labelling — general, not Friday/afternoon special cases
// ==========================================================================

check("label: dayparts are derived from HOURS, for any daypart", () => {
  assert.equal(dayPartLabel({ startHour: 9, endHour: 12 }, TZ, FRIDAY), "morning");
  assert.equal(dayPartLabel({ startHour: 12, endHour: 17 }, TZ, FRIDAY), "afternoon");
  assert.equal(dayPartLabel({ startHour: 17, endHour: 21 }, TZ, FRIDAY), "evening");
});

check("label: a non-daypart window gets real hours, not an invented name", () => {
  const label = dayPartLabel({ startHour: 14, endHour: 16 }, TZ, FRIDAY);
  assert.match(label, /between 2:00\s?PM and 4:00\s?PM/i);
});

check("label: the day name is derived from the DATE (no weekday special-casing)", () => {
  assert.equal(dayLabel(FRIDAY, NOW, TZ), "Friday");
  assert.equal(dayLabel("2026-07-21", NOW, TZ), "Tuesday");
  // Relative days read naturally.
  assert.equal(dayLabel("2026-07-13", NOW, TZ), "today");
  assert.equal(dayLabel("2026-07-14", NOW, TZ), "tomorrow");
});

check("label: the queried interval is described as the user framed it", () => {
  assert.equal(
    describeQueriedInterval({
      date: FRIDAY,
      window: { startHour: 12, endHour: 17 },
      wholeDay: false,
      now: NOW,
      tz: TZ,
    }),
    "Friday afternoon",
  );
  assert.equal(
    describeQueriedInterval({ date: FRIDAY, window: null, wholeDay: true, now: NOW, tz: TZ }),
    "all day Friday",
  );
});

// ==========================================================================
// Target resolution
// ==========================================================================

check("target: a daypart check queries exactly the daypart, in the user's tz", () => {
  const t = resolveCheckTarget(
    intent({ dateFrom: FRIDAY, dateTo: FRIDAY, windowStartHour: 12, windowEndHour: 17 }),
    NOW,
    TZ,
  );
  assert.ok(t);
  assert.equal(t.interval.start, FRI_NOON_Z);
  assert.equal(t.interval.end, FRI_5PM_Z);
  assert.equal(t.isWholeDay, false);
  assert.equal(t.label, "Friday afternoon");
});

check("target: 'all day Friday' queries the WHOLE day, not the 9-5 working window", () => {
  // The working window exists to OFFER slots. It must never narrow a yes/no
  // question the user scoped themselves.
  const t = resolveCheckTarget(intent({ dateFrom: FRIDAY, dateTo: FRIDAY, wholeDay: true }), NOW, TZ);
  assert.ok(t);
  assert.equal(t.interval.start, "2026-07-17T04:00:00.000Z"); // local midnight
  assert.equal(t.interval.end, "2026-07-18T04:00:00.000Z"); // next local midnight
  assert.equal(t.isWholeDay, true);
});

check("target: no date means we ask, rather than guess a day", () => {
  assert.equal(resolveCheckTarget(intent({}), NOW, TZ), null);
});

// ==========================================================================
// Gap subtraction (bounded to the asked-about interval)
// ==========================================================================

check("gaps: subtraction stays inside the requested interval", () => {
  // Busy 1–2pm EDT (17:00–18:00Z) inside a 12–5 afternoon.
  const gaps = subtractBusy(iv(FRI_NOON_Z, FRI_5PM_Z), [
    iv("2026-07-17T17:00:00Z", "2026-07-17T18:00:00Z"),
  ]);
  assert.deepEqual(
    gaps.map((g) => [g.start, g.end]),
    [
      [FRI_NOON_Z, "2026-07-17T17:00:00.000Z"],
      ["2026-07-17T18:00:00.000Z", FRI_5PM_Z],
    ],
  );
});

check("gaps: a fully free interval subtracts to itself", () => {
  assert.deepEqual(subtractBusy(iv(FRI_NOON_Z, FRI_5PM_Z), []), [
    { start: FRI_NOON_Z, end: FRI_5PM_Z },
  ]);
});

check("gaps: a fully busy interval has none", () => {
  assert.deepEqual(subtractBusy(iv(FRI_NOON_Z, FRI_5PM_Z), [iv(FRI_NOON_Z, FRI_5PM_Z)]), []);
});

// ==========================================================================
// 1. Empty afternoon + "Am I free Friday afternoon?"  (the reported bug)
// ==========================================================================

asyncCheck("REGRESSION: an empty Friday answers YES, not a 12–5 slot list", async () => {
  let queried: { timeMin: string; timeMax: string }[] = [];
  const r = await handleCalendarAvailability(
    "u",
    "Am I free Friday afternoon?",
    deps({
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        windowStartHour: 12,
        windowEndHour: 17,
        availabilityKind: "check",
      }),
      freeBusy: async (_u, o) => {
        queried.push({ timeMin: o.timeMin, timeMax: o.timeMax });
        return [];
      },
    }),
  );

  // The exact string from the real transcript must be gone.
  assert.ok(
    !/Here’s when you’re free/.test(r.reply!),
    "a yes/no question must not be answered with a slot list",
  );
  assert.ok(
    !/12:00\s?PM–5:00\s?PM/i.test(r.reply!),
    "internal daypart bounds must never be presented as the user's availability",
  );
  assert.match(r.reply!, /^Yes — you’re free Friday afternoon\./);

  // The afternoon was queried; a second query verified the whole day.
  assert.equal(queried[0]!.timeMin, FRI_NOON_Z);
  assert.equal(queried[0]!.timeMax, FRI_5PM_Z);
});

asyncCheck("whole-day claim is made ONLY after separately verifying the whole day", async () => {
  const queried: { timeMin: string; timeMax: string }[] = [];
  const r = await handleCalendarAvailability(
    "u",
    "Am I free Friday afternoon?",
    deps({
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        windowStartHour: 12,
        windowEndHour: 17,
        availabilityKind: "check",
      }),
      freeBusy: async (_u, o) => {
        queried.push({ timeMin: o.timeMin, timeMax: o.timeMax });
        return [];
      },
    }),
  );
  assert.match(r.reply!, /Your calendar is clear all day\./);
  // Two DISTINCT queries: the afternoon, then the whole day.
  assert.equal(queried.length, 2);
  assert.equal(queried[1]!.timeMin, "2026-07-17T04:00:00.000Z");
  assert.equal(queried[1]!.timeMax, "2026-07-18T04:00:00.000Z");
});

// ==========================================================================
// 3. Events outside the afternoon only
// ==========================================================================

asyncCheck("a morning meeting does NOT make the afternoon busy, and blocks the all-day claim", async () => {
  // The precise honesty case: free in the asked-about window, but the day is not
  // clear — so "clear all day" must NOT be said.
  const r = await handleCalendarAvailability(
    "u",
    "Am I free Friday afternoon?",
    deps({
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        windowStartHour: 12,
        windowEndHour: 17,
        availabilityKind: "check",
      }),
      freeBusy: async (_u, o) => {
        // A 9–10am EDT meeting (13:00–14:00Z): inside the whole-day query only.
        const morning = iv("2026-07-17T13:00:00Z", "2026-07-17T14:00:00Z");
        return o.timeMin === FRI_NOON_Z ? [] : [morning];
      },
    }),
  );
  assert.match(r.reply!, /^Yes — you’re free Friday afternoon\./);
  assert.ok(
    !/clear all day/i.test(r.reply!),
    "an afternoon query must never be stretched into a whole-day claim",
  );
});

// ==========================================================================
// 2. One conflict inside the afternoon
// ==========================================================================

asyncCheck("a conflict inside the afternoon: not fully free, with the REAL event named", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "Am I free Friday afternoon?",
    deps({
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        windowStartHour: 12,
        windowEndHour: 17,
        availabilityKind: "check",
      }),
      // Busy 1–2pm EDT.
      freeBusy: async () => [iv("2026-07-17T17:00:00Z", "2026-07-17T18:00:00Z")],
      find: async () => [ev({ summary: "Lunch with Adam" })],
    }),
  );
  assert.match(r.reply!, /^No — you’re not completely free Friday afternoon\./);
  assert.match(r.reply!, /Lunch with Adam/);
  // Real gaps within the asked-about interval only.
  assert.match(r.reply!, /12:00\s?PM–1:00\s?PM/i);
  assert.match(r.reply!, /2:00\s?PM–5:00\s?PM/i);
  assert.ok(!/clear all day/i.test(r.reply!));
});

asyncCheck("a conflict with no readable event falls back to REAL busy times", async () => {
  // Busy from another calendar: we must report the true busy interval rather
  // than invent an event to name.
  const r = await handleCalendarAvailability(
    "u",
    "Am I free Friday afternoon?",
    deps({
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        windowStartHour: 12,
        windowEndHour: 17,
        availabilityKind: "check",
      }),
      freeBusy: async () => [iv("2026-07-17T17:00:00Z", "2026-07-17T18:00:00Z")],
      find: async () => [],
    }),
  );
  assert.match(r.reply!, /^No — you’re not completely free Friday afternoon\./);
  assert.match(r.reply!, /You’re busy:/);
  assert.match(r.reply!, /1:00\s?PM–2:00\s?PM/i);
});

// ==========================================================================
// 4. "When am I free Friday afternoon?"
// ==========================================================================

asyncCheck("'When am I free Friday afternoon?' DOES list real intervals", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "When am I free Friday afternoon?",
    deps({
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        windowStartHour: 12,
        windowEndHour: 17,
        durationMinutes: 60,
        availabilityKind: "find",
      }),
      freeBusy: async () => [iv("2026-07-17T17:00:00Z", "2026-07-17T18:00:00Z")],
    }),
  );
  assert.match(r.reply!, /Here’s when you’re free/);
  assert.match(r.reply!, /12:00\s?PM–1:00\s?PM/i);
  assert.match(r.reply!, /2:00\s?PM–5:00\s?PM/i);
});

// ==========================================================================
// 5. "Am I free all day Friday?"
// ==========================================================================

asyncCheck("'Am I free all day Friday?' queries the FULL day and answers directly", async () => {
  const queried: { timeMin: string; timeMax: string }[] = [];
  const r = await handleCalendarAvailability(
    "u",
    "Am I free all day Friday?",
    deps({
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        wholeDay: true,
        availabilityKind: "check",
      }),
      freeBusy: async (_u, o) => {
        queried.push({ timeMin: o.timeMin, timeMax: o.timeMax });
        return [];
      },
    }),
  );
  assert.equal(queried.length, 1, "the day was asked about directly — no second query needed");
  assert.equal(queried[0]!.timeMin, "2026-07-17T04:00:00.000Z");
  assert.equal(queried[0]!.timeMax, "2026-07-18T04:00:00.000Z");
  assert.match(r.reply!, /^Yes — you’re free all day Friday\./);
});

asyncCheck("'Am I free all day Friday?' with an early meeting says no", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "Am I free all day Friday?",
    deps({
      extract: fixedIntent({ dateFrom: FRIDAY, dateTo: FRIDAY, wholeDay: true, availabilityKind: "check" }),
      freeBusy: async () => [iv("2026-07-17T13:00:00Z", "2026-07-17T14:00:00Z")],
      find: async () => [
        ev({ summary: "Standup", start: "2026-07-17T13:00:00.000Z", end: "2026-07-17T14:00:00.000Z" }),
      ],
    }),
  );
  assert.match(r.reply!, /^No — you’re not completely free all day Friday\./);
  assert.match(r.reply!, /Standup/);
});

// ==========================================================================
// 6. Morning, evening, explicit ranges
// ==========================================================================

asyncCheck("morning: an empty morning answers yes, naming the morning", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "Am I free Friday morning?",
    deps({
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        windowStartHour: 9,
        windowEndHour: 12,
        availabilityKind: "check",
      }),
      freeBusy: async () => [],
    }),
  );
  assert.match(r.reply!, /^Yes — you’re free Friday morning\./);
});

asyncCheck("evening: an empty evening answers yes, naming the evening", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "Am I free Friday evening?",
    deps({
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        windowStartHour: 17,
        windowEndHour: 21,
        availabilityKind: "check",
      }),
      freeBusy: async () => [],
    }),
  );
  assert.match(r.reply!, /^Yes — you’re free Friday evening\./);
});

asyncCheck("explicit range: 'free Friday between 2 and 4?' uses the real hours", async () => {
  const queried: { timeMin: string; timeMax: string }[] = [];
  const r = await handleCalendarAvailability(
    "u",
    "Am I free Friday between 2 and 4?",
    deps({
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        windowStartHour: 14,
        windowEndHour: 16,
        availabilityKind: "check",
      }),
      freeBusy: async (_u, o) => {
        queried.push({ timeMin: o.timeMin, timeMax: o.timeMax });
        return [];
      },
    }),
  );
  // 2pm EDT == 18:00Z, 4pm EDT == 20:00Z.
  assert.equal(queried[0]!.timeMin, "2026-07-17T18:00:00.000Z");
  assert.equal(queried[0]!.timeMax, "2026-07-17T20:00:00.000Z");
  assert.match(r.reply!, /between 2:00\s?PM and 4:00\s?PM/i);
});

asyncCheck("a specific time still answers directly yes/no", async () => {
  const free = await handleCalendarAvailability(
    "u",
    "Am I free tomorrow at 3?",
    deps({
      extract: fixedIntent({ dateFrom: "2026-07-14", dateTo: "2026-07-14", checkTime: "15:00", availabilityKind: "check" }),
      freeBusy: async () => [],
    }),
  );
  assert.match(free.reply!, /^Yes — you’re free at 3:00\s?PM\./i);

  const busy = await handleCalendarAvailability(
    "u",
    "Am I free tomorrow at 3?",
    deps({
      extract: fixedIntent({ dateFrom: "2026-07-14", dateTo: "2026-07-14", checkTime: "15:00", availabilityKind: "check" }),
      freeBusy: async () => [iv("2026-07-14T19:00:00Z", "2026-07-14T20:00:00Z")],
    }),
  );
  assert.match(busy.reply!, /^No —/);
});

asyncCheck("a check with no date asks which day, rather than guessing", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "am I free in the afternoon?",
    deps({
      extract: fixedIntent({ windowStartHour: 12, windowEndHour: 17, availabilityKind: "check" }),
      freeBusy: async () => [],
    }),
  );
  assert.match(r.reply!, /Which day should I check\?/);
});

// ==========================================================================
// 7. Timezone + DST boundaries
// ==========================================================================

asyncCheck("timezone: the afternoon is the USER's afternoon, not UTC's", async () => {
  const queried: { timeMin: string; timeMax: string }[] = [];
  await handleCalendarAvailability(
    "u",
    "Am I free Friday afternoon?",
    deps({
      getTimezone: async () => "Asia/Tokyo", // UTC+9, no DST
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        windowStartHour: 12,
        windowEndHour: 17,
        availabilityKind: "check",
      }),
      freeBusy: async (_u, o) => {
        queried.push({ timeMin: o.timeMin, timeMax: o.timeMax });
        return [];
      },
    }),
  );
  // 12:00 JST == 03:00Z; 17:00 JST == 08:00Z (same day).
  assert.equal(queried[0]!.timeMin, "2026-07-17T03:00:00.000Z");
  assert.equal(queried[0]!.timeMax, "2026-07-17T08:00:00.000Z");
});

asyncCheck("DST: an afternoon check across the spring-forward stays local", async () => {
  // US DST 2026 begins Sun 8 Mar. Sat 7 Mar is EST (UTC-5): 12:00 == 17:00Z.
  const queried: { timeMin: string; timeMax: string }[] = [];
  await handleCalendarAvailability(
    "u",
    "Am I free Saturday afternoon?",
    deps({
      now: new Date("2026-03-05T12:00:00Z"),
      extract: fixedIntent({
        dateFrom: "2026-03-07",
        dateTo: "2026-03-07",
        windowStartHour: 12,
        windowEndHour: 17,
        availabilityKind: "check",
      }),
      freeBusy: async (_u, o) => {
        queried.push({ timeMin: o.timeMin, timeMax: o.timeMax });
        return [];
      },
    }),
  );
  assert.equal(queried[0]!.timeMin, "2026-03-07T17:00:00.000Z", "EST: 12:00 local == 17:00Z");
  assert.equal(queried[0]!.timeMax, "2026-03-07T22:00:00.000Z");
});

asyncCheck("DST: the SAME question after the transition shifts by an hour in UTC", async () => {
  // Mon 9 Mar is EDT (UTC-4): 12:00 == 16:00Z. Same local question, different
  // absolute instants — which is exactly right.
  const queried: { timeMin: string; timeMax: string }[] = [];
  await handleCalendarAvailability(
    "u",
    "Am I free Monday afternoon?",
    deps({
      now: new Date("2026-03-05T12:00:00Z"),
      extract: fixedIntent({
        dateFrom: "2026-03-09",
        dateTo: "2026-03-09",
        windowStartHour: 12,
        windowEndHour: 17,
        availabilityKind: "check",
      }),
      freeBusy: async (_u, o) => {
        queried.push({ timeMin: o.timeMin, timeMax: o.timeMax });
        return [];
      },
    }),
  );
  assert.equal(queried[0]!.timeMin, "2026-03-09T16:00:00.000Z", "EDT: 12:00 local == 16:00Z");
  assert.equal(queried[0]!.timeMax, "2026-03-09T21:00:00.000Z");
});

asyncCheck("DST: an 'all day' check spans 25 hours on the fall-back day", async () => {
  // Sun 1 Nov 2026 has 25 hours in America/New_York. A whole-day query must
  // cover the real day, not a hardcoded 24h.
  const queried: { timeMin: string; timeMax: string }[] = [];
  await handleCalendarAvailability(
    "u",
    "Am I free all day Sunday?",
    deps({
      now: new Date("2026-10-30T12:00:00Z"),
      extract: fixedIntent({ dateFrom: "2026-11-01", dateTo: "2026-11-01", wholeDay: true, availabilityKind: "check" }),
      freeBusy: async (_u, o) => {
        queried.push({ timeMin: o.timeMin, timeMax: o.timeMax });
        return [];
      },
    }),
  );
  const span =
    Date.parse(queried[0]!.timeMax) - Date.parse(queried[0]!.timeMin);
  assert.equal(span, 25 * 60 * 60 * 1000, "the fall-back day is genuinely 25 hours long");
});

// ==========================================================================
// Honesty under failure
// ==========================================================================

asyncCheck("a free/busy failure never becomes a yes", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "Am I free Friday afternoon?",
    deps({
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        windowStartHour: 12,
        windowEndHour: 17,
        availabilityKind: "check",
      }),
      freeBusy: async () => {
        throw new Error("boom");
      },
    }),
  );
  assert.match(r.reply!, /couldn’t check your availability/i);
  assert.ok(!/^Yes/.test(r.reply!));
});

asyncCheck("nothing is ever claimed outside the queried range", async () => {
  const r = await handleCalendarAvailability(
    "u",
    "Am I free Friday afternoon?",
    deps({
      extract: fixedIntent({
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
        windowStartHour: 12,
        windowEndHour: 17,
        availabilityKind: "check",
      }),
      // The afternoon is free, but the whole-day check FAILS.
      freeBusy: async (_u, o) => {
        if (o.timeMin === FRI_NOON_Z) return [];
        throw new Error("whole-day check unavailable");
      },
    }),
  );
  assert.match(r.reply!, /^Yes — you’re free Friday afternoon\./);
  assert.ok(
    !/clear all day/i.test(r.reply!),
    "an unverifiable whole day must not be claimed clear",
  );
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} Calendar availability semantics tests passed.`);
}

void run().catch((err) => {
  console.error(
    "Calendar availability tests failed:",
    err instanceof Error ? err.message : "unknown error",
  );
  process.exitCode = 1;
});
