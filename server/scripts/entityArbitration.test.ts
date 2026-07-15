import assert from "node:assert/strict";

import type { ActionProposalView, CreateProposalInput } from "../src/actions/proposals";
import {
  conflictClarification,
  explicitEntityKinds,
  isDestructiveFollowup,
  isFollowupShape,
  loadGroundedContexts,
  resolveFollowupOwner,
  toProviderFamilies,
} from "../src/actions/entityContextArbiter";
import {
  DESTRUCTIVE_NO_CONTEXT_REPLY,
  handleEntityFollowup,
} from "../src/routes/entityFollowup";
import { classifyMemoryCommand, isPronounOnlyForgetTarget } from "../src/users/memory";
import { handleTodoistWrite } from "../src/integrations/providers/todoist/todoistActions";
import { looksLikeDraftCommand } from "../src/integrations/providers/gmail/gmailDraftLifecycle";
import { routeInboundText, inboundHandlerOrder } from "../src/routes/inboundRouting";

/**
 * Cross-provider entity-context arbitration tests — OFFLINE.
 *
 * These encode a REAL DEVICE FAILURE. After "Show my tasks for hula" printed a
 * numbered Todoist list, the user said:
 *
 *     "Change the second one's priority to high"
 *
 * and Hula answered:
 *
 *     "I'm not sure which draft you mean — try 'show me my drafts' first."
 *
 * Nothing in that message concerns email. Gmail's draft-edit gate matches a bare
 * "change" and sits above Todoist, so it claimed a follow-up whose meaning came
 * entirely from a Todoist list.
 *
 * Every routing test below runs through the REAL cascade (`routeInboundText`) with
 * the REAL arbiter, so a regression in handler order or in the arbitration rules
 * fails here rather than on a phone.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}
async function asyncCheck(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const NOW = new Date("2026-07-15T12:00:00.000Z");

/** An in-memory, USER-SCOPED stand-in for the shared proposal store. */
class FakeContextStore {
  rows: (ActionProposalView & { userId: string })[] = [];
  private seq = 0;

  /** Record a grounded context exactly as a provider's context module would. */
  add(
    userId: string,
    actionId: string,
    input: Record<string, unknown>,
    opts: { agoMs?: number; ttlMs?: number } = {},
  ): void {
    const createdAt = new Date(NOW.getTime() - (opts.agoMs ?? 0));
    this.rows.unshift({
      userId,
      id: `ctx_${++this.seq}`,
      provider: null,
      actionId,
      status: "proposed",
      riskLevel: "read",
      confirmationRequired: false,
      previewText: "ctx",
      input,
      expiresAt: new Date(createdAt.getTime() + (opts.ttlMs ?? 30 * 60 * 1000)).toISOString(),
      confirmedAt: null,
      rejectedAt: null,
      executedAt: null,
      createdAt: createdAt.toISOString(),
    });
  }

  listRecent = async (userId: string, actionId: string) =>
    this.rows.filter((r) => r.userId === userId && r.actionId === actionId);
}

/** Grounded-context fixtures, shaped like each provider's real payload. */
function todoistList(store: FakeContextStore, userId: string, agoMs = 0) {
  store.add(
    userId,
    "todoist.lastSelection",
    {
      kind: "todoist_selection",
      items: [
        { id: "t1", content: "Review Hula roadmap", labels: [], priority: 1 },
        { id: "t2", content: "Finish Todoist integration test", labels: [], priority: 1 },
      ],
    },
    { agoMs },
  );
}
/** The entity context left behind by a verified action ("undo that" → reopened). */
function todoistActed(store: FakeContextStore, userId: string, agoMs = 0) {
  const task = { id: "t2", content: "Finish Todoist integration test", labels: [], priority: 1 };
  store.add(
    userId,
    "todoist.entityContext",
    { kind: "todoist_entity_context", selected: task, acted: { task, kind: "reopened", at: new Date(NOW.getTime() - agoMs).toISOString() } },
    { agoMs, ttlMs: 2 * 60 * 60 * 1000 },
  );
}
function gmailDraftList(store: FakeContextStore, userId: string, agoMs = 0) {
  store.add(
    userId,
    "email.lastSelection",
    { kind: "gmail_selection", itemKind: "drafts", items: [{ id: "d1" }, { id: "d2" }] },
    { agoMs },
  );
}
function gmailEmailList(store: FakeContextStore, userId: string, agoMs = 0) {
  store.add(
    userId,
    "email.lastSelection",
    { kind: "gmail_selection", itemKind: "messages", items: [{ id: "m1" }, { id: "m2" }] },
    { agoMs },
  );
}
function calendarList(store: FakeContextStore, userId: string, agoMs = 0) {
  store.add(
    userId,
    "calendar.lastSelection",
    { kind: "calendar_selection", items: [{ id: "e1" }, { id: "e2" }] },
    { agoMs },
  );
}

