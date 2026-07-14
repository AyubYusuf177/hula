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
import {
  GoogleCalendarError,
  buildGoogleCalendarUrl,
  classifyCalendarHttpError,
  classifyFetchException,
  googleCalendarGet,
  isReconnectReason,
  requestWithAuthRetry,
  safeFetchCause,
} from "../src/integrations/providers/googleCalendar/client";
import { isSafeAppReturnUrl } from "../src/integrations/appReturnUrl";
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
    // Scopes fall back to the catalog default (read-only + calendar.events write
    // since Section 15). The read-only scope is always still present.
    const def = getProvider("google_calendar")?.defaultScopes ?? [];
    assert.deepEqual(config.scopes, def);
    assert.ok(
      config.scopes.includes("https://www.googleapis.com/auth/calendar.readonly"),
      "read-only scope must be preserved",
    );
    assert.ok(config.scopes.every((s) => /calendar\.(readonly|events)$/.test(s)), "only calendar scopes");
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

check("normalize: keeps only whitelisted safe fields, drops raw payload", () => {
  const raw: RawGoogleEvent & { hangoutLink?: string; etag?: string } = {
    id: "evt1",
    status: "confirmed",
    summary: "Dentist",
    description: "Bring the referral letter",
    location: "123 Main St",
    htmlLink: "https://calendar.google.com/evt1",
    // Non-whitelisted raw fields. `hangoutLink` is Google's DEPRECATED Meet
    // field: Section 18 reads conferencing STRICTLY from `conferenceData` entry
    // points, so this must not become a Meet link by the back door.
    hangoutLink: "https://meet.google.com/xyz",
    etag: "\"SECRETETAG\"",
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

  // Section 18 CHANGE (deliberate, and narrow): `description` is now a
  // whitelisted field. Section 11 dropped it to keep the read surface minimal,
  // but Section 18 lets the user SET and CHANGE it, and an update preview has to
  // show the real before-value — which it cannot do from a field we threw away.
  // Normalization stays a strict whitelist; description simply joins it.
  assert.equal(norm.description, "Bring the referral letter");

  // Everything NOT on the whitelist must still be gone.
  const blob = JSON.stringify(norm);
  assert.ok(!blob.includes("hangoutLink"), "raw payload keys must be dropped");
  assert.ok(!blob.includes("SECRETETAG"), "raw provider metadata must be dropped");
  // The deprecated hangoutLink must NOT be promoted into a conference.
  assert.equal(norm.conference, null, "no conferenceData -> no conference");
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
    // Section 18 fields. Real events always carry these — a fixture that
    // omits them is not a realistic event and hides formatting bugs.
    description: null,
    attendees: [],
    timeZone: null,
    conference: null,
    isRecurringMaster: false,
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

// --- Provider error classification (Section 13) --------------------------

check("classify: 403 API-disabled maps to google_calendar_api_disabled", () => {
  const body =
    '{"error":{"code":403,"message":"Google Calendar API has not been used in project 12345 before or it is disabled.","status":"PERMISSION_DENIED","errors":[{"reason":"accessNotConfigured"}]}}';
  assert.equal(classifyCalendarHttpError(403, body), "google_calendar_api_disabled");
});

check("classify: 403 insufficient scope maps to insufficient_scope", () => {
  const body =
    '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED","errors":[{"reason":"insufficientPermissions"}]}}';
  assert.equal(classifyCalendarHttpError(403, body), "insufficient_scope");
});

check("classify: 401/404/429/5xx map to safe codes", () => {
  assert.equal(classifyCalendarHttpError(401, "{}"), "auth_failed");
  assert.equal(classifyCalendarHttpError(404, "{}"), "calendar_not_found");
  assert.equal(classifyCalendarHttpError(429, "{}"), "provider_rate_limited");
  assert.equal(classifyCalendarHttpError(503, "{}"), "provider_unavailable");
});

check("reconnect: only dead-grant reasons ask the user to reconnect", () => {
  assert.equal(isReconnectReason("invalid_grant"), true);
  assert.equal(isReconnectReason("no_refresh_token"), true);
  assert.equal(isReconnectReason("google_calendar_api_disabled"), false);
  assert.equal(isReconnectReason("provider_rate_limited"), false);
});

// --- googleCalendarGet with faked HTTP -----------------------------------

await checkAsync("get: an empty event list (items: []) is a success, not an error", async () => {
  const data = await googleCalendarGet<{ items?: unknown[] }>(
    "ya29.token",
    "/calendars/primary/events",
    { singleEvents: "true" },
    fakeFetch(200, { items: [] }),
  );
  assert.deepEqual(data.items, []);
});

await checkAsync("get: a populated event list is returned parsed", async () => {
  const data = await googleCalendarGet<{ items?: { id: string }[] }>(
    "ya29.token",
    "/calendars/primary/events",
    {},
    fakeFetch(200, { items: [{ id: "e1" }, { id: "e2" }] }),
  );
  assert.equal(data.items?.length, 2);
});

await checkAsync("get: API-disabled 403 throws google_calendar_api_disabled, no token leak", async () => {
  const secretToken = "ya29.super-secret-token-value";
  await assert.rejects(
    googleCalendarGet(
      secretToken,
      "/calendars/primary/events",
      {},
      fakeFetch(403, {
        error: {
          code: 403,
          message: "Google Calendar API has not been used in project 12345 before or it is disabled.",
        },
      }),
    ),
    (err: unknown) => {
      assert.ok(err instanceof GoogleCalendarError);
      assert.equal((err as GoogleCalendarError).reason, "google_calendar_api_disabled");
      // The thrown error must NOT leak the access token or the raw provider body.
      const msg = (err as Error).message;
      assert.ok(!msg.includes(secretToken), "must not leak token");
      assert.ok(!/has not been used in project/i.test(msg), "must not leak raw body");
      return true;
    },
  );
});

await checkAsync("get: insufficient-scope 403 throws insufficient_scope", async () => {
  await assert.rejects(
    googleCalendarGet("t", "/calendars/primary/events", {}, fakeFetch(403, {
      error: { message: "Request had insufficient authentication scopes." },
    })),
    (err: unknown) => (err as GoogleCalendarError).reason === "insufficient_scope",
  );
});

await checkAsync("get: a malformed (non-JSON) body throws malformed_provider_response", async () => {
  const malformed: FetchLike = async () => ({
    ok: true,
    status: 200,
    text: async () => "<html>not json</html>",
  });
  await assert.rejects(
    googleCalendarGet("t", "/calendars/primary/events", {}, malformed),
    (err: unknown) => (err as GoogleCalendarError).reason === "malformed_provider_response",
  );
});

await checkAsync("get: a thrown fetch becomes network_failure", async () => {
  const throwing: FetchLike = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    googleCalendarGet("t", "/calendars/primary/events", {}, throwing),
    (err: unknown) => (err as GoogleCalendarError).reason === "network_failure",
  );
});

// --- URL construction (Section 13c) --------------------------------------

check("url: builds an absolute https googleapis URL for the events path", () => {
  const url = buildGoogleCalendarUrl("/calendars/primary/events", {
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "5",
    timeMin: "2026-07-12T00:00:00-04:00",
  });
  assert.equal(url.protocol, "https:");
  assert.equal(url.host, "www.googleapis.com");
  assert.equal(url.pathname, "/calendar/v3/calendars/primary/events");
  assert.equal(url.searchParams.get("singleEvents"), "true");
  assert.equal(url.searchParams.get("orderBy"), "startTime");
  assert.equal(url.searchParams.get("maxResults"), "5");
  assert.equal(url.searchParams.get("timeMin"), "2026-07-12T00:00:00-04:00");
  // The whole thing round-trips as a valid absolute URL.
  assert.equal(new URL(url.toString()).host, "www.googleapis.com");
});

check("url: drops undefined/null query values (never inserts 'undefined')", () => {
  const url = buildGoogleCalendarUrl("/calendars/primary/events", {
    singleEvents: "true",
    // Simulate an accidental undefined/null slipping into the query map.
    timeMax: undefined as unknown as string,
    orderBy: null as unknown as string,
  });
  assert.equal(url.searchParams.has("timeMax"), false, "undefined must be dropped");
  assert.equal(url.searchParams.has("orderBy"), false, "null must be dropped");
  assert.ok(!url.toString().includes("undefined"), "no literal 'undefined' in URL");
  assert.ok(!url.toString().includes("null"), "no literal 'null' in URL");
});

check("url: encodes a calendarId safely into the path", () => {
  const calId = "me@example.com";
  const url = buildGoogleCalendarUrl(
    `/calendars/${encodeURIComponent(calId)}/events`,
    {},
  );
  assert.equal(url.pathname, "/calendar/v3/calendars/me%40example.com/events");
});

check("url: an invalid (non-absolute) URL maps to malformed_request_url", () => {
  assert.throws(
    // A relative base can't form an absolute URL → classified, not a raw crash.
    () => buildGoogleCalendarUrl("/calendars/primary/events", {}, "not-a-url"),
    (err: unknown) =>
      err instanceof GoogleCalendarError && err.reason === "malformed_request_url",
  );
});

// --- computeRange values are valid RFC3339 -------------------------------

check("range: today/week produce parseable RFC3339 timeMin/timeMax", () => {
  const today = computeRange("today", NOW, TZ);
  const week = computeRange("week", NOW, TZ);
  for (const v of [today.timeMin, today.timeMax, week.timeMin, week.timeMax]) {
    assert.ok(typeof v === "string" && v.length > 0);
    // Date.parse accepts RFC3339; NaN means it was malformed.
    assert.ok(!Number.isNaN(Date.parse(v as string)), `not RFC3339: ${v}`);
  }
  // RFC3339 offset shape on the local-midnight bounds.
  assert.ok(/[+-]\d{2}:\d{2}$/.test(today.timeMin), "timeMin carries a numeric offset");
});

// --- Thrown-fetch classification + safe cause (Section 13c) --------------

check("classify: AbortError/TimeoutError map to google_calendar_timeout", () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  assert.equal(classifyFetchException(abort), "google_calendar_timeout");
  assert.equal(classifyFetchException(timeout), "google_calendar_timeout");
});

check("classify: undici cause codes map to precise transport reasons", () => {
  const withCause = (code: string) =>
    Object.assign(new TypeError("fetch failed"), {
      cause: { code, message: `${code} www.googleapis.com` },
    });
  assert.equal(classifyFetchException(withCause("ENOTFOUND")), "dns_failure");
  assert.equal(classifyFetchException(withCause("EAI_AGAIN")), "dns_failure");
  assert.equal(classifyFetchException(withCause("ECONNRESET")), "connection_reset");
  assert.equal(classifyFetchException(withCause("ECONNREFUSED")), "connection_refused");
  assert.equal(classifyFetchException(withCause("UND_ERR_CONNECT_TIMEOUT")), "connect_timeout");
});

check("classify: a generic fetch TypeError stays network_failure", () => {
  const generic = new TypeError("fetch failed");
  assert.equal(classifyFetchException(generic), "network_failure");
});

check("cause: safeFetchCause extracts only name/code/message", () => {
  const err = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND www.googleapis.com" },
  });
  const safe = safeFetchCause(err);
  assert.equal(safe.name, "TypeError");
  assert.equal(safe.code, "ENOTFOUND");
  assert.ok(safe.message?.includes("ENOTFOUND"));
});

