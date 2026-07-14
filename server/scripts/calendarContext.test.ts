import assert from "node:assert/strict";

import {
  CALENDAR_ENTITY_CONTEXT_ACTION_ID,
  CALENDAR_ENTITY_TTL_MS,
  CALENDAR_SELECTION_ACTION_ID,
  CALENDAR_SELECTION_TTL_MS,
  loadCalendarEntityContext,
  loadLatestCalendarSelection,
  parseCalendarEntityContextData,
  parseCalendarSelectionData,
  parseCalendarOrdinal,
  recordActedCalendarEvent,
  recordCalendarSelection,
  recordSelectedCalendarEvent,
  referencesCalendarPronoun,
  referencesLastCalendarAction,
  referencesLastCalendarResults,
  resolveCalendarSelectionItem,
  toSelectionItem,
  type CalendarContextStore,
  type CalendarSelectionData,
} from "../src/integrations/providers/googleCalendar/calendarContext";
import type { ActionProposalView, CreateProposalInput } from "../src/actions/proposals";
import type { NormalizedCalendarEvent } from "../src/integrations/providers/googleCalendar/types";

/**
 * Offline tests for CALENDAR CONVERSATIONAL CONTEXT (Section 18). NO database —
 * the Section 12 proposal store is faked at its injection seam.
 *
 * Two properties are defended here:
 *  1. Numbered references are STABLE. "Cancel the second one" resolves against
 *     the snapshot of ids Hula actually showed, so an event created in between
 *     cannot shift what position 2 means.
 *  2. A stale or out-of-range reference ASKS. It never clamps onto a
 *     neighbouring event and cancels the wrong thing.
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

/** Build a normalized event. */
function ev(id: string, summary: string, start: string): NormalizedCalendarEvent {
  return {
    id,
    calendarId: "primary",
    summary,
    location: null,
    description: null,
    start,
    end: start,
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
  };
}

/**
 * An in-memory stand-in for the proposal store, scoped by user exactly as the
 * real one is — so a cross-user leak would show up here.
 */
function fakeStore(): CalendarContextStore & { rows: Map<string, ActionProposalView[]> } {
  const rows = new Map<string, ActionProposalView[]>();
  let seq = 0;
  return {
    rows,
    create: async (userId: string, input: CreateProposalInput) => {
      seq += 1;
      const id = `row_${seq}`;
      const now = Date.now();
      const view: ActionProposalView = {
        id,
        provider: input.provider ?? null,
        actionId: input.actionId,
        status: "proposed",
        riskLevel: input.riskLevel,
        confirmationRequired: input.confirmationRequired ?? true,
        previewText: input.previewText,
        input: (input.input ?? null) as Record<string, unknown> | null,
        expiresAt: new Date(now + (input.ttlMs ?? 600_000)).toISOString(),
        confirmedAt: null,
        rejectedAt: null,
        executedAt: null,
        createdAt: new Date(now + seq).toISOString(),
      };
      const key = `${userId}:${input.actionId}`;
      rows.set(key, [view, ...(rows.get(key) ?? [])]);
      return { id };
    },
    listRecent: async (userId: string, actionId: string) => rows.get(`${userId}:${actionId}`) ?? [],
  };
}

// --- Ordinal parsing -----------------------------------------------------

check("ordinal: word ordinals resolve to positions", () => {
  assert.deepEqual(parseCalendarOrdinal("cancel the second one"), { position: 2 });
  assert.deepEqual(parseCalendarOrdinal("the first meeting"), { position: 1 });
  assert.deepEqual(parseCalendarOrdinal("move the third to friday"), { position: 3 });
});

check("ordinal: numeric forms and bare numbers", () => {
  assert.deepEqual(parseCalendarOrdinal("the 2nd"), { position: 2 });
  assert.deepEqual(parseCalendarOrdinal("number 3"), { position: 3 });
  assert.deepEqual(parseCalendarOrdinal("event 4"), { position: 4 });
  assert.deepEqual(parseCalendarOrdinal("2"), { position: 2 });
  assert.deepEqual(parseCalendarOrdinal("#2"), { position: 2 });
});

