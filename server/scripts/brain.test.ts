import assert from "node:assert/strict";

import {
  FALLBACK_REPLY,
  generateHulaReply,
  toAnthropicMessages,
} from "../src/ai/hulaBrain";
import type { BrainMessage } from "../src/ai/hulaBrain";
import { buildHulaSystemPrompt, HULA_SYSTEM_PROMPT } from "../src/ai/prompts";
import { mapRowsToBrainMessages } from "../src/db/queries";
import { isNormalLinkedMessage } from "../src/users/linking";

/**
 * Offline tests for the Section 6 Hula brain/router. Everything here is pure or
 * uses an injected fake generator — NO real Anthropic call, no network, no DB.
 * Covers routing (which flows reach the brain), history preparation, prompt
 * safety, and the fallback path. Run with: `npm test`.
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

// --- Routing: which flows call the brain ---------------------------------

check("already-linked normal (non-code) message is brain-eligible", () => {
  assert.equal(
    isNormalLinkedMessage({ existingUserId: "user_a", hadCode: false }),
    true,
  );
});

check("connect-code message from a linked user is NOT brain-eligible", () => {
  assert.equal(
    isNormalLinkedMessage({ existingUserId: "user_a", hadCode: true }),
    false,
  );
});

check("unknown sender (no code) is NOT brain-eligible", () => {
  assert.equal(
    isNormalLinkedMessage({ existingUserId: undefined, hadCode: false }),
    false,
  );
});

check("unknown sender WITH a code is NOT brain-eligible", () => {
  assert.equal(
    isNormalLinkedMessage({ existingUserId: undefined, hadCode: true }),
    false,
  );
});

// --- History preparation -------------------------------------------------

check("mapRowsToBrainMessages maps direction and reverses to oldest-first", () => {
  // Rows come newest-first (as queried); result must be oldest-first.
  const rows = [
    { direction: "inbound" as const, text: "latest question" },
    { direction: "outbound" as const, text: "earlier reply" },
    { direction: "inbound" as const, text: "earlier question" },
  ];
  const result = mapRowsToBrainMessages(rows);
  assert.deepEqual(result, [
    { role: "user", text: "earlier question" },
    { role: "assistant", text: "earlier reply" },
    { role: "user", text: "latest question" },
  ]);
});

check("mapRowsToBrainMessages drops rows without usable text", () => {
  const rows = [
    { direction: "inbound" as const, text: "hi" },
    { direction: "outbound" as const, text: null },
    { direction: "inbound" as const, text: "   " },
  ];
  assert.deepEqual(mapRowsToBrainMessages(rows), [
    { role: "user", text: "hi" },
  ]);
});

check("toAnthropicMessages trims leading/trailing assistant turns", () => {
  const history: BrainMessage[] = [
    { role: "assistant", text: "leading" },
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi there" },
    { role: "user", text: "help me plan" },
    { role: "assistant", text: "trailing (no user after)" },
  ];
  assert.deepEqual(toAnthropicMessages(history), [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
    { role: "user", content: "help me plan" },
  ]);
});

check("toAnthropicMessages collapses consecutive same-role turns", () => {
  const history: BrainMessage[] = [
    { role: "user", text: "part one" },
    { role: "user", text: "part two" },
  ];
  assert.deepEqual(toAnthropicMessages(history), [
    { role: "user", content: "part one\n\npart two" },
  ]);
});

check("toAnthropicMessages returns [] when nothing usable remains", () => {
  assert.deepEqual(toAnthropicMessages([]), []);
  assert.deepEqual(
    toAnthropicMessages([{ role: "assistant", text: "only assistant" }]),
    [],
  );
});

// --- Prompt safety -------------------------------------------------------

check("Hula system prompt does not expose internal/vendor details", () => {
  const forbidden = [
    "sendblue",
    "clerk",
    "neon",
    "prisma",
    "anthropic",
    "ngrok",
    "postgres",
    "webhook",
  ];
  const haystack = buildHulaSystemPrompt({
    firstName: "Ayub",
    tone: "concise",
    channel: "imessage",
  }).toLowerCase();
  for (const term of forbidden) {
    assert.ok(
      !haystack.includes(term),
      `system prompt must not mention "${term}"`,
    );
  }
  // Base prompt (no context) is equally clean.
  assert.ok(!HULA_SYSTEM_PROMPT.toLowerCase().includes("anthropic"));
});

// --- Fallback + generation paths (injected fake generator) ---------------

asyncCheck("empty history falls back without calling the model", async () => {
  let called = false;
  const result = await generateHulaReply({
    history: [],
    generate: async () => {
      called = true;
      return "should not be used";
    },
  });
  assert.equal(called, false);
  assert.equal(result.usedFallback, true);
  assert.equal(result.reply, FALLBACK_REPLY);
});

asyncCheck("provider error resolves to the safe fallback", async () => {
  const result = await generateHulaReply({
    history: [{ role: "user", text: "hi" }],
    generate: async () => {
      throw new Error("simulated rate limit");
    },
  });
  assert.equal(result.usedFallback, true);
  assert.equal(result.reply, FALLBACK_REPLY);
});

asyncCheck("successful generation returns the model reply", async () => {
  let seenSystem = "";
  let seenMessages: unknown = null;
  const result = await generateHulaReply({
    history: [
      { role: "user", text: "earlier" },
      { role: "assistant", text: "ok" },
      { role: "user", text: "help me plan my next 3 hours" },
    ],
    context: { channel: "imessage" },
    generate: async ({ system, messages }) => {
      seenSystem = system;
      seenMessages = messages;
      return "Here's a quick plan.";
    },
  });
  assert.equal(result.usedFallback, false);
  assert.equal(result.reply, "Here's a quick plan.");
  // The model receives the Hula system prompt and a valid, user-ending list.
  assert.ok(seenSystem.startsWith("You are Hula"));
  assert.deepEqual(seenMessages, [
    { role: "user", content: "earlier" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "help me plan my next 3 hours" },
  ]);
});

asyncCheck("blank model reply falls back", async () => {
  const result = await generateHulaReply({
    history: [{ role: "user", text: "hi" }],
    generate: async () => "   ",
  });
  assert.equal(result.usedFallback, true);
  assert.equal(result.reply, FALLBACK_REPLY);
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\n${passed} brain checks passed.`);
}

void run();
