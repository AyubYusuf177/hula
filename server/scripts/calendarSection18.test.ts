import assert from "node:assert/strict";

import {
  CALENDAR_UNDO_REPLIES,
  CALENDAR_WRITE_REPLIES,
  computeFinalAttendees,
  computeNewTiming,
  describeRecurrenceChoice,
  formatCreatePreview,
  formatUpdatePreview,
  handleCalendarUndo,
  handleCalendarWrite,
  isCalendarUndoRequest,
  looksLikeCalendarWrite,
  resolveAttendees,
  type CalendarWriteDeps,
  type WriteCapability,
} from "../src/integrations/providers/googleCalendar/calendarActions";
import {
  handleCalendarFlexibleRead,
  looksLikeCalendarRead,
  matchesAttendee,
  matchesLocation,
  type CalendarReadDeps,
} from "../src/integrations/providers/googleCalendar/calendarReads";
import { dedupeRecurringSeries } from "../src/integrations/providers/googleCalendar/events";
import { buildEventBody } from "../src/integrations/providers/googleCalendar/calendarWrites";
import { verifyEventState } from "../src/integrations/providers/googleCalendar/calendarVerify";
import { parseCalendarReadIntent } from "../src/integrations/providers/googleCalendar/calendarIntentExtract";
import { executeAction } from "../src/actions/executor";
import { GoogleCalendarError } from "../src/integrations/providers/googleCalendar/client";
import type { CalendarAction } from "../src/integrations/providers/googleCalendar/calendarActionExtract";
import type { CalendarReadIntent } from "../src/integrations/providers/googleCalendar/calendarIntentExtract";
import type { ActionPolicyContext } from "../src/actions/policy";
import type { CreateProposalInput } from "../src/actions/proposals";
import type { NormalizedCalendarEvent } from "../src/integrations/providers/googleCalendar/types";