check("ordinal: 'the last one' resolves to the tail", () => {
  assert.deepEqual(parseCalendarOrdinal("cancel the last one"), { last: true });
});

check("ordinal: a bare number inside a sentence is NOT a position", () => {
  // The trap: "move it to 3" must never mean "item 3".
  assert.equal(parseCalendarOrdinal("move it to 3"), null);
  assert.equal(parseCalendarOrdinal("change 5pm to 6pm"), null);
  assert.equal(parseCalendarOrdinal("book 30 minutes"), null);
});

check("ordinal: ordinary messages carry no position", () => {
  assert.equal(parseCalendarOrdinal("what's on today"), null);
  assert.equal(parseCalendarOrdinal(""), null);
  assert.equal(parseCalendarOrdinal(undefined), null);
});

// --- Reference detection -------------------------------------------------

check("reference: positional and collective references to a shown list", () => {
  assert.equal(referencesLastCalendarResults("cancel the second one"), true);
  assert.equal(referencesLastCalendarResults("cancel them"), true);
  assert.equal(referencesLastCalendarResults("move that one to friday"), true);
  assert.equal(referencesLastCalendarResults("what's on today"), false);
});

check("reference: an explicit reference to our own last action", () => {
  assert.equal(referencesLastCalendarAction("cancel the meeting you just created"), true);
  assert.equal(referencesLastCalendarAction("undo that"), true);
  assert.equal(referencesLastCalendarAction("book lunch friday"), false);
});

check("reference: bare pronouns", () => {
  assert.equal(referencesCalendarPronoun("move it to friday"), true);
  assert.equal(referencesCalendarPronoun("cancel that"), true);
  assert.equal(referencesCalendarPronoun("book lunch friday"), false);
});

// --- Selection resolution ------------------------------------------------

const sample: CalendarSelectionData = {
  kind: "calendar_selection",
  items: [
    { id: "a", recurringEventId: null, title: "Standup", start: "2026-07-14T13:00:00Z", end: null, allDay: false },
    { id: "b", recurringEventId: null, title: "Lunch", start: "2026-07-14T16:00:00Z", end: null, allDay: false },
    { id: "c", recurringEventId: null, title: "Review", start: "2026-07-14T19:00:00Z", end: null, allDay: false },
  ],
};

check("resolve: a position maps to the id that occupied it", () => {
  assert.equal(resolveCalendarSelectionItem(sample, { position: 2 })?.id, "b");
  assert.equal(resolveCalendarSelectionItem(sample, { position: 1 })?.id, "a");
  assert.equal(resolveCalendarSelectionItem(sample, { last: true })?.id, "c");
});

check("resolve: an out-of-range position returns null (never clamps)", () => {
  // Clamping "the fifth one" onto the third would cancel an event the user
  // never picked. It must ask instead.
  assert.equal(resolveCalendarSelectionItem(sample, { position: 5 }), null);
  assert.equal(resolveCalendarSelectionItem(sample, { position: 0 }), null);
});

// --- Payload parsing -----------------------------------------------------

check("parse: a valid selection payload round-trips", () => {
  const parsed = parseCalendarSelectionData(sample as unknown as Record<string, unknown>);
  assert.equal(parsed?.items.length, 3);
  assert.equal(parsed?.items[1]?.id, "b");
});

check("parse: a foreign or malformed payload is rejected", () => {
  assert.equal(parseCalendarSelectionData(null), null);
  assert.equal(parseCalendarSelectionData({ kind: "gmail_selection", items: [] }), null);
  assert.equal(parseCalendarSelectionData({ kind: "calendar_selection", items: [] }), null);
  // An item with no id is unusable — the whole payload is refused.
  assert.equal(
    parseCalendarSelectionData({ kind: "calendar_selection", items: [{ title: "x" }] }),
    null,
  );
});

