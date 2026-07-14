import assert from "node:assert/strict";

import {
  buildEventBody,
  requireEventReceipt,
} from "../src/integrations/providers/googleCalendar/calendarWrites";
import { GoogleCalendarError } from "../src/integrations/providers/googleCalendar/client";
import {
  CalendarActionSchema,
  buildExtractionPrompt,
  parseCalendarAction,
} from "../src/integrations/providers/googleCalendar/calendarActionExtract";
import {
  CALENDAR_WRITE_REPLIES,
  eventTitleMatches,
  formatAmbiguous,
  formatCreated,
  formatDeleted,
  formatNowLocal,
  formatUpdated,
  formatWhen,
  handleCalendarWrite,
  localDayWindow,
  looksLikeCalendarWrite,
  selectMatches,
  type CalendarWriteDeps,
  type WriteCapability,
} from "../src/integrations/providers/googleCalendar/calendarActions";
import type { CalendarAction } from "../src/integrations/providers/googleCalendar/calendarActionExtract";
import type { NormalizedCalendarEvent } from "../src/integrations/providers/googleCalendar/types";
import type { CreateProposalInput } from "../src/actions/proposals";

/**
 * Offline tests for Google Calendar WRITES (Sections 15 + 17). Everything here is
 * PURE or uses injected fakes — NO database, NO real Google API, NO Anthropic.
 *
 * Section 17 moved the actual Google write behind the proposal → confirmation →
 * executor path, so these tests assert the RESOLVE + PREVIEW + PROPOSE half:
 * the right event is resolved, the safety guards (past / ambiguous / recurring /
 * read-only) still fire, and — critically — nothing is proposed when a guard fires.
 * The provider write itself is covered in `actions.test.ts`. No test can touch a
 * real calendar: `handleCalendarWrite` no longer has a provider write to call.
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
// 2026-07-13T16:00:00Z == 2026-07-13 12:00 (Mon) in America/New_York (UTC-4).
const NOW = new Date("2026-07-13T16:00:00Z");

/** Build a normalized event for tests. */
function ev(
  id: string,
  summary: string,
  start: string | null,
  end: string | null,
  recurringEventId: string | null = null,
): NormalizedCalendarEvent {
  return {
    id,
    calendarId: "primary",
    summary,
    location: null,
    start,
    end,
    allDay: false,
    status: "confirmed",
    htmlLink: null,
    attendeeCount: null,
    // Section 18 fields. Real events always carry these — a fixture that
    // omits them is not a realistic event and hides formatting bugs.
    description: null,
    attendees: [],
    timeZone: null,
    conference: null,
    isRecurringMaster: false,
    organizerEmail: null,
    recurringEventId,
    source: "google_calendar",
  };
}

/**
 * A write-capable, connected calendar whose PROPOSAL store is a controllable fake.
 *
 * Section 17: `handleCalendarWrite` no longer performs any Google write — it
 * resolves the target, previews it, and creates a proposal. So the thing to assert
 * is what got PROPOSED (and, just as importantly, that nothing was proposed when a
 * safety guard fired). The executor's provider adapters are tested separately in
 * `actions.test.ts`.
 */
function makeDeps(over: Partial<CalendarWriteDeps> & { capability?: WriteCapability } = {}): {
  deps: CalendarWriteDeps;
  calls: { proposed: CreateProposalInput[]; found: number };
} {
  const calls = { proposed: [] as CreateProposalInput[], found: 0 };
  const deps: CalendarWriteDeps = {
    now: NOW,
    getTimezone: async () => TZ,
    writeCapability: async () => over.capability ?? "connected_write",
    // Default extractor is overridden per test; default returns not_calendar_write.
    extract: over.extract ?? (async () => ({ action: "not_calendar_write" }) as CalendarAction),
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
    find: async () => {
      calls.found += 1;
      return over.find ? await over.find("u", { timeMin: "", timeMax: "" }) : [];
    },
    ...over,
  };
  return { deps, calls };
}