await checkAsync("get: a GET request carries NO body (regression: undici GET+body throws)", async () => {
  let seenBody: unknown = "SENTINEL";
  let seenMethod = "";
  const capturing: FetchLike = async (_url, init) => {
    seenBody = init.body;
    seenMethod = init.method;
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) };
  };
  await googleCalendarGet("ya29.token", "/calendars/primary/events", { singleEvents: "true" }, capturing);
  assert.equal(seenMethod, "GET");
  assert.equal(seenBody, undefined, "GET must NOT pass a body (empty string included)");
});

await checkAsync("get: passes a fresh, un-aborted AbortSignal per call", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const capturing: FetchLike = async (_url, init) => {
    signals.push(init.signal);
    // The timeout must NOT have fired synchronously before the request starts.
    assert.equal(init.signal?.aborted, false, "signal must not be aborted at call time");
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) };
  };
  await googleCalendarGet("t", "/calendars/primary/events", {}, capturing);
  await googleCalendarGet("t", "/calendars/primary/events", {}, capturing);
  assert.ok(signals[0] instanceof AbortSignal, "an AbortSignal is passed");
  assert.notEqual(signals[0], signals[1], "each call gets a FRESH AbortController/signal");
});

await checkAsync("get: an AbortError from fetch maps to google_calendar_timeout", async () => {
  const aborting: FetchLike = async () => {
    throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  };
  await assert.rejects(
    googleCalendarGet("t", "/calendars/primary/events", {}, aborting),
    (err: unknown) => (err as GoogleCalendarError).reason === "google_calendar_timeout",
  );
});

