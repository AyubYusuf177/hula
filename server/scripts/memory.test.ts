import assert from "node:assert/strict";

import { buildHulaSystemPrompt } from "../src/ai/prompts";
import {
  classifyMemoryCommand,
  formatMemoryList,
  inferMemoryImportance,
  inferMemoryType,
  isMemoryAllowed,
  MEMORY_REPLIES,
  memoryMatchesQuery,
  rememberConfirmation,
  sanitizeMemoryText,
  toSecondPerson,
} from "../src/users/memory";

/**
 * Offline tests for Section 8 explicit memory. Everything here is PURE — NO
 * database, network, or Anthropic call. Covers command classification (remember
 * / forget / list / none), text sanitisation, the safety policy (practical
 * sensitive memories allowed, secrets blocked), phrasing, keyword matching, and
 * that memory context is injected into the brain prompt. Run with: `npm test`.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// --- Command classification ----------------------------------------------

check("classify: 'remember …' is a remember command", () => {
  const cmd = classifyMemoryCommand("Remember I prefer blunt, concise replies.");
  assert.equal(cmd.intent, "remember");
  assert.equal(cmd.intent === "remember" && cmd.content, "I prefer blunt, concise replies.");
});

check("classify: 'please remember that …' strips the trigger and 'that'", () => {
  const cmd = classifyMemoryCommand("Please remember that I avoid alcohol");
  assert.equal(cmd.intent === "remember" && cmd.content, "I avoid alcohol");
});

check("classify: 'don't forget …' is remember, not forget", () => {
  const cmd = classifyMemoryCommand("Don't forget I'm lactose intolerant");
  assert.equal(cmd.intent, "remember");
  assert.equal(cmd.intent === "remember" && cmd.content, "I'm lactose intolerant");
});

check("classify: 'keep in mind …' and 'save this …' are remember", () => {
  assert.equal(classifyMemoryCommand("keep in mind I use they/them").intent, "remember");
  assert.equal(classifyMemoryCommand("save this: I'm based in London").intent, "remember");
});

check("classify: 'forget everything …' is forget-all", () => {
  const cmd = classifyMemoryCommand("Forget everything you remember about me");
  assert.deepEqual(cmd, { intent: "forget", scope: "all" });
});

check("classify: 'clear my memory' is forget-all", () => {
  assert.deepEqual(classifyMemoryCommand("clear my memory"), { intent: "forget", scope: "all" });
});

check("classify: 'forget that I prefer blunt replies' is forget-match", () => {
  const cmd = classifyMemoryCommand("Forget that I prefer blunt replies");
  assert.equal(cmd.intent, "forget");
  assert.equal(cmd.intent === "forget" && cmd.scope, "match");
  assert.equal(cmd.intent === "forget" && cmd.scope === "match" && cmd.query, "I prefer blunt replies");
});

check("classify: 'delete that memory about my diet' is forget-match", () => {
  const cmd = classifyMemoryCommand("delete that memory about my diet");
  assert.equal(cmd.intent, "forget");
  assert.equal(cmd.intent === "forget" && cmd.scope === "match" && cmd.query, "my diet");
});

// --- Calendar-delete vs memory-delete routing (Section 15 fix) -----------

check("classify: explicit CALENDAR event deletes are NOT memory commands", () => {
  // These must fall through so the Section 15 Calendar-write handler runs.
  for (const msg of [
    "Delete the Hula calendar test tomorrow at 4pm",
    "Delete lunch with Adam tomorrow",
    "Cancel my meeting tomorrow at 2pm",
    "Remove the Project Planning event from my calendar",
    "Delete my 4pm calendar event tomorrow",
  ]) {
    assert.equal(classifyMemoryCommand(msg).intent, "none", `should not be memory: ${msg}`);
  }
});

check("classify: saved-memory deletes STILL route to memory forget", () => {
  const coffee = classifyMemoryCommand("Forget that I like coffee");
  assert.equal(coffee.intent, "forget");
  assert.equal(coffee.intent === "forget" && coffee.scope, "match");

  const savedMemory = classifyMemoryCommand("Delete the saved memory about Adam");
  assert.equal(savedMemory.intent, "forget", "explicit 'memory' keeps it a memory command");

  const fromMemory = classifyMemoryCommand("Remove that from your memory");
  assert.equal(fromMemory.intent, "forget", "explicit 'memory' keeps it a memory command");

  const restaurant = classifyMemoryCommand("Forget what I told you about my favourite restaurant");
  assert.equal(restaurant.intent, "forget");
});

check("classify: 'delete that memory about my diet' still routes to memory", () => {
  // A calendar date/time cue is absent and 'memory' is explicit → stays memory.
  assert.equal(classifyMemoryCommand("delete that memory about my diet").intent, "forget");
});

check("classify: list questions are list commands", () => {
  assert.equal(classifyMemoryCommand("What do you remember about me?").intent, "list");
  assert.equal(classifyMemoryCommand("what have you remembered?").intent, "list");
  assert.equal(classifyMemoryCommand("show me my memories").intent, "list");
  assert.equal(classifyMemoryCommand("list my memories").intent, "list");
});

check("classify: ordinary messages are NOT memory commands", () => {
  assert.equal(classifyMemoryCommand("Plan a quick dinner idea for me.").intent, "none");
  assert.equal(classifyMemoryCommand("What's the weather like tomorrow?").intent, "none");
  assert.equal(classifyMemoryCommand("Can you help me draft an email?").intent, "none");
  assert.equal(classifyMemoryCommand("").intent, "none");
  assert.equal(classifyMemoryCommand(undefined).intent, "none");
});

// --- Sanitisation --------------------------------------------------------

check("sanitizeMemoryText trims, collapses whitespace, and strips quotes", () => {
  assert.equal(sanitizeMemoryText('  "I like tea"  '), "I like tea");
  assert.equal(sanitizeMemoryText("I  like\n\n  tea"), "I like tea");
});

check("sanitizeMemoryText caps very long text", () => {
  const out = sanitizeMemoryText("x".repeat(1000));
  assert.ok(out && out.length <= 280, "memory text should be capped to 280");
});

check("sanitizeMemoryText rejects empty/too-short input", () => {
  assert.equal(sanitizeMemoryText("   "), null);
  assert.equal(sanitizeMemoryText("."), null);
});

// --- Safety policy -------------------------------------------------------

check("policy: practical sensitive constraint is ALLOWED when explicit", () => {
  assert.equal(isMemoryAllowed("I'm Muslim and don't eat pork"), true);
  assert.equal(isMemoryAllowed("I'm lactose intolerant"), true);
  assert.equal(isMemoryAllowed("I avoid alcohol"), true);
  assert.equal(isMemoryAllowed("I prefer politically neutral wording"), true);
});

check("policy: secrets and identifiers are BLOCKED", () => {
  assert.equal(isMemoryAllowed("my password is abc123"), false);
  assert.equal(isMemoryAllowed("my api key is sk-test-123"), false);
  assert.equal(isMemoryAllowed("my credit card number is on file"), false);
  assert.equal(isMemoryAllowed("my bank account is important"), false);
  assert.equal(isMemoryAllowed("my SSN matters"), false);
  assert.equal(isMemoryAllowed("I live at 221 Baker Street"), false);
  assert.equal(isMemoryAllowed("my number is 4111111111111111"), false);
});

// --- Type + importance inference -----------------------------------------

check("inferMemoryType classifies common memories", () => {
  assert.equal(inferMemoryType("I prefer blunt, concise replies"), "preference");
  assert.equal(inferMemoryType("I don't eat pork"), "constraint");
  assert.equal(inferMemoryType("I'm building Hula"), "project");
});

check("inferMemoryImportance raises constraints to high", () => {
  assert.equal(inferMemoryImportance("constraint"), "high");
  assert.equal(inferMemoryImportance("preference"), "medium");
});

// --- Phrasing ------------------------------------------------------------

check("toSecondPerson rewrites first-person to a direct statement", () => {
  assert.equal(toSecondPerson("I prefer blunt, concise replies"), "You prefer blunt, concise replies.");
  assert.equal(toSecondPerson("I'm Muslim and don't eat pork"), "You're Muslim and don't eat pork.");
  assert.equal(toSecondPerson("I'm building Hula"), "You're building Hula.");
});

check("rememberConfirmation reads naturally", () => {
  const stored = toSecondPerson("I prefer blunt, concise replies");
  assert.equal(
    rememberConfirmation(stored),
    "Got it — I’ll remember that you prefer blunt, concise replies.",
  );
});

check("formatMemoryList numbers memories and handles empty", () => {
  assert.equal(formatMemoryList([]), MEMORY_REPLIES.listEmpty);
  const out = formatMemoryList([
    "You prefer blunt, concise replies.",
    "You're building Hula.",
    "You don't eat pork.",
  ]);
  assert.ok(out.startsWith("I remember:\n1. You prefer blunt, concise replies."));
  assert.ok(out.includes("\n3. You don't eat pork."));
});

// --- Keyword matching (for "forget X") -----------------------------------

check("memoryMatchesQuery matches on significant keyword overlap", () => {
  assert.equal(
    memoryMatchesQuery("You prefer blunt, concise replies.", "I prefer blunt replies"),
    true,
  );
  assert.equal(
    memoryMatchesQuery("You don't eat pork.", "I prefer blunt replies"),
    false,
  );
});

check("memoryMatchesQuery ignores empty/stopword-only queries", () => {
  assert.equal(memoryMatchesQuery("You prefer concise replies.", "that the"), false);
});

// --- Memory context reaches the brain prompt -----------------------------

check("buildHulaSystemPrompt injects memory lines", () => {
  const prompt = buildHulaSystemPrompt({
    channel: "imessage",
    memories: ["You prefer blunt, concise replies.", "You don't eat pork."],
  });
  assert.ok(prompt.startsWith("You are Hula"));
  assert.ok(prompt.includes("explicitly asked you to remember"));
  assert.ok(prompt.includes("- You prefer blunt, concise replies."));
  assert.ok(prompt.includes("- You don't eat pork."));
});

check("buildHulaSystemPrompt with memories leaks no vendor detail", () => {
  const forbidden = ["sendblue", "clerk", "neon", "prisma", "anthropic", "ngrok", "postgres", "webhook"];
  const prompt = buildHulaSystemPrompt({
    channel: "imessage",
    memories: ["You prefer blunt, concise replies."],
  }).toLowerCase();
  for (const term of forbidden) {
    assert.ok(!prompt.includes(term), `memory prompt must not mention "${term}"`);
  }
});

check("buildHulaSystemPrompt omits the memory block when there are none", () => {
  const prompt = buildHulaSystemPrompt({ channel: "imessage", memories: [] });
  assert.ok(!prompt.includes("explicitly asked you to remember"));
});

console.log(`\n${passed} memory checks passed.`);