/**
 * Offline tests for the rest of Section 18: flexible reads, search, all-day
 * events, attendees + invitation warnings, reminders, postcondition
 * verification, and recurrence scope. NO database, NO real Google, NO Anthropic.
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
// 2026-07-13T16:00:00Z == Mon 13 Jul 2026 12:00 EDT.
const NOW = new Date("2026-07-13T16:00:00Z");

function ev(over: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent {
  return {
    id: "evt1",
    calendarId: "primary",
    summary: "Lunch with Adam",
    location: null,
    description: null,
    start: "2026-07-14T17:00:00.000Z",
    end: "2026-07-14T18:00:00.000Z",
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

function makeDeps(
  over: Partial<CalendarWriteDeps> & { capability?: WriteCapability } = {},
): { deps: CalendarWriteDeps; calls: { proposed: CreateProposalInput[] } } {
  const calls = { proposed: [] as CreateProposalInput[] };
  const deps: CalendarWriteDeps = {
    now: NOW,
    getTimezone: async () => TZ,
    writeCapability: async () => over.capability ?? "connected_write",
    extract: over.extract ?? (async () => ({ action: "not_calendar_write" }) as CalendarAction),
    // No conflict warning unless a test asks for one.
    freeBusy: async () => [],
    newRequestId: () => "req-fixed",
    contextStore: { create: async () => ({ id: "row" }), listRecent: async () => [] },
    propose: async (_userId, input) => {
      calls.proposed.push(input);
      return {
        id: "prop_fake",
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
    find: async () => [],
    ...over,
  };
  return { deps, calls };
}

function fixedExtract(action: CalendarAction): CalendarWriteDeps["extract"] {
  return async () => action;
}

function writeCalendarContext(): ActionPolicyContext {
  return {
    connectedProviders: ["google_calendar"],
    grantedScopesByProvider: {
      google_calendar: [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
      ],
    },
    capabilitiesByProvider: {
      google_calendar: ["read_calendar_events", "write_calendar_events"],
    },
    userConfirmed: true,
  };
}

function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

// ==========================================================================
// 1. Prefilter — references
// ==========================================================================

check("prefilter: a reference with no calendar noun still reaches the write path", () => {
  // Before Section 18 these fell through to the generic model, which would deny
  // a capability that exists. The user stops naming events once a list is up.
  assert.equal(looksLikeCalendarWrite("cancel the second one"), true);
  assert.equal(looksLikeCalendarWrite("move it to Friday"), true);
  assert.equal(looksLikeCalendarWrite("make it a Google Meet"), true);
  assert.equal(looksLikeCalendarWrite("cancel it"), true);
});

check("prefilter: read questions are still not writes", () => {
  assert.equal(looksLikeCalendarWrite("what am I doing next Tuesday?"), false);
  assert.equal(looksLikeCalendarWrite("how are you"), false);
});

check("prefilter: flexible reads are recognised", () => {
  assert.equal(looksLikeCalendarRead("What am I doing next Tuesday?"), true);
  assert.equal(looksLikeCalendarRead("Find my meetings with Rob this month"), true);
  assert.equal(looksLikeCalendarRead("hey how are you"), false);
});

// ==========================================================================
// 2. All-day events
// ==========================================================================

check("all-day: the body uses a bare date and NEVER a dateTime alongside it", () => {
  // Google rejects a start carrying both, and `date` alone is what makes it all-day.
  const body = buildEventBody({ summary: "Holiday", start: { date: "2026-07-20" }, end: { date: "2026-07-21" } });
  assert.deepEqual(body.start, { date: "2026-07-20" });
  assert.deepEqual(body.end, { date: "2026-07-21" });
  assert.ok(!JSON.stringify(body).includes("dateTime"));
});

asyncCheck("all-day: an all-day create proposes an EXCLUSIVE end date", async () => {
  // A one-day event on the 20th ends on the 21st. Sending the same date twice
  // makes Google reject the request.
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Holiday", date: "2026-07-20", allDay: true }),
  });
  const r = await handleCalendarWrite("u", "add holiday on the 20th all day", deps);
  assert.equal(calls.proposed.length, 1);
  assert.equal(calls.proposed[0]!.input!.allDay, true);
  assert.equal(calls.proposed[0]!.input!.startDate, "2026-07-20");
  assert.equal(calls.proposed[0]!.input!.endDate, "2026-07-21");
  assert.match(r.reply!, /all day/i);
});

asyncCheck("all-day: a missing date asks rather than guessing one", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Holiday", allDay: true }),
  });
  const r = await handleCalendarWrite("u", "add a holiday event to my calendar, all day", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.needDate);
  assert.equal(calls.proposed.length, 0);
});

check("all-day verify: an all-day postcondition compares the bare date", () => {
  const ok = verifyEventState(ev({ allDay: true, start: "2026-07-20" }), { startDate: "2026-07-20" });
  assert.equal(ok.ok, true);
  const bad = verifyEventState(ev({ allDay: false, start: "2026-07-20T13:00:00Z" }), {
    startDate: "2026-07-20",
  });
  assert.equal(bad.ok, false);
});

// ==========================================================================
// 3. Attendees + invitations
// ==========================================================================

check("attendees: only addresses the user actually typed are used", () => {
  const r = resolveAttendees({ action: "create", attendees: ["rob@x.com"], attendeeNames: ["Sarah"] });
  assert.deepEqual(r.emails, ["rob@x.com"]);
  assert.deepEqual(r.needAddressFor, []);
});

check("attendees: a bare NAME with no address produces a question, never a guess", () => {
  // The unrecallable-mistake case: guessing sarah@… emails a real stranger.
  const r = resolveAttendees({ action: "create", attendeeNames: ["Sarah"] });
  assert.deepEqual(r.emails, []);
  assert.deepEqual(r.needAddressFor, ["Sarah"]);
});

asyncCheck("attendees: 'book an hour with Sarah' asks for her address, proposes nothing", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({
      action: "create",
      title: "Chat with Sarah",
      date: "2026-07-20",
      time: "10:00",
      durationMinutes: 60,
      attendeeNames: ["Sarah"],
    }),
  });
  const r = await handleCalendarWrite("u", "book an hour with Sarah next Monday", deps);
  assert.match(r.reply!, /email address/i);
  assert.match(r.reply!, /Sarah/);
  assert.equal(calls.proposed.length, 0, "nothing may be proposed without a verified address");
});

asyncCheck("attendees: the preview WARNS that confirming emails the guests", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({
      action: "create",
      title: "Sync",
      date: "2026-07-20",
      time: "10:00",
      attendees: ["rob@x.com"],
    }),
  });
  const r = await handleCalendarWrite("u", "book a sync with rob@x.com Monday at 10", deps);
  assert.match(r.reply!, /Inviting: rob@x\.com/);
  assert.match(r.reply!, /Confirming will email them an invitation/i);
  // Still only a proposal — no invitation has gone out.
  assert.equal(calls.proposed.length, 1);
  assert.equal(calls.proposed[0]!.confirmationRequired, true);
});

check("attendees: PATCH replaces the array, so the full list is computed", () => {
  // "Add Rob" that sent only Rob would silently uninvite everyone else.
  const event = ev({
    attendees: [
      { email: "me@x.com", displayName: null, responseStatus: "accepted", optional: false, self: true, organizer: true },
      { email: "ann@x.com", displayName: "Ann", responseStatus: "accepted", optional: false, self: false, organizer: false },
    ],
  });
  assert.deepEqual(computeFinalAttendees(event, ["rob@x.com"], []), [
    "me@x.com",
    "ann@x.com",
    "rob@x.com",
  ]);
});

check("attendees: removal drops exactly the named guest, case-insensitively", () => {
  const event = ev({
    attendees: [
      { email: "ann@x.com", displayName: "Ann", responseStatus: "accepted", optional: false, self: false, organizer: false },
      { email: "rob@x.com", displayName: "Rob", responseStatus: "accepted", optional: false, self: false, organizer: false },
    ],
  });
  assert.deepEqual(computeFinalAttendees(event, [], ["ROB@X.COM"]), ["ann@x.com"]);
});

check("attendees: untouched attendees mean no attendee field is sent at all", () => {
  assert.equal(computeFinalAttendees(ev(), [], []), null);
});

check("attendees verify: Google adding the organizer is not a mismatch", () => {
  // Google adds the organizer's own row unbidden — requiring exact equality
  // would fail every correct invite.
  const actual = ev({
    attendees: [
      { email: "rob@x.com", displayName: null, responseStatus: "needsAction", optional: false, self: false, organizer: false },
      { email: "me@x.com", displayName: null, responseStatus: "accepted", optional: false, self: true, organizer: true },
    ],
  });
  assert.equal(verifyEventState(actual, { attendees: ["rob@x.com"] }).ok, true);
});

check("attendees verify: a guest Google did NOT add is a mismatch", () => {
  const v = verifyEventState(ev({ attendees: [] }), { attendees: ["rob@x.com"] });
  assert.equal(v.ok, false);
  assert.deepEqual(v.mismatches, ["attendees"]);
});

// ==========================================================================
// 4. Location / description / reminders
// ==========================================================================

asyncCheck("create: location, description and a reminder reach the proposal", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({
      action: "create",
      title: "Dentist",
      date: "2026-07-20",
      time: "10:00",
      location: "12 High St",
      description: "bring referral",
      reminderMinutes: 15,
    }),
  });
  const r = await handleCalendarWrite("u", "book dentist Monday 10am at 12 High St", deps);
  const input = calls.proposed[0]!.input!;
  assert.equal(input.location, "12 High St");
  assert.equal(input.description, "bring referral");
  assert.equal(input.reminderMinutes, 15);
  assert.match(r.reply!, /12 High St/);
  assert.match(r.reply!, /Reminder 15 minutes before/);
});

check("reminders: overrides require useDefault:false or Google ignores them", () => {
  const body = buildEventBody({ reminders: [{ method: "popup", minutes: 15 }] });
  assert.deepEqual(body.reminders, {
    useDefault: false,
    overrides: [{ method: "popup", minutes: 15 }],
  });
});

// ==========================================================================
// 5. Update timing — relative shifts and durations
// ==========================================================================

check("timing: 'move it back thirty minutes' shifts from the REAL current start", () => {
  const event = ev({ start: "2026-07-14T17:00:00.000Z", end: "2026-07-14T18:00:00.000Z" });
  const t = computeNewTiming(event, { action: "update", shiftMinutes: -30 }, TZ);
  assert.equal(t.kind, "timed");
  if (t.kind !== "timed") return;
  assert.equal(t.startIso, "2026-07-14T16:30:00.000Z");
  // The original one-hour duration is preserved.
  assert.equal(t.endIso, "2026-07-14T17:30:00.000Z");
});

check("timing: 'push it an hour later' shifts forward", () => {
  const event = ev();
  const t = computeNewTiming(event, { action: "update", shiftMinutes: 60 }, TZ);
  assert.equal(t.kind === "timed" && t.startIso, "2026-07-14T18:00:00.000Z");
});

check("timing: an absolute new time preserves the existing duration", () => {
  // 14:00 EDT == 18:00Z.
  const event = ev({ start: "2026-07-14T17:00:00.000Z", end: "2026-07-14T18:00:00.000Z" });
  const t = computeNewTiming(event, { action: "update", newTime: "14:00" }, TZ);
  assert.equal(t.kind, "timed");
  if (t.kind !== "timed") return;
  assert.equal(t.startIso, "2026-07-14T18:00:00.000Z");
  assert.equal(t.endIso, "2026-07-14T19:00:00.000Z");
});

check("timing: a duration change keeps the start exactly where it is", () => {
  const event = ev({ start: "2026-07-14T17:00:00.000Z", end: "2026-07-14T18:00:00.000Z" });
  const t = computeNewTiming(event, { action: "update", newDurationMinutes: 30 }, TZ);
  assert.equal(t.kind, "timed");
  if (t.kind !== "timed") return;
  assert.equal(t.startIso, "2026-07-14T17:00:00.000Z");
  assert.equal(t.endIso, "2026-07-14T17:30:00.000Z");
});

check("timing: no timing request means no timing change", () => {
  assert.equal(computeNewTiming(ev(), { action: "update", newTitle: "x" }, TZ).kind, "none");
});

check("timing: a shift against an event with no start is invalid, not a guess", () => {
  assert.equal(computeNewTiming(ev({ start: null }), { action: "update", shiftMinutes: -30 }, TZ).kind, "invalid");
});

asyncCheck("update: a reschedule into the past is refused at proposal time", async () => {
  const { deps, calls } = makeDeps({
    find: async () => [ev({ start: "2026-07-13T18:00:00.000Z", end: "2026-07-13T19:00:00.000Z" })],
    extract: fixedExtract({
      action: "update",
      title: "Lunch with Adam",
      date: "2026-07-13",
      newTime: "09:00", // 09:00 EDT == 13:00Z, before NOW (16:00Z)
    }),
  });
  const r = await handleCalendarWrite("u", "move lunch to 9am", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.inPast);
  assert.equal(calls.proposed.length, 0);
});

// ==========================================================================
// 6. Update preview — exact before/after
// ==========================================================================

check("preview: an update shows exact BEFORE → AFTER values", () => {
  // Without both sides the user has no way to catch a wrongly-resolved event.
  const event = ev({ location: "Cafe" });
  const preview = formatUpdatePreview(
    event,
    {
      newLocation: "the office",
      startIso: "2026-07-14T18:00:00.000Z",
      endIso: "2026-07-14T19:00:00.000Z",
    },
    TZ,
  );
  assert.match(preview, /Location: “Cafe” → “the office”/);
  assert.match(preview, /Time: .*1:00\s?PM.* → .*2:00\s?PM/);
  // The preview now ends with the shared confirmation instruction. It no longer
  // offers "cancel" as the stop word: Sendblue reads that as a carrier opt-out and
  // blocks Hula's reply, which is how a real user was left staring at silence.
  assert.match(preview, /Want me to go ahead\? Reply Yes to confirm or No to cancel\.$/);
});

check("preview: a time change on an event WITH guests warns about notifications", () => {
  // Google emails the guest list on a time change too, not just on an invite.
  const event = ev({
    attendees: [
      { email: "rob@x.com", displayName: "Rob", responseStatus: "accepted", optional: false, self: false, organizer: false },
    ],
  });
  const preview = formatUpdatePreview(
    event,
    { startIso: "2026-07-14T18:00:00.000Z", endIso: "2026-07-14T19:00:00.000Z" },
    TZ,
  );
  assert.match(preview, /email the guests/i);
});

check("preview: a conflict is warned about, not silently allowed", () => {
  const preview = formatCreatePreview(
    {
      title: "Sync",
      startIso: "2026-07-14T17:00:00.000Z",
      endIso: "2026-07-14T18:00:00.000Z",
      conflicts: [{ start: "2026-07-14T17:00:00.000Z", end: "2026-07-14T17:30:00.000Z" }],
    },
    TZ,
  );
  assert.match(preview, /already busy/i);
  // It warns; it does not block. Sometimes the user means it.
  assert.match(preview, /Want me to go ahead\?/);
});

asyncCheck("create: a real conflict from free/busy reaches the preview", async () => {
  const { deps } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Sync", date: "2026-07-20", time: "10:00" }),
    freeBusy: async () => [{ start: "2026-07-20T14:00:00Z", end: "2026-07-20T15:00:00Z" }],
  });
  const r = await handleCalendarWrite("u", "book a sync monday at 10", deps);
  assert.match(r.reply!, /already busy/i);
});

asyncCheck("create: a free/busy failure never blocks scheduling", async () => {
  // The warning is a courtesy. Losing it must cost the heads-up, not the action.
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Sync", date: "2026-07-20", time: "10:00" }),
    freeBusy: async () => {
      throw new GoogleCalendarError("provider_unavailable", "boom", 503);
    },
  });
  const r = await handleCalendarWrite("u", "book a sync monday at 10", deps);
  assert.equal(calls.proposed.length, 1);
  assert.match(r.reply!, /Want me to go ahead\?/);
});

// ==========================================================================
// 7. Recurrence scope
// ==========================================================================

check("recurrence: a NON-recurring event needs no scope question", () => {
  const c = describeRecurrenceChoice(ev(), null);
  assert.equal(c.kind, "scope");
  assert.equal(c.kind === "scope" && c.targetId, "evt1");
});

check("recurrence: a recurring event with NO stated scope asks", () => {
  const c = describeRecurrenceChoice(ev({ recurringEventId: "series_1" }), null);
  assert.equal(c.kind, "reply");
  assert.equal(c.kind === "reply" && c.reply, CALENDAR_WRITE_REPLIES.recurrenceScope);
});

check("recurrence: 'this event' targets the INSTANCE id", () => {
  const c = describeRecurrenceChoice(ev({ id: "inst_1", recurringEventId: "series_1" }), "this_event");
  assert.equal(c.kind === "scope" && c.targetId, "inst_1");
});

check("recurrence: 'entire series' targets the MASTER id", () => {
  const c = describeRecurrenceChoice(ev({ id: "inst_1", recurringEventId: "series_1" }), "entire_series");
  assert.equal(c.kind === "scope" && c.targetId, "series_1");
});

check("recurrence: 'this and following' is declined HONESTLY, not faked", () => {
  // Google has no single safe call for it — the UI truncates the series and
  // creates a replacement (two writes, non-atomic). Saying so is correct.
  const c = describeRecurrenceChoice(ev({ recurringEventId: "series_1" }), "this_and_following");
  assert.equal(c.kind, "reply");
  assert.equal(c.kind === "reply" && c.reply, CALENDAR_WRITE_REPLIES.seriesUnsupported);
});

asyncCheck("recurrence: 'only cancel this occurrence' proposes the INSTANCE", async () => {
  const { deps, calls } = makeDeps({
    find: async () => [ev({ id: "inst_1", summary: "Standup", recurringEventId: "series_1" })],
    extract: fixedExtract({
      action: "delete",
      title: "Standup",
      date: "2026-07-14",
      recurrenceScope: "this_event",
    }),
  });
  const r = await handleCalendarWrite("u", "only cancel this occurrence of standup tomorrow", deps);
  assert.equal(calls.proposed.length, 1);
  assert.equal(calls.proposed[0]!.input!.eventId, "inst_1");
  assert.equal(calls.proposed[0]!.input!.recurrenceScope, "this_event");
  assert.match(r.reply!, /want me to go ahead\?/i);
});

asyncCheck("recurrence: 'cancel the whole series' proposes the MASTER", async () => {
  const { deps, calls } = makeDeps({
    find: async () => [ev({ id: "inst_1", summary: "Standup", recurringEventId: "series_1" })],
    extract: fixedExtract({
      action: "delete",
      title: "Standup",
      date: "2026-07-14",
      recurrenceScope: "entire_series",
    }),
  });
  const r = await handleCalendarWrite("u", "cancel the whole standup series", deps);
  assert.equal(calls.proposed[0]!.input!.eventId, "series_1");
  assert.match(r.reply!, /every occurrence/i);
});

check("recurrence: reads collapse a repeated series to its earliest instance", () => {
  const events = [
    ev({ id: "i1", summary: "Standup", start: "2026-07-14T13:00:00Z", recurringEventId: "s1" }),
    ev({ id: "i2", summary: "Standup", start: "2026-07-15T13:00:00Z", recurringEventId: "s1" }),
    ev({ id: "i3", summary: "Standup", start: "2026-07-16T13:00:00Z", recurringEventId: "s1" }),
    ev({ id: "x1", summary: "Lunch", start: "2026-07-15T16:00:00Z" }),
  ];
  const deduped = dedupeRecurringSeries(events);
  assert.deepEqual(deduped.map((e) => e.id), ["i1", "x1"]);
});

// ==========================================================================
// 8. Flexible reads + search
// ==========================================================================

function readDeps(over: Partial<CalendarReadDeps> = {}): CalendarReadDeps {
  return {
    getTimezone: async () => TZ,
    now: NOW,
    contextStore: { create: async () => ({ id: "sel" }), listRecent: async () => [] },
    ...over,
  };
}

function fixedReadIntent(over: Partial<CalendarReadIntent>): CalendarReadDeps["extract"] {
  return async () => ({
    intent: "schedule",
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

asyncCheck("read: an arbitrary date ('next Tuesday') reads that exact local day", async () => {
  let asked: { timeMin: string; timeMax: string } | null = null;
  const r = await handleCalendarFlexibleRead(
    "u",
    "What am I doing next Tuesday?",
    readDeps({
      extract: fixedReadIntent({ intent: "schedule", dateFrom: "2026-07-21", dateTo: "2026-07-21" }),
      find: async (_u, opts) => {
        asked = { timeMin: opts.timeMin, timeMax: opts.timeMax };
        return [ev({ id: "a", summary: "Standup", start: "2026-07-21T13:00:00Z", end: "2026-07-21T13:15:00Z" })];
      },
    }),
  );
  // Local midnight → next local midnight, in the user's timezone.
  assert.equal(asked!.timeMin, "2026-07-21T04:00:00.000Z");
  assert.equal(asked!.timeMax, "2026-07-22T04:00:00.000Z");
  assert.match(r.reply!, /Standup/);
});

asyncCheck("read: a date RANGE ('this month') reads the whole span", async () => {
  let asked: { timeMin: string; timeMax: string } | null = null;
  await handleCalendarFlexibleRead(
    "u",
    "what meetings do I have this month?",
    readDeps({
      extract: fixedReadIntent({ intent: "schedule", dateFrom: "2026-07-01", dateTo: "2026-07-31" }),
      find: async (_u, opts) => {
        asked = { timeMin: opts.timeMin, timeMax: opts.timeMax };
        return [];
      },
    }),
  );
  assert.equal(asked!.timeMin, "2026-07-01T04:00:00.000Z");
  // Exclusive: local midnight AFTER the last requested day.
  assert.equal(asked!.timeMax, "2026-08-01T04:00:00.000Z");
});

asyncCheck("search: 'meetings with Rob' filters by REAL attendance", async () => {
  // Google's free-text `q` also matches the DESCRIPTION, so an event merely
  // mentioning Rob comes back. That is a false positive for this question.
  const withRob = ev({
    id: "a",
    summary: "1:1",
    start: "2026-07-20T13:00:00Z",
    attendees: [
      { email: "rob@x.com", displayName: "Rob", responseStatus: "accepted", optional: false, self: false, organizer: false },
    ],
  });
  const mentionsRobInNotes = ev({
    id: "b",
    summary: "Planning",
    start: "2026-07-21T13:00:00Z",
    description: "ask Rob about the deck",
  });

  const r = await handleCalendarFlexibleRead(
    "u",
    "Find my meetings with Rob this month",
    readDeps({
      extract: fixedReadIntent({
        intent: "search",
        attendee: "Rob",
        dateFrom: "2026-07-01",
        dateTo: "2026-07-31",
      }),
      find: async () => [withRob, mentionsRobInNotes],
    }),
  );
  assert.match(r.reply!, /1:1/);
  assert.ok(!/Planning/.test(r.reply!), "an event that merely MENTIONS Rob is not a meeting with Rob");
});

check("search: attendee matching covers address and display name", () => {
  const e = ev({
    attendees: [
      { email: "rob.smith@x.com", displayName: "Rob Smith", responseStatus: "accepted", optional: false, self: false, organizer: false },
    ],
  });
  assert.equal(matchesAttendee(e, "rob"), true);
  assert.equal(matchesAttendee(e, "Rob Smith"), true);
  assert.equal(matchesAttendee(e, "rob.smith@x.com"), true);
  assert.equal(matchesAttendee(e, "jane"), false);
});

check("search: location matching is a case-insensitive contains", () => {
  const e = ev({ location: "The Office, 12 High St" });
  assert.equal(matchesLocation(e, "office"), true);
  assert.equal(matchesLocation(e, "cafe"), false);
});

asyncCheck("search: an empty result says so honestly", async () => {
  const r = await handleCalendarFlexibleRead(
    "u",
    "find my meetings with Rob this month",
    readDeps({
      extract: fixedReadIntent({ intent: "search", attendee: "Rob", dateFrom: "2026-07-01", dateTo: "2026-07-31" }),
      find: async () => [],
    }),
  );
  assert.match(r.reply!, /couldn’t find anything matching “Rob”/i);
});

asyncCheck("read: a shown list is remembered so 'the second one' can resolve", async () => {
  const recorded: NormalizedCalendarEvent[][] = [];
  await handleCalendarFlexibleRead(
    "u",
    "what am I doing next Tuesday?",
    readDeps({
      extract: fixedReadIntent({ intent: "schedule", dateFrom: "2026-07-21", dateTo: "2026-07-21" }),
      find: async () => [
        ev({ id: "a", summary: "Standup", start: "2026-07-21T13:00:00Z" }),
        ev({ id: "b", summary: "Lunch", start: "2026-07-21T16:00:00Z" }),
      ],
      contextStore: {
        create: async (_u, input) => {
          const data = input.input as unknown as { items: { id: string }[] };
          recorded.push(data.items as unknown as NormalizedCalendarEvent[]);
          return { id: "sel" };
        },
        listRecent: async () => [],
      },
    }),
  );
  assert.equal(recorded.length, 1);
  assert.deepEqual((recorded[0] as unknown as { id: string }[]).map((i) => i.id), ["a", "b"]);
});

asyncCheck("read: a provider failure is honest, never an empty schedule", async () => {
  // "You've got nothing on" would be a fabrication when we simply couldn't look.
  const r = await handleCalendarFlexibleRead(
    "u",
    "what am I doing next Tuesday?",
    readDeps({
      extract: fixedReadIntent({ intent: "schedule", dateFrom: "2026-07-21", dateTo: "2026-07-21" }),
      find: async () => {
        throw new GoogleCalendarError("provider_unavailable", "boom", 503);
      },
    }),
  );
  assert.match(r.reply!, /trouble reaching your Google Calendar/i);
  assert.ok(!/nothing on/i.test(r.reply!));
});

asyncCheck("read: a write request is never claimed by the reader", async () => {
  const r = await handleCalendarFlexibleRead(
    "u",
    "cancel my meetings tomorrow",
    readDeps({ extract: async () => ({ intent: "not_calendar_read" }) as CalendarReadIntent }),
  );
  assert.equal(r.handled, false);
});

check("read intent: an inverted window is discarded rather than trusted", () => {
  // end <= start would silently yield zero free slots and read as "fully booked".
  const parsed = parseCalendarReadIntent(
    JSON.stringify({ intent: "availability", windowStartHour: 18, windowEndHour: 9 }),
  );
  assert.equal(parsed?.windowStartHour, null);
  assert.equal(parsed?.windowEndHour, null);
});

check("read intent: malformed model output is refused", () => {
  assert.equal(parseCalendarReadIntent(""), null);
  assert.equal(parseCalendarReadIntent("not json"), null);
  assert.equal(parseCalendarReadIntent(JSON.stringify({ intent: "explode" })), null);
});

// ==========================================================================
// 9. Postcondition verification + no fabricated success
// ==========================================================================

asyncCheck("postcondition: a verified update reports success", async () => {
  const start = futureIso(60);
  const end = futureIso(120);
  const updated = ev({ id: "evt1", summary: "Renamed", start, end });
  const result = await executeAction(
    "u",
    "calendar.updateEvent",
    {
      input: { eventId: "evt1", newTitle: "Renamed", timezone: TZ, renamedOnly: true },
      userConfirmed: true,
    },
    {
      buildContext: async () => writeCalendarContext(),
      record: async () => "exec_1",
      updateCalendarEvent: async () => updated,
      getCalendarEvent: async () => updated,
      recordActedCalendarEvent: async () => ({ id: "ctx" }),
    },
  );
  assert.equal(result.ok, true);
  assert.match(result.userMessage, /Renamed/);
});

asyncCheck("postcondition: an update that did NOT stick is reported honestly", async () => {
  // Google answered 2xx, but the calendar disagrees. Reality wins.
  const start = futureIso(60);
  const result = await executeAction(
    "u",
    "calendar.updateEvent",
    {
      input: { eventId: "evt1", newTitle: "Renamed", timezone: TZ, renamedOnly: true },
      userConfirmed: true,
    },
    {
      buildContext: async () => writeCalendarContext(),
      record: async () => "exec_1",
      updateCalendarEvent: async () => ev({ id: "evt1", summary: "Renamed", start }),
      // The re-read still shows the OLD title.
      getCalendarEvent: async () => ev({ id: "evt1", summary: "Lunch with Adam", start }),
      recordActedCalendarEvent: async () => ({ id: "ctx" }),
    },
  );
  assert.equal(result.ok, false, "an unverified change is not a success");
  assert.match(result.userMessage, /didn’t save exactly as I described/i);
  assert.match(result.userMessage, /title didn’t stick/i);
});

asyncCheck("postcondition: a failed re-read falls back to the validated receipt", async () => {
  // The write's receipt (a real Google-issued id) IS evidence the event exists.
  // Refusing to report a real success because a second call flaked would be a
  // lie in the other direction.
  const created = ev({ id: "evt_new", summary: "Gym", start: futureIso(60), end: futureIso(120) });
  const result = await executeAction(
    "u",
    "calendar.createEvent",
    {
      input: { title: "Gym", startIso: futureIso(60), endIso: futureIso(120), timezone: TZ },
      userConfirmed: true,
    },
    {
      buildContext: async () => writeCalendarContext(),
      record: async () => "exec_1",
      createCalendarEvent: async () => created,
      getCalendarEvent: async () => {
        throw new GoogleCalendarError("provider_unavailable", "flake", 503);
      },
      recordActedCalendarEvent: async () => ({ id: "ctx" }),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.receipt?.eventId, "evt_new");
});

asyncCheck("postcondition: a delete is only reported once it is VERIFIED gone", async () => {
  let verifyCalls = 0;
  const result = await executeAction(
    "u",
    "calendar.cancelEvent",
    { input: { eventId: "evt1", title: "Lunch", timezone: TZ }, userConfirmed: true },
    {
      buildContext: async () => writeCalendarContext(),
      record: async () => "exec_1",
      deleteCalendarEvent: async () => undefined,
      verifyEventDeleted: async () => {
        verifyCalls += 1;
        return true;
      },
      recordActedCalendarEvent: async () => ({ id: "ctx" }),
    },
  );
  assert.equal(verifyCalls, 1, "deletion must be checked, not assumed");
  assert.equal(result.ok, true);
  assert.match(result.userMessage, /Deleted/);
});

asyncCheck("postcondition: a delete that did NOT happen is never reported as done", async () => {
  // Google accepted the DELETE but the event is still there.
  const result = await executeAction(
    "u",
    "calendar.cancelEvent",
    { input: { eventId: "evt1", title: "Lunch", timezone: TZ }, userConfirmed: true },
    {
      buildContext: async () => writeCalendarContext(),
      record: async () => "exec_1",
      deleteCalendarEvent: async () => undefined,
      verifyEventDeleted: async () => false,
      recordActedCalendarEvent: async () => ({ id: "ctx" }),
    },
  );
  assert.equal(result.ok, false);
  assert.ok(!/Deleted/.test(result.userMessage));
});

asyncCheck("no fabricated success: a malformed create response fails loudly", async () => {
  const result = await executeAction(
    "u",
    "calendar.createEvent",
    {
      input: { title: "Gym", startIso: futureIso(60), endIso: futureIso(120), timezone: TZ },
      userConfirmed: true,
    },
    {
      buildContext: async () => writeCalendarContext(),
      record: async () => "exec_1",
      createCalendarEvent: async () => {
        // What `requireEventReceipt` throws when Google returns no event id.
        throw new GoogleCalendarError("malformed_provider_response", "no id");
      },
      recordActedCalendarEvent: async () => ({ id: "ctx" }),
    },
  );
  assert.equal(result.ok, false);
  assert.ok(!/scheduled/i.test(result.userMessage), "a malformed response is not a scheduled event");
});

asyncCheck("acted context is recorded ONLY after a verified write", async () => {
  const recorded: string[] = [];
  const start = futureIso(60);
  // Mismatched postcondition → no acted memory, so "undo that" can't reverse
  // something that didn't happen.
  await executeAction(
    "u",
    "calendar.updateEvent",
    { input: { eventId: "evt1", newTitle: "Renamed", timezone: TZ }, userConfirmed: true },
    {
      buildContext: async () => writeCalendarContext(),
      record: async () => "exec_1",
      updateCalendarEvent: async () => ev({ id: "evt1", summary: "Renamed", start }),
      getCalendarEvent: async () => ev({ id: "evt1", summary: "Lunch with Adam", start }),
      recordActedCalendarEvent: async (_u, acted) => {
        recorded.push(acted.event.id);
        return { id: "ctx" };
      },
    },
  );
  assert.deepEqual(recorded, [], "an unverified write must not become 'the meeting you just changed'");
});

// ==========================================================================
// 10. Scope gating
// ==========================================================================

asyncCheck("scope: a read-only connection cannot create, and nothing is proposed", async () => {
  const { deps, calls } = makeDeps({
    capability: "connected_readonly",
    extract: fixedExtract({ action: "create", title: "Gym", date: "2026-07-20", time: "10:00" }),
  });
  const r = await handleCalendarWrite("u", "book gym monday at 10", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.reconnect);
  assert.equal(calls.proposed.length, 0);
});

asyncCheck("safety: no Section 18 reply leaks token material", async () => {
  const { deps } = makeDeps({
    extract: fixedExtract({
      action: "create",
      title: "Sync",
      date: "2026-07-20",
      time: "10:00",
      attendees: ["rob@x.com"],
      addMeet: true,
    }),
  });
  const r = await handleCalendarWrite("u", "book a sync with rob@x.com monday at 10 with a meet", deps);
  assert.ok(!/Bearer|ya29\.|access_token|refresh_token/i.test(JSON.stringify(r)));
});

asyncCheck("meet: a create with addMeet pins a conference requestId onto the proposal", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({
      action: "create",
      title: "Sync",
      date: "2026-07-20",
      time: "10:00",
      addMeet: true,
    }),
  });
  const r = await handleCalendarWrite("u", "book a sync monday at 10 as a google meet", deps);
  assert.equal(calls.proposed[0]!.input!.conferenceRequestId, "req-fixed");
  assert.match(r.reply!, /With a Google Meet link/);
  // The preview promises nothing about the URL — it does not exist yet.
  assert.ok(!/meet\.google\.com/.test(r.reply!));
});

// ==========================================================================
// 11. Undo — only where a safe verified inverse exists
// ==========================================================================

check("undo: only a bare 'undo' counts", () => {
  assert.equal(isCalendarUndoRequest("undo"), true);
  assert.equal(isCalendarUndoRequest("undo that"), true);
  assert.equal(isCalendarUndoRequest("Undo it."), true);
  // A richer request is a normal update — it belongs on a path that can preview.
  assert.equal(isCalendarUndoRequest("undo the location change"), false);
  assert.equal(isCalendarUndoRequest("cancel my 2pm"), false);
});

asyncCheck("undo: with nothing acted on, it falls through untouched", async () => {
  const { deps } = makeDeps({ contextStore: { create: async () => ({ id: "r" }), listRecent: async () => [] } });
  const r = await handleCalendarUndo("u", "undo that", deps);
  assert.equal(r.handled, false, "nothing of ours to undo -> another handler may have it");
});

asyncCheck("undo: a verified CREATE is inverted via the normal confirmation path", async () => {
  // A create has an exact inverse: the event did not exist before.
  const created = ev({ id: "evt_new", summary: "Gym" });
  const { deps, calls } = makeDeps({
    contextStore: {
      create: async () => ({ id: "r" }),
      listRecent: async () => [
        {
          id: "row1",
          provider: "google_calendar",
          actionId: "calendar.entityContext",
          status: "proposed",
          riskLevel: "read",
          confirmationRequired: false,
          previewText: "ctx",
          input: {
            kind: "calendar_entity_context",
            selected: { id: "evt_new", title: "Gym" },
            acted: { event: { id: "evt_new", title: "Gym" }, kind: "created", at: new Date().toISOString() },
          },
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          confirmedAt: null,
          rejectedAt: null,
          executedAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
    },
    getEvent: async () => created,
  });
  const r = await handleCalendarUndo("u", "undo that", deps);
  // It PROPOSES a delete — undo is not a licence to skip the confirmation.
  assert.equal(calls.proposed.length, 1);
  assert.equal(calls.proposed[0]!.actionId, "calendar.cancelEvent");
  assert.equal(calls.proposed[0]!.input!.eventId, "evt_new");
  assert.equal(calls.proposed[0]!.confirmationRequired, true);
  assert.match(r.reply!, /delete “Gym”/);
});

asyncCheck("undo: an UPDATE is not inverted — the before-state isn't stored", async () => {
  const { deps, calls } = makeDeps({
    contextStore: {
      create: async () => ({ id: "r" }),
      listRecent: async () => [
        {
          id: "row1",
          provider: "google_calendar",
          actionId: "calendar.entityContext",
          status: "proposed",
          riskLevel: "read",
          confirmationRequired: false,
          previewText: "ctx",
          input: {
            kind: "calendar_entity_context",
            selected: { id: "evt1", title: "Lunch" },
            acted: { event: { id: "evt1", title: "Lunch" }, kind: "updated", at: new Date().toISOString() },
          },
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          confirmedAt: null,
          rejectedAt: null,
          executedAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
    },
  });
  const r = await handleCalendarUndo("u", "undo that", deps);
  assert.equal(r.reply, CALENDAR_UNDO_REPLIES.cannot);
  assert.equal(calls.proposed.length, 0, "an inverse we cannot compute must never be guessed");
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} Calendar Section 18 tests passed.`);
}

void run().catch((err) => {
  console.error("Calendar Section 18 tests failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
