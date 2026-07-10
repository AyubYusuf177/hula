import assert from "node:assert/strict";

import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  clampMessageLimit,
  parseMessageOrder,
} from "../src/db/queries";

/**
 * Offline tests for the inspection query helpers. Covers the PURE pieces that
 * need no database: `limit` clamping and `order` parsing for the
 * `GET /v1/me/messages` endpoint. The DB-backed query functions are exercised
 * via the manual persistence script (`npm run test:persistence`).
 *
 * No network, no Clerk, no DB. Run with: `npm test`.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

check("clampMessageLimit falls back to the default when absent", () => {
  assert.equal(clampMessageLimit(undefined), DEFAULT_MESSAGE_LIMIT);
});

check("clampMessageLimit falls back for non-numeric or empty input", () => {
  assert.equal(clampMessageLimit(""), DEFAULT_MESSAGE_LIMIT);
  assert.equal(clampMessageLimit("abc"), DEFAULT_MESSAGE_LIMIT);
});

check("clampMessageLimit rejects zero and negative values", () => {
  assert.equal(clampMessageLimit("0"), DEFAULT_MESSAGE_LIMIT);
  assert.equal(clampMessageLimit("-5"), DEFAULT_MESSAGE_LIMIT);
});

check("clampMessageLimit keeps valid in-range values", () => {
  assert.equal(clampMessageLimit("1"), 1);
  assert.equal(clampMessageLimit("25"), 25);
  assert.equal(clampMessageLimit(String(MAX_MESSAGE_LIMIT)), MAX_MESSAGE_LIMIT);
});

check("clampMessageLimit clamps values above the maximum", () => {
  assert.equal(clampMessageLimit("101"), MAX_MESSAGE_LIMIT);
  assert.equal(clampMessageLimit("100000"), MAX_MESSAGE_LIMIT);
});

check("clampMessageLimit tolerates surrounding whitespace", () => {
  assert.equal(clampMessageLimit("  30  "), 30);
});

check("parseMessageOrder defaults to newest-first (desc)", () => {
  assert.equal(parseMessageOrder(undefined), "desc");
  assert.equal(parseMessageOrder("nonsense"), "desc");
  assert.equal(parseMessageOrder("desc"), "desc");
});

check("parseMessageOrder honours an explicit oldest-first (asc)", () => {
  assert.equal(parseMessageOrder("asc"), "asc");
  assert.equal(parseMessageOrder("ASC"), "asc");
  assert.equal(parseMessageOrder("  asc "), "asc");
});

console.log(`\n${passed} query checks passed.`);
