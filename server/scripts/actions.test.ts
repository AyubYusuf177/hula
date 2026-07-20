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
import { GmailError } from "../src/integrations/providers/gmail/client";
import {
  GoogleCalendarError,
  type GoogleCalendarErrorReason,
} from "../src/integrations/providers/googleCalendar/client";

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

/**
 * A calendar connection that granted the WRITE scope + capability (Section 17) —
 * i.e. a user who reconnected after calendar writes shipped.
 */
function writeCalendarContext(userConfirmed?: boolean): ActionPolicyContext {
  return {
    connectedProviders: ["google_calendar"],
    grantedScopesByProvider: {
      google_calendar: [GCAL_READONLY, "https://www.googleapis.com/auth/calendar.events"],
    },
    capabilitiesByProvider: {
      google_calendar: ["read_calendar_events", "write_calendar_events"],
    },
    userConfirmed,
  };
}

/** An ISO instant safely in the future (default +1h), for never-past checks. */
function futureIso(offsetMinutes = 60): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

/** An empty context — nothing connected. */
function emptyContext(): ActionPolicyContext {
  return {
    connectedProviders: [],
    grantedScopesByProvider: {},
    capabilitiesByProvider: {},
  };
}

function notionWriteContext(userConfirmed?: boolean): ActionPolicyContext {
  return {
    connectedProviders: ["notion"],
    grantedScopesByProvider: { notion: ["content:write", "comments:write"] },
    capabilitiesByProvider: { notion: ["content.write", "comments.write"] },
    userConfirmed,
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
      ["read", "draft", "modify", "write", "send", "purchase", "destructive"].includes(
        a.riskLevel,
      ),
      `${a.actionId} has an unknown risk level: ${a.riskLevel}`,
    );
    assert.ok(Array.isArray(a.providerTypes));
    assert.ok(Array.isArray(a.requiredScopes));
    assert.ok(Array.isArray(a.inputSchema));
    assert.equal(typeof a.implemented, "boolean");
    assert.equal(typeof a.enabled, "boolean");
  }
});

check("registry: implemented actions include the Notion adapter", () => {
  const implemented = ACTION_DEFINITIONS.filter((a) => a.implemented).map((a) => a.actionId);
  // Section 16 added real Gmail draft creation + send to the Section 11 calendar
  // reads; Section 17 adds the confirmation-gated calendar event writes; Section 19
  // adds the Todoist task lifecycle.
  assert.deepEqual(implemented.sort(), [
    "asana.portfolio.membership",
    "asana.portfolio.write",
    "asana.project.delete",
    "asana.project.write",
    "asana.task.attachUrl",
    "asana.task.comment",
    "asana.task.create",
    "asana.task.delete",
    "asana.task.relationship",
    "asana.task.update",
    "calendar.cancelEvent",
    "calendar.createEvent",
    "calendar.findNextEvent",
    "calendar.listEvents",
    "calendar.updateEvent",
    "drive.createDocument",
    "drive.createFolder",
    "email.createDraft",
    "email.deleteDraft",
    "email.modifyLabels",
    "email.sendDraft",
    "email.trash",
    "email.untrash",
    "email.updateDraft",
    "notion.mutate",
    "slack.mutate",
    "slack.postMessage",
    "task.complete",
    "task.create",
    "task.delete",
    "task.move",
    "task.reopen",
    "task.update",
  ]);
  // No implemented action is a purchase/destructive risk.
  for (const a of ACTION_DEFINITIONS) {
    if (a.implemented) {
      assert.ok(
        ["read", "draft", "modify", "write", "send"].includes(a.riskLevel),
        `${a.actionId} unexpected implemented risk: ${a.riskLevel}`,
      );
    }
  }
});

check("registry: no implemented action still carries stale 'not enabled yet' copy", () => {
  // Section 17 guard. The registry's userFacingDescription is what policy replies
  // with, so an implemented action describing itself as unavailable makes Hula deny
  // a capability it actually has (which is exactly what the calendar writes did
  // between Sections 15 and 17).
  for (const a of ACTION_DEFINITIONS) {
    if (!a.implemented) continue;
    assert.ok(
      !/isn.t enabled yet|not enabled yet|can.t do that action yet/i.test(a.userFacingDescription),
      `${a.actionId} is implemented but its copy claims it is not enabled`,
    );
  }
});