/**
 * Route through the REAL cascade with every provider handler stubbed to shout its
 * own name. Whoever claims the message is the answer — so these tests measure
 * ROUTING, not each provider's internals.
 */
async function routeWith(
  userId: string,
  text: string,
  store: FakeContextStore,
  over: Record<string, unknown> = {},
) {
  const decline = async () => ({ handled: false as const });
  const claims = (name: string) => async () => ({ handled: true, reply: `handled by ${name}` });
  return routeInboundText(userId, text, {
    memory: decline,
    reminder: decline,
    confirmation: decline,
    // The REAL arbitration step, reading the REAL context rows from the fake store.
    entityFollowup: (u, t) =>
      handleEntityFollowup(u, t, {
        listRecent: store.listRecent,
        now: NOW,
        todoistWrite: claims("todoist"),
      }),
    gmailClarify: decline,
    gmailDraftFollowup: decline,
    // The handler that caused the incident, behind its REAL gate. Using the real
    // `looksLikeDraftCommand` is the point: it matches a bare "change" (which is
    // how a Todoist follow-up became a draft edit) but not "move" or "reply" — so
    // these tests reproduce the true competition between handlers rather than a
    // stub that greedily claims everything.
    gmailDraftLifecycle: async (_u, t) =>
      looksLikeDraftCommand(t)
        ? { handled: true, reply: "handled by gmailDraftLifecycle" }
        : { handled: false },
    gmailCommand: decline,
    calendarUndo: decline,
    todoistUndo: decline,
    // The REAL Todoist handler, so the SYMMETRIC guard is genuinely exercised: its
    // `extract` is stubbed to claim anything it reaches, so if the arbiter guard
    // failed to decline a Gmail/Calendar-owned follow-up, Todoist would steal it
    // and these tests would fail. A stub that always claimed would hide that.
    todoistWrite: (u, t) =>
      handleTodoistWrite(u, t, {
        resolveFollowupOwner: (uu, tt) =>
          resolveFollowupOwner(uu, tt, { listRecent: store.listRecent, now: NOW }),
        extract: async () => ({ intent: "complete" }) as never,
        getTimezone: async () => "Europe/London",
        loadSelection: async () => null,
        loadEntityContext: async () => null,
        execute: (async () => ({ userMessage: "handled by todoistWrite" })) as never,
      }),
    todoistRead: decline,
    calendarWrite: claims("calendarWrite"),
    gmailWrite: decline,
    actionIntent: decline,
    calendarAvailability: decline,
    calendar: decline,
    calendarRead: decline,
    gmailReadOne: decline,
    gmailSummary: decline,
    gmailSearch: decline,
    gmailQuestion: decline,
    pendingReprompt: decline,
    ...over,
  });
}

