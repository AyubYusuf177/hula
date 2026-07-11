import assert from "node:assert/strict";

import {
  ACTION_DEFINITIONS,
  getActionDefinition,
  isKnownAction,
  listActionDefinitions,
  type ActionDefinition,
} from "../src/actions/registry";
import {
  evaluateActionForUser,
  type ActionPolicyContext,
} from "../src/actions/policy";
import { classifyConfirmationReply } from "../src/actions/confirmations";
import { detectActionIntent } from "../src/actions/detect";
import { executeAction } from "../src/actions/executor";
import type { RecordExecutionInput } from "../src/actions/executions";
import type { NormalizedCalendarEvent } from "../src/integrations/providers/googleCalendar/types";

/**
 * Offline tests for the Section 12 agentic action runtime. Everything here is
 * PURE or uses injected fakes — NO database, NO network, NO real provider API,
 * NO Anthropic. Covers the action registry, the policy engine, confirmation +
 * cancellation phrase detection, imperative action-intent detection, and the
 * executor read path (with a fake fetch) proving it never returns a token.
 * Run with: `npm test`.
 */

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): void {
  const result = fn();
  if (result instanceof Promise) {
    throw new Error(`check '${name}' returned a promise; use asyncCheck`);
  }
  passed += 1;
  console.log(`  ok - ${name}`);
}

const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function asyncCheck(name: string, fn: () => Promise<void>): void {
  asyncChecks.push({ name, fn });
}

const GCAL_READONLY = "https://www.googleapis.com/auth/calendar.readonly";

/** A context with a fully-connected Google Calendar (read scope + capability). */
function connectedCalendarContext(userConfirmed?: boolean): ActionPolicyContext {
  return {
    connectedProviders: ["google_calendar"],
    grantedScopesByProvider: { google_calendar: [GCAL_READONLY] },
    capabilitiesByProvider: { google_calendar: ["read_calendar_events"] },
    userConfirmed,
  };
}

/** An empty context — nothing connected. */
function emptyContext(): ActionPolicyContext {
  return {
    connectedProviders: [],
    grantedScopesByProvider: {},
    capabilitiesByProvider: {},
  };
}

// --- Registry ------------------------------------------------------------

check("registry: contains the expected actions", () => {
  const ids = listActionDefinitions().map((a) => a.actionId);
  for (const expected of [
    "calendar.listEvents",
    "calendar.findNextEvent",
    "calendar.createEvent",
    "calendar.updateEvent",
    "calendar.cancelEvent",
    "email.search",
    "email.createDraft",
    "email.sendDraft",
    "task.create",
    "task.complete",
    "document.search",
    "document.appendText",
    "slack.postMessage",
    "shopping.createList",
  ]) {
    assert.ok(ids.includes(expected), `missing action: ${expected}`);
  }
});

check("registry: every action has complete, typed metadata", () => {
  for (const a of ACTION_DEFINITIONS) {
    assert.ok(a.actionId.includes("."), "actionId should be dotted");
    assert.ok(a.displayName.length > 0, "displayName required");
    assert.ok(a.userFacingDescription.length > 0, "userFacingDescription required");
    assert.ok(
      ["read", "draft", "write", "send", "purchase", "destructive"].includes(a.riskLevel),
    );
    assert.ok(Array.isArray(a.providerTypes));
    assert.ok(Array.isArray(a.requiredScopes));
    assert.ok(Array.isArray(a.inputSchema));
    assert.equal(typeof a.implemented, "boolean");
    assert.equal(typeof a.enabled, "boolean");
  }
});

check("registry: only the two calendar reads are implemented today", () => {
  const implemented = ACTION_DEFINITIONS.filter((a) => a.implemented).map((a) => a.actionId);
  assert.deepEqual(implemented.sort(), ["calendar.findNextEvent", "calendar.listEvents"]);
  // No implemented action writes/sends/buys.
  for (const a of ACTION_DEFINITIONS) {
    if (a.implemented) assert.equal(a.riskLevel, "read", `${a.actionId} must be read-only`);
  }
});