check("registry: Asana actions without current named OAuth scopes are disabled", () => {
  for (const actionId of ["asana.section.write","asana.section.delete","asana.goal.write","asana.goal.delete","asana.portfolio.delete","asana.time_entry.write","asana.time_entry.delete"]) {
    const action=getActionDefinition(actionId);assert.ok(action,actionId);assert.equal(action?.implemented,false,actionId);assert.deepEqual(action?.requiredScopes,[],actionId);assert.match(action?.userFacingDescription??"",/named OAuth scopes do not authorise/i);
  }
  assert.deepEqual(getActionDefinition("asana.task.attachUrl")?.requiredScopes,["attachments:write"]);
});

check("registry: draft delete requires confirmation; draft edit does not", () => {
  // The Section 17 asymmetry that matters. Deleting a Gmail draft is irreversible
  // (Gmail does not trash it), so it must be confirmed. Editing one stays in the
  // user's Drafts and is freely reversible, so it must NOT nag — the same rung
  // `email.createDraft` already sits on.
  const del = getActionDefinition("email.deleteDraft") as ActionDefinition;
  assert.equal(del.confirmationRequired, true, "draft deletion must be confirmed");
  assert.notEqual(del.riskLevel, "destructive", "destructive is hard-blocked by policy");

  const edit = getActionDefinition("email.updateDraft") as ActionDefinition;
  assert.equal(edit.confirmationRequired, false, "editing a draft must not need confirmation");
  assert.equal(edit.riskLevel, "draft");
});

check("registry: the draft lifecycle needs no scope beyond gmail.compose", () => {
  // Verified against Google's per-method reference: drafts.list/get/update/delete
  // all accept gmail.compose. Requesting gmail.modify or https://mail.google.com/
  // would force every existing user to reconnect for no capability gain.
  for (const id of ["email.updateDraft", "email.deleteDraft"]) {
    const a = getActionDefinition(id) as ActionDefinition;
    assert.deepEqual(a.requiredScopes, ["https://www.googleapis.com/auth/gmail.compose"]);
  }
});

check("registry: every calendar write requires confirmation and the events scope", () => {
  const writes = ["calendar.createEvent", "calendar.updateEvent", "calendar.cancelEvent"];
  for (const id of writes) {
    const a = ACTION_DEFINITIONS.find((x) => x.actionId === id);
    assert.ok(a, `${id} must exist`);
    assert.equal(a!.confirmationRequired, true, `${id} must require confirmation`);
    assert.ok(
      a!.requiredScopes.includes("https://www.googleapis.com/auth/calendar.events"),
      `${id} must require the calendar.events scope`,
    );
  }
});

check("registry: risk levels and confirmation rules are coherent", () => {
  // The rungs BELOW `write` are the ones that never leave the user's control and
  // can always be undone, so they must not nag. Everything from `write` up is
  // either irreversible or externally visible, so it must be confirmed. Section 17
  // added `modify` (mark read, star, archive, label) to the no-confirmation set.
  const noConfirmation = new Set(["read", "draft", "modify"]);
  for (const a of ACTION_DEFINITIONS) {
    if (noConfirmation.has(a.riskLevel)) {
      assert.equal(
        a.confirmationRequired,
        false,
        `${a.actionId} (${a.riskLevel}) is reversible and must not require confirmation`,
      );
    } else {
      assert.equal(a.confirmationRequired, true, `${a.actionId} must require confirmation`);
    }
  }
});

check("registry: the `modify` rung is only used for reversible, non-external actions", () => {
  // A guard on the rung itself. `modify` skips confirmation, so anything filed
  // there that could actually lose data or reach another person would silently
  // bypass the one gate protecting the user.
  const allowed = new Set([
    "email.modifyLabels",
    "email.untrash",
    // Section 19 — the Todoist task lifecycle. Each earns the rung on the same two
    // tests the rung defines, and the reasoning is stated rather than assumed:
    //
    //  task.create   reversible by deleting it; nothing existed to destroy; the
    //                task is visible only in the user's own account.
    //  task.update   reversible by editing back; changes only fields the user owns.
    //  task.move     reversible by moving back; the task itself is untouched.
    //  task.complete reversible by task.reopen — Todoist keeps the task and its
    //                history, so completing destroys nothing.
    //  task.reopen   restorative: it puts a task BACK. Nothing can be lost.
    //
    // task.delete is deliberately ABSENT: Todoist does not trash a deleted task, so
    // it is irreversible and stays on `write` with confirmationRequired.
    "task.create",
    "task.update",
    "task.move",
    "task.complete",
    "task.reopen",
    "asana.task.create",
    "asana.task.update",
    "asana.task.relationship",
  ]);
  for (const a of ACTION_DEFINITIONS) {
    if (a.riskLevel !== "modify") continue;
    assert.ok(
      allowed.has(a.actionId),
      `${a.actionId} is on the no-confirmation \`modify\` rung — prove it is reversible and non-external, then allowlist it here`,
    );
  }
});

