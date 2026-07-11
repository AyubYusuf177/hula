import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { env } from "../src/config/env";
import { getProvider } from "../src/integrations/catalog";
import {
  GoogleOAuthConfigError,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkce,
  getGoogleOAuthConfig,
  isGoogleOAuthConfigured,
  refreshAccessToken,
  type FetchLike,
  type GoogleOAuthConfig,
} from "../src/integrations/providers/googleCalendar/oauth";
import {
  computeRange,
  normalizeGoogleEvent,
} from "../src/integrations/providers/googleCalendar/events";
import {
  CALENDAR_REPLIES,
  classifyCalendarQuestion,
  formatCalendarAnswer,
} from "../src/integrations/providers/googleCalendar/calendarQuestion";
import type {
  NormalizedCalendarEvent,
  RawGoogleEvent,
} from "../src/integrations/providers/googleCalendar/types";

/**
 * Offline tests for Section 11 Google Calendar (read-only). Everything here is
 * PURE — NO database, NO real Google API (HTTP is faked), NO Anthropic. Covers
 * OAuth config/PKCE/URL building, faked token exchange + refresh, deterministic
 * range computation, strict event normalization (raw payload stripped), calendar
 * intent detection, and answer formatting. Run with: `npm test`.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

async function main(): Promise<void> {
// A throwaway config for URL/token tests (never a real client secret).
const TEST_CONFIG: GoogleOAuthConfig = {
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-secret-never-real",
  redirectUri: "https://example.ngrok.app/v1/integrations/google_calendar/callback",
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
};

/** Build a fake FetchLike that returns a fixed status + JSON body. */
function fakeFetch(status: number, body: unknown): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
}

// --- OAuth config --------------------------------------------------------

check("oauth: missing config throws a safe GoogleOAuthConfigError", () => {
  // In the test process none of the GOOGLE_* env vars are set.
  assert.equal(isGoogleOAuthConfigured(), false);
  assert.throws(() => getGoogleOAuthConfig(), GoogleOAuthConfigError);
});

check("oauth: resolves config from env and defaults scopes to catalog", () => {
  const saved = {
    id: env.GOOGLE_OAUTH_CLIENT_ID,
    secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect: env.GOOGLE_OAUTH_REDIRECT_URI,
    scopes: env.GOOGLE_CALENDAR_SCOPES,
  };
  try {
    env.GOOGLE_OAUTH_CLIENT_ID = "id.apps.googleusercontent.com";
    env.GOOGLE_OAUTH_CLIENT_SECRET = "secret";
    env.GOOGLE_OAUTH_REDIRECT_URI = TEST_CONFIG.redirectUri;
    env.GOOGLE_CALENDAR_SCOPES = undefined;
    assert.equal(isGoogleOAuthConfigured(), true);
    const config = getGoogleOAuthConfig();
    assert.equal(config.clientId, "id.apps.googleusercontent.com");
    // Scopes fall back to the catalog's least-privilege read-only default.
    const def = getProvider("google_calendar")?.defaultScopes ?? [];
    assert.deepEqual(config.scopes, def);
    assert.ok(config.scopes.every((s) => /readonly/.test(s)), "scopes must be read-only");
  } finally {
    env.GOOGLE_OAUTH_CLIENT_ID = saved.id;
    env.GOOGLE_OAUTH_CLIENT_SECRET = saved.secret;
    env.GOOGLE_OAUTH_REDIRECT_URI = saved.redirect;
    env.GOOGLE_CALENDAR_SCOPES = saved.scopes;
  }
});

// --- PKCE + authorization URL --------------------------------------------

check("pkce: challenge is base64url(sha256(verifier))", () => {
  const { codeVerifier, codeChallenge } = generatePkce();
  assert.ok(codeVerifier.length >= 43, "verifier must be long enough");
  const expected = createHash("sha256").update(codeVerifier).digest("base64url");
  assert.equal(codeChallenge, expected);
});

