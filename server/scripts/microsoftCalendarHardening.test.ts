import assert from "node:assert/strict";

import { handleActionConfirmation } from "../src/actions/confirmations";
import type { ActionProposalView, CreateProposalInput } from "../src/actions/proposals";
import { handleOutlookCalendarConversation } from "../src/integrations/providers/microsoft/calendarConversation";
import { recordOutlookCalendarEntity } from "../src/integrations/providers/microsoft/calendarContext";
import { parseOutlookCalendarIntent } from "../src/integrations/providers/microsoft/calendarIntent";
import {
  executeOutlookCalendarMutation,
  normalizeOutlookCalendarEvent,
} from "../src/integrations/providers/microsoft/calendarOperations";
import type { OutlookCalendarEvent } from "../src/integrations/providers/microsoft/calendarTypes";
import { MicrosoftGraphError } from "../src/integrations/providers/microsoft/graph";
import { routeInboundText } from "../src/routes/inboundRouting";

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function rawEvent(id: string, subject: string, start = "2026-07-22T10:00:00Z", end = "2026-07-22T10:30:00Z") {
  return {
    id,
    calendar: { id: "calendar-1" },
    subject,
    bodyPreview: "",
    body: { contentType: "text", content: "" },
    start: { dateTime: start, timeZone: "Europe/London" },
    end: { dateTime: end, timeZone: "Europe/London" },
    isAllDay: false,
    isCancelled: false,
    attendees: [],
    location: { displayName: "" },
    isOnlineMeeting: false,
  };
}

function event(id: string, subject: string, start?: string, end?: string): OutlookCalendarEvent {
  const normalized = normalizeOutlookCalendarEvent(rawEvent(id, subject, start, end));
  assert.ok(normalized);
  return normalized;
}