/** An extractor that always returns the given action (bypasses the model). */
function fixedExtract(action: CalendarAction): CalendarWriteDeps["extract"] {
  return async () => action;
}

// --- Prefilter -----------------------------------------------------------

check("prefilter: matches create/update/delete phrasings", () => {
  assert.equal(looksLikeCalendarWrite("Schedule lunch with Adam tomorrow at 1pm"), true);
  assert.equal(looksLikeCalendarWrite("Move lunch with Adam tomorrow to 2pm"), true);
  assert.equal(looksLikeCalendarWrite("Delete lunch with Adam tomorrow"), true);
  assert.equal(looksLikeCalendarWrite("book a call with Sam on Friday"), true);
});

check("prefilter: the required calendar-delete acceptance messages all pass", () => {
  // These must reach the Calendar-write handler (memory no longer swallows them).
  for (const msg of [
    "Delete the Hula calendar test tomorrow at 4pm",
    "Delete lunch with Adam tomorrow",
    "Cancel my meeting tomorrow at 2pm",
    "Remove the Project Planning event from my calendar",
    "Delete my 4pm calendar event tomorrow",
  ]) {
    assert.equal(looksLikeCalendarWrite(msg), true, `prefilter should pass: ${msg}`);
  }
});

check("prefilter: ignores non-calendar messages", () => {
  assert.equal(looksLikeCalendarWrite("how are you"), false);
  assert.equal(looksLikeCalendarWrite("what's on my calendar today"), false); // question verb, no write verb
  assert.equal(looksLikeCalendarWrite("send an email to Rob"), false);
  assert.equal(looksLikeCalendarWrite(""), false);
});

// --- Extraction schema / parsing -----------------------------------------

check("extract: valid model JSON parses to a typed action", () => {
  const action = parseCalendarAction(
    '{"action":"create","title":"Lunch with Adam","date":"2026-07-14","time":"13:00","durationMinutes":null,"location":null,"description":null,"newTitle":null,"newDate":null,"newTime":null,"newLocation":null}',
  );
  assert.ok(action);
  assert.equal(action?.action, "create");
  assert.equal(action?.title, "Lunch with Adam");
  assert.equal(action?.time, "13:00");
});

check("extract: tolerates markdown fences and surrounding prose", () => {
  const action = parseCalendarAction('```json\n{"action":"delete","title":"Lunch","date":"2026-07-14"}\n```');
  assert.equal(action?.action, "delete");
});

check("extract: malformed / off-schema JSON returns null", () => {
  assert.equal(parseCalendarAction("not json at all"), null);
  assert.equal(parseCalendarAction('{"action":"frobnicate"}'), null); // bad enum
  assert.equal(parseCalendarAction('{"action":"create","time":"1pm"}'), null); // bad time format
  assert.equal(parseCalendarAction(""), null);
});

check("extract: prompt carries the current local time + timezone", () => {
  const prompt = buildExtractionPrompt("2026-07-13 12:00 (Monday)", TZ);
  assert.ok(prompt.includes("2026-07-13 12:00 (Monday)"));
  assert.ok(prompt.includes(TZ));
  assert.ok(/not_calendar_write/.test(prompt));
});

check("extract: schema accepts the not_calendar_write escape hatch", () => {
  const r = CalendarActionSchema.safeParse({ action: "not_calendar_write" });
  assert.equal(r.success, true);
});

// --- Pure helpers --------------------------------------------------------

check("nowLocal: formats the current local wall time", () => {
  assert.equal(formatNowLocal(NOW, TZ), "2026-07-13 12:00 (Monday)");
});

check("dayWindow: spans the local day for a date", () => {
  const w = localDayWindow("2026-07-14", TZ);
  assert.equal(w.timeMin, "2026-07-14T04:00:00.000Z"); // local midnight EDT
  assert.equal(w.timeMax, "2026-07-15T04:00:00.000Z");
});