await checkAsync("get: ENOTFOUND maps to dns_failure and carries a safe cause", async () => {
  const dnsFail: FetchLike = async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND www.googleapis.com" },
    });
  };
  await assert.rejects(
    googleCalendarGet("t", "/calendars/primary/events", {}, dnsFail),
    (err: unknown) => {
      const e = err as GoogleCalendarError;
      assert.equal(e.reason, "dns_failure");
      assert.equal(e.safeCauseName, "TypeError");
      assert.equal(e.safeCauseCode, "ENOTFOUND");
      return true;
    },
  );
});

await checkAsync("get: a generic fetch TypeError → network_failure with a safe cause", async () => {
  const generic: FetchLike = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    googleCalendarGet("t", "/calendars/primary/events", {}, generic),
    (err: unknown) => {
      const e = err as GoogleCalendarError;
      assert.equal(e.reason, "network_failure");
      assert.equal(e.safeCauseName, "TypeError");
      return true;
    },
  );
});

await checkAsync("get: a non-string access token maps to invalid_request_headers", async () => {
  const shouldNotRun: FetchLike = async () => {
    throw new Error("fetch must not be called with an invalid token");
  };
  await assert.rejects(
    // Simulate an object/JSON accidentally passed as the token string.
    googleCalendarGet(
      { access_token: "x" } as unknown as string,
      "/calendars/primary/events",
      {},
      shouldNotRun,
    ),
    (err: unknown) => (err as GoogleCalendarError).reason === "invalid_request_headers",
  );
});