function memory(now = new Date("2026-07-21T22:00:00Z")) {
  const rows: ActionProposalView[] = [];
  let sequence = 0;
  const store = {
    now,
    create: async (_userId: string, input: CreateProposalInput) => {
      sequence += 1;
      const row: ActionProposalView = {
        id: `row-${sequence}`,
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
  };
  return { rows, store };
}

function connected() {
  return {
    getMicrosoftState: async () => ({ connected: true }),
    getGoogleState: async () => ({ connected: false }),
    getTimezone: async () => "Europe/London",
    getContexts: async () => [{ kind: "outlook_calendar_event" as const, actionId: "microsoft.calendar.entityContext", at: 1, names: [] }],
    arbitrated: true,
  };
}

async function proposalFor(intent: Record<string, unknown>, active = event("active", "Hula Final Certification")) {
  const state = memory();
  await recordOutlookCalendarEntity("u", active, state.store);
  const captured: { value?: CreateProposalInput } = {};
  const result = await handleOutlookCalendarConversation("u", "change the selected event", {
    ...connected(),
    ...state.store,
    extract: async () => ({ provider: "outlook_calendar", operation: "update", ...intent }),
    getEvent: async (_userId, id) => {
      assert.equal(id, active.id);
      return active;
    },
    getActiveProposal: async () => null,
    propose: async (_userId, input) => { captured.value = input; },
  });
  return { result, proposal: captured.value, state };
}

async function main(): Promise<void> {
  await check("relative intent variants normalize to one signed-minute contract", () => {
    assert.equal(parseOutlookCalendarIntent('{"provider":"outlook_calendar","operation":"update","shiftMinutes":60}')?.relativeStartMinutes, 60);
    assert.equal(parseOutlookCalendarIntent('{"provider":"outlook_calendar","operation":"update","deltaMinutes":-30}')?.relativeStartMinutes, -30);
  });

  await check("11:00–11:30 shifted one hour proposes exactly 12:00–12:30", async () => {
    const active = event("active", "Hula Final Certification", "2026-07-22T10:00:00Z", "2026-07-22T10:30:00Z");
    const { proposal, result } = await proposalFor({ relativeStartMinutes: 60 }, active);
    assert.equal(proposal?.input?.start, "2026-07-22T11:00:00.000Z");
    assert.equal(proposal?.input?.end, "2026-07-22T11:30:00.000Z");
    assert.match(result.reply ?? "", /From:/);
    assert.match(result.reply ?? "", /To:/);
    assert.doesNotMatch(result.reply ?? "", /Location: none/);
  });

  await check("relative shifts preserve event duration and timezone", async () => {
    const { proposal } = await proposalFor({ relativeStartMinutes: 30 });
    assert.equal(Date.parse(String(proposal?.input?.end)) - Date.parse(String(proposal?.input?.start)), 30 * 60_000);
    assert.equal(proposal?.input?.timeZone, "Europe/London");
  });

  await check("absolute move to 4pm preserves the authoritative duration", async () => {
    const { proposal } = await proposalFor({ start: "2026-07-22T15:00:00Z" });
    assert.equal(proposal?.input?.start, "2026-07-22T15:00:00.000Z");
    assert.equal(proposal?.input?.end, "2026-07-22T15:30:00.000Z");
  });

  await check("30 minutes later computes both exact fields", async () => {
    const { proposal } = await proposalFor({ relativeStartMinutes: 30 });
    assert.equal(proposal?.input?.start, "2026-07-22T10:30:00.000Z");
    assert.equal(proposal?.input?.end, "2026-07-22T11:00:00.000Z");
  });

  await check("one hour earlier computes both exact fields", async () => {
    const { proposal } = await proposalFor({ relativeStartMinutes: -60 });
    assert.equal(proposal?.input?.start, "2026-07-22T09:00:00.000Z");
    assert.equal(proposal?.input?.end, "2026-07-22T09:30:00.000Z");
  });

  await check("a no-op time patch cannot create an executable proposal", async () => {
    const active = event("active", "Hula Final Certification");
    let proposals = 0;
    const state = memory();
    await recordOutlookCalendarEntity("u", active, state.store);
    const result = await handleOutlookCalendarConversation("u", "move it to the same time", {
      ...connected(), ...state.store,
      extract: async () => ({ provider: "outlook_calendar", operation: "update", start: active.start, end: active.end }),
      getEvent: async () => active,
      getActiveProposal: async () => null,
      propose: async () => { proposals += 1; },
    });
    assert.equal(proposals, 0);
    assert.match(result.reply ?? "", /already at the requested time/);
  });

  await check("PATCH success plus stale GET fails field verification", async () => {
    let patches = 0;
    await assert.rejects(executeOutlookCalendarMutation("u", {
      operation: "update", eventId: "active", start: "2026-07-22T11:00:00Z", end: "2026-07-22T11:30:00Z", timeZone: "Europe/London",
    }, {
      request: async (_userId, options) => {
        if (options.method === "PATCH") { patches += 1; return {} as never; }
        return rawEvent("active", "Hula Final Certification") as never;
      },
    }), (error: unknown) => error instanceof MicrosoftGraphError && error.reason === "verification_inconclusive");
    assert.equal(patches, 1);
  });

  await check("explicit named delete overrides a different active event", async () => {
    const active = event("teams", "Hula Teams Final Check", "2026-07-22T13:00:00Z", "2026-07-22T13:30:00Z");
    const named = event("final", "Hula Final Certification");
    const state = memory();
    await recordOutlookCalendarEntity("u", active, state.store);
    const captured: { value?: CreateProposalInput } = {};
    const result = await handleOutlookCalendarConversation("u", "Delete my Outlook event called Hula Final Certification.", {
      ...connected(), ...state.store,
      extract: async () => ({ provider: "outlook_calendar", operation: "delete", eventQuery: "Hula Final Certification" }),
      listEvents: async () => ({ events: [active, named], hasMore: false, fetchedCount: 2 }),
      getActiveProposal: async () => null,
      propose: async (_userId, input) => { captured.value = input; },
    });
    assert.equal(captured.value?.input?.eventId, "final");
    assert.match(result.reply ?? "", /Hula Final Certification/);
    assert.doesNotMatch(result.reply ?? "", /Hula Teams Final Check/);
  });

  await check("explicit named reschedule binds the named stable ID and patch", async () => {
    const active = event("teams", "Hula Teams Final Check");
    const named = event("final", "Hula Final Certification");
    const state = memory();
    await recordOutlookCalendarEntity("u", active, state.store);
    const captured: { value?: CreateProposalInput } = {};
    await handleOutlookCalendarConversation("u", "Move Hula Final Certification an hour later in Outlook Calendar.", {
      ...connected(), ...state.store,
      extract: async () => ({ provider: "outlook_calendar", operation: "update", eventQuery: "Hula Final Certification", relativeStartMinutes: 60 }),
      listEvents: async () => ({ events: [active, named], hasMore: false, fetchedCount: 2 }),
      getActiveProposal: async () => null,
      propose: async (_userId, input) => { captured.value = input; },
    });
    assert.equal(captured.value?.input?.eventId, "final");
    assert.equal(captured.value?.input?.start, "2026-07-22T11:00:00.000Z");
  });

  await check("explicit named title, location, attendee, and description updates all bind the named stable ID", async () => {
    const cases: Array<{
      intent: { title?: string; location?: string; attendees?: string[]; description?: string };
      field: "title" | "location" | "attendees" | "description";
      expected: unknown;
    }> = [
      { intent: { title: "Renamed certification" }, field: "title", expected: "Renamed certification" },
      { intent: { location: "Room 4" }, field: "location", expected: "Room 4" },
      { intent: { attendees: ["sarah@example.com"] }, field: "attendees", expected: ["sarah@example.com"] },
      { intent: { description: "Bring the final checklist." }, field: "description", expected: "Bring the final checklist." },
    ];
    for (const item of cases) {
      const active = event("teams", "Hula Teams Final Check");
      const named = event("final", "Hula Final Certification");
      const state = memory();
      await recordOutlookCalendarEntity("u", active, state.store);
      const captured: { value?: CreateProposalInput } = {};
      const result = await handleOutlookCalendarConversation("u", "Update Hula Final Certification in Outlook Calendar.", {
        ...connected(), ...state.store,
        extract: async () => ({
          provider: "outlook_calendar",
          operation: "update",
          eventQuery: "Hula Final Certification",
          ...item.intent,
        }),
        listEvents: async () => ({ events: [active, named], hasMore: false, fetchedCount: 2 }),
        getActiveProposal: async () => null,
        propose: async (_userId, input) => { captured.value = input; },
      });
      assert.equal(captured.value?.input?.eventId, "final");
      assert.deepEqual(captured.value?.input?.[item.field], item.expected);
      assert.match(result.reply ?? "", /Hula Final Certification/);
      assert.doesNotMatch(result.reply ?? "", /Hula Teams Final Check/);
    }
  });

  await check("an update proposal contains only meaningful requested fields", async () => {
    const { proposal, result } = await proposalFor({ relativeStartMinutes: 60, location: null });
    assert.deepEqual(Object.keys(proposal?.input ?? {}).sort(), ["end", "eventId", "operation", "start", "timeZone"]);
    assert.doesNotMatch(result.reply ?? "", /Location:/);
  });

  await check("one inbound shift request yields one routed proposal and repeated Yes yields one execution", async () => {
    const decline = async () => ({ handled: false as const });
    let replies = 0;
    const routed = await routeInboundText("u", "Move it an hour later.", {
      transportKeyword: decline,
      confirmation: decline,
      entityFollowup: async () => ({ handled: true, reply: "Update event?\nFrom: 11:00–11:30\nTo: 12:00–12:30\nReply Yes to confirm or No to cancel.", routeSource: "outlookCalendar" }),
      memory: async () => { throw new Error("must not reach memory"); },
      pendingReprompt: decline,
    });
    if (routed) replies += 1;
    assert.equal(replies, 1);
    assert.equal(routed?.source, "outlookCalendar");

    const proposal: ActionProposalView = {
      id: "p", provider: "microsoft", actionId: "microsoft.calendar.mutate", status: "proposed", riskLevel: "write", confirmationRequired: true,
      previewText: "Update event?", input: { operation: "update" }, expiresAt: "2026-07-22T12:00:00Z", confirmedAt: null, rejectedAt: null, executedAt: null, createdAt: "2026-07-21T22:00:00Z",
    };
    let active = true;
    let executions = 0;
    const deps = {
      getActiveProposal: async () => active ? proposal : null,
      getRecentResolvedProposal: async () => ({ ...proposal, status: "executed" as const, executedAt: "2026-07-21T22:00:01Z" }),
      confirmProposal: async () => { active = false; return { ...proposal, status: "confirmed" as const }; },
      finalizeProposal: async () => {},
      executeAction: async () => { executions += 1; return { ok: true, status: "succeeded" as const, actionId: proposal.actionId, userMessage: "Updated." }; },
    };
    await handleActionConfirmation("u", "Yes", deps);
    const duplicate = await handleActionConfirmation("u", "Yes", deps);
    assert.equal(executions, 1);
    assert.equal(duplicate.handled, true);
    assert.match(duplicate.reply ?? "", /already completed/);
  });

  console.log(`\nMicrosoft Calendar hardening tests: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