check("titleMatch: overlap-based matching", () => {
  assert.equal(eventTitleMatches("Lunch with Adam", "lunch with adam"), true);
  assert.equal(eventTitleMatches("Lunch with Adam", "lunch"), true);
  assert.equal(eventTitleMatches("Dentist", "lunch with adam"), false);
  assert.equal(eventTitleMatches("anything", ""), true); // no constraint
});

check("selectMatches: filters by title, and by time when given", () => {
  const events = [
    ev("a", "Lunch with Adam", "2026-07-14T13:00:00-04:00", "2026-07-14T14:00:00-04:00"),
    ev("b", "Lunch with Adam", "2026-07-14T17:00:00-04:00", "2026-07-14T18:00:00-04:00"),
    ev("c", "Dentist", "2026-07-14T09:00:00-04:00", "2026-07-14T10:00:00-04:00"),
  ];
  assert.equal(selectMatches(events, { title: "lunch with adam", tz: TZ }).length, 2);
  assert.equal(selectMatches(events, { title: "lunch with adam", time: "17:00", tz: TZ }).length, 1);
  assert.equal(selectMatches(events, { title: "dentist", tz: TZ }).length, 1);
});

check("format: created / updated / deleted / ambiguous read naturally", () => {
  const e = ev("x", "Lunch with Adam", "2026-07-14T13:00:00-04:00", "2026-07-14T14:00:00-04:00");
  assert.ok(/Done — “Lunch with Adam” is scheduled for Tuesday from 1:00 PM to 2:00 PM\./.test(
    formatCreated(e, TZ),
  ) || /Done — “Lunch with Adam” is scheduled for Tuesday from 1:00 PM to 2:00 PM\./.test(formatCreated(e, TZ)));
  assert.ok(/^Updated — “Lunch with Adam” is now scheduled for Tuesday/.test(formatUpdated(e, TZ, false)));
  assert.ok(/^Updated — renamed to “Lunch with Adam”\.$/.test(formatUpdated(e, TZ, true)));
  assert.ok(/^Deleted — “Lunch with Adam” on Tuesday at 1:00/.test(formatDeleted(e, TZ)));
  const amb = formatAmbiguous(
    [e, ev("y", "Lunch with Adam", "2026-07-14T17:00:00-04:00", "2026-07-14T18:00:00-04:00")],
    TZ,
  );
  assert.ok(/Which one did you mean/.test(amb));
  assert.ok(/1\. Lunch with Adam at 1:00/.test(amb));
  assert.ok(/2\. Lunch with Adam at 5:00/.test(amb));
  assert.ok(/from 1:00/.test(formatWhen(e, TZ)));
});

// --- Request body + provider receipt validation (PURE) --------------------

check("buildEventBody: emits only whitelisted keys and drops undefined ones", () => {
  // PATCH semantics: a field the user didn't ask to change must be ABSENT, not
  // null — an emitted null would clear it on the real event.
  const body = buildEventBody({ summary: "Gym" });
  assert.deepEqual(body, { summary: "Gym" });
  assert.equal("location" in body, false);
  assert.equal("start" in body, false);

  const full = buildEventBody({
    summary: "Lunch",
    location: "Cafe",
    description: "catch up",
    start: { dateTime: "2026-07-14T17:00:00.000Z", timeZone: TZ },
    end: { dateTime: "2026-07-14T18:00:00.000Z", timeZone: TZ },
  });
  assert.deepEqual(Object.keys(full).sort(), [
    "description",
    "end",
    "location",
    "start",
    "summary",
  ]);
  assert.deepEqual(full.start, { dateTime: "2026-07-14T17:00:00.000Z", timeZone: TZ });
});

