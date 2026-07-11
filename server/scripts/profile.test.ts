import assert from "node:assert/strict";

import { buildHulaSystemPrompt, deriveAge, toneGuidance } from "../src/ai/prompts";
import {
  profileToBrainContext,
  sanitizeProfileInput,
} from "../src/users/profile";

/**
 * Offline tests for the Section 7 profile sync + brain context. Everything here
 * is pure — NO database, network, or Clerk. Covers input sanitisation, brain
 * context derivation, tone mapping, and that profile context is used safely in
 * the system prompt without leaking any vendor/internal detail. Run: `npm test`.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// --- Sanitisation --------------------------------------------------------

check("sanitizeProfileInput keeps known fields and trims strings", () => {
  const out = sanitizeProfileInput({
    displayName: "  Ayub  ",
    firstName: "Ayub",
    tone: "concise",
    sex: "male",
    birthday: "1996-04-12",
    helpMost: ["travel", "emails"],
    discoverySource: "tiktok",
    timezone: "Europe/London",
    locale: "en-GB",
    country: "GB",
  });
  assert.deepEqual(out, {
    displayName: "Ayub",
    firstName: "Ayub",
    tone: "concise",
    sex: "male",
    birthday: "1996-04-12",
    helpMost: ["travel", "emails"],
    discoverySource: "tiktok",
    timezone: "Europe/London",
    locale: "en-GB",
    country: "GB",
  });
});

check("sanitizeProfileInput drops unknown fields and empty strings", () => {
  const out = sanitizeProfileInput({
    displayName: "   ",
    firstName: "Sam",
    evil: "DROP TABLE users",
    token: "secret-token",
    apiKey: "sk-123",
  } as Record<string, unknown>);
  assert.deepEqual(out, { firstName: "Sam" });
  assert.equal("evil" in out, false);
  assert.equal("token" in out, false);
});

check("sanitizeProfileInput rejects an invalid tone", () => {
  assert.equal(sanitizeProfileInput({ tone: "spicy" }).tone, undefined);
  assert.equal(sanitizeProfileInput({ tone: "witty" }).tone, "witty");
});

check("sanitizeProfileInput caps helpMost length and item length", () => {
  const many = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
  const out = sanitizeProfileInput({ helpMost: many });
  assert.ok(out.helpMost);
  assert.ok(out.helpMost!.length <= 12, "helpMost should be capped to 12");

  const longItem = "x".repeat(200);
  const capped = sanitizeProfileInput({ helpMost: [longItem] });
  assert.equal(capped.helpMost?.[0]?.length, 40);
});

check("sanitizeProfileInput caps long strings", () => {
  const out = sanitizeProfileInput({ displayName: "y".repeat(500) });
  assert.equal(out.displayName?.length, 120);
});

check("sanitizeProfileInput dedupes helpMost and drops blanks", () => {
  const out = sanitizeProfileInput({ helpMost: ["travel", "travel", "  ", "emails"] });
  assert.deepEqual(out.helpMost, ["travel", "emails"]);
});

check("sanitizeProfileInput tolerates non-object input", () => {
  assert.deepEqual(sanitizeProfileInput(null), {});
  assert.deepEqual(sanitizeProfileInput("nope"), {});
  assert.deepEqual(sanitizeProfileInput(undefined), {});
});

// --- Brain context derivation --------------------------------------------

check("profileToBrainContext maps safe fields", () => {
  const ctx = profileToBrainContext({
    firstName: "Ayub",
    tone: "strategic",
    helpMost: ["travel"],
    sex: "male",
    timezone: "Europe/London",
    locale: "en-GB",
    country: "GB",
    birthday: "1996-04-12",
  });
  assert.equal(ctx.firstName, "Ayub");
  assert.equal(ctx.tone, "strategic");
  assert.deepEqual(ctx.helpMost, ["travel"]);
  assert.equal(ctx.timezone, "Europe/London");
});

check("profileToBrainContext falls back to first word of displayName", () => {
  const ctx = profileToBrainContext({ displayName: "Ayub Yusuf" });
  assert.equal(ctx.firstName, "Ayub");
});

check("profileToBrainContext on empty/undefined profile returns empty", () => {
  assert.deepEqual(profileToBrainContext(undefined), {});
  assert.deepEqual(profileToBrainContext(null), {});
  assert.deepEqual(profileToBrainContext({}), {});
});

// --- Tone mapping + age derivation ---------------------------------------

check("toneGuidance maps each known tone and ignores unknown", () => {
  assert.ok(toneGuidance("concise")?.includes("minimal"));
  assert.ok(toneGuidance("witty")?.includes("personality"));
  assert.ok(toneGuidance("strategic")?.includes("planning"));
  assert.equal(toneGuidance("nonsense"), undefined);
  assert.equal(toneGuidance(undefined), undefined);
});

check("deriveAge computes whole years and rejects junk", () => {
  const now = new Date("2026-07-11T00:00:00Z");
  assert.equal(deriveAge("1996-04-12", now), 30);
  assert.equal(deriveAge("1996-12-31", now), 29); // birthday not reached yet
  assert.equal(deriveAge("not-a-date", now), undefined);
  assert.equal(deriveAge(undefined, now), undefined);
});

// --- Prompt uses context safely ------------------------------------------

check("buildHulaSystemPrompt applies tone guidance and helpMost", () => {
  const prompt = buildHulaSystemPrompt({
    firstName: "Ayub",
    tone: "concise",
    helpMost: ["travel", "emails"],
    channel: "imessage",
  });
  assert.ok(prompt.startsWith("You are Hula"));
  assert.ok(prompt.includes("Ayub"));
  assert.ok(prompt.toLowerCase().includes("minimal")); // concise tone guidance
  assert.ok(prompt.includes("travel"));
});

check("buildHulaSystemPrompt with profile context leaks no vendor detail", () => {
  // Vendor/internal terms must never leak. (The prompt DOES mention
  // "onboarding/profiles" on purpose — it instructs the model NOT to reference
  // them to the user — so those words are intentionally not forbidden here.)
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
  const prompt = buildHulaSystemPrompt({
    firstName: "Ayub",
    tone: "strategic",
    helpMost: ["research"],
    sex: "male",
    birthday: "1996-04-12",
    timezone: "Europe/London",
    locale: "en-GB",
    country: "GB",
    channel: "imessage",
  }).toLowerCase();
  for (const term of forbidden) {
    assert.ok(!prompt.includes(term), `system prompt must not mention "${term}"`);
  }
});

console.log(`\n${passed} profile checks passed.`);
