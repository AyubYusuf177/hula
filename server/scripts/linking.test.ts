import assert from "node:assert/strict";

import {
  buildLinkMessageBody,
  extractLinkCode,
} from "../src/users/linkSessions";
import { normalizeHandleKey } from "../src/users/messagingIdentity";
import { LINK_REPLIES, decideLinkOutcome } from "../src/users/linking";

/**
 * Offline test for the connect-code linking flow. Covers the PURE pieces that
 * need no database: the code/message helpers, handle normalization, and the
 * `decideLinkOutcome` decision table. The database-backed pieces
 * (createLinkSession, getLinkedIdentity, linkIdentity, resolveInboundLink) are
 * exercised end-to-end via the manual persistence test in the README.
 *
 * No network, no Clerk, no Sendblue, no DB. Run with: `npm test`.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

check("buildLinkMessageBody uses first name or falls back to 'me'", () => {
  assert.equal(
    buildLinkMessageBody("HULA-8K2Q", "Ayub"),
    "Hey Hula, it's Ayub. Connect my account: HULA-8K2Q",
  );
  assert.equal(
    buildLinkMessageBody("HULA-8K2Q"),
    "Hey Hula, it's me. Connect my account: HULA-8K2Q",
  );
});

check("extractLinkCode finds the code inside a natural message", () => {
  const body = "Hey Hula, it's Ayub. Connect my account: HULA-8K2Q";
  assert.equal(extractLinkCode(body), "HULA-8K2Q");
  // Case-insensitive match, normalized to uppercase.
  assert.equal(extractLinkCode("connect hula-abcd please"), "HULA-ABCD");
  assert.equal(extractLinkCode("no code here"), undefined);
  assert.equal(extractLinkCode(undefined), undefined);
});

check("normalizeHandleKey collapses phone formats to bare digits", () => {
  assert.equal(normalizeHandleKey("+1 (646) 548-0761"), "16465480761");
  assert.equal(normalizeHandleKey("+16465480761"), "16465480761");
  // Emails are lowercased, not digit-stripped.
  assert.equal(normalizeHandleKey("Me@Example.com"), "me@example.com");
});

check("valid code on a fresh handle links and replies connected", () => {
  const outcome = decideLinkOutcome({
    existingUserId: undefined,
    sessionUserId: "user_a",
  });
  assert.equal(outcome.status, "connected");
  assert.equal(outcome.reply, LINK_REPLIES.connected);
  assert.equal(outcome.codeMatched, true);
  assert.equal(outcome.effect, "link_and_consume");
});

check("owner re-sending their own code is treated as already connected", () => {
  const outcome = decideLinkOutcome({
    existingUserId: "user_a",
    sessionUserId: "user_a",
  });
  assert.equal(outcome.status, "already_connected");
  assert.equal(outcome.reply, LINK_REPLIES.alreadyConnected);
  assert.equal(outcome.codeMatched, true);
  // The code is consumed but no new identity is created.
  assert.equal(outcome.effect, "consume_only");
});

check("a code for a different user does not relink an owned handle", () => {
  const outcome = decideLinkOutcome({
    existingUserId: "user_a",
    sessionUserId: "user_b",
  });
  assert.equal(outcome.status, "different_account");
  assert.equal(outcome.reply, LINK_REPLIES.differentAccount);
  assert.equal(outcome.codeMatched, true);
  // The code is NOT consumed and no relink happens.
  assert.equal(outcome.effect, "none");
});

check("already-linked sender without a valid code gets alreadyConnected", () => {
  const outcome = decideLinkOutcome({
    existingUserId: "user_a",
    sessionUserId: undefined,
  });
  assert.equal(outcome.status, "already_connected");
  assert.equal(outcome.reply, LINK_REPLIES.alreadyConnected);
  assert.equal(outcome.codeMatched, false);
  assert.equal(outcome.effect, "none");
});

check("unknown sender without a valid code gets notConnected", () => {
  const outcome = decideLinkOutcome({
    existingUserId: undefined,
    sessionUserId: undefined,
  });
  assert.equal(outcome.status, "not_connected");
  assert.equal(outcome.reply, LINK_REPLIES.notConnected);
  assert.equal(outcome.codeMatched, false);
  assert.equal(outcome.effect, "none");
});

console.log(`\n${passed} linking checks passed.`);
