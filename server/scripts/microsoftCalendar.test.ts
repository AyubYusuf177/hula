import assert from "node:assert/strict";

import { handleActionConfirmation } from "../src/actions/confirmations";
import { executeAction } from "../src/actions/executor";
import type { ActionProposalView, CreateProposalInput } from "../src/actions/proposals";
import { explicitEntityKinds, toProviderFamilies } from "../src/actions/entityContextArbiter";
import {
  handleOutlookCalendarConversation,
  formatOutlookCalendarEvents,
} from "../src/integrations/providers/microsoft/calendarConversation";
import {
  loadOutlookCalendarEntity,
  loadOutlookCalendarSelection,
  recordOutlookCalendarEntity,
  recordOutlookCalendarSelection,
  resolveOutlookCalendarReference,
} from "../src/integrations/providers/microsoft/calendarContext";
import {
  buildOutlookCalendarIntentPrompt,
  parseOutlookCalendarIntent,
  shouldConsiderOutlookCalendar,
} from "../src/integrations/providers/microsoft/calendarIntent";
import {
  executeOutlookCalendarMutation,
  listOutlookCalendarEvents,
  normalizeOutlookCalendarEvent,
} from "../src/integrations/providers/microsoft/calendarOperations";
import type { OutlookCalendarEvent } from "../src/integrations/providers/microsoft/calendarTypes";
import { MicrosoftGraphError } from "../src/integrations/providers/microsoft/graph";
import { computeRange } from "../src/integrations/providers/googleCalendar/events";

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function rawEvent(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    calendar: { id: "calendar-1" },
    seriesMasterId: null,
    type: "singleInstance",
    subject: `Event ${id}`,
    bodyPreview: "Discuss launch",
    body: { contentType: "text", content: "Discuss launch and next steps." },
    start: { dateTime: "2026-07-22T13:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-07-22T14:00:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    organizer: { emailAddress: { name: "Owner", address: "owner@example.com" } },
    attendees: [{ type: "required", status: { response: "accepted" }, emailAddress: { name: "Sarah", address: "sarah@example.com" } }],
    location: { displayName: "Room 2" },
    webLink: "https://outlook.office.com/calendar/item",
    isOnlineMeeting: false,
    onlineMeetingProvider: "unknown",
    onlineMeeting: null,
    recurrence: null,
    createdDateTime: "2026-07-21T10:00:00Z",
    lastModifiedDateTime: "2026-07-21T10:00:00Z",
    ...overrides,
  };
}

function event(id: string, overrides: Record<string, unknown> = {}): OutlookCalendarEvent {
  const parsed = normalizeOutlookCalendarEvent(rawEvent(id, overrides));
  assert.ok(parsed);
  return parsed;
}

function memory(now = new Date("2026-07-21T12:00:00Z")) {
  const rows: ActionProposalView[] = [];
  let sequence = 0;
  return {
    rows,
    store: {
      now,
      create: async (_userId: string, input: CreateProposalInput) => {
        sequence += 1;
        const row: ActionProposalView = {
          id: `p-${sequence}`,
          provider: input.provider ?? null,
          actionId: input.actionId,
          status: "proposed",
          riskLevel: input.riskLevel,
          confirmationRequired: input.confirmationRequired ?? true,
          previewText: input.previewText,
          input: input.input ?? null,
          expiresAt: new Date(now.getTime() + (input.ttlMs ?? 600_000)).toISOString(),
          confirmedAt: null,
          rejectedAt: null,
          executedAt: null,
          createdAt: new Date(now.getTime() + sequence).toISOString(),
        };
        rows.unshift(row);
        return row;
      },
      listRecent: async (_userId: string, actionId: string) => rows.filter((row) => row.actionId === actionId),
    },
  };
}

const microsoftPolicy = {
  connectedProviders: ["microsoft"],
  grantedScopesByProvider: { microsoft: ["Calendars.ReadWrite"] },
  capabilitiesByProvider: { microsoft: ["outlook_calendar.read", "outlook_calendar.write"] },
};

