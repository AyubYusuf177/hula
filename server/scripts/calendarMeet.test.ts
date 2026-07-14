import assert from "node:assert/strict";

import {
  buildConferenceCreateRequest,
  describeConference,
  generateConferenceRequestId,
  isValidMeetUrl,
  normalizeConferenceData,
  readConferenceStatus,
} from "../src/integrations/providers/googleCalendar/conference";
import {
  buildEventBody,
  buildWriteQuery,
} from "../src/integrations/providers/googleCalendar/calendarWrites";
import { normalizeGoogleEvent } from "../src/integrations/providers/googleCalendar/events";
import { verifyEventState } from "../src/integrations/providers/googleCalendar/calendarVerify";
import { formatEventDetail } from "../src/integrations/providers/googleCalendar/calendarDisplay";
import { executeAction } from "../src/actions/executor";
import type { ActionPolicyContext } from "../src/actions/policy";
import type { NormalizedCalendarEvent, RawGoogleEvent } from "../src/integrations/providers/googleCalendar/types";
import type { CalendarEventWriteFields } from "../src/integrations/providers/googleCalendar/calendarWrites";

/**
 * Offline tests for GOOGLE MEET (Section 18). NO database, NO real Google, NO
 * Anthropic — pure functions and injected fakes only.
 *
 * The property this file exists to defend: a Meet URL Hula reports is a URL
 * GOOGLE SENT. Never derived from a conference id, never assumed from a request
 * we made, never reported before Google allocated it.
 *
 * That matters because a Meet URL is trivially *shaped* — `meet.google.com/
 * xxx-yyyy-zzz` — so a fabricated one looks completely correct in an iMessage
 * and fails for everyone who clicks it, including invited guests.
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
const REAL_MEET = "https://meet.google.com/abc-defg-hij";

/** A Google event carrying a fully-allocated Meet. */
function rawWithMeet(uri: string = REAL_MEET): RawGoogleEvent {
  return {
    id: "evt_meet",
    status: "confirmed",
    summary: "Sync",
    start: { dateTime: "2026-07-20T13:00:00-04:00" },
    end: { dateTime: "2026-07-20T14:00:00-04:00" },
    conferenceData: {
      conferenceId: "abc-defg-hij",
      conferenceSolution: { key: { type: "hangoutsMeet" }, name: "Google Meet" },
      entryPoints: [{ entryPointType: "video", uri, label: "meet.google.com/abc-defg-hij" }],
      createRequest: { requestId: "req-1", status: { statusCode: "success" } },
    },
  };
}