async function run(): Promise<void> {
  console.log("arbitration: shape + semantics (pure)");

  check("follow-up shapes are recognised; self-describing requests are not", () => {
    for (const t of [
      "the second one",
      "change the second one's priority to high",
      "complete it",
      "delete the first one",
      "move it to Work",
      "2",
      "all of those",
    ]) {
      assert.equal(isFollowupShape(t), true, `"${t}" is a follow-up`);
    }
    // These name their own target — no arbitration needed.
    for (const t of ["show my tasks for hula", "what tasks are overdue", "book a meeting with Sam"]) {
      assert.equal(isFollowupShape(t), false, `"${t}" is self-describing`);
    }
  });

  check("typed nouns name an entity; generic verbs never do", () => {
    assert.deepEqual(explicitEntityKinds("change the second one's priority to high"), ["todoist_task"]);
    assert.deepEqual(explicitEntityKinds("complete it"), ["todoist_task"]);
    assert.deepEqual(explicitEntityKinds("move it to my project"), ["todoist_task"]);
    assert.deepEqual(explicitEntityKinds("change the second draft's body"), ["gmail_draft"]);
    assert.deepEqual(explicitEntityKinds("reply to the second one"), ["gmail_email"]);
    assert.deepEqual(explicitEntityKinds("move the second meeting"), ["calendar_event"]);
    // THE ROOT CAUSE: a bare verb must imply nothing at all.
    for (const t of ["change the second one", "move it", "delete the first one", "it"]) {
      assert.deepEqual(explicitEntityKinds(t), [], `"${t}" names no entity`);
    }
  });

  check("draft + body is one family, not a conflict", () => {
    assert.deepEqual(toProviderFamilies(["gmail_draft", "gmail_email"]), ["gmail"]);
    assert.deepEqual(toProviderFamilies(["gmail_draft", "todoist_task"]).sort(), ["gmail", "todoist_task"]);
  });

  console.log("arbitration: grounded context");

  await asyncCheck("the MOST RECENT grounded list wins", async () => {
    const store = new FakeContextStore();
    gmailEmailList(store, "u1", 10 * 60 * 1000); // ten minutes ago
    todoistList(store, "u1", 1000); // one second ago
    const contexts = await loadGroundedContexts("u1", { listRecent: store.listRecent, now: NOW });
    assert.equal(contexts[0]?.kind, "todoist_task");
  });

  await asyncCheck("Gmail's single selection id distinguishes drafts from messages", async () => {
    const drafts = new FakeContextStore();
    gmailDraftList(drafts, "u1");
    assert.equal(
      (await loadGroundedContexts("u1", { listRecent: drafts.listRecent, now: NOW }))[0]?.kind,
      "gmail_draft",
    );
    const emails = new FakeContextStore();
    gmailEmailList(emails, "u1");
    assert.equal(
      (await loadGroundedContexts("u1", { listRecent: emails.listRecent, now: NOW }))[0]?.kind,
      "gmail_email",
    );
  });

  await asyncCheck("context is user-scoped: one user's list never arbitrates another's", async () => {
    const store = new FakeContextStore();
    todoistList(store, "user_a");
    const forB = await loadGroundedContexts("user_b", { listRecent: store.listRecent, now: NOW });
    assert.deepEqual(forB, [], "cross-user leakage would route to the wrong account");
    const owner = await resolveFollowupOwner("user_b", "change the second one", {
      listRecent: store.listRecent,
      now: NOW,
    });
    assert.equal(owner.kind, "none");
  });

  await asyncCheck("an EXPIRED context never resolves a follow-up", async () => {
    const store = new FakeContextStore();
    // Shown 40 minutes ago with a 30-minute TTL — the numbers are long gone.
    todoistList(store, "u1", 40 * 60 * 1000);
    const contexts = await loadGroundedContexts("u1", { listRecent: store.listRecent, now: NOW });
    assert.deepEqual(contexts, []);
    const owner = await resolveFollowupOwner("u1", "change the second one", {
      listRecent: store.listRecent,
      now: NOW,
    });
    assert.equal(owner.kind, "none", "a stale list must not decide what 'the second one' means");
  });

  console.log("arbitration: routing through the REAL cascade");

  check("entityFollowup sits above every provider handler, below confirmation", () => {
    const order = inboundHandlerOrder();
    assert.equal(order[order.indexOf("entityFollowup") - 1], "confirmation");
    for (const provider of ["gmailDraftLifecycle", "gmailCommand", "todoistWrite", "calendarWrite"]) {
      assert.ok(
        order.indexOf("entityFollowup") < order.indexOf(provider),
        `entityFollowup must precede ${provider}`,
      );
    }
  });

  await asyncCheck("1. Todoist list → 'change the second one's priority to high' → Todoist", async () => {
    // THE EXACT INCIDENT.
    const store = new FakeContextStore();
    todoistList(store, "u1");
    const routed = await routeWith("u1", "Change the second one's priority to high", store);
    assert.equal(routed?.source, "entityFollowup");
    assert.equal(routed?.reply, "handled by todoist");
    assert.doesNotMatch(routed?.reply ?? "", /draft/i, "must never mention drafts");
  });

  await asyncCheck("2. Todoist list → 'move the second one to Work' → Todoist", async () => {
    const store = new FakeContextStore();
    todoistList(store, "u1");
    const routed = await routeWith("u1", "move the second one to Work", store);
    assert.equal(routed?.reply, "handled by todoist");
  });

  await asyncCheck("3. Todoist list → 'complete it' → Todoist", async () => {
    const store = new FakeContextStore();
    todoistList(store, "u1");
    const routed = await routeWith("u1", "complete it", store);
    assert.equal(routed?.reply, "handled by todoist");
  });

  await asyncCheck("4. Todoist list → 'delete the first one' → Todoist", async () => {
    const store = new FakeContextStore();
    todoistList(store, "u1");
    const routed = await routeWith("u1", "delete the first one", store);
    // Reaches Todoist, whose own policy then requires confirmation (covered in the
    // Todoist flow suite). What matters here is that Gmail never sees it.
    assert.equal(routed?.reply, "handled by todoist");
  });

  await asyncCheck("5. Gmail DRAFT list → 'change the second draft's body' → Gmail", async () => {
    const store = new FakeContextStore();
    gmailDraftList(store, "u1");
    const routed = await routeWith("u1", "change the second draft's body", store);
    assert.equal(routed?.source, "gmailDraftLifecycle", "genuine Gmail work must be untouched");
  });

  await asyncCheck("5b. Gmail DRAFT list → a bare 'change the second one' → Gmail", async () => {
    // No explicit noun, so CONTEXT decides — and the context is drafts.
    const store = new FakeContextStore();
    gmailDraftList(store, "u1");
    const routed = await routeWith("u1", "change the second one", store);
    assert.equal(routed?.source, "gmailDraftLifecycle");
  });

  await asyncCheck("6. Gmail EMAIL list → 'reply to the second one' → Gmail", async () => {
    const store = new FakeContextStore();
    gmailEmailList(store, "u1");
    // A reply is composed by `gmailWrite`, which sits BELOW calendarWrite — so the
    // handlers that would genuinely decline a reply are made to decline here.
    const routed = await routeWith("u1", "reply to the second one", store, {
      gmailDraftLifecycle: async () => ({ handled: false as const }),
      calendarWrite: async () => ({ handled: false as const }),
      gmailWrite: async () => ({ handled: true, reply: "handled by gmailWrite" }),
    });
    assert.equal(routed?.reply, "handled by gmailWrite");
    assert.notEqual(routed?.source, "entityFollowup", "the arbiter must stand aside for Gmail");
  });

  await asyncCheck("7. Calendar list → 'move the second one to 5 PM' → Calendar", async () => {
    const store = new FakeContextStore();
    calendarList(store, "u1");
    const routed = await routeWith("u1", "move the second one to 5 PM", store);
    assert.equal(routed?.source, "calendarWrite");
  });

  await asyncCheck("8. explicit 'task' with STALE Gmail context → Todoist", async () => {
    // Explicit semantics beat context, even when the context is more recent.
    const store = new FakeContextStore();
    todoistList(store, "u1", 20 * 60 * 1000);
    gmailDraftList(store, "u1", 1000);
    const routed = await routeWith("u1", "complete the second task", store);
    assert.equal(routed?.reply, "handled by todoist");
  });

  await asyncCheck("9. explicit 'draft' with STALE Todoist context → Gmail", async () => {
    // The mirror image — the arbiter must not be biased toward Todoist.
    const store = new FakeContextStore();
    gmailDraftList(store, "u1", 20 * 60 * 1000);
    todoistList(store, "u1", 1000);
    const routed = await routeWith("u1", "change the second draft", store);
    assert.equal(routed?.source, "gmailDraftLifecycle");
  });

  await asyncCheck("10. conflicting semantics fail closed with a clarification", async () => {
    const store = new FakeContextStore();
    todoistList(store, "u1");
    const routed = await routeWith("u1", "change the second draft's priority", store);
    assert.equal(routed?.source, "entityFollowup");
    // Mutates NEITHER provider and names both options precisely.
    assert.match(routed?.reply ?? "", /Do you mean/);
    assert.match(routed?.reply ?? "", /Todoist task/);
    assert.match(routed?.reply ?? "", /email draft/);
    assert.doesNotMatch(routed?.reply ?? "", /handled by/);
  });

  check("the clarification names the real options and promises nothing", () => {
    const text = conflictClarification(["todoist_task", "gmail_draft"]);
    assert.match(text, /a Todoist task or an email draft/);
    // It must not claim anything happened.
    assert.doesNotMatch(text, /changed|updated|done/i);
  });

  await asyncCheck("11. cross-user isolation holds through the real cascade", async () => {
    const store = new FakeContextStore();
    todoistList(store, "user_a");
    // user_b has no context at all — their identical message must NOT be routed
    // to Todoist off the back of user_a's list.
    const routed = await routeWith("user_b", "change the second one", store);
    assert.notEqual(routed?.source, "entityFollowup");
  });

  await asyncCheck("12. an expired context routes as if there were none", async () => {
    const store = new FakeContextStore();
    todoistList(store, "u1", 40 * 60 * 1000); // past its 30-minute TTL
    const routed = await routeWith("u1", "change the second one", store);
    assert.notEqual(routed?.source, "entityFollowup", "a dead list must not claim a follow-up");
  });

  await asyncCheck("no context at all → the cascade is completely unchanged", async () => {
    const store = new FakeContextStore();
    const routed = await routeWith("u1", "change the second one", store);
    // Exactly today's behaviour: Gmail's draft gate takes it. The arbiter only ever
    // intervenes when it has a real reason to.
    assert.equal(routed?.source, "gmailDraftLifecycle");
  });

  await asyncCheck("a non-follow-up is never arbitrated", async () => {
    const store = new FakeContextStore();
    todoistList(store, "u1");
    const routed = await routeWith("u1", "book a meeting with Sam on Friday", store, {
      calendarWrite: async () => ({ handled: true, reply: "handled by calendarWrite" }),
    });
    assert.equal(routed?.reply, "handled by calendarWrite");
  });

  await asyncCheck("an arbitration failure degrades to the normal cascade", async () => {
    // A context lookup that throws must never block the reply.
    const routed = await routeInboundText("u1", "change the second one", {
      memory: async () => ({ handled: false }),
      reminder: async () => ({ handled: false }),
      confirmation: async () => ({ handled: false }),
      entityFollowup: (u, t) =>
        handleEntityFollowup(u, t, {
          resolveOwner: async () => {
            throw new Error("store down");
          },
        }),
      gmailClarify: async () => ({ handled: false }),
      gmailDraftFollowup: async () => ({ handled: false }),
      gmailDraftLifecycle: async () => ({ handled: true, reply: "handled by gmailDraftLifecycle" }),
      gmailCommand: async () => ({ handled: false }),
      calendarUndo: async () => ({ handled: false }),
      todoistUndo: async () => ({ handled: false }),
      todoistWrite: async () => ({ handled: false }),
      todoistRead: async () => ({ handled: false }),
      calendarWrite: async () => ({ handled: false }),
      gmailWrite: async () => ({ handled: false }),
      actionIntent: async () => ({ handled: false }),
      calendarAvailability: async () => ({ handled: false }),
      calendar: async () => ({ handled: false }),
      calendarRead: async () => ({ handled: false }),
      gmailReadOne: async () => ({ handled: false }),
      gmailSummary: async () => ({ handled: false }),
      gmailSearch: async () => ({ handled: false }),
      gmailQuestion: async () => ({ handled: false }),
      pendingReprompt: async () => ({ handled: false }),
    });
    assert.equal(routed?.source, "gmailDraftLifecycle");
  });

  console.log("arbitration: memory vs pronoun-only destructive follow-ups");

  check("memory declines a delete that names ONLY a pronoun", () => {
    // THE ROOT CAUSE. `FORGET_MATCH_RE` matches any delete/remove/forget prefix and
    // treats the rest as a search string, so "delete it" searched for a memory whose
    // text contains "it" — and answered "I couldn't find a saved memory matching
    // that" while the user was looking at a task list.
    for (const t of ["delete it", "delete that", "remove it", "delete this", "forget it", "delete that one"]) {
      assert.equal(isPronounOnlyForgetTarget(t), true, `"${t}" names no memory`);
      assert.equal(classifyMemoryCommand(t).intent, "none", `"${t}" must not be a memory command`);
    }
  });

  check("genuine memory commands are COMPLETELY unchanged", () => {
    // The regression that matters most: memory must keep everything it owns.
    assert.equal(classifyMemoryCommand("forget my favourite colour").intent, "forget");
    assert.equal(classifyMemoryCommand("delete the memory about my address").intent, "forget");
    assert.equal(classifyMemoryCommand("clear my memories").intent, "forget");
    assert.equal(classifyMemoryCommand("forget that memory").intent, "forget");
    assert.equal(classifyMemoryCommand("remember I like tea").intent, "remember");
    assert.equal(classifyMemoryCommand("what do you remember").intent, "list");
    // An explicit memory noun wins even though "that" is a pronoun.
    assert.equal(isPronounOnlyForgetTarget("delete that memory"), false);
  });

  check("an explicit memory reference names memory, whatever list is on screen", () => {
    assert.deepEqual(explicitEntityKinds("delete that memory"), ["memory_item"]);
    // …and therefore conflicts with a task reference rather than silently picking.
    assert.deepEqual(toProviderFamilies(["memory_item", "todoist_task"]).sort(), [
      "memory_item",
      "todoist_task",
    ]);
  });

  check("destructive pronoun-only follow-ups are identified", () => {
    for (const t of ["delete it", "remove it", "delete that", "delete the first one"]) {
      assert.equal(isDestructiveFollowup(t), true, `"${t}" is destructive`);
    }
    // Not destructive, or not a follow-up.
    assert.equal(isDestructiveFollowup("complete it"), false);
    assert.equal(isDestructiveFollowup("delete the pitch deck task"), false);
  });

  await asyncCheck("invariant 1: 'delete it'/'delete that'/'remove it' route to Todoist", async () => {
    for (const text of ["delete it", "delete that", "remove it"]) {
      const store = new FakeContextStore();
      todoistActed(store, "u1");
      const routed = await routeWith("u1", text, store, {
        // The handler that swallowed it on the real device, behind its REAL gate.
        memory: async (_u: string, t: string | undefined) =>
          classifyMemoryCommand(t).intent === "none"
            ? { handled: false as const }
            : { handled: true, reply: "I’m couldn’t find a saved memory matching that." },
      });
      assert.equal(routed?.source, "entityFollowup", `"${text}" must be arbitrated`);
      assert.equal(routed?.reply, "handled by todoist");
      assert.doesNotMatch(routed?.reply ?? "", /memory/i, "must never reach Memory");
    }
  });

  await asyncCheck("a destructive follow-up with NO context fails closed, mutating nothing", async () => {
    const store = new FakeContextStore();
    const routed = await routeWith("u1", "delete it", store, {
      memory: async (_u: string, t: string | undefined) =>
        classifyMemoryCommand(t).intent === "none"
          ? { handled: false as const }
          : { handled: true, reply: "memory claimed it" },
    });
    // It must ASK — never fall through to the brain, which could answer "Deleted!".
    assert.equal(routed?.source, "entityFollowup");
    assert.equal(routed?.reply, DESTRUCTIVE_NO_CONTEXT_REPLY);
    assert.doesNotMatch(routed?.reply ?? "", /deleted/i);
  });

  await asyncCheck("explicit memory deletion still reaches Memory, even with a task context", async () => {
    const store = new FakeContextStore();
    todoistActed(store, "u1");
    for (const text of ["forget my favourite colour", "delete the memory about my address", "clear my memories"]) {
      const routed = await routeWith("u1", text, store, {
        memory: async (_u: string, t: string | undefined) =>
          classifyMemoryCommand(t).intent === "none"
            ? { handled: false as const }
            : { handled: true, reply: "handled by memory" },
      });
      assert.equal(routed?.reply, "handled by memory", `"${text}" is Memory's`);
    }
  });

  console.log(`\narbitration: ${passed} assertions passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
