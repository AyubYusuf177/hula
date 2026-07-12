import assert from "node:assert/strict";

import {
  buildEventBody,
  type CalendarEventWriteFields,
} from "../src/integrations/providers/googleCalendar/calendarWrites";
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

/**
 * Offline tests for Section 15 Google Calendar WRITES. Everything here is PURE or
 * uses injected fakes — NO database, NO real Google API, NO Anthropic. Google
 * writes are mocked via injected create/update/find/remove deps, so no test ever
 * touches a real calendar. Run with: `npm test`.
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
    organizerEmail: null,
    recurringEventId,
    source: "google_calendar",
  };
}

/** A write-capable, connected calendar with all Google ops as controllable fakes. */
function makeDeps(over: Partial<CalendarWriteDeps> & { capability?: WriteCapability } = {}): {
  deps: CalendarWriteDeps;
  calls: { created: unknown[]; updated: unknown[]; removed: string[]; found: number };
} {
  const calls = { created: [] as unknown[], updated: [] as unknown[], removed: [] as string[], found: 0 };
  const deps: CalendarWriteDeps = {
    now: NOW,
    getTimezone: async () => TZ,
    writeCapability: async () => over.capability ?? "connected_write",
    // Default extractor is overridden per test; default returns not_calendar_write.
    extract: over.extract ?? (async () => ({ action: "not_calendar_write" }) as CalendarAction),
    create: async (_u, fields) => {
      calls.created.push(fields);
      const start = (fields.start?.dateTime as string) ?? null;
      const end = (fields.end?.dateTime as string) ?? null;
      return ev("new_1", fields.summary ?? "", start, end);
    },
    update: async (_u, id, fields) => {
      calls.updated.push({ id, fields });
      const start = (fields.start?.dateTime as string) ?? "2026-07-14T18:00:00.000Z";
      const end = (fields.end?.dateTime as string) ?? "2026-07-14T19:00:00.000Z";
      return ev(id, fields.summary ?? "Lunch with Adam", start, end);
    },
    remove: async (_u, id) => {
      calls.removed.push(id);
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

// --- CREATE flow ---------------------------------------------------------

asyncCheck("create: valid request creates the event and confirms from Google", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Lunch with Adam", date: "2026-07-14", time: "13:00" }),
  });
  const r = await handleCalendarWrite("u", "schedule lunch with Adam tomorrow at 1pm", deps);
  assert.equal(r.handled, true);
  assert.equal(r.action, "create");
  assert.ok(/Done — “Lunch with Adam” is scheduled/.test(r.reply ?? ""));
  assert.equal(calls.created.length, 1);
});

asyncCheck("create: default 60-minute duration when none is given", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Sync", date: "2026-07-14", time: "15:00" }),
  });
  await handleCalendarWrite("u", "schedule a sync tomorrow at 3pm", deps);
  const fields = calls.created[0] as CalendarEventWriteFields;
  const start = new Date(fields.start!.dateTime).getTime();
  const end = new Date(fields.end!.dateTime).getTime();
  assert.equal((end - start) / 60000, 60);
});

asyncCheck("create: custom duration is honored", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Hula test", date: "2026-07-14", time: "15:00", durationMinutes: 30 }),
  });
  await handleCalendarWrite("u", "schedule a Hula test tomorrow at 3pm for 30 minutes", deps);
  const fields = calls.created[0] as CalendarEventWriteFields;
  const mins = (new Date(fields.end!.dateTime).getTime() - new Date(fields.start!.dateTime).getTime()) / 60000;
  assert.equal(mins, 30);
});

asyncCheck("create: optional location is passed through", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Coffee", date: "2026-07-14", time: "10:00", location: "Blue Bottle" }),
  });
  await handleCalendarWrite("u", "schedule coffee tomorrow at 10am at Blue Bottle", deps);
  assert.equal((calls.created[0] as CalendarEventWriteFields).location, "Blue Bottle");
});

asyncCheck("create: missing time asks for clarification (no write)", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Lunch with Adam", date: "2026-07-14" }),
  });
  const r = await handleCalendarWrite("u", "schedule lunch with Adam tomorrow", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.needTime);
  assert.equal(calls.created.length, 0);
});

asyncCheck("create: missing title asks for clarification (no write)", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", date: "2026-07-14", time: "13:00" }),
  });
  const r = await handleCalendarWrite("u", "schedule something tomorrow at 1pm", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.needTitle);
  assert.equal(calls.created.length, 0);
});

