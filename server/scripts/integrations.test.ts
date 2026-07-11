import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  getProvider,
  isKnownProvider,
  listIntegrationCatalog,
} from "../src/integrations/catalog";
import {
  TokenVaultConfigError,
  decodeEncryptionKey,
  decryptToken,
  encryptToken,
  hashScopes,
  isTokenVaultConfigured,
} from "../src/integrations/tokenVault";
import {
  ACTION_RISK_LEVELS,
  evaluateActionPolicy,
} from "../src/integrations/policy";
import { buildHulaSystemPrompt } from "../src/ai/prompts";

/**
 * Offline tests for Section 10 integration foundation. Everything here is PURE —
 * NO database, NO network, NO real provider API. Covers the provider registry,
 * the AES-256-GCM token vault (roundtrip + refusal without a key + tamper
 * detection), scope hashing, the action-risk policy, and the honest brain
 * integration-context rendering. Run with: `npm test`.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// A throwaway 32-byte key for the vault tests. Never a real key.
const TEST_KEY = randomBytes(32);

// --- Provider registry ---------------------------------------------------

check("registry: contains the expected providers", () => {
  const ids = listIntegrationCatalog().map((p) => p.provider);
  for (const expected of [
    "google_calendar",
    "gmail",
    "zoom",
    "notion",
    "asana",
    "slack",
    "nylas",
    "generic",
  ]) {
    assert.ok(ids.includes(expected as never), `missing provider: ${expected}`);
  }
});

check("registry: every entry has complete, typed metadata", () => {
  for (const entry of listIntegrationCatalog()) {
    assert.ok(entry.displayName.length > 0, "displayName required");
    assert.ok(entry.category.length > 0, "category required");
    assert.ok(
      ["planned", "available_stub", "available_readonly"].includes(entry.status),
    );
    assert.ok(["oauth2", "api_key", "partner", "none"].includes(entry.authType));
    assert.ok(Array.isArray(entry.defaultScopes));
    assert.ok(Array.isArray(entry.capabilities));
  }
});

check("registry: google_calendar is the least-privilege first provider", () => {
  const gcal = getProvider("google_calendar");
  assert.ok(gcal, "google_calendar should exist");
  assert.equal(gcal?.authType, "oauth2");
  assert.ok((gcal?.defaultScopes.length ?? 0) > 0, "should declare default scopes");
});

check("registry: google_calendar is READ-ONLY (no write scope/capability)", () => {
  const gcal = getProvider("google_calendar");
  assert.equal(gcal?.status, "available_readonly");
  // No scope may grant write access.
  for (const scope of gcal?.defaultScopes ?? []) {
    assert.ok(!/\.events\b(?!\.readonly)/.test(scope), `write-ish scope: ${scope}`);
    assert.ok(/readonly/.test(scope), `scope must be read-only: ${scope}`);
  }
  // No capability may imply writing.
  for (const cap of gcal?.capabilities ?? []) {
    assert.ok(!/write|create|edit|delete/i.test(cap), `write capability leaked: ${cap}`);
  }
});

check("registry: unknown provider is rejected", () => {
  assert.equal(isKnownProvider("google_calendar"), true);
  assert.equal(isKnownProvider("myspace"), false);
  assert.equal(isKnownProvider(""), false);
  assert.equal(getProvider("myspace"), undefined);
});

// --- Token vault ---------------------------------------------------------

check("vault: encrypt → decrypt roundtrips with a test key", () => {
  const secret = "ya29.a0Af_fake_access_token_value";
  const ciphertext = encryptToken(secret, TEST_KEY);
  // Ciphertext must NOT contain the plaintext token anywhere.
  assert.ok(!ciphertext.includes(secret), "ciphertext must not leak plaintext");
  assert.ok(ciphertext.startsWith("v1:"), "ciphertext should be versioned");
  const decrypted = decryptToken(ciphertext, TEST_KEY);
  assert.equal(decrypted, secret, "roundtrip must return the original token");
});

check("vault: two encryptions of the same token differ (random IV)", () => {
  const a = encryptToken("same-token", TEST_KEY);
  const b = encryptToken("same-token", TEST_KEY);
  assert.notEqual(a, b, "IV should make ciphertexts differ");
  assert.equal(decryptToken(a, TEST_KEY), "same-token");
  assert.equal(decryptToken(b, TEST_KEY), "same-token");
});

check("vault: refuses to store without a key", () => {
  const saved = process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  delete process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  try {
    assert.equal(isTokenVaultConfigured(), false);
    assert.throws(() => encryptToken("x"), TokenVaultConfigError);
    assert.throws(() => decodeEncryptionKey(undefined), TokenVaultConfigError);
  } finally {
    if (saved !== undefined) process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = saved;
  }
});

check("vault: rejects a key of the wrong length", () => {
  assert.throws(() => decodeEncryptionKey("dG9vc2hvcnQ="), TokenVaultConfigError);
});

check("vault: accepts base64 and hex 32-byte keys, configured() true", () => {
  const saved = process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = TEST_KEY.toString("base64");
  try {
    assert.equal(isTokenVaultConfigured(), true);
    const hexKey = randomBytes(32).toString("hex");
    assert.equal(decodeEncryptionKey(hexKey).length, 32);
  } finally {
    if (saved !== undefined) process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = saved;
    else delete process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  }
});

check("vault: wrong key fails to decrypt (authenticated)", () => {
  const ciphertext = encryptToken("secret", TEST_KEY);
  const otherKey = randomBytes(32);
  assert.throws(() => decryptToken(ciphertext, otherKey), TokenVaultConfigError);
});

check("vault: tampered ciphertext fails to decrypt", () => {
  const ciphertext = encryptToken("secret", TEST_KEY);
  const parts = ciphertext.split(":");
  // Flip the last char of the ciphertext segment.
  const data = parts[3];
  parts[3] = data.slice(0, -1) + (data.endsWith("A") ? "B" : "A");
  assert.throws(() => decryptToken(parts.join(":"), TEST_KEY), TokenVaultConfigError);
});

check("vault: malformed payloads are rejected safely", () => {
  assert.throws(() => decryptToken("not-a-payload", TEST_KEY), TokenVaultConfigError);
  assert.throws(() => decryptToken("v2:a:b:c", TEST_KEY), TokenVaultConfigError);
});

check("vault: hashScopes is deterministic and order-independent", () => {
  const a = hashScopes(["b", "a"]);
  const b = hashScopes(["a", "b"]);
  assert.equal(a, b, "scope hash must be order-independent");
  assert.notEqual(a, hashScopes(["a", "b", "c"]));
  assert.equal(hashScopes([]), null);
  assert.equal(hashScopes(undefined), null);
});

// --- Action policy -------------------------------------------------------

check("policy: risk levels are ordered safest → most dangerous", () => {
  assert.deepEqual(ACTION_RISK_LEVELS, [
    "read",
    "draft",
    "write",
    "send",
    "purchase",
    "destructive",
  ]);
});

check("policy: reads need connection AND granted scope", () => {
  assert.equal(
    evaluateActionPolicy({ risk: "read", providerConnected: false, scopeGranted: false }).reason,
    "not_connected",
  );
  assert.equal(
    evaluateActionPolicy({ risk: "read", providerConnected: true, scopeGranted: false }).reason,
    "scope_not_granted",
  );
  assert.equal(
    evaluateActionPolicy({ risk: "read", providerConnected: true, scopeGranted: true }).allowed,
    true,
  );
});

check("policy: writes/sends require explicit confirmation", () => {
  const base = { providerConnected: true, scopeGranted: true } as const;
  const write = evaluateActionPolicy({ risk: "write", ...base });
  assert.equal(write.allowed, false);
  assert.equal(write.needsConfirmation, true);
  assert.equal(write.reason, "requires_confirmation");

  const confirmed = evaluateActionPolicy({ risk: "send", ...base, userConfirmed: true });
  assert.equal(confirmed.allowed, true);
});

check("policy: purchases and destructive are never allowed yet", () => {
  const base = { providerConnected: true, scopeGranted: true, userConfirmed: true } as const;
  assert.equal(evaluateActionPolicy({ risk: "purchase", ...base }).allowed, false);
  assert.equal(evaluateActionPolicy({ risk: "destructive", ...base }).allowed, false);
  assert.equal(evaluateActionPolicy({ risk: "purchase", ...base }).reason, "not_allowed_yet");
});

// --- Brain integration context (honest) ----------------------------------

check("prompt: no connected apps → no integration line", () => {
  const prompt = buildHulaSystemPrompt({ firstName: "Ayub" });
  assert.ok(!/connected these apps/i.test(prompt), "should not mention connections");
});

check("prompt: connected apps render honestly (reads ok, writes off)", () => {
  const prompt = buildHulaSystemPrompt({ connectedProviders: ["Google Calendar"] });
  assert.ok(/connected these apps/i.test(prompt));
  assert.ok(/Google Calendar/.test(prompt));
  // Section 12: calendar READS are now honest-and-allowed, but writes/actions
  // stay off and Hula must never claim it performed an action it can't.
  assert.ok(
    /never claim you (?:read|performed)|not turned on/i.test(prompt),
    "must stay honest about un-enabled actions",
  );
});

console.log(`\nAll ${passed} integration foundation tests passed.`);