check("receipt: a create is only a success when Google returns a real event id", () => {
  const ok = requireEventReceipt(
    { id: "evt_1", summary: "Gym", start: { dateTime: "2026-07-14T17:00:00Z" } },
    "create",
  );
  assert.equal(ok.id, "evt_1");

  // A 2xx with no id is NOT evidence the event exists — it must never be
  // formatted as a success.
  assert.throws(
    () => requireEventReceipt({ summary: "Gym" }, "create"),
    (err: unknown) =>
      err instanceof GoogleCalendarError && err.reason === "malformed_provider_response",
  );
  assert.throws(
    () => requireEventReceipt({ id: "   " }, "create"),
    (err: unknown) => err instanceof GoogleCalendarError,
  );
});

check("receipt: a create that comes back cancelled is not a success", () => {
  assert.throws(
    () => requireEventReceipt({ id: "evt_1", status: "cancelled" }, "create"),
    (err: unknown) =>
      err instanceof GoogleCalendarError && err.reason === "malformed_provider_response",
  );
});

check("receipt: an update must confirm the event we actually targeted", () => {
  const ok = requireEventReceipt({ id: "evt_lunch" }, "update", "evt_lunch");
  assert.equal(ok.id, "evt_lunch");

  // Google confirming a DIFFERENT event than requested must never be reported as
  // the requested update succeeding.
  assert.throws(
    () => requireEventReceipt({ id: "evt_other" }, "update", "evt_lunch"),
    (err: unknown) =>
      err instanceof GoogleCalendarError && err.reason === "malformed_provider_response",
  );
});

// --- CREATE flow ---------------------------------------------------------

/** The single proposal a flow created (asserts exactly one was made). */
function onlyProposal(calls: { proposed: CreateProposalInput[] }): CreateProposalInput {
  assert.equal(calls.proposed.length, 1, "expected exactly one proposal");
  return calls.proposed[0]!;
}

/** The redacted input a proposal carries, as the executor will read it back. */
function proposalInput(calls: { proposed: CreateProposalInput[] }): Record<string, unknown> {
  return (onlyProposal(calls).input ?? {}) as Record<string, unknown>;
}

asyncCheck("create: valid request PREVIEWS and proposes, but writes nothing yet", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Lunch with Adam", date: "2026-07-14", time: "13:00" }),
  });
  const r = await handleCalendarWrite("u", "schedule lunch with Adam tomorrow at 1pm", deps);
  assert.equal(r.handled, true);
  assert.equal(r.action, "create");
  // The reply must read as an intention + an ask, never as a completed write.
  assert.ok(/I’ll schedule “Lunch with Adam”/.test(r.reply ?? ""), r.reply);
  assert.ok(/want me to go ahead\?/i.test(r.reply ?? ""), r.reply);
  assert.ok(!/Done —|scheduled\.$/.test(r.reply ?? ""), "must not claim the event exists yet");

  const p = onlyProposal(calls);
  assert.equal(p.actionId, "calendar.createEvent");
  assert.equal(p.provider, "google_calendar");
  assert.equal(p.confirmationRequired, true);
  assert.equal(p.riskLevel, "write");
});

asyncCheck("create: default 60-minute duration when none is given", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Sync", date: "2026-07-14", time: "15:00" }),
  });
  await handleCalendarWrite("u", "schedule a sync tomorrow at 3pm", deps);
  const input = proposalInput(calls);
  const mins =
    (new Date(input.endIso as string).getTime() - new Date(input.startIso as string).getTime()) / 60000;
  assert.equal(mins, 60);
});

asyncCheck("create: custom duration is honored", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Hula test", date: "2026-07-14", time: "15:00", durationMinutes: 30 }),
  });
  await handleCalendarWrite("u", "schedule a Hula test tomorrow at 3pm for 30 minutes", deps);
  const input = proposalInput(calls);
  const mins =
    (new Date(input.endIso as string).getTime() - new Date(input.startIso as string).getTime()) / 60000;
  assert.equal(mins, 30);
});

asyncCheck("create: optional location is passed through to the proposal", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Coffee", date: "2026-07-14", time: "10:00", location: "Blue Bottle" }),
  });
  await handleCalendarWrite("u", "schedule coffee tomorrow at 10am at Blue Bottle", deps);
  assert.equal(proposalInput(calls).location, "Blue Bottle");
});