asyncCheck("create: never schedules in the past", async () => {
  const { deps, calls } = makeDeps({
    extract: fixedExtract({ action: "create", title: "Past thing", date: "2026-07-10", time: "09:00" }),
  });
  const r = await handleCalendarWrite("u", "schedule a call at 9am on Friday", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.inPast);
  assert.equal(calls.created.length, 0);
});

asyncCheck("create: a Google failure yields an honest reply, not a false success", async () => {
  const { deps } = makeDeps({
    extract: fixedExtract({ action: "create", title: "X", date: "2026-07-14", time: "13:00" }),
    create: async () => {
      const { GoogleCalendarError } = await import("../src/integrations/providers/googleCalendar/client");
      throw new GoogleCalendarError("provider_unavailable", "boom", 503);
    },
  });
  const r = await handleCalendarWrite("u", "schedule X tomorrow at 1pm", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.unavailable);
  assert.ok(!/Done —/.test(r.reply ?? ""));
});

// --- UPDATE flow ---------------------------------------------------------

const oneLunch = [ev("evt_lunch", "Lunch with Adam", "2026-07-14T13:00:00-04:00", "2026-07-14T14:00:00-04:00")];

asyncCheck("update: reschedules and preserves the original duration", async () => {
  const { deps, calls } = makeDeps({
    find: async () => oneLunch,
    extract: fixedExtract({ action: "update", title: "Lunch with Adam", date: "2026-07-14", newTime: "14:00" }),
  });
  const r = await handleCalendarWrite("u", "move lunch with Adam tomorrow to 2pm", deps);
  assert.equal(r.action, "update");
  assert.ok(/^Updated — “Lunch with Adam” is now scheduled/.test(r.reply ?? ""));
  const { id, fields } = calls.updated[0] as { id: string; fields: CalendarEventWriteFields };
  assert.equal(id, "evt_lunch");
  const mins = (new Date(fields.end!.dateTime).getTime() - new Date(fields.start!.dateTime).getTime()) / 60000;
  assert.equal(mins, 60, "original 60-min duration preserved");
});

asyncCheck("update: title-only change reads as a rename and doesn't touch time", async () => {
  const { deps, calls } = makeDeps({
    find: async () => oneLunch,
    extract: fixedExtract({ action: "update", title: "Lunch with Adam", date: "2026-07-14", newTitle: "Project Planning" }),
  });
  const r = await handleCalendarWrite("u", "rename lunch with Adam to Project Planning", deps);
  const { fields } = calls.updated[0] as { fields: CalendarEventWriteFields };
  assert.equal(fields.summary, "Project Planning");
  assert.equal(fields.start, undefined, "no time change on a pure rename");
  assert.ok(/renamed to “Project Planning”/.test(r.reply ?? ""));
});

asyncCheck("update: zero matches -> not found (no write)", async () => {
  const { deps, calls } = makeDeps({
    find: async () => [],
    extract: fixedExtract({ action: "update", title: "Lunch with Adam", date: "2026-07-14", newTime: "14:00" }),
  });
  const r = await handleCalendarWrite("u", "move lunch with Adam to 2pm", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.notFound);
  assert.equal(calls.updated.length, 0);
});

asyncCheck("update: multiple matches -> clarify (no write)", async () => {
  const two = [
    ev("a", "Lunch with Adam", "2026-07-14T13:00:00-04:00", "2026-07-14T14:00:00-04:00"),
    ev("b", "Lunch with Adam", "2026-07-14T17:00:00-04:00", "2026-07-14T18:00:00-04:00"),
  ];
  const { deps, calls } = makeDeps({
    find: async () => two,
    extract: fixedExtract({ action: "update", title: "Lunch with Adam", date: "2026-07-14", newTime: "15:00" }),
  });
  const r = await handleCalendarWrite("u", "move lunch with Adam to 3pm", deps);
  assert.ok(/Which one did you mean/.test(r.reply ?? ""));
  assert.equal(calls.updated.length, 0, "ambiguity must never write");
});

asyncCheck("update: Google failure is surfaced honestly", async () => {
  const { deps } = makeDeps({
    find: async () => oneLunch,
    extract: fixedExtract({ action: "update", title: "Lunch with Adam", date: "2026-07-14", newTime: "14:00" }),
    update: async () => {
      const { GoogleCalendarError } = await import("../src/integrations/providers/googleCalendar/client");
      throw new GoogleCalendarError("provider_unavailable", "boom", 503);
    },
  });
  const r = await handleCalendarWrite("u", "move lunch with Adam to 2pm", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.unavailable);
});