check("url: authorization URL has required, read-only params", () => {
  const url = new URL(
    buildAuthorizationUrl({ config: TEST_CONFIG, state: "state123", codeChallenge: "chal" }),
  );
  const p = url.searchParams;
  assert.equal(p.get("client_id"), TEST_CONFIG.clientId);
  assert.equal(p.get("redirect_uri"), TEST_CONFIG.redirectUri);
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("access_type"), "offline");
  assert.equal(p.get("state"), "state123");
  assert.equal(p.get("code_challenge"), "chal");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.ok(/calendar\.readonly/.test(p.get("scope") ?? ""), "scope must be read-only");
  assert.ok(!/events\b(?!\.readonly)/.test(p.get("scope") ?? ""), "no write scope");
});

// --- Token exchange + refresh (faked HTTP) -------------------------------

await checkAsync("token: exchangeCodeForTokens parses a faked response", async () => {
  const tokens = await exchangeCodeForTokens({
    config: TEST_CONFIG,
    code: "auth-code",
    codeVerifier: "verifier",
    fetchImpl: fakeFetch(200, {
      access_token: "ya29.fake",
      refresh_token: "1//fake",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/calendar.readonly",
    }),
  });
  assert.equal(tokens.accessToken, "ya29.fake");
  assert.equal(tokens.refreshToken, "1//fake");
  assert.equal(tokens.expiresIn, 3600);
  assert.deepEqual(tokens.scopes, ["https://www.googleapis.com/auth/calendar.readonly"]);
});

await checkAsync("token: exchange failure throws without leaking the secret", async () => {
  await assert.rejects(
    exchangeCodeForTokens({
      config: TEST_CONFIG,
      code: "bad",
      codeVerifier: "v",
      fetchImpl: fakeFetch(400, { error: "invalid_grant" }),
    }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : "";
      assert.ok(!msg.includes(TEST_CONFIG.clientSecret), "must not leak client secret");
      return true;
    },
  );
});

await checkAsync("token: refreshAccessToken parses a faked response", async () => {
  const refreshed = await refreshAccessToken({
    config: TEST_CONFIG,
    refreshToken: "1//fake",
    fetchImpl: fakeFetch(200, { access_token: "ya29.new", expires_in: 3599 }),
  });
  assert.equal(refreshed.accessToken, "ya29.new");
  assert.equal(refreshed.refreshToken, null); // refresh responses omit it
  assert.equal(refreshed.expiresIn, 3599);
});

// --- Range computation ---------------------------------------------------

// 2026-07-15T12:00:00Z is 08:00 in America/New_York (UTC-4 in July).
const NOW = new Date("2026-07-15T12:00:00Z");
const TZ = "America/New_York";

check("range: today spans local midnight → next local midnight", () => {
  const r = computeRange("today", NOW, TZ);
  assert.equal(r.timeMin, "2026-07-15T00:00:00-04:00");
  assert.equal(r.timeMax, "2026-07-16T00:00:00-04:00");
});

check("range: tomorrow is the following local day", () => {
  const r = computeRange("tomorrow", NOW, TZ);
  assert.equal(r.timeMin, "2026-07-16T00:00:00-04:00");
  assert.equal(r.timeMax, "2026-07-17T00:00:00-04:00");
});

check("range: week starts now and ends 7 local days out", () => {
  const r = computeRange("week", NOW, TZ);
  assert.equal(r.timeMin, NOW.toISOString());
  assert.equal(r.timeMax, "2026-07-22T00:00:00-04:00");
});

check("range: next is open-ended (no timeMax)", () => {
  const r = computeRange("next", NOW, TZ);
  assert.equal(r.timeMin, NOW.toISOString());
  assert.equal(r.timeMax, undefined);
});

// --- Event normalization (raw payload stripped) --------------------------

check("normalize: keeps only safe fields, drops description + raw payload", () => {
  const raw: RawGoogleEvent & { description?: string; hangoutLink?: string } = {
    id: "evt1",
    status: "confirmed",
    summary: "Dentist",
    description: "SECRET personal medical note",
    location: "123 Main St",
    htmlLink: "https://calendar.google.com/evt1",
    hangoutLink: "https://meet.google.com/xyz",
    start: { dateTime: "2026-07-15T15:00:00-04:00" },
    end: { dateTime: "2026-07-15T16:00:00-04:00" },
    attendees: [{ email: "a@x.com" }, { email: "b@x.com" }],
    organizer: { email: "me@x.com" },
  };
  const norm = normalizeGoogleEvent(raw, "primary");
  assert.equal(norm.summary, "Dentist");
  assert.equal(norm.location, "123 Main St");
  assert.equal(norm.start, "2026-07-15T15:00:00-04:00");
  assert.equal(norm.allDay, false);
  assert.equal(norm.attendeeCount, 2);
  assert.equal(norm.organizerEmail, "me@x.com");
  assert.equal(norm.source, "google_calendar");
  // The description and any non-whitelisted raw field must not survive.
  const blob = JSON.stringify(norm);
  assert.ok(!blob.includes("SECRET"), "description must be dropped");
  assert.ok(!blob.includes("hangoutLink"), "raw payload keys must be dropped");
  assert.ok(!("description" in norm), "no description key");
});