asyncCheck("create: the proposal carries the EXACT instants shown in the preview", async () => {
  // The executor replays these verbatim, so a drift between preview and stored
  // input would mean the user confirms one thing and Hula writes another.
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Lunch", date: "2026-07-14", time: "13:00" }),
  });
  const r = await handleCalendarWrite("u", "schedule lunch tomorrow at 1pm", deps);
  const input = proposalInput(calls);
  assert.equal(input.startIso, "2026-07-14T17:00:00.000Z", "1pm New York == 17:00Z");
  assert.equal(input.timezone, TZ);
  // The preview text stored on the proposal is what the user was actually shown.
  assert.equal(onlyProposal(calls).previewText, r.reply);
});

asyncCheck("create: missing time asks for clarification (nothing proposed)", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Lunch with Adam", date: "2026-07-14" }),
  });
  const r = await handleCalendarWrite("u", "schedule lunch with Adam tomorrow", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.needTime);
  assert.equal(calls.proposed.length, 0);
});

asyncCheck("create: missing title asks for clarification (nothing proposed)", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", date: "2026-07-14", time: "13:00" }),
  });
  const r = await handleCalendarWrite("u", "schedule something tomorrow at 1pm", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.needTitle);
  assert.equal(calls.proposed.length, 0);
});

asyncCheck("create: never proposes an event in the past", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Past thing", date: "2026-07-10", time: "09:00" }),
  });
  const r = await handleCalendarWrite("u", "schedule a call at 9am on Friday", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.inPast);
  assert.equal(calls.proposed.length, 0);
});

// --- UPDATE flow ---------------------------------------------------------

const oneLunch = [ev("evt_lunch", "Lunch with Adam", "2026-07-14T13:00:00-04:00", "2026-07-14T14:00:00-04:00")];

asyncCheck("update: reschedule previews the move and preserves the original duration", async () => {
  const { deps, calls } = makeDeps({
    find: async () => oneLunch,
    extract: fixedExtract({ action: "update", title: "Lunch with Adam", date: "2026-07-14", newTime: "14:00" }),
  });
  const r = await handleCalendarWrite("u", "move lunch with Adam to 2pm", deps);
  assert.equal(r.action, "update");
  assert.ok(/I’ll update “Lunch with Adam”/.test(r.reply ?? ""), r.reply);
  assert.ok(/want me to go ahead\?/i.test(r.reply ?? ""), r.reply);
  assert.ok(!/^Updated —/.test(r.reply ?? ""), "must not claim the update happened");

  const p = onlyProposal(calls);
  assert.equal(p.actionId, "calendar.updateEvent");
  const input = (p.input ?? {}) as Record<string, unknown>;
  // The RESOLVED event id is captured now, so confirmation can't drift onto another.
  assert.equal(input.eventId, "evt_lunch");
  const mins =
    (new Date(input.endIso as string).getTime() - new Date(input.startIso as string).getTime()) / 60000;
  assert.equal(mins, 60, "original 1h duration must be preserved");
});

asyncCheck("update: title-only change reads as a rename and doesn't touch time", async () => {
  const { deps, calls } = makeDeps({
    find: async () => oneLunch,
    extract: fixedExtract({ action: "update", title: "Lunch with Adam", date: "2026-07-14", newTitle: "Lunch with Adam B" }),
  });
  await handleCalendarWrite("u", "rename lunch with Adam to Lunch with Adam B", deps);
  const input = proposalInput(calls);
  assert.equal(input.newTitle, "Lunch with Adam B");
  assert.equal(input.renamedOnly, true);
  assert.equal(input.startIso, undefined, "a rename must not reschedule");
  assert.equal(input.endIso, undefined, "a rename must not reschedule");
});