check("registry: risk levels and confirmation rules are coherent", () => {
  for (const a of ACTION_DEFINITIONS) {
    if (a.riskLevel === "read") {
      assert.equal(a.confirmationRequired, false, `${a.actionId} read needs no confirmation`);
    } else {
      // Any non-read (draft/write/send/purchase/destructive) requires confirmation.
      assert.equal(a.confirmationRequired, true, `${a.actionId} must require confirmation`);
    }
  }
});

check("registry: lookup helpers work", () => {
  assert.ok(getActionDefinition("calendar.listEvents"));
  assert.equal(getActionDefinition("nope.nope"), undefined);
  assert.equal(isKnownAction("email.sendDraft"), true);
  assert.equal(isKnownAction("email.bogus"), false);
});

// --- Policy engine -------------------------------------------------------

check("policy: read action allowed with connected provider + scope", () => {
  const action = getActionDefinition("calendar.listEvents") as ActionDefinition;
  const result = evaluateActionForUser(action, connectedCalendarContext());
  assert.equal(result.allowed, true);
  assert.equal(result.needsConfirmation, false);
  assert.equal(result.provider, "google_calendar");
});

check("policy: read action BLOCKED when provider not connected", () => {
  const action = getActionDefinition("calendar.listEvents") as ActionDefinition;
  const result = evaluateActionForUser(action, emptyContext());
  assert.equal(result.allowed, false);
  assert.equal(result.needsConnection, true);
  assert.equal(result.blockedReason, "needs_connection");
});