check("normalize: detects an all-day event from a date-only start", () => {
  const norm = normalizeGoogleEvent(
    { id: "e", summary: "Holiday", start: { date: "2026-07-16" }, end: { date: "2026-07-17" } },
    "primary",
  );
  assert.equal(norm.allDay, true);
  assert.equal(norm.start, "2026-07-16");
});

// --- Calendar intent detection -------------------------------------------

check("intent: detects today / tomorrow / week / next", () => {
  assert.equal(classifyCalendarQuestion("What's on my calendar today?"), "today");
  assert.equal(classifyCalendarQuestion("do I have anything tomorrow"), "tomorrow");
  assert.equal(classifyCalendarQuestion("what meetings do I have this week"), "week");
  assert.equal(classifyCalendarQuestion("when's my next meeting?"), "next");
  assert.equal(classifyCalendarQuestion("what's my next event"), "next");
});

check("intent: bare calendar question defaults to today", () => {
  assert.equal(classifyCalendarQuestion("what's on my calendar?"), "today");
  assert.equal(classifyCalendarQuestion("what's my schedule"), "today");
});

check("intent: ordinary messages are not calendar questions", () => {
  assert.equal(classifyCalendarQuestion("hey how are you"), "none");
  assert.equal(classifyCalendarQuestion("can you draft an email to my boss"), "none");
  assert.equal(classifyCalendarQuestion("remind me to call mom tomorrow"), "none");
  assert.equal(classifyCalendarQuestion("thanks!"), "none");
  assert.equal(classifyCalendarQuestion(""), "none");
});

// --- Answer formatting ---------------------------------------------------

function timedEvent(summary: string, startIso: string): NormalizedCalendarEvent {
  return {
    id: summary,
    calendarId: "primary",
    summary,
    location: null,
    start: startIso,
    end: startIso,
    allDay: false,
    status: "confirmed",
    htmlLink: null,
    attendeeCount: null,
    organizerEmail: null,
    source: "google_calendar",
  };
}

check("format: empty ranges give honest 'nothing' replies", () => {
  assert.ok(/nothing/i.test(formatCalendarAnswer("today", [], TZ)));
  assert.ok(/nothing/i.test(formatCalendarAnswer("tomorrow", [], TZ)));
  assert.ok(/nothing/i.test(formatCalendarAnswer("week", [], TZ)));
  assert.ok(/any upcoming/i.test(formatCalendarAnswer("next", [], TZ)));
});

check("format: today lists events with a header", () => {
  const out = formatCalendarAnswer(
    "today",
    [timedEvent("Standup", "2026-07-15T09:00:00-04:00")],
    TZ,
  );
  assert.ok(/Here’s today/.test(out));
  assert.ok(/Standup/.test(out));
  assert.ok(/9:00/.test(out));
});

check("format: next describes the single next event", () => {
  const out = formatCalendarAnswer(
    "next",
    [timedEvent("1:1 with Sam", "2026-07-15T15:00:00-04:00")],
    TZ,
  );
  assert.ok(/Your next event is/.test(out));
  assert.ok(/1:1 with Sam/.test(out));
});

check("replies: not-connected reply is honest (no pretending)", () => {
  assert.ok(/connect it in Hula/i.test(CALENDAR_REPLIES.notConnected));
  assert.ok(!/i (?:checked|looked)/i.test(CALENDAR_REPLIES.notConnected));
});

  console.log(`\nAll ${passed} Google Calendar (Section 11) tests passed.`);
}

main().catch((err) => {
  console.error(
    "Google Calendar tests failed:",
    err instanceof Error ? err.message : "unknown error",
  );
  process.exitCode = 1;
});