asyncCheck("update: zero matches -> not found (nothing proposed)", async () => {
  const { deps, calls } = makeDeps({
    find: async () => [],
    extract: fixedExtract({ action: "update", title: "Lunch with Adam", date: "2026-07-14", newTime: "14:00" }),
  });
  const r = await handleCalendarWrite("u", "move lunch with Adam to 2pm", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.notFound);
  assert.equal(calls.proposed.length, 0);
});

asyncCheck("update: multiple matches -> clarify (nothing proposed)", async () => {
  const { deps, calls } = makeDeps({
    find: async () => [
      ev("a", "Lunch with Adam", "2026-07-14T13:00:00-04:00", "2026-07-14T14:00:00-04:00"),
      ev("b", "Lunch with Adam", "2026-07-14T17:00:00-04:00", "2026-07-14T18:00:00-04:00"),
    ],
    extract: fixedExtract({ action: "update", title: "Lunch with Adam", date: "2026-07-14", newTime: "14:00" }),
  });
  const r = await handleCalendarWrite("u", "move lunch with Adam to 2pm", deps);
  assert.ok(/Which one did you mean/.test(r.reply ?? ""));
  assert.equal(calls.proposed.length, 0, "an ambiguous target must never be proposed");
});

asyncCheck("update: a recurring match asks WHICH SCOPE (nothing proposed)", async () => {
  // Section 18 replaces Section 15's blanket refusal with an explicit scope
  // question. The protection is not weakened — it is strictly stronger: without
  // an explicit scope, nothing is proposed and nothing can be confirmed. What
  // changed is that the user now has a way to say what they meant instead of
  // being told to rephrase.
  const recurring = ev("inst_1", "Standup", "2026-07-14T13:00:00-04:00", "2026-07-14T13:15:00-04:00");
  const { deps, calls } = makeDeps({
    find: async () => [{ ...recurring, recurringEventId: "series_1" }],
    extract: fixedExtract({ action: "update", title: "Standup", date: "2026-07-14", newTime: "14:00" }),
  });
  const r = await handleCalendarWrite("u", "move standup to 2pm", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.recurrenceScope);
  assert.equal(calls.proposed.length, 0, "a recurring series must never be proposed unscoped");
});

// --- DELETE flow ---------------------------------------------------------

asyncCheck("delete: single match previews the deletion from captured details", async () => {
  const { deps, calls } = makeDeps({
    find: async () => oneLunch,
    extract: fixedExtract({ action: "delete", title: "Lunch with Adam", date: "2026-07-14" }),
  });
  const r = await handleCalendarWrite("u", "delete lunch with Adam tomorrow", deps);
  assert.equal(r.action, "delete");
  assert.ok(/I’ll delete “Lunch with Adam”/.test(r.reply ?? ""), r.reply);
  assert.ok(/can’t be undone/i.test(r.reply ?? ""), "a destructive preview must say so");
  assert.ok(!/^Deleted —/.test(r.reply ?? ""), "must not claim the deletion happened");

  const p = onlyProposal(calls);
  assert.equal(p.actionId, "calendar.cancelEvent");
  const input = (p.input ?? {}) as Record<string, unknown>;
  assert.equal(input.eventId, "evt_lunch");
  // Captured now because a deleted event returns 204 with no body to read back.
  assert.equal(input.title, "Lunch with Adam");
});

asyncCheck("delete: zero matches -> not found (nothing proposed)", async () => {
  const { deps, calls } = makeDeps({
    find: async () => [],
    extract: fixedExtract({ action: "delete", title: "Lunch with Adam", date: "2026-07-14" }),
  });
  const r = await handleCalendarWrite("u", "delete lunch with Adam tomorrow", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.notFound);
  assert.equal(calls.proposed.length, 0);
});