check("policy: read action BLOCKED when scope not granted", () => {
  const action = getActionDefinition("calendar.listEvents") as ActionDefinition;
  const result = evaluateActionForUser(action, {
    connectedProviders: ["google_calendar"],
    grantedScopesByProvider: { google_calendar: [] },
    capabilitiesByProvider: { google_calendar: ["read_calendar_events"] },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.needsScope, true);
  assert.equal(result.blockedReason, "needs_scope");
});

check("policy: stub write action returns not_implemented", () => {
  const action = getActionDefinition("calendar.createEvent") as ActionDefinition;
  // Even with a fully connected calendar, an unimplemented action can't run.
  const result = evaluateActionForUser(action, connectedCalendarContext(true));
  assert.equal(result.allowed, false);
  assert.equal(result.blockedReason, "not_implemented");
  assert.ok((result.userMessage ?? "").length > 0);
});

check("policy: purchases and destructive actions are blocked", () => {
  const base = {
    category: "shopping" as const,
    displayName: "x",
    description: "x",
    providerTypes: [] as never[],
    requiredCapabilities: [],
    requiredScopes: [],
    confirmationRequired: true,
    implemented: true,
    enabled: true,
    inputSchema: [],
    examples: [],
    userFacingDescription: "x",
  };
  const purchase = evaluateActionForUser(
    { ...base, actionId: "test.purchase", riskLevel: "purchase" },
    connectedCalendarContext(true),
  );
  const destructive = evaluateActionForUser(
    { ...base, actionId: "test.destructive", riskLevel: "destructive" },
    connectedCalendarContext(true),
  );
  assert.equal(purchase.allowed, false);
  assert.equal(purchase.blockedReason, "not_allowed_yet");
  assert.equal(destructive.allowed, false);
  assert.equal(destructive.blockedReason, "not_allowed_yet");
});

check("policy: an implemented write needs confirmation before it runs", () => {
  // Synthetic implemented write to exercise the confirmation gate (no real one
  // is implemented yet).
  const action: ActionDefinition = {
    actionId: "test.write",
    category: "calendar",
    displayName: "x",
    description: "x",
    providerTypes: ["google_calendar"],
    requiredCapabilities: [],
    requiredScopes: [GCAL_READONLY],
    riskLevel: "write",
    confirmationRequired: true,
    implemented: true,
    enabled: true,
    inputSchema: [],
    examples: [],
    userFacingDescription: "x",
  };
  const unconfirmed = evaluateActionForUser(action, connectedCalendarContext());
  assert.equal(unconfirmed.allowed, false);
  assert.equal(unconfirmed.needsConfirmation, true);
  assert.equal(unconfirmed.blockedReason, "needs_confirmation");

  const confirmed = evaluateActionForUser(action, connectedCalendarContext(true));
  assert.equal(confirmed.allowed, true);
});

// --- Confirmation / cancellation phrase detection ------------------------

check("confirmations: confirm phrases are detected", () => {
  for (const phrase of ["yes", "Yes!", "yep", "confirm", "do it", "go ahead", "sounds good", "ok"]) {
    assert.equal(classifyConfirmationReply(phrase), "confirm", `should confirm: ${phrase}`);
  }
});

check("confirmations: cancel phrases are detected", () => {
  for (const phrase of ["no", "No.", "nope", "cancel", "don't", "never mind", "stop"]) {
    assert.equal(classifyConfirmationReply(phrase), "cancel", `should cancel: ${phrase}`);
  }
});

check("confirmations: ordinary messages are neither", () => {
  for (const phrase of ["what's on my calendar", "yes but can you also", "send an email to Rob", ""]) {
    assert.equal(classifyConfirmationReply(phrase), "none", `should be none: ${phrase}`);
  }
});

// --- Imperative action-intent detection ----------------------------------

check("detect: imperative create/send intents map to actions", () => {
  assert.equal(detectActionIntent("schedule gym tomorrow at 7pm"), "calendar.createEvent");
  assert.equal(detectActionIntent("book a call with Sam on Friday"), "calendar.createEvent");
  assert.equal(detectActionIntent("send an email to Rob"), "email.sendDraft");
  assert.equal(detectActionIntent("draft an email to my accountant"), "email.createDraft");
  assert.equal(detectActionIntent("create a task to renew my passport"), "task.create");
});

check("detect: questions and chatter do NOT match", () => {
  for (const q of [
    "what's on my calendar today",
    "when's my next meeting",
    "what should I say in an email to Rob",
    "how do I schedule a meeting",
    "thanks!",
  ]) {
    assert.equal(detectActionIntent(q), null, `should not match: ${q}`);
  }
});

// --- Executor (fakes only — no DB, no network) ---------------------------

const sampleEvent: NormalizedCalendarEvent = {
  id: "e1",
  calendarId: "primary",
  summary: "Standup",
  location: null,
  start: "2026-07-11T09:00:00Z",
  end: "2026-07-11T09:15:00Z",
  allDay: false,
  status: "confirmed",
  htmlLink: null,
  attendeeCount: 3,
  organizerEmail: "someone@example.com",
  source: "google_calendar",
};

asyncCheck("executor: calendar read routes through the read helper, no token leak", async () => {
  const recorded: RecordExecutionInput[] = [];
  const result = await executeAction(
    "user_fake",
    "calendar.listEvents",
    { input: { range: "today" } },
    {
      buildContext: async () => connectedCalendarContext(),
      fetchEvents: async () => [sampleEvent],
      getTimezone: async () => "UTC",
      record: async (_userId, input) => {
        recorded.push(input);
        return "exec_1";
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  // The reply reflects the fake event but carries NO token/secret.
  assert.ok(/Standup/.test(result.userMessage));
  const blob = JSON.stringify({ result, recorded });
  assert.ok(!/Bearer|ya29\.|access_token|refresh/i.test(blob), "no token material anywhere");
  // Ledger keeps only a count, never event payloads.
  assert.deepEqual(recorded[0]?.resultSummary, { eventCount: 1 });
});

asyncCheck("executor: stub write action is blocked with an honest message", async () => {
  const recorded: RecordExecutionInput[] = [];
  const result = await executeAction(
    "user_fake",
    "calendar.createEvent",
    { input: { title: "Gym" } },
    {
      buildContext: async () => connectedCalendarContext(true),
      record: async (_userId, input) => {
        recorded.push(input);
        return "exec_2";
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(recorded[0]?.status, "blocked");
  assert.ok(/not enabled|only read/i.test(result.userMessage), "must stay honest");
});

asyncCheck("executor: unknown action fails safely without a provider call", async () => {
  let fetched = false;
  const result = await executeAction(
    "user_fake",
    "bogus.action",
    {},
    {
      buildContext: async () => emptyContext(),
      fetchEvents: async () => {
        fetched = true;
        return [];
      },
      record: async () => "exec_3",
    },
  );
  assert.equal(result.ok, false);
  assert.equal(fetched, false, "must not call a provider for an unknown action");
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} action runtime tests passed.`);
}

void run();
