import assert from "node:assert/strict";

import {
  OAUTH_REPLAY_WINDOW_MS,
  resolveOAuthCallbackReplay,
  type OAuthReplayDeps,
} from "../src/integrations/oauthReplay";
import type { ConsumedOAuthStateRef } from "../src/integrations/oauthState";

/**
 * Offline tests for OAUTH CALLBACK REPLAY (Section 18 real-device fix). NO
 * database, NO network — every dependency is injected.
 *
 * THE REAL FAILURE. Reconnecting Google Calendar on a real device logged
 * `callback connected` (scopes stored, account live) and then `callback rejected
 * state`, and the phone showed "Couldn't connect Google Calendar". The browser
 * re-issued the same callback GET; the second request found the single-use state
 * already consumed and painted a failure over a success that had really happened.
 *
 * The two properties under test, together:
 *   1. An exact replay of an ALREADY-SUCCESSFUL callback renders success — with
 *      no second token exchange and no second credential write.
 *   2. Everything else still fails closed. This is emphatically NOT "treat state
 *      errors as success".
 */

let passed = 0;
const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}
function asyncCheck(name: string, fn: () => Promise<void>): void {
  asyncChecks.push({ name, fn });
}

const NOW = new Date("2026-07-14T12:00:00Z");
const CONSUMED_AT = new Date("2026-07-14T11:59:58Z"); // 2s earlier — a real double-callback
const CALENDAR = "google_calendar";
const GMAIL = "gmail";

/** A consumed-state row for a given provider. */
function stateRef(over: Partial<ConsumedOAuthStateRef> = {}): ConsumedOAuthStateRef {
  return {
    userId: "user_1",
    provider: CALENDAR,
    appReturnUrl: "hula://integrations",
    consumedAt: CONSUMED_AT,
    ...over,
  };
}

/** Deps where the state is consumed and the connection was made BY it. */
function deps(over: Partial<OAuthReplayDeps> = {}): OAuthReplayDeps {
  return {
    now: NOW,
    findConsumedState: async () => stateRef(),
    // connectedAt at/after consumedAt == established by THIS callback.
    getConnection: async () => ({
      status: "connected",
      connectedAt: new Date("2026-07-14T11:59:59Z"),
    }),
    ...over,
  };
}

// --- 1. The success replay ------------------------------------------------

asyncCheck("replay: an exact replay after success renders the SAME success result", async () => {
  const r = await resolveOAuthCallbackReplay("state_abc", CALENDAR, deps());
  assert.ok(r, "a provable replay must resolve");
  // The same return URL the original callback used, so the page is identical.
  assert.equal(r.appReturnUrl, "hula://integrations");
});

asyncCheck("replay: the replay path performs NO token exchange and NO credential write", async () => {
  // The strongest structural guarantee available: the replay resolver is only
  // given a read of the state and a read of the connection. It has no exchange
  // or credential dependency to call, and the state ref it receives carries no
  // `codeVerifier` — so it could not perform PKCE even if it tried.
  let stateReads = 0;
  let connectionReads = 0;
  const r = await resolveOAuthCallbackReplay(
    "state_abc",
    CALENDAR,
    deps({
      findConsumedState: async () => {
        stateReads += 1;
        return stateRef();
      },
      getConnection: async () => {
        connectionReads += 1;
        return { status: "connected", connectedAt: new Date("2026-07-14T11:59:59Z") };
      },
    }),
  );
  assert.ok(r);
  assert.equal(stateReads, 1);
  assert.equal(connectionReads, 1);
  const ref = stateRef() as unknown as Record<string, unknown>;
  assert.equal("codeVerifier" in ref, false, "the replay path is never given PKCE material");
});

// --- 2. Fail-closed cases -------------------------------------------------

asyncCheck("invalid state: an unknown state fails closed", async () => {
  const r = await resolveOAuthCallbackReplay(
    "never_existed",
    CALENDAR,
    deps({ findConsumedState: async () => null }),
  );
  assert.equal(r, null);
});

asyncCheck("expired state: fails closed (never mistaken for completed)", async () => {
  // `consumeOAuthState` flips an expired row to `expired`, so `findConsumedState`
  // — which only returns `consumed` rows — yields null for it.
  const r = await resolveOAuthCallbackReplay(
    "state_expired",
    CALENDAR,
    deps({ findConsumedState: async () => null }),
  );
  assert.equal(r, null);
});

asyncCheck("pending state: an unused state is NOT a replay", async () => {
  // A pending row has no earlier success to mirror. `findConsumedState` returns
  // only `consumed` rows, so this is null.
  const r = await resolveOAuthCallbackReplay(
    "state_pending",
    CALENDAR,
    deps({ findConsumedState: async () => null }),
  );
  assert.equal(r, null);
});

asyncCheck("provider mismatch: a Calendar state can never resolve as Gmail", async () => {
  // The provider filter lives in the lookup: asking for GMAIL with a Calendar
  // state returns null, exactly as `consumeOAuthState` would.
  const r = await resolveOAuthCallbackReplay(
    "state_abc",
    GMAIL,
    deps({
      findConsumedState: async (_state, provider) =>
        provider === CALENDAR ? stateRef() : null,
    }),
  );
  assert.equal(r, null);
});