await checkAsync("retry: the retry attempt uses a FRESH request signal", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const capturing: FetchLike = async (_url, init) => {
    signals.push(init.signal);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  await requestWithAuthRetry<{ ok: boolean }>({
    getAccessToken: async () => "stale",
    refresh: async () => "fresh",
    doGet: (token) =>
      googleCalendarGet<{ ok: boolean }>(token, "/calendars/primary/events", {}, capturing).then(
        (data) => {
          if (token === "stale") throw new GoogleCalendarError("auth_failed", "401", 401);
          return data;
        },
      ),
  });
  assert.equal(signals.length, 2, "one signal per attempt (original + retry)");
  assert.notEqual(signals[0], signals[1], "the retry must not reuse the first signal");
});

await checkAsync("get: no token leakage in the thrown error/message", async () => {
  const secretToken = "ya29.SUPER-SECRET-DO-NOT-LEAK";
  const dnsFail: FetchLike = async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND www.googleapis.com" },
    });
  };
  await assert.rejects(
    googleCalendarGet(secretToken, "/calendars/primary/events", { singleEvents: "true" }, dnsFail),
    (err: unknown) => {
      const e = err as GoogleCalendarError;
      const blob = JSON.stringify({ m: e.message, n: e.safeCauseName, c: e.safeCauseCode });
      assert.ok(!blob.includes(secretToken), "must not leak the access token anywhere");
      return true;
    },
  );
});