asyncCheck("delete: multiple matches -> clarify (nothing proposed)", async () => {
  const { deps, calls } = makeDeps({
    find: async () => [
      ev("a", "Lunch with Adam", "2026-07-14T13:00:00-04:00", "2026-07-14T14:00:00-04:00"),
      ev("b", "Lunch with Adam", "2026-07-14T17:00:00-04:00", "2026-07-14T18:00:00-04:00"),
    ],
    extract: fixedExtract({ action: "delete", title: "Lunch with Adam", date: "2026-07-14" }),
  });
  const r = await handleCalendarWrite("u", "delete lunch with Adam tomorrow", deps);
  assert.ok(/Which one did you mean/.test(r.reply ?? ""));
  assert.equal(calls.proposed.length, 0, "an ambiguous deletion must never be proposed");
});

asyncCheck("delete: a recurring match asks WHICH SCOPE (never touches the series)", async () => {
  const recurring = ev("inst_1", "Standup", "2026-07-14T13:00:00-04:00", "2026-07-14T13:15:00-04:00");
  const { deps, calls } = makeDeps({
    find: async () => [{ ...recurring, recurringEventId: "series_1" }],
    extract: fixedExtract({ action: "delete", title: "Standup", date: "2026-07-14" }),
  });
  const r = await handleCalendarWrite("u", "cancel standup tomorrow", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.recurrenceScope);
  assert.equal(calls.proposed.length, 0, "a recurring series must never be proposed unscoped");
});

// --- Capability gating & fall-through ------------------------------------

asyncCheck("gate: not connected -> honest connect message (no Google call)", async () => {
  const { deps, calls } = makeDeps({
    capability: "not_connected",
    extract: fixedExtract({ action: "create", title: "X", date: "2026-07-14", time: "13:00" }),
  });
  const r = await handleCalendarWrite("u", "schedule X tomorrow at 1pm", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.notConnected);
  assert.equal(calls.proposed.length, 0, "an unconnected user must not get a pending proposal");
});

asyncCheck("gate: read-only connection -> reconnect message (no Google call)", async () => {
  const { deps, calls } = makeDeps({
    capability: "connected_readonly",
    extract: fixedExtract({ action: "create", title: "X", date: "2026-07-14", time: "13:00" }),
  });
  const r = await handleCalendarWrite("u", "schedule X tomorrow at 1pm", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.reconnect);
  // A read-only connection must not leave a pending proposal a later "yes" could
  // pick up — the user is told to reconnect, and nothing stays armed.
  assert.equal(calls.proposed.length, 0);
});

asyncCheck("fallthrough: not_calendar_write returns handled:false", async () => {
  const { deps } = makeDeps({ extract: fixedExtract({ action: "not_calendar_write" }) });
  const r = await handleCalendarWrite("u", "book a table at the restaurant", deps);
  assert.equal(r.handled, false);
});

asyncCheck("fallthrough: prefilter miss returns handled:false without extracting", async () => {
  let extracted = false;
  const { deps } = makeDeps({
    extract: async () => {
      extracted = true;
      return { action: "not_calendar_write" } as CalendarAction;
    },
  });
  const r = await handleCalendarWrite("u", "how are you today", deps);
  assert.equal(r.handled, false);
  assert.equal(extracted, false, "prefilter miss must not spend a model call");
});

asyncCheck("fallthrough: model unavailable (null extraction) returns handled:false", async () => {
  const { deps } = makeDeps({ extract: async () => null });
  const r = await handleCalendarWrite("u", "schedule lunch with Adam tomorrow at 1pm", deps);
  assert.equal(r.handled, false);
});

asyncCheck("safety: no reply from any flow leaks token material", async () => {
  const { deps } = makeDeps({
    find: async () => oneLunch,
    extract: fixedExtract({ action: "update", title: "Lunch with Adam", date: "2026-07-14", newTime: "14:00" }),
  });
  const r = await handleCalendarWrite("u", "move lunch with Adam to 2pm", deps);
  assert.ok(!/Bearer|ya29\.|access_token|refresh/i.test(JSON.stringify(r)));
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} Google Calendar write (Sections 15 + 17) tests passed.`);
}

void run().catch((err) => {
  console.error("Calendar write tests failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