asyncCheck("replay after a FAILED callback stays failed (no connection at all)", async () => {
  // The state was consumed, but the token exchange then blew up, so no
  // connection was ever created. Rendering success here would be a lie.
  const r = await resolveOAuthCallbackReplay(
    "state_abc",
    CALENDAR,
    deps({ getConnection: async () => null }),
  );
  assert.equal(r, null);
});

asyncCheck("replay after a FAILED callback stays failed (stale prior connection)", async () => {
  // The nastiest false positive: the user was ALREADY connected, reconnected,
  // and the exchange failed. The old connection is still `connected` — but it
  // predates this attempt, so it is not evidence THIS callback succeeded.
  const r = await resolveOAuthCallbackReplay(
    "state_abc",
    CALENDAR,
    deps({
      getConnection: async () => ({
        status: "connected",
        connectedAt: new Date("2026-07-01T09:00:00Z"), // long before consumedAt
      }),
    }),
  );
  assert.equal(r, null, "a pre-existing connection must not vouch for a failed callback");
});

asyncCheck("a disconnected/expired connection never vouches for a replay", async () => {
  for (const status of ["disconnected", "expired", "error", "revoked"]) {
    const r = await resolveOAuthCallbackReplay(
      "state_abc",
      CALENDAR,
      deps({
        getConnection: async () => ({
          status,
          connectedAt: new Date("2026-07-14T11:59:59Z"),
        }),
      }),
    );
    assert.equal(r, null, `status ${status} must not resolve`);
  }
});

asyncCheck("a connection with no connectedAt stamp fails closed", async () => {
  const r = await resolveOAuthCallbackReplay(
    "state_abc",
    CALENDAR,
    deps({ getConnection: async () => ({ status: "connected", connectedAt: null }) }),
  );
  assert.equal(r, null);
});

// --- 3. The replay window -------------------------------------------------

asyncCheck("replay window: a stale replay outside the window fails closed", async () => {
  const old = new Date(NOW.getTime() - OAUTH_REPLAY_WINDOW_MS - 1000);
  const r = await resolveOAuthCallbackReplay(
    "state_abc",
    CALENDAR,
    deps({ findConsumedState: async () => stateRef({ consumedAt: old }) }),
  );
  assert.equal(r, null, "an old state token must not keep rendering success forever");
});

asyncCheck("replay window: just inside the window still resolves", async () => {
  const recent = new Date(NOW.getTime() - OAUTH_REPLAY_WINDOW_MS + 5_000);
  const r = await resolveOAuthCallbackReplay(
    "state_abc",
    CALENDAR,
    deps({
      findConsumedState: async () => stateRef({ consumedAt: recent }),
      getConnection: async () => ({ status: "connected", connectedAt: recent }),
    }),
  );
  assert.ok(r);
});

asyncCheck("a consumedAt far in the future is nonsense and fails closed", async () => {
  const future = new Date(NOW.getTime() + 60_000);
  const r = await resolveOAuthCallbackReplay(
    "state_abc",
    CALENDAR,
    deps({ findConsumedState: async () => stateRef({ consumedAt: future }) }),
  );
  assert.equal(r, null);
});

// --- 4. Robustness --------------------------------------------------------

asyncCheck("a lookup failure fails closed rather than accidentally succeeding", async () => {
  const r = await resolveOAuthCallbackReplay(
    "state_abc",
    CALENDAR,
    deps({
      findConsumedState: async () => {
        throw new Error("db down");
      },
    }),
  );
  assert.equal(r, null, "unprovable must never mean success");
});

asyncCheck("a connection lookup failure fails closed", async () => {
  const r = await resolveOAuthCallbackReplay(
    "state_abc",
    CALENDAR,
    deps({
      getConnection: async () => {
        throw new Error("db down");
      },
    }),
  );
  assert.equal(r, null);
});

asyncCheck("ISO-string timestamps are accepted as well as Date objects", async () => {
  const r = await resolveOAuthCallbackReplay(
    "state_abc",
    CALENDAR,
    deps({
      getConnection: async () => ({
        status: "connected",
        connectedAt: "2026-07-14T11:59:59.000Z",
      }),
    }),
  );
  assert.ok(r);
});

asyncCheck("Gmail: an exact replay after a successful Gmail connect renders success", async () => {
  // The same shared fix, pinned to Gmail's provider.
  const r = await resolveOAuthCallbackReplay(
    "state_gmail",
    GMAIL,
    deps({
      findConsumedState: async (_s, provider) =>
        provider === GMAIL ? stateRef({ provider: GMAIL, appReturnUrl: "hula://integrations" }) : null,
    }),
  );
  assert.ok(r);
  assert.equal(r.appReturnUrl, "hula://integrations");
});

asyncCheck("replay result carries no token or secret material", async () => {
  const r = await resolveOAuthCallbackReplay("state_abc", CALENDAR, deps());
  assert.ok(!/Bearer|ya29\.|access_token|refresh_token|codeVerifier|client_secret/i.test(
    JSON.stringify(r),
  ));
});

check("the replay window is a tight, bounded constant", () => {
  assert.equal(OAUTH_REPLAY_WINDOW_MS, 5 * 60 * 1000);
});

async function run(): Promise<void> {
  for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }
  console.log(`\nAll ${passed} OAuth callback replay tests passed.`);
}

void run().catch((err) => {
  console.error("OAuth replay tests failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
