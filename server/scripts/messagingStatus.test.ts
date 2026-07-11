import assert from "node:assert/strict";

import { maskHandle } from "../src/users/messagingIdentity";

/**
 * Offline tests for the messaging-status masking used by
 * `GET /v1/me/messaging-status` (Section 7.1). Covers the PURE `maskHandle`
 * helper that keeps the full phone number / email off the wire. The DB-backed
 * status query (`getImessageStatusForUser` / `getMessagingStatus`) is exercised
 * end-to-end via the manual test in the README.
 *
 * No network, no Clerk, no Sendblue, no DB. Run with: `npm test`.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

check("maskHandle hides all but the last four digits of a phone", () => {
  assert.equal(maskHandle("+16465480761"), "+*******0761");
  // Same number in a formatted shape masks identically.
  assert.equal(maskHandle("+1 (646) 548-0761"), "+*******0761");
  // No leading + is preserved as-is (no + added).
  assert.equal(maskHandle("6465480761"), "******0761");
});

check("maskHandle never leaks the full phone number", () => {
  const masked = maskHandle("+16465480761");
  assert.ok(!masked.includes("6465"), "masked value must not contain the hidden digits");
  assert.ok(masked.endsWith("0761"), "only the last four digits stay visible");
});

check("maskHandle masks the local part of an email", () => {
  assert.equal(maskHandle("me@example.com"), "m***@example.com");
  assert.equal(maskHandle("Ayub@Example.com"), "A***@Example.com");
});

check("maskHandle handles empty / junk input safely", () => {
  assert.equal(maskHandle(""), "");
  assert.equal(maskHandle("   "), "");
  assert.equal(maskHandle("no-digits-here"), "***");
});

console.log(`\n${passed} messaging-status checks passed.`);