/** A connected, write-scoped Calendar context (mirrors `actions.test.ts`). */
function writeCalendarContext(): ActionPolicyContext {
  return {
    connectedProviders: ["google_calendar"],
    grantedScopesByProvider: {
      google_calendar: [
        "https://www.googleapis.com/auth/calendar.readonly",
        // The SAME scope authorises Google Meet conference creation — there is
        // no separate Meet scope.
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

/**
 * Pinned instants, computed ONCE.
 *
 * Not cosmetic: the postcondition verifier compares instants strictly, so a
 * fake that recomputed `futureIso(60)` per call would describe an event a few
 * milliseconds off the expectation and trip a real (correct) mismatch. The
 * fixture has to name the same moment the input does.
 */
const START = futureIso(60);
const END = futureIso(120);

/** A normalized event, for executor fakes. */
function normEvent(over: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent {
  return {
    id: "evt_meet",
    calendarId: "primary",
    summary: "Sync",
    location: null,
    description: null,
    start: START,
    end: END,
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

// --- URL validation ------------------------------------------------------

check("meet url: accepts a real Google-issued Meet link", () => {
  assert.equal(isValidMeetUrl(REAL_MEET), true);
  assert.equal(isValidMeetUrl("https://meet.google.com/xyz-abcd-efg"), true);
});

check("meet url: rejects look-alikes, non-https, and junk", () => {
  // A suffix check would accept this. It must be an EXACT host match.
  assert.equal(isValidMeetUrl("https://meet.google.com.evil.test/abc"), false);
  assert.equal(isValidMeetUrl("https://evil.test/meet.google.com/abc"), false);
  assert.equal(isValidMeetUrl("http://meet.google.com/abc-defg-hij"), false);
  assert.equal(isValidMeetUrl("javascript:alert(1)"), false);
  assert.equal(isValidMeetUrl(""), false);
  assert.equal(isValidMeetUrl(null), false);
  assert.equal(isValidMeetUrl(undefined), false);
  assert.equal(isValidMeetUrl(12345), false);
  assert.equal(isValidMeetUrl("not a url"), false);
});

// --- Conference request --------------------------------------------------

check("meet request: unique requestId per generated conference", () => {
  const ids = new Set(Array.from({ length: 200 }, () => generateConferenceRequestId()));
  // Two events sharing an id would make Google hand back the FIRST event's
  // conference for the second event.
  assert.equal(ids.size, 200, "every generated conference requestId must be unique");
  for (const id of ids) assert.ok(id.length >= 16, "requestId must be substantial");
});

check("meet request: body asks for hangoutsMeet with the given id", () => {
  const body = buildConferenceCreateRequest("req-xyz");
  assert.equal(body.createRequest.requestId, "req-xyz");
  assert.equal(body.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
});

check("meet request: conferenceDataVersion=1 is set ONLY when a Meet is requested", () => {
  // Without this parameter Google SILENTLY ignores conferenceData and returns a
  // clean 200 describing an event with no Meet. This is the whole reason the
  // postcondition check exists.
  const withMeet = buildWriteQuery({ addConferenceRequestId: "req-1" }, {});
  assert.equal(withMeet.conferenceDataVersion, "1");

  const without = buildWriteQuery({ summary: "Gym" }, {});
  assert.equal("conferenceDataVersion" in without, false);
});

check("meet request: buildEventBody emits conferenceData only when requested", () => {
  const body = buildEventBody({ summary: "Sync", addConferenceRequestId: "req-1" });
  assert.deepEqual(body.conferenceData, {
    createRequest: { requestId: "req-1", conferenceSolutionKey: { type: "hangoutsMeet" } },
  });
  assert.equal("conferenceData" in buildEventBody({ summary: "Sync" }), false);
});

// --- Conference normalization -------------------------------------------

check("meet: a successful conference yields the REAL url from the entry point", () => {
  const conf = normalizeConferenceData(rawWithMeet().conferenceData);
  assert.ok(conf);
  assert.equal(conf.status, "success");
  assert.equal(conf.meetUrl, REAL_MEET);
  assert.equal(conf.conferenceId, "abc-defg-hij");
});

check("meet: PENDING conference reports no url, honestly", () => {
  // Google accepted the request but has not allocated the Meet yet. There is no
  // entry point. Reporting a link here would be pure invention.
  const conf = normalizeConferenceData({
    createRequest: { requestId: "req-1", status: { statusCode: "pending" } },
  });
  assert.ok(conf);
  assert.equal(conf.status, "pending");
  assert.equal(conf.meetUrl, null);
  assert.match(describeConference(conf), /still setting up/i);
});

check("meet: FAILURE conference reports no url and says so", () => {
  const conf = normalizeConferenceData({
    createRequest: { requestId: "req-1", status: { statusCode: "failure" } },
  });
  assert.ok(conf);
  assert.equal(conf.status, "failure");
  assert.equal(conf.meetUrl, null);
  assert.match(describeConference(conf), /didn’t create a Meet link/i);
});

check("meet: a conference id ALONE never becomes a url", () => {
  // The fabrication that must never happen: `abc-defg-hij` -> a plausible link.
  const conf = normalizeConferenceData({ conferenceId: "abc-defg-hij" });
  assert.ok(conf);
  assert.equal(conf.meetUrl, null, "a conferenceId is not a URL and must never be turned into one");
  assert.ok(!JSON.stringify(conf).includes("https://meet.google.com/abc-defg-hij"));
});

check("meet: an INVALID entry-point uri is rejected, not passed through", () => {
  const conf = normalizeConferenceData({
    conferenceId: "abc",
    entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com.evil.test/abc" }],
  });
  assert.ok(conf);
  assert.equal(conf.meetUrl, null, "an untrusted look-alike uri must not be reported");
});

check("meet: no conferenceData -> no conference at all", () => {
  assert.equal(normalizeConferenceData(undefined), null);
  assert.equal(normalizeConferenceData({}), null);
});

check("meet: an absent createRequest status reads as success (existing Meet)", () => {
  // Google omits createRequest on an event whose conference already exists.
  assert.equal(readConferenceStatus({ conferenceId: "x" }), "success");
  assert.equal(readConferenceStatus(undefined), "success");
});

check("meet: a phone entry point is kept alongside the video link", () => {
  const conf = normalizeConferenceData({
    entryPoints: [
      { entryPointType: "video", uri: REAL_MEET },
      { entryPointType: "phone", uri: "tel:+1-555-0100" },
    ],
  });
  assert.equal(conf?.meetUrl, REAL_MEET);
  assert.equal(conf?.phoneNumber, "tel:+1-555-0100");
});

// --- Retrieving an existing Meet -----------------------------------------

check("meet: retrieving an existing event's Meet link off a normalized read", () => {
  const norm = normalizeGoogleEvent(rawWithMeet(), "primary");
  assert.equal(norm.conference?.meetUrl, REAL_MEET);
  // And it renders into the card the user actually sees.
  assert.match(formatEventDetail(norm, TZ), /meet\.google\.com\/abc-defg-hij/);
});

check("meet: an event WITHOUT a Meet renders no link and claims none", () => {
  const norm = normalizeGoogleEvent(
    { id: "e", summary: "Gym", start: { dateTime: "2026-07-20T13:00:00-04:00" } },
    "primary",
  );
  assert.equal(norm.conference, null);
  assert.ok(!/meet\.google\.com/.test(formatEventDetail(norm, TZ)));
});

// --- Verification --------------------------------------------------------

check("meet verify: expecting a Meet that Google did NOT create is a mismatch", () => {
  // The conferenceDataVersion trap: a clean 200, an event that exists, no Meet.
  const v = verifyEventState(normEvent({ conference: null }), { expectMeet: true });
  assert.equal(v.ok, false);
  assert.deepEqual(v.mismatches, ["conference"]);
  assert.equal(v.conferencePending, false);
});

check("meet verify: a PENDING Meet is not a mismatch — it's a real state", () => {
  const v = verifyEventState(
    normEvent({ conference: { status: "pending", meetUrl: null, conferenceId: null, phoneNumber: null } }),
    { expectMeet: true },
  );
  assert.equal(v.conferencePending, true);
  assert.deepEqual(v.mismatches, []);
});

check("meet verify: a real link verifies", () => {
  const v = verifyEventState(
    normEvent({
      conference: { status: "success", meetUrl: REAL_MEET, conferenceId: "abc", phoneNumber: null },
    }),
    { expectMeet: true },
  );
  assert.equal(v.ok, true);
});

// --- Executor: end-to-end Meet creation with fakes ------------------------

asyncCheck("executor: a confirmed Meet create returns GOOGLE's url, not ours", async () => {
  let sent: CalendarEventWriteFields | null = null;

  const result = await executeAction(
    "user_fake",
    "calendar.createEvent",
    {
      input: {
        title: "Sync",
        startIso: START,
        endIso: END,
        timezone: TZ,
        conferenceRequestId: "req-pinned",
      },
      userConfirmed: true,
      proposalId: "prop_1",
    },
    {
      buildContext: async () => writeCalendarContext(),
      record: async () => "exec_1",
      createCalendarEvent: async (_u, fields) => {
        sent = fields;
        return normEvent({
          conference: { status: "success", meetUrl: REAL_MEET, conferenceId: "abc", phoneNumber: null },
        });
      },
      // The postcondition read agrees.
      getCalendarEvent: async () =>
        normEvent({
          conference: { status: "success", meetUrl: REAL_MEET, conferenceId: "abc", phoneNumber: null },
        }),
      recordActedCalendarEvent: async () => ({ id: "ctx_1" }),
    },
  );

  assert.equal(result.ok, true);
  // The exact requestId from the proposal is replayed — NOT regenerated.
  assert.equal(sent!.addConferenceRequestId, "req-pinned");
  assert.match(result.userMessage, /meet\.google\.com\/abc-defg-hij/);
});

asyncCheck("executor: a Meet Google did NOT create is reported honestly, not faked", async () => {
  // This is the anti-fabrication case, end to end: we asked for a Meet, Google
  // returned a perfectly valid event without one. Hula must NOT say "here's your
  // Meet", and must NOT go quiet about it either.
  const recorded: unknown[] = [];
  const result = await executeAction(
    "user_fake",
    "calendar.createEvent",
    {
      input: {
        title: "Sync",
        startIso: START,
        endIso: END,
        timezone: TZ,
        conferenceRequestId: "req-1",
      },
      userConfirmed: true,
      proposalId: "prop_1",
    },
    {
      buildContext: async () => writeCalendarContext(),
      record: async (_u, input) => {
        recorded.push(input);
        return "exec_1";
      },
      createCalendarEvent: async () => normEvent({ conference: null }),
      getCalendarEvent: async () => normEvent({ conference: null }),
      recordActedCalendarEvent: async () => ({ id: "ctx_1" }),
    },
  );

  assert.equal(result.ok, false, "an unmet expectation is not a success");
  assert.ok(!/meet\.google\.com/.test(result.userMessage), "must never invent a Meet URL");
  assert.match(result.userMessage, /didn’t attach a Meet link/i);
  assert.equal((recorded[0] as { status?: string })?.status, "failed");
});

asyncCheck("executor: a PENDING Meet is reported as pending, with no url", async () => {
  const pending = normEvent({
    conference: { status: "pending", meetUrl: null, conferenceId: null, phoneNumber: null },
  });
  const result = await executeAction(
    "user_fake",
    "calendar.createEvent",
    {
      input: {
        title: "Sync",
        startIso: START,
        endIso: END,
        timezone: TZ,
        conferenceRequestId: "req-1",
      },
      userConfirmed: true,
      proposalId: "prop_1",
    },
    {
      buildContext: async () => writeCalendarContext(),
      record: async () => "exec_1",
      createCalendarEvent: async () => pending,
      getCalendarEvent: async () => pending,
      recordActedCalendarEvent: async () => ({ id: "ctx_1" }),
    },
  );

  // Pending is a real, honest outcome: the event exists, the Meet is coming.
  assert.equal(result.ok, true);
  assert.ok(!/meet\.google\.com/.test(result.userMessage), "no url exists yet, so none may be shown");
  assert.match(result.userMessage, /still creating the Meet link/i);
});

asyncCheck("executor: a duplicate confirmation replays the SAME requestId", async () => {
  // Idempotency at the conference level: Google returns the SAME conference for a
  // repeated requestId, so a duplicate delivery cannot allocate a second Meet.
  const seen: string[] = [];
  const input = {
    title: "Sync",
    startIso: START,
    endIso: END,
    timezone: TZ,
    conferenceRequestId: "req-stable",
  };
  const deps = {
    buildContext: async () => writeCalendarContext(),
    record: async () => "exec_1",
    createCalendarEvent: async (_u: string, fields: CalendarEventWriteFields) => {
      seen.push(fields.addConferenceRequestId ?? "");
      return normEvent({
        conference: { status: "success", meetUrl: REAL_MEET, conferenceId: "abc", phoneNumber: null },
      });
    },
    getCalendarEvent: async () =>
      normEvent({
        conference: { status: "success", meetUrl: REAL_MEET, conferenceId: "abc", phoneNumber: null },
      }),
    recordActedCalendarEvent: async () => ({ id: "ctx_1" }),
  };

  await executeAction("u", "calendar.createEvent", { input, userConfirmed: true }, deps);
  await executeAction("u", "calendar.createEvent", { input, userConfirmed: true }, deps);

  assert.deepEqual(seen, ["req-stable", "req-stable"], "the stored id must be replayed verbatim");
});

asyncCheck("meet: no reply leaks token material", async () => {
  const result = await executeAction(
    "user_fake",
    "calendar.createEvent",
    {
      input: {
        title: "Sync",
        startIso: START,
        endIso: END,
        conferenceRequestId: "req-1",
      },
      userConfirmed: true,
    },
    {
      buildContext: async () => writeCalendarContext(),
      record: async () => "exec_1",
      createCalendarEvent: async () =>
        normEvent({
          conference: { status: "success", meetUrl: REAL_MEET, conferenceId: "abc", phoneNumber: null },
        }),
      getCalendarEvent: async () =>
        normEvent({
          conference: { status: "success", meetUrl: REAL_MEET, conferenceId: "abc", phoneNumber: null },
        }),
      recordActedCalendarEvent: async () => ({ id: "ctx_1" }),
    },
  );
  assert.ok(!/Bearer|ya29\.|access_token|refresh_token/i.test(JSON.stringify(result)));
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} Google Meet (Section 18) tests passed.`);
}

void run().catch((err) => {
  console.error("Google Meet tests failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