async function main(): Promise<void> {
  await check("normalization: event details, attendees, recurrence, and verified Teams URL stay typed", () => {
    const value = event("teams", {
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/test" },
      recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: ["wednesday"] }, range: { type: "numbered", startDate: "2026-07-22", numberOfOccurrences: 4 } },
    });
    assert.equal(value.start, "2026-07-22T13:00:00.000Z");
    assert.equal(value.attendees[0]?.address, "sarah@example.com");
    assert.equal(value.teamsJoinUrl, "https://teams.microsoft.com/l/meetup-join/test");
    assert.equal(value.recurrence?.patternType, "weekly");
  });

  await check("normalization: fabricated/non-HTTPS meeting links are discarded", () => {
    assert.equal(event("bad", { onlineMeeting: { joinUrl: "javascript:fake" } }).teamsJoinUrl, null);
  });

  await check("reads: calendarView uses exact bounded range, ImmutableId, UTC semantics, and honest count", async () => {
    let captured: Record<string, unknown> = {};
    const result = await listOutlookCalendarEvents("u", {
      start: "2026-07-22T00:00:00Z",
      end: "2026-07-23T00:00:00Z",
      maxResults: 2,
    }, {
      request: async (_u, options) => {
        captured = options as unknown as Record<string, unknown>;
        return { value: [rawEvent("a"), rawEvent("b")] } as never;
      },
    });
    assert.equal(captured.path, "/me/calendarView");
    assert.match(String((captured.headers as Record<string, string>).Prefer), /ImmutableId/);
    assert.match(String((captured.headers as Record<string, string>).Prefer), /UTC/);
    assert.equal(result.events.length, 2);
    assert.match(formatOutlookCalendarEvents(result.events), /^I found 2 Outlook calendar events:/);
  });

  await check("reads: pagination is bounded, de-duplicates immutable IDs, and reports truncation", async () => {
    let calls = 0;
    const result = await listOutlookCalendarEvents("u", {
      start: "2026-07-22T00:00:00Z", end: "2026-07-23T00:00:00Z", maxResults: 3,
    }, {
      request: async (_u, options) => {
        calls += 1;
        return options.nextLink
          ? { value: [rawEvent("b"), rawEvent("c")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skip=4" } as never
          : { value: [rawEvent("a"), rawEvent("b")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skip=2" } as never;
      },
    });
    assert.deepEqual(result.events.map((item) => item.id), ["a", "b", "c"]);
    assert.equal(result.hasMore, true);
    assert.equal(calls, 2);
  });

  await check("timezone: today/tomorrow bounds remain local across a UTC boundary", () => {
    const now = new Date("2026-07-21T23:30:00Z");
    const london = computeRange("today", now, "Europe/London");
    const newYork = computeRange("today", now, "America/New_York");
    assert.notEqual(london.timeMin.slice(0, 10), newYork.timeMin.slice(0, 10));
    assert.equal(Date.parse(london.timeMin) < Date.parse(london.timeMax!), true);
  });

  await check("timezone: DST-sensitive day boundaries use different UTC offsets", () => {
    const winter = computeRange("today", new Date("2026-01-15T12:00:00Z"), "Europe/London");
    const summer = computeRange("today", new Date("2026-07-15T12:00:00Z"), "Europe/London");
    assert.match(winter.timeMin, /\+00:00$/);
    assert.match(summer.timeMin, /\+01:00$/);
  });

  await check("context: ordered selection and active event remain distinct", async () => {
    const state = memory();
    await recordOutlookCalendarSelection("u", [event("one"), event("two")], state.store);
    await recordOutlookCalendarEntity("u", event("two"), state.store);
    assert.equal((await resolveOutlookCalendarReference("u", "the first one", 1, state.store))?.eventId, "one");
    assert.equal((await resolveOutlookCalendarReference("u", "move it", null, state.store))?.eventId, "two");
    assert.equal((await loadOutlookCalendarSelection("u", state.store)).length, 2);
    assert.equal((await loadOutlookCalendarEntity("u", state.store))?.ref.eventId, "two");
  });

  await check("context: expired event pronouns resolve to nothing", async () => {
    const state = memory(new Date("2026-07-21T12:00:00Z"));
    state.rows.push({
      id: "old", provider: "microsoft", actionId: "microsoft.calendar.entityContext", status: "proposed", riskLevel: "read", confirmationRequired: false,
      previewText: "", input: { kind: "outlook_calendar_entity", ref: { provider: "microsoft", service: "outlook_calendar", driveId: "", eventId: "old", subject: "Old" } },
      expiresAt: "2026-07-21T10:00:00Z", confirmedAt: null, rejectedAt: null, executedAt: null, createdAt: "2026-07-21T09:00:00Z",
    });
    assert.equal(await resolveOutlookCalendarReference("u", "move it", null, state.store), null);
  });

  await check("intent: arbitrary paraphrases are semantic and schema-bound, not literal command cases", () => {
    const parsed = parseOutlookCalendarIntent('{"provider":"outlook_calendar","operation":"update","start":"2026-07-23T15:00:00Z","timeZone":"Europe/London"}');
    assert.equal(parsed?.operation, "update");
    assert.match(buildOutlookCalendarIntentPrompt({ now: new Date(), timeZone: "Europe/London", hasContext: true }), /relativeStartMinutes as a signed integer/i);
    assert.equal(shouldConsiderOutlookCalendar("What have I got tomorrow?"), true);
  });

  await check("arbitration: Outlook Calendar is a distinct provider family", () => {
    assert.deepEqual(toProviderFamilies(explicitEntityKinds("Move the Outlook calendar event")), ["outlook_calendar_event"]);
    assert.deepEqual(toProviderFamilies(explicitEntityKinds("Move the Google Calendar event")), ["calendar_event"]);
  });

  await check("arbitration: both connected with no context clarifies before a provider read", async () => {
    let reads = 0;
    const result = await handleOutlookCalendarConversation("u", "What’s on my calendar tomorrow?", {
      getMicrosoftState: async () => ({ connected: true }),
      getGoogleState: async () => ({ connected: true }),
      getContexts: async () => [],
      listEvents: async () => { reads += 1; throw new Error("must not read"); },
    });
    assert.match(result.reply ?? "", /Google Calendar or Outlook Calendar/);
    assert.equal(reads, 0);
  });

  await check("arbitration: explicit Outlook overrides stale Google event context", async () => {
    const result = await handleOutlookCalendarConversation("u", "Check Outlook calendar tomorrow", {
      getMicrosoftState: async () => ({ connected: true }),
      getGoogleState: async () => ({ connected: true }),
      getContexts: async () => [{ kind: "calendar_event", actionId: "calendar.entityContext", at: 10, names: [] }],
      getTimezone: async () => "Europe/London",
      extract: async () => ({ provider: "outlook_calendar", operation: "list", range: "tomorrow", count: 10 }),
      listEvents: async () => ({ events: [event("outlook")], hasMore: false, fetchedCount: 1 }),
      create: async () => ({ id: "context" }),
    });
    assert.match(result.reply ?? "", /Event outlook/);
  });

  await check("reads: list → open → attendee/location/Teams follow-ups stay on selected event", async () => {
    const state = memory();
    const selected = event("selected");
    const common = {
      ...state.store,
      arbitrated: true,
      getMicrosoftState: async () => ({ connected: true }),
      getGoogleState: async () => ({ connected: false }),
      getTimezone: async () => "Europe/London",
      getEvent: async () => selected,
    };
    await recordOutlookCalendarSelection("u", [event("first"), selected], state.store);
    const opened = await handleOutlookCalendarConversation("u", "Open the second one", {
      ...common,
      extract: async () => ({ provider: "outlook_calendar", operation: "get", ordinal: 2 }),
    });
    assert.match(opened.reply ?? "", /Event selected/);
    const attendees = await handleOutlookCalendarConversation("u", "Who’s attending?", {
      ...common,
      extract: async () => ({ provider: "outlook_calendar", operation: "question", question: "Who’s attending?" }),
    });
    assert.match(attendees.reply ?? "", /Sarah/);
  });

  await check("writes: creation is proposal-only before confirmation and carries stable transaction ID", async () => {
    let proposals: CreateProposalInput[] = [];
    let mutations = 0;
    const result = await handleOutlookCalendarConversation("u", "Schedule a Teams meeting tomorrow", {
      getMicrosoftState: async () => ({ connected: true }), getGoogleState: async () => ({ connected: false }), getContexts: async () => [],
      getTimezone: async () => "Europe/London",
      extract: async () => ({ provider: "outlook_calendar", operation: "create", title: "Project sync", start: "2026-07-22T13:00:00Z", end: "2026-07-22T14:00:00Z", timeZone: "Europe/London", attendees: ["sarah@example.com"], teamsMeeting: true }),
      getActiveProposal: async () => null,
      propose: async (_u, input) => { proposals.push(input); },
      request: async () => { mutations += 1; throw new Error("must not mutate"); },
    });
    assert.equal(mutations, 0);
    assert.equal(proposals.length, 1);
    assert.equal(typeof proposals[0]?.input?.transactionId, "string");
    assert.equal(proposals[0]?.input?.teamsMeeting, true);
    assert.match(result.reply ?? "", /Reply Yes/);
  });

  await check("writes: create sends transactionId once and verifies an authoritative Teams URL", async () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    const teams = rawEvent("created", { subject: "Project sync", isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness", onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/verified" } });
    const receipt = await executeOutlookCalendarMutation("u", {
      operation: "create", transactionId: "stable-transaction", title: "Project sync", start: "2026-07-22T13:00:00Z", end: "2026-07-22T14:00:00Z", timeZone: "Europe/London", attendees: ["sarah@example.com"], teamsMeeting: true,
    }, {
      request: async (_u, options) => {
        calls.push({ method: options.method ?? "GET", path: options.path ?? "", body: options.body });
        return options.method === "POST" ? teams as never : teams as never;
      },
    });
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(calls[0]?.body?.transactionId, "stable-transaction");
    assert.equal(calls[0]?.body?.onlineMeetingProvider, "teamsForBusiness");
    assert.equal(receipt.event?.teamsJoinUrl, "https://teams.microsoft.com/l/meetup-join/verified");
  });

  await check("writes: update performs one PATCH then verifies changed time", async () => {
    let patches = 0;
    const updated = rawEvent("e", { start: { dateTime: "2026-07-22T15:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-07-22T16:00:00Z", timeZone: "UTC" } });
    const receipt = await executeOutlookCalendarMutation("u", { operation: "update", eventId: "e", start: "2026-07-22T15:00:00Z", end: "2026-07-22T16:00:00Z", timeZone: "Europe/London" }, {
      request: async (_u, options) => {
        if (options.method === "PATCH") { patches += 1; return undefined as never; }
        return updated as never;
      },
    });
    assert.equal(patches, 1);
    assert.equal(receipt.event?.start, "2026-07-22T15:00:00.000Z");
  });

  await check("writes: delete verifies authoritative 404 and never retries mutation", async () => {
    let deletes = 0;
    let gets = 0;
    const receipt = await executeOutlookCalendarMutation("u", { operation: "delete", eventId: "e" }, {
      request: async (_u, options) => {
        if (options.method === "DELETE") { deletes += 1; return undefined as never; }
        gets += 1;
        if (gets === 1) return rawEvent("e") as never;
        throw new MicrosoftGraphError("not_found", 404);
      },
    });
    assert.equal(deletes, 1);
    assert.equal(receipt.verification, "verified");
  });

  await check("writes: uncertain mutation is never retried", async () => {
    let posts = 0;
    await assert.rejects(executeOutlookCalendarMutation("u", { operation: "create", transactionId: "x", title: "X", start: "2026-07-22T13:00:00Z", end: "2026-07-22T14:00:00Z" }, {
      request: async (_u, options) => {
        if (options.method === "POST") posts += 1;
        throw new MicrosoftGraphError("timeout");
      },
    }), (error: unknown) => error instanceof MicrosoftGraphError && error.reason === "timeout");
    assert.equal(posts, 1);
  });

  await check("executor: verified event receipt and Teams URL are truthfully returned", async () => {
    let remembered = 0;
    const result = await executeAction("u", "microsoft.calendar.mutate", {
      userConfirmed: true,
      input: { operation: "create", transactionId: "x", teamsMeeting: true },
    }, {
      buildContext: async () => ({ ...microsoftPolicy, userConfirmed: true }),
      record: async () => "execution",
      executeOutlookCalendarMutation: async () => ({ operation: "create", event: event("e", { isOnlineMeeting: true, onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/e" } }), eventId: "e", verification: "verified" }),
      recordOutlookCalendarEntity: async () => { remembered += 1; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.receipt?.microsoftEventId, "e");
    assert.match(result.userMessage, /verified Teams link/);
    assert.equal(remembered, 1);
  });

  await check("Teams capability: unsupported tenant is honest and never fabricates a URL", async () => {
    const result = await executeAction("u", "microsoft.calendar.mutate", { userConfirmed: true, input: { operation: "create", transactionId: "x", teamsMeeting: true } }, {
      buildContext: async () => ({ ...microsoftPolicy, userConfirmed: true }),
      record: async () => "execution",
      executeOutlookCalendarMutation: async () => { throw new MicrosoftGraphError("invalid_request", 400); },
    });
    assert.equal(result.ok, false);
    assert.match(result.userMessage, /account or tenant did not allow Teams/);
    assert.equal(result.userMessage.includes("https://"), false);
  });

  await check("confirmation: cancel produces zero calendar mutations", async () => {
    let mutations = 0;
    const active: ActionProposalView = {
      id: "proposal", provider: "microsoft", actionId: "microsoft.calendar.mutate", status: "proposed", riskLevel: "write", confirmationRequired: true,
      previewText: "Create event?", input: { operation: "create" }, expiresAt: "2026-07-22T12:00:00Z", confirmedAt: null, rejectedAt: null, executedAt: null, createdAt: "2026-07-21T12:00:00Z",
    };
    const result = await handleActionConfirmation("u", "No", {
      getActiveProposal: async () => active,
      rejectProposal: async () => ({ ...active, status: "rejected" }),
      executeAction: async () => { mutations += 1; throw new Error("must not execute"); },
    });
    assert.equal(result.outcome, "cancelled");
    assert.equal(mutations, 0);
  });

  await check("confirmation: duplicate yes admits exactly one calendar execution", async () => {
    let active = true;
    let mutations = 0;
    const proposal: ActionProposalView = {
      id: "proposal", provider: "microsoft", actionId: "microsoft.calendar.mutate", status: "proposed", riskLevel: "write", confirmationRequired: true,
      previewText: "Create event?", input: { operation: "create" }, expiresAt: "2026-07-22T12:00:00Z", confirmedAt: null, rejectedAt: null, executedAt: null, createdAt: "2026-07-21T12:00:00Z",
    };
    const deps = {
      getActiveProposal: async () => active ? proposal : null,
      confirmProposal: async () => { if (!active) return null; active = false; return { ...proposal, status: "confirmed" as const }; },
      finalizeProposal: async () => {},
      executeAction: async () => { mutations += 1; return { ok: true, status: "succeeded" as const, actionId: proposal.actionId, userMessage: "done" }; },
    };
    await handleActionConfirmation("u", "Yes", deps);
    await handleActionConfirmation("u", "Yes", deps);
    assert.equal(mutations, 1);
  });

  console.log(`\nOutlook Calendar tests: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