// --- One refresh + retry policy (DB-free via injected fakes) --------------

await checkAsync("retry: a single 401 refreshes once then succeeds on retry", async () => {
  let refreshed = 0;
  let calls = 0;
  const data = await requestWithAuthRetry<{ ok: boolean }>({
    getAccessToken: async () => "stale",
    refresh: async () => {
      refreshed += 1;
      return "fresh";
    },
    doGet: async (token) => {
      calls += 1;
      if (token === "stale") throw new GoogleCalendarError("auth_failed", "401", 401);
      return { ok: true };
    },
  });
  assert.deepEqual(data, { ok: true });
  assert.equal(refreshed, 1, "refresh runs exactly once");
  assert.equal(calls, 2, "the GET runs exactly twice (original + one retry)");
});

await checkAsync("retry: an invalid refresh token propagates invalid_grant", async () => {
  await assert.rejects(
    requestWithAuthRetry({
      getAccessToken: async () => "stale",
      refresh: async () => {
        throw new GoogleCalendarError("invalid_grant", "bad refresh token");
      },
      doGet: async () => {
        throw new GoogleCalendarError("auth_failed", "401", 401);
      },
    }),
    (err: unknown) => (err as GoogleCalendarError).reason === "invalid_grant",
  );
});

await checkAsync("retry: a persistent 401 after refresh becomes invalid_grant and marks the grant dead", async () => {
  let markedDead = 0;
  await assert.rejects(
    requestWithAuthRetry({
      getAccessToken: async () => "stale",
      refresh: async () => "fresh",
      doGet: async () => {
        throw new GoogleCalendarError("auth_failed", "401", 401);
      },
      onInvalidGrant: async () => {
        markedDead += 1;
      },
    }),
    (err: unknown) => (err as GoogleCalendarError).reason === "invalid_grant",
  );
  assert.equal(markedDead, 1, "the connection is marked dead exactly once");
});

await checkAsync("retry: a successful first call never refreshes", async () => {
  let refreshed = 0;
  const data = await requestWithAuthRetry<string>({
    getAccessToken: async () => "good",
    refresh: async () => {
      refreshed += 1;
      return "unused";
    },
    doGet: async () => "ok",
  });
  assert.equal(data, "ok");
  assert.equal(refreshed, 0);
});

// --- Safe app-return-URL validation (Section 13) -------------------------

check("returnUrl: accepts the app scheme and Expo dev schemes", () => {
  assert.equal(isSafeAppReturnUrl("hulaai://integrations"), true);
  assert.equal(isSafeAppReturnUrl("exp://192.168.1.20:8081/--/integrations"), true);
  assert.equal(isSafeAppReturnUrl("exp+hulaai://integrations"), true);
});

check("returnUrl: rejects arbitrary http(s) redirects and junk (no open redirect)", () => {
  assert.equal(isSafeAppReturnUrl("https://evil.example.com/phish"), false);
  assert.equal(isSafeAppReturnUrl("http://evil.example.com"), false);
  assert.equal(isSafeAppReturnUrl("javascript:alert(1)"), false);
  assert.equal(isSafeAppReturnUrl("//evil.example.com"), false);
  assert.equal(isSafeAppReturnUrl("integrations"), false);
  assert.equal(isSafeAppReturnUrl(""), false);
  assert.equal(isSafeAppReturnUrl(undefined), false);
  assert.equal(isSafeAppReturnUrl("hula" + "a".repeat(3000) + "://x"), false);
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