check("parse: entity context requires a usable event", () => {
  assert.equal(parseCalendarEntityContextData(null), null);
  assert.equal(parseCalendarEntityContextData({ kind: "calendar_entity_context" })?.selected, null);
  const good = parseCalendarEntityContextData({
    kind: "calendar_entity_context",
    selected: { id: "a", title: "Standup" },
    acted: { event: { id: "a", title: "Standup" }, kind: "created", at: "2026-07-14T00:00:00Z" },
  });
  assert.equal(good?.acted?.kind, "created");
  assert.equal(good?.selected?.id, "a");
  // An unknown action kind is refused rather than coerced.
  assert.equal(
    parseCalendarEntityContextData({
      kind: "calendar_entity_context",
      acted: { event: { id: "a" }, kind: "exploded", at: "x" },
    })?.acted,
    null,
  );
});

check("project: a normalized event reduces to safe fields only", () => {
  const item = toSelectionItem(ev("evt1", "Standup", "2026-07-14T13:00:00Z"));
  assert.deepEqual(Object.keys(item).sort(), ["allDay", "end", "id", "recurringEventId", "start", "title"]);
});

// --- Persistence ---------------------------------------------------------

asyncCheck("selection: the list Hula showed is remembered in order", async () => {
  const store = fakeStore();
  await recordCalendarSelection(
    "u1",
    [ev("a", "Standup", "2026-07-14T13:00:00Z"), ev("b", "Lunch", "2026-07-14T16:00:00Z")],
    store,
  );
  const loaded = await loadLatestCalendarSelection("u1", store);
  assert.deepEqual(loaded?.data.items.map((i) => i.id), ["a", "b"]);
});

asyncCheck("selection: it is stored as a NON-confirmable row (invisible to yes/no)", async () => {
  // A "yes" meant for a real delete must never resolve a selection instead.
  const store = fakeStore();
  await recordCalendarSelection("u1", [ev("a", "Standup", "2026-07-14T13:00:00Z")], store);
  const row = store.rows.get(`u1:${CALENDAR_SELECTION_ACTION_ID}`)![0]!;
  assert.equal(row.confirmationRequired, false);
  assert.equal(row.riskLevel, "read");
  assert.equal(row.actionId, CALENDAR_SELECTION_ACTION_ID);
});

asyncCheck("selection: STABLE — a newly created event does not shift old positions", async () => {
  // The property Section 18 asks for by name. The user reads a list, Hula creates
  // something in between, then the user says "cancel the second one". It must
  // still mean what was on their screen.
  const store = fakeStore();
  await recordCalendarSelection(
    "u1",
    [ev("a", "Standup", "2026-07-14T13:00:00Z"), ev("b", "Lunch", "2026-07-14T16:00:00Z")],
    store,
  );

  // A new event is created and recorded as the acted entity — a DIFFERENT memory.
  await recordActedCalendarEvent(
    "u1",
    { event: toSelectionItem(ev("zzz", "New thing", "2026-07-14T09:00:00Z")), kind: "created", at: new Date().toISOString() },
    store,
  );

  const loaded = await loadLatestCalendarSelection("u1", store);
  const second = resolveCalendarSelectionItem(loaded!.data, { position: 2 });
  assert.equal(second?.id, "b", "position 2 must still be the event the user saw");
});