// --- DELETE flow ---------------------------------------------------------

asyncCheck("delete: single match is deleted and confirmed from captured details", async () => {
  const { deps, calls } = makeDeps({
    find: async () => oneLunch,
    extract: fixedExtract({ action: "delete", title: "Lunch with Adam", date: "2026-07-14" }),
  });
  const r = await handleCalendarWrite("u", "delete lunch with Adam tomorrow", deps);
  assert.equal(r.action, "delete");
  assert.deepEqual(calls.removed, ["evt_lunch"]);
  assert.ok(/^Deleted — “Lunch with Adam” on Tuesday at 1:00/.test(r.reply ?? ""));
});

asyncCheck("delete: zero matches -> not found (no delete)", async () => {
  const { deps, calls } = makeDeps({
    find: async () => [],
    extract: fixedExtract({ action: "delete", title: "Lunch with Adam", date: "2026-07-14" }),
  });
  const r = await handleCalendarWrite("u", "delete lunch with Adam tomorrow", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.notFound);
  assert.equal(calls.removed.length, 0);
});

asyncCheck("delete: multiple matches -> clarify (no delete)", async () => {
  const two = [
    ev("a", "Lunch with Adam", "2026-07-14T13:00:00-04:00", "2026-07-14T14:00:00-04:00"),
    ev("b", "Lunch with Adam", "2026-07-14T17:00:00-04:00", "2026-07-14T18:00:00-04:00"),
  ];
  const { deps, calls } = makeDeps({
    find: async () => two,
    extract: fixedExtract({ action: "delete", title: "Lunch with Adam", date: "2026-07-14" }),
  });
  const r = await handleCalendarWrite("u", "delete lunch with Adam tomorrow", deps);
  assert.ok(/Which one did you mean/.test(r.reply ?? ""));
  assert.equal(calls.removed.length, 0);
});

asyncCheck("delete: a recurring match asks for clarification (never touches the series)", async () => {
  const recurring = [ev("inst_1", "Standup", "2026-07-14T09:00:00-04:00", "2026-07-14T09:15:00-04:00", "series_1")];
  const { deps, calls } = makeDeps({
    find: async () => recurring,
    extract: fixedExtract({ action: "delete", title: "Standup", date: "2026-07-14" }),
  });
  const r = await handleCalendarWrite("u", "delete standup tomorrow", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.recurring);
  assert.equal(calls.removed.length, 0);
});

asyncCheck("delete: Google failure is surfaced honestly", async () => {
  const { deps } = makeDeps({
    find: async () => oneLunch,
    extract: fixedExtract({ action: "delete", title: "Lunch with Adam", date: "2026-07-14" }),
    remove: async () => {
      const { GoogleCalendarError } = await import("../src/integrations/providers/googleCalendar/client");
      throw new GoogleCalendarError("provider_rate_limited", "slow down", 429);
    },
  });
  const r = await handleCalendarWrite("u", "delete lunch with Adam tomorrow", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.unavailable);
});

// --- Capability gating & fall-through ------------------------------------

asyncCheck("gate: not connected -> honest connect message (no Google call)", async () => {
  const { deps, calls } = makeDeps({
    capability: "not_connected",
    extract: fixedExtract({ action: "create", title: "X", date: "2026-07-14", time: "13:00" }),
  });
  const r = await handleCalendarWrite("u", "schedule X tomorrow at 1pm", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.notConnected);
  assert.equal(calls.created.length, 0);
});

asyncCheck("gate: read-only connection -> reconnect message (no Google call)", async () => {
  const { deps, calls } = makeDeps({
    capability: "connected_readonly",
    extract: fixedExtract({ action: "create", title: "X", date: "2026-07-14", time: "13:00" }),
  });
  const r = await handleCalendarWrite("u", "schedule X tomorrow at 1pm", deps);
  assert.equal(r.reply, CALENDAR_WRITE_REPLIES.reconnect);
  assert.equal(calls.created.length, 0);
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
  console.log(`\nAll ${passed} Google Calendar write (Section 15) tests passed.`);
}

void run().catch((err) => {
  console.error("Calendar write tests failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
