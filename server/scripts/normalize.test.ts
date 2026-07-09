import assert from "node:assert/strict";

import {
  extractRecipientHandle,
  extractSenderHandle,
  isPlaceholderHandle,
  normalizeSendblueInbound,
} from "../src/channels/sendblue/normalize";
import type { SendblueInboundWebhook } from "../src/channels/sendblue/types";

/**
 * Safe, offline test for Sendblue normalization only. It NEVER calls the real
 * Sendblue API — it just verifies field extraction. Run with: `npm test`.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// 1. Required case from the task: top-level `from` / `to`.
check("extracts from/to from a simple payload", () => {
  const payload: SendblueInboundWebhook = {
    from: "+447000000000",
    to: "+16465480761",
    content: "hi hula",
    message_handle: "test-handle-1",
  };
  const message = normalizeSendblueInbound(payload);
  assert.equal(message.senderHandle, "+447000000000");
  assert.equal(message.recipientHandle, "+16465480761");
  assert.equal(message.provider, "sendblue");
  assert.equal(message.content.text, "hi hula");
});

// 2. Sendblue's documented shape: from_number / number.
check("extracts from_number / number", () => {
  const payload: SendblueInboundWebhook = {
    from_number: "+447000000000",
    number: "+16465480761",
    content: "hello",
  };
  assert.equal(extractSenderHandle(payload), "+447000000000");
  assert.equal(extractRecipientHandle(payload), "+16465480761");
});

// 3. Nested shape: data.from / data.to.
check("extracts nested data.from / data.to", () => {
  const payload: SendblueInboundWebhook = {
    data: { from: "+447000000000", to: "+16465480761" },
    content: "nested",
  };
  assert.equal(extractSenderHandle(payload), "+447000000000");
  assert.equal(extractRecipientHandle(payload), "+16465480761");
});

// 4. Placeholder/test numbers are flagged.
check("flags placeholder and test numbers", () => {
  assert.equal(isPlaceholderHandle("+10000000000"), true);
  assert.equal(isPlaceholderHandle("10000000000"), true);
  assert.equal(isPlaceholderHandle(undefined), true);
  assert.equal(isPlaceholderHandle(""), true);
  assert.equal(isPlaceholderHandle("unknown"), true);
  // A real-looking number is NOT a placeholder.
  assert.equal(isPlaceholderHandle("+16465480761"), false);
});

// 5. Missing sender never falls through to a fabricated number.
check("missing sender normalizes to 'unknown'", () => {
  const payload: SendblueInboundWebhook = { content: "no sender" };
  const message = normalizeSendblueInbound(payload);
  assert.equal(message.senderHandle, "unknown");
  assert.equal(isPlaceholderHandle(message.senderHandle), true);
});

console.log(`\n${passed} normalization checks passed.`);