asyncCheck("selection: an EXPIRED list is not used (a stale number must ask)", async () => {
  const store = fakeStore();
  await recordCalendarSelection("u1", [ev("a", "Standup", "2026-07-14T13:00:00Z")], store);
  // Force the row to have expired.
  const rows = store.rows.get(`u1:${CALENDAR_SELECTION_ACTION_ID}`)!;
  rows[0] = { ...rows[0]!, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal(await loadLatestCalendarSelection("u1", store), null);
});

asyncCheck("selection: USER ISOLATION — one user's list is never another's", async () => {
  const store = fakeStore();
  await recordCalendarSelection("u1", [ev("a", "Standup", "2026-07-14T13:00:00Z")], store);
  assert.equal(await loadLatestCalendarSelection("u2", store), null);
});

asyncCheck("entity: the acted event is remembered and re-selected", async () => {
  const store = fakeStore();
  await recordActedCalendarEvent(
    "u1",
    { event: toSelectionItem(ev("evt1", "Lunch", "2026-07-14T16:00:00Z")), kind: "created", at: new Date().toISOString() },
    store,
  );
  const ctx = await loadCalendarEntityContext("u1", store);
  assert.equal(ctx?.data.acted?.event.id, "evt1");
  // After "book lunch", both "it" and "that meeting" mean that event.
  assert.equal(ctx?.data.selected?.id, "evt1");
});

asyncCheck("entity: a CANCELLED event stays 'acted' but is not re-selected", async () => {
  // "undo that" should still find it; "move it to Friday" should not silently
  // target an event that no longer exists.
  const store = fakeStore();
  await recordActedCalendarEvent(
    "u1",
    { event: toSelectionItem(ev("evt1", "Lunch", "2026-07-14T16:00:00Z")), kind: "cancelled", at: new Date().toISOString() },
    store,
  );
  const ctx = await loadCalendarEntityContext("u1", store);
  assert.equal(ctx?.data.acted?.kind, "cancelled");
  assert.equal(ctx?.data.selected, null);
});

asyncCheck("entity: picking a new event does not un-happen the last action", async () => {
  const store = fakeStore();
  await recordActedCalendarEvent(
    "u1",
    { event: toSelectionItem(ev("evt1", "Lunch", "2026-07-14T16:00:00Z")), kind: "created", at: new Date().toISOString() },
    store,
  );
  await recordSelectedCalendarEvent("u1", toSelectionItem(ev("evt2", "Standup", "2026-07-14T13:00:00Z")), store);
  const ctx = await loadCalendarEntityContext("u1", store);
  assert.equal(ctx?.data.selected?.id, "evt2");
  assert.equal(ctx?.data.acted?.event.id, "evt1", "the acted record must survive a new pick");
});

asyncCheck("entity: an EXPIRED context is not used", async () => {
  const store = fakeStore();
  await recordActedCalendarEvent(
    "u1",
    { event: toSelectionItem(ev("evt1", "Lunch", "2026-07-14T16:00:00Z")), kind: "created", at: new Date().toISOString() },
    store,
  );
  const rows = store.rows.get(`u1:${CALENDAR_ENTITY_CONTEXT_ACTION_ID}`)!;
  rows[0] = { ...rows[0]!, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal(await loadCalendarEntityContext("u1", store), null);
});

asyncCheck("entity: USER ISOLATION — one user's 'it' is never another's", async () => {
  const store = fakeStore();
  await recordActedCalendarEvent(
    "u1",
    { event: toSelectionItem(ev("evt1", "Lunch", "2026-07-14T16:00:00Z")), kind: "created", at: new Date().toISOString() },
    store,
  );
  assert.equal(await loadCalendarEntityContext("u2", store), null);
});

check("ttl: the entity window outlives the list window, deliberately", () => {
  // A numbered list goes stale quickly (the numbers leave the screen); the event
  // the conversation is about stays relevant across a meeting.
  assert.ok(CALENDAR_ENTITY_TTL_MS > CALENDAR_SELECTION_TTL_MS);
  assert.equal(CALENDAR_SELECTION_TTL_MS, 30 * 60 * 1000);
  assert.equal(CALENDAR_ENTITY_TTL_MS, 2 * 60 * 60 * 1000);
});

check("payload: context carries no raw provider payload or token material", () => {
  const item = toSelectionItem(ev("evt1", "Standup", "2026-07-14T13:00:00Z"));
  const blob = JSON.stringify(item);
  assert.ok(!/Bearer|ya29\.|access_token|htmlLink|organizer/i.test(blob));
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} Calendar context (Section 18) tests passed.`);
}

void run().catch((err) => {
  console.error("Calendar context tests failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
