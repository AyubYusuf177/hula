import assert from "node:assert/strict";

import {
  _resetLinkSessions,
  buildLinkMessageBody,
  createLinkSession,
  extractLinkCode,
  getValidLinkSession,
} from "../src/users/linkSessions";
import {
  _resetIdentities,
  getLinkedIdentity,
} from "../src/users/messagingIdentity";
import { LINK_REPLIES, resolveInboundLink } from "../src/users/linking";

/**
 * Offline test for the Section 3 connect-code linking flow. Uses only the
 * in-memory stores — no network, no Clerk, no Sendblue, no DB. Run with:
 * `npm test`.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  _resetLinkSessions();
  _resetIdentities();
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const CODE_SHAPE = /^HULA-[A-Z0-9]{4}$/;

check("createLinkSession returns a well-formed, unique code", () => {
  const a = createLinkSession("user_a");
  const b = createLinkSession("user_b");
  assert.match(a.code, CODE_SHAPE);
  assert.match(b.code, CODE_SHAPE);
  assert.notEqual(a.code, b.code);
  assert.equal(a.used, false);
  assert.ok(a.expiresAt > a.createdAt);
});

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

check("valid code links the sender and replies connected", () => {
  const session = createLinkSession("user_a");
  const outcome = resolveInboundLink({
    senderHandle: "+447000000000",
    text: buildLinkMessageBody(session.code, "Ayub"),
    provider: "sendblue",
    channel: "imessage",
  });
  assert.equal(outcome.status, "connected");
  assert.equal(outcome.reply, LINK_REPLIES.connected);
  assert.equal(getLinkedIdentity("+447000000000")?.clerkUserId, "user_a");
  // Code is now used and cannot be reused.
  assert.equal(getValidLinkSession(session.code), undefined);
});

check("already-linked sender without a code gets alreadyConnected", () => {
  const session = createLinkSession("user_a");
  resolveInboundLink({
    senderHandle: "+447000000000",
    text: buildLinkMessageBody(session.code, "Ayub"),
    provider: "sendblue",
    channel: "imessage",
  });
  const outcome = resolveInboundLink({
    senderHandle: "+447000000000",
    text: "what's the weather?",
    provider: "sendblue",
    channel: "imessage",
  });
  assert.equal(outcome.status, "already_connected");
  assert.equal(outcome.reply, LINK_REPLIES.alreadyConnected);
});

check("unknown sender without a code gets notConnected", () => {
  const outcome = resolveInboundLink({
    senderHandle: "+447000000000",
    text: "hello?",
    provider: "sendblue",
    channel: "imessage",
  });
  assert.equal(outcome.status, "not_connected");
  assert.equal(outcome.reply, LINK_REPLIES.notConnected);
  assert.equal(getLinkedIdentity("+447000000000"), undefined);
});

check("a code for a different user does not relink an owned handle", () => {
  // Handle first linked to user_a.
  const first = createLinkSession("user_a");
  resolveInboundLink({
    senderHandle: "+447000000000",
    text: buildLinkMessageBody(first.code),
    provider: "sendblue",
    channel: "imessage",
  });
  // Now a code owned by user_b arrives from the SAME handle.
  const second = createLinkSession("user_b");
  const outcome = resolveInboundLink({
    senderHandle: "+447000000000",
    text: buildLinkMessageBody(second.code),
    provider: "sendblue",
    channel: "imessage",
  });
  assert.equal(outcome.status, "different_account");
  assert.equal(outcome.reply, LINK_REPLIES.differentAccount);
  // Still linked to user_a; the second code was NOT consumed.
  assert.equal(getLinkedIdentity("+447000000000")?.clerkUserId, "user_a");
  assert.ok(getValidLinkSession(second.code));
});

check("expired/used code falls through to identity replies", () => {
  const session = createLinkSession("user_a");
  // Same handle, but the code shape is valid yet unknown → unknown sender.
  const outcome = resolveInboundLink({
    senderHandle: "+447000000001",
    text: "Connect my account: HULA-ZZZZ",
    provider: "sendblue",
    channel: "imessage",
  });
  assert.equal(outcome.status, "not_connected");
  // The real session is untouched.
  assert.ok(getValidLinkSession(session.code));
});

check("normalized handle matches across formats", () => {
  const session = createLinkSession("user_a");
  resolveInboundLink({
    senderHandle: "+16465480761",
    text: buildLinkMessageBody(session.code),
    provider: "sendblue",
    channel: "imessage",
  });
  // Same number, different formatting, resolves to the same identity.
  assert.equal(
    getLinkedIdentity("+1 (646) 548-0761")?.clerkUserId,
    "user_a",
  );
});

console.log(`\n${passed} linking checks passed.`);