check("registry: Todoist deletion is irreversible, so it never sits on `modify`", () => {
  // The single most important Todoist policy fact, pinned. Todoist does NOT trash a
  // deleted task — there is no untrash to reach for — so a delete that skipped
  // confirmation would be unrecoverable data loss on a natural-language guess.
  const del = ACTION_DEFINITIONS.find((a) => a.actionId === "task.delete");
  assert.ok(del);
  assert.equal(del.riskLevel, "write");
  assert.equal(del.confirmationRequired, true);
  // And it is the ONLY Todoist action needing the optional delete scope, so
  // declining that scope costs deletion alone.
  assert.deepEqual(del.requiredScopes, ["data:delete"]);
  assert.deepEqual(del.requiredCapabilities, ["tasks.delete"]);

  for (const a of ACTION_DEFINITIONS) {
    if (a.category !== "tasks" || a.actionId === "task.delete") continue;
    assert.equal(
      a.requiredScopes.includes("data:delete"),
      false,
      `${a.actionId} must not require the optional delete scope`,
    );
  }
});

check("registry: trashing is confirmed and is the only email removal", () => {
  const trash = getActionDefinition("email.trash") as ActionDefinition;
  assert.equal(trash.confirmationRequired, true, "trashing must be confirmed");
  assert.equal(trash.riskLevel, "write");
  // Permanent deletion must not exist at all — it needs the full-mailbox scope and
  // cannot be undone.
  const ids = listActionDefinitions().map((a) => a.actionId);
  for (const forbidden of ["email.delete", "email.deleteMessage", "email.purge"]) {
    assert.equal(ids.includes(forbidden), false, `${forbidden} must never exist`);
  }
  // And no action may ever request the full-mailbox scope.
  for (const a of ACTION_DEFINITIONS) {
    assert.equal(
      a.requiredScopes.includes("https://mail.google.com/"),
      false,
      `${a.actionId} must not request the full-mailbox scope`,
    );
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
  // `document.appendText` is still a genuine stub. (`task.create` used to be this
  // example; Section 19 gave it a real Todoist adapter, so the example moved rather
  // than the rule changing.) `implemented` is checked BEFORE connection/scope, so
  // this holds regardless of context.
  const action = getActionDefinition("document.appendText") as ActionDefinition;
  const result = evaluateActionForUser(action, connectedCalendarContext(true));
  assert.equal(result.allowed, false);
  assert.equal(result.blockedReason, "not_implemented");
  assert.ok((result.userMessage ?? "").length > 0);
});

check("policy: an implemented calendar write needs confirmation before it may run", () => {
  const action = getActionDefinition("calendar.createEvent") as ActionDefinition;
  // Fully connected + correct scope, but NOT confirmed -> must not be allowed.
  const unconfirmed = evaluateActionForUser(action, writeCalendarContext());
  assert.equal(unconfirmed.allowed, false);
  assert.equal(unconfirmed.needsConfirmation, true);
  assert.equal(unconfirmed.blockedReason, "needs_confirmation");

  // Same context, explicitly confirmed -> allowed.
  const confirmed = evaluateActionForUser(action, writeCalendarContext(true));
  assert.equal(confirmed.allowed, true);
  assert.equal(confirmed.provider, "google_calendar");
});

check("policy: a read-only calendar connection cannot run a calendar write", () => {
  const action = getActionDefinition("calendar.createEvent") as ActionDefinition;
  // Connected, but only the readonly scope was granted -> honest needs_scope, which
  // the caller surfaces as "reconnect", never as a silent success.
  const result = evaluateActionForUser(action, {
    connectedProviders: ["google_calendar"],
    grantedScopesByProvider: {
      google_calendar: ["https://www.googleapis.com/auth/calendar.readonly"],
    },
    capabilitiesByProvider: { google_calendar: ["read_calendar_events"] },
    userConfirmed: true,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.needsScope, true);
  assert.equal(result.blockedReason, "needs_scope");
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
  // Section 18 fields. Real events always carry these — a fixture that
  // omits them is not a realistic event and hides formatting bugs.
  description: null,
  attendees: [],
  timeZone: null,
  conference: null,
  isRecurringMaster: false,
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
  // `document.appendText` replaces `task.create` here for the same reason as the
  // policy test above: Todoist gave task.create a real adapter in Section 19.
  const result = await executeAction(
    "user_fake",
    "document.appendText",
    { input: { documentId: "doc_1", text: "hello" } },
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
  assert.ok(/can't write to your documents yet/i.test(result.userMessage), "must stay honest");
});

asyncCheck("executor: Todoist writes are blocked when Todoist is not connected", async () => {
  // The replacement for what `task.create` used to prove. It is no longer a stub,
  // so the honest refusal now comes from the CONNECTION gate rather than from
  // `implemented:false` — and it must still never reach a provider.
  const recorded: RecordExecutionInput[] = [];
  const result = await executeAction(
    "user_fake",
    "task.create",
    { input: { content: "Call the bank" } },
    {
      // A calendar-only context: Todoist is absent.
      buildContext: async () => connectedCalendarContext(true),
      record: async (_userId, input) => {
        recorded.push(input);
        return "exec_todoist_blocked";
      },
      createTodoistTask: async () => {
        throw new Error("must not reach Todoist when it is not connected");
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(recorded[0]?.status, "blocked");
  assert.ok(/connect Todoist/i.test(result.userMessage), "must name the real problem");
});

asyncCheck(
  "executor: a read-only calendar connection is blocked (no write) for calendar.createEvent",
  async () => {
    // Section 17 regression: an existing user who connected before writes shipped
    // holds only calendar.readonly. The write must be refused honestly and must NOT
    // reach Google.
    let called = false;
    const recorded: RecordExecutionInput[] = [];
    const result = await executeAction(
      "user_fake",
      "calendar.createEvent",
      { input: { title: "Gym", startIso: futureIso(), endIso: futureIso(60) }, userConfirmed: true },
      {
        buildContext: async () => connectedCalendarContext(true),
        record: async (_userId, input) => {
          recorded.push(input);
          return "exec_ro";
        },
        createCalendarEvent: async () => {
          called = true;
          throw new Error("must never reach Google");
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(called, false, "a read-only connection must never call the provider");
    assert.equal(recorded[0]?.status, "blocked");
  },
);

// --- Section 17: executor calendar write adapters ------------------------

/** A normalized event as Google would confirm it back after a write. */
function fakeEvent(id: string, startIso: string, endIso: string): NormalizedCalendarEvent {
  return {
    id,
    calendarId: "primary",
    summary: "Gym",
    location: null,
    start: startIso,
    end: endIso,
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
    source: "google_calendar",
  };
}

asyncCheck("executor: confirmed calendar create writes and confirms from the real event", async () => {
  const start = futureIso(60);
  const end = futureIso(120);
  const recorded: RecordExecutionInput[] = [];
  let sentFields: unknown = null;
  const result = await executeAction(
    "user_fake",
    "calendar.createEvent",
    {
      input: { title: "Gym", startIso: start, endIso: end, timezone: "America/New_York" },
      userConfirmed: true,
      proposalId: "prop_1",
    },
    {
      buildContext: async () => writeCalendarContext(true),
      record: async (_u, input) => {
        recorded.push(input);
        return "exec_c";
      },
      createCalendarEvent: async (_u, fields) => {
        sentFields = fields;
        return fakeEvent("evt_new", start, end);
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.receipt?.eventId, "evt_new");
  assert.ok(/scheduled/i.test(result.userMessage));
  assert.ok(sentFields, "provider must have been called");
  // The ledger keeps the Google-issued id only — never the title or times.
  // Section 18 adds `verified` — whether the postcondition re-read matched. It is
  // false here because this test injects no `getCalendarEvent`, so the re-read
  // could not run. The ledger still carries the Google-issued id and NOTHING else
  // that could identify the event's content.
  assert.deepEqual(recorded[0]?.resultSummary, { eventId: "evt_new", verified: false });
  assert.equal(JSON.stringify(recorded).includes("Gym"), false, "no event title in the ledger");
});

asyncCheck("executor: calendar create never claims success on a past start", async () => {
  // Never-past must hold at EXECUTION time, not only when the proposal was made:
  // confirming late must not create an event in the past.
  let called = false;
  const result = await executeAction(
    "user_fake",
    "calendar.createEvent",
    {
      input: { title: "Gym", startIso: futureIso(-120), endIso: futureIso(-60) },
      userConfirmed: true,
    },
    {
      buildContext: async () => writeCalendarContext(true),
      record: async () => "exec_past",
      createCalendarEvent: async () => {
        called = true;
        throw new Error("must never be called for a past start");
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(called, false, "a past start must never reach Google");
  assert.ok(/already passed/i.test(result.userMessage));
});

asyncCheck("executor: calendar update targets the resolved event id verbatim", async () => {
  const start = futureIso(60);
  const end = futureIso(120);
  let targetedId = "";
  const result = await executeAction(
    "user_fake",
    "calendar.updateEvent",
    {
      input: { eventId: "evt_lunch", startIso: start, endIso: end, renamedOnly: false },
      userConfirmed: true,
    },
    {
      buildContext: async () => writeCalendarContext(true),
      record: async () => "exec_u",
      updateCalendarEvent: async (_u, id) => {
        targetedId = id;
        return fakeEvent("evt_lunch", start, end);
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(targetedId, "evt_lunch", "must update exactly the previewed event");
  assert.equal(result.receipt?.eventId, "evt_lunch");
});

asyncCheck("executor: confirmed calendar delete reports only a real provider delete", async () => {
  const removed: string[] = [];
  const result = await executeAction(
    "user_fake",
    "calendar.cancelEvent",
    {
      input: { eventId: "evt_lunch", title: "Lunch with Adam", startIso: futureIso(60) },
      userConfirmed: true,
    },
    {
      buildContext: async () => writeCalendarContext(true),
      record: async () => "exec_d",
      deleteCalendarEvent: async (_u, id) => {
        removed.push(id);
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(removed, ["evt_lunch"]);
  assert.ok(/deleted/i.test(result.userMessage));
  assert.ok(result.userMessage.includes("Lunch with Adam"));
});

asyncCheck("executor: a failed provider delete is never reported as deleted", async () => {
  const result = await executeAction(
    "user_fake",
    "calendar.cancelEvent",
    { input: { eventId: "evt_x", title: "Lunch" }, userConfirmed: true },
    {
      buildContext: async () => writeCalendarContext(true),
      record: async () => "exec_df",
      deleteCalendarEvent: async () => {
        throw new GoogleCalendarError("calendar_not_found", "gone", 404);
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.ok(!/deleted/i.test(result.userMessage), "must not claim a deletion happened");
});

asyncCheck("executor: a calendar provider failure maps to an honest reply, no false success", async () => {
  const cases: Array<[GoogleCalendarErrorReason, RegExp]> = [
    ["not_connected", /connected/i],
    ["insufficient_scope", /permission|reconnect/i],
    ["provider_unavailable", /trouble reaching|trying again/i],
  ];
  for (const [reason, expected] of cases) {
    const result = await executeAction(
      "user_fake",
      "calendar.createEvent",
      { input: { title: "Gym", startIso: futureIso(60), endIso: futureIso(120) }, userConfirmed: true },
      {
        buildContext: async () => writeCalendarContext(true),
        record: async () => "exec_f",
        createCalendarEvent: async () => {
          throw new GoogleCalendarError(reason, "failed");
        },
      },
    );
    assert.equal(result.ok, false, `${reason} must not succeed`);
    assert.ok(expected.test(result.userMessage), `${reason} -> unexpected copy: ${result.userMessage}`);
    assert.ok(!/scheduled|done/i.test(result.userMessage), `${reason} must not read as success`);
  }
});

// --- Section 17 / 3.5: message-management adapter ------------------------

/** A Gmail connection that granted the Section 17 modify scope. */
function gmailModifyContext(userConfirmed?: boolean): ActionPolicyContext {
  return {
    connectedProviders: ["gmail"],
    grantedScopesByProvider: {
      gmail: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
    },
    capabilitiesByProvider: {
      gmail: ["email.read", "email.draft", "email.send", "email.modify"],
    },
    userConfirmed,
  };
}

asyncCheck("executor: a label change applies to each message and reports the count", async () => {
  const touched: string[] = [];
  const recorded: RecordExecutionInput[] = [];
  const result = await executeAction(
    "user_fake",
    "email.modifyLabels",
    { input: { messageIds: ["m1", "m2"], removeLabelIds: ["UNREAD"], summary: "marked as read" } },
    {
      buildContext: async () => gmailModifyContext(),
      record: async (_u, input) => {
        recorded.push(input);
        return "exec_m";
      },
      modifyGmailMessageLabels: async (_u, id) => {
        touched.push(id);
        return { id, labelIds: [] };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(touched, ["m1", "m2"]);
  assert.ok(/Marked as read 2 emails\./.test(result.userMessage), result.userMessage);
  // The ledger keeps counts only — never senders or subjects.
  assert.deepEqual(recorded[0]?.resultSummary, { succeeded: 2, failed: 0 });
});

asyncCheck("executor: a PARTIAL bulk failure is reported as partial, never as done", async () => {
  // Gmail has no batch endpoint, so N messages is N calls and some can fail.
  // Reporting "archived 3" when one failed would be a plain lie.
  const result = await executeAction(
    "user_fake",
    "email.modifyLabels",
    { input: { messageIds: ["m1", "m2", "m3"], removeLabelIds: ["INBOX"], summary: "archived" } },
    {
      buildContext: async () => gmailModifyContext(),
      record: async () => "exec_p",
      modifyGmailMessageLabels: async (_u, id) => {
        if (id === "m2") throw new GmailError("provider_unavailable", "boom", 503);
        return { id, labelIds: [] };
      },
    },
  );
  assert.equal(result.ok, false, "a partial failure is not a success");
  assert.equal(result.status, "failed");
  assert.ok(/2 of 3/.test(result.userMessage), `must state the real numbers: ${result.userMessage}`);
  assert.ok(/didn’t go through/.test(result.userMessage));
});

asyncCheck("executor: a missing modify scope stops at the FIRST message", async () => {
  // A scope failure applies to every message — hammering Gmail with N calls that
  // will all fail identically is pointless and rate-limits the user.
  let attempts = 0;
  const result = await executeAction(
    "user_fake",
    "email.modifyLabels",
    { input: { messageIds: ["m1", "m2", "m3"], addLabelIds: ["STARRED"], summary: "starred" } },
    {
      buildContext: async () => gmailModifyContext(),
      record: async () => "exec_s",
      modifyGmailMessageLabels: async () => {
        attempts += 1;
        throw new GmailError("insufficient_scope", "nope", 403);
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(attempts, 1, "must not retry a scope failure per message");
  assert.ok(/reconnect Gmail/i.test(result.userMessage), result.userMessage);
  assert.ok(!/starred/i.test(result.userMessage), "must not claim anything was starred");
});

asyncCheck("executor: a pre-Section-17 connection is refused before reaching Gmail", async () => {
  // The real upgrade case: a user connected under Section 16 holds readonly +
  // compose but NOT modify. Policy must refuse, and Gmail must never be called.
  let called = false;
  const result = await executeAction(
    "user_fake",
    "email.modifyLabels",
    { input: { messageIds: ["m1"], addLabelIds: ["STARRED"], summary: "starred" } },
    {
      buildContext: async () => ({
        connectedProviders: ["gmail"],
        grantedScopesByProvider: {
          gmail: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.compose",
          ],
        },
        capabilitiesByProvider: { gmail: ["email.read", "email.draft", "email.send"] },
      }),
      record: async () => "exec_old",
      modifyGmailMessageLabels: async () => {
        called = true;
        return { id: "m1", labelIds: [] };
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(called, false, "a connection without gmail.modify must never reach Gmail");
});

asyncCheck("executor: trashing requires confirmation and is recoverable", async () => {
  // Unconfirmed -> blocked.
  let called = false;
  const blocked = await executeAction(
    "user_fake",
    "email.trash",
    { input: { messageIds: ["m1"], summary: "moved to trash" } },
    {
      buildContext: async () => gmailModifyContext(),
      record: async () => "exec_t1",
      trashGmailMessage: async () => {
        called = true;
        return { id: "m1", labelIds: [] };
      },
    },
  );
  assert.equal(blocked.ok, false);
  assert.equal(called, false, "trash must never run without confirmation");

  // Confirmed -> runs.
  const ok = await executeAction(
    "user_fake",
    "email.trash",
    { input: { messageIds: ["m1"], summary: "moved to trash" }, userConfirmed: true },
    {
      buildContext: async (_u, o) => gmailModifyContext(o.userConfirmed),
      record: async () => "exec_t2",
      trashGmailMessage: async (_u, id) => ({ id, labelIds: ["TRASH"] }),
    },
  );
  assert.equal(ok.ok, true);
  assert.ok(/Moved to trash 1 email\./.test(ok.userMessage), ok.userMessage);
});

asyncCheck("executor: an empty label change is refused, not sent to Gmail", async () => {
  let called = false;
  const result = await executeAction(
    "user_fake",
    "email.modifyLabels",
    { input: { messageIds: ["m1"], addLabelIds: [], removeLabelIds: [] } },
    {
      buildContext: async () => gmailModifyContext(),
      record: async () => "exec_e",
      modifyGmailMessageLabels: async () => {
        called = true;
        return { id: "m1", labelIds: [] };
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

asyncCheck("executor: every confirmed Notion mutation uses an injected provider and validates its receipt", async () => {
  const operations = ["archive_page", "restore_page", "update_page", "comment", "update_comment", "delete_comment", "move_page", "schema", "archive_block", "append"] as const;
  for (const operation of operations) {
    let called = 0;
    const receipt = operation === "append" ? { object: "list", results: [], has_more: false, next_cursor: null } : { object: operation.includes("comment") ? "comment" : operation === "archive_block" ? "block" : operation === "schema" ? "data_source" : "page", id: "target", ...(operation==="archive_page"?{in_trash:true}:operation==="restore_page"?{in_trash:false}:operation==="move_page"?{parent:{type:"page_id",page_id:"parent"}}:{}) };
    const result = await executeAction("user_fake", "notion.mutate", { userConfirmed: true, input: { operation, targetId: "target", targetTitle: "Launch Plan", body: operation === "move_page" ? { parent: { type: "page_id", page_id: "parent" } } : operation === "append" ? { children: [] } : {} } }, {
      buildContext: async (_u:string, options:{userConfirmed?:boolean}) => notionWriteContext(options.userConfirmed),
      record: async () => `exec-${operation}`,
      updateNotionPage: async () => { called += 1; return receipt; },
      moveNotionPage: async () => { called += 1; return receipt; },
      createNotionComment: async () => { called += 1; return receipt; },
      updateNotionComment: async () => { called += 1; return receipt; },
      deleteNotionComment: async () => { called += 1; return receipt; },
      updateNotionDataSource: async () => { called += 1; return receipt; },
      archiveNotionBlock: async () => { called += 1; return receipt; },
      appendNotionBlocks: async () => { called += 1; return receipt; },
      recordNotionEntity: async () => undefined,
    } as never);
    assert.equal(called, 1, `${operation} must execute exactly once`);
    assert.equal(result.ok, true, `${operation} must accept its authoritative fake receipt`);
  }
});

asyncCheck("executor: an unconfirmed or malformed Notion mutation never reports success", async () => {
  let called = false;
  const blocked = await executeAction("user_fake", "notion.mutate", { input: { operation: "archive_page", targetId: "page", targetTitle: "Plan", body: {} } }, { buildContext: async () => notionWriteContext(false), record: async () => "blocked", updateNotionPage: async () => { called = true; return { object: "page", id: "page" }; } });
  assert.equal(blocked.ok, false);
  assert.equal(called, false);
  const failed = await executeAction("user_fake", "notion.mutate", { userConfirmed: true, input: { operation: "archive_page", targetId: "page", targetTitle: "Plan", body: {} } }, { buildContext: async (_u, options) => notionWriteContext(options.userConfirmed), record: async () => "failed", updateNotionPage: async () => null as never });
  assert.equal(failed.ok, false);
  assert.match(failed.userMessage, /couldn’t verify/);
});

asyncCheck("executor: Notion target and archive postcondition mismatches are never successes",async()=>{
  for(const receipt of [{object:"page",id:"wrong",in_trash:true},{object:"page",id:"page",in_trash:false}]){
    const result=await executeAction("user_fake","notion.mutate",{userConfirmed:true,input:{operation:"archive_page",targetId:"page",targetTitle:"Plan",body:{}}},{buildContext:async(_u,options)=>notionWriteContext(options.userConfirmed),record:async()=>"mismatch",updateNotionPage:async()=>receipt,recordNotionEntity:async()=>undefined});
    assert.equal(result.ok,false);
    assert.match(result.userMessage,/couldn’t verify/);
  }
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
