import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { env } from "../src/config/env";
import { getProvider } from "../src/integrations/catalog";
import {
  GoogleOAuthConfigError,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkce,
  getGmailOAuthConfig,
  hasGmailReadonlyScope,
  isGmailOAuthConfigured,
  refreshAccessToken,
  type FetchLike,
  type GoogleOAuthConfig,
} from "../src/integrations/providers/gmail/oauth";
import {
  GmailError,
  buildGmailUrl,
  classifyFetchException,
  classifyGmailHttpError,
  gmailGet,
  isReconnectReason,
  requestWithAuthRetry,
  safeFetchCause,
} from "../src/integrations/providers/gmail/client";
import {
  internalDateToIso,
  normalizeGmailMessage,
  parseFromHeader,
} from "../src/integrations/providers/gmail/messages";
import {
  IMPORTANCE_THRESHOLD,
  hasActionTerm,
  scoreMessageImportance,
  selectLikelyImportant,
} from "../src/integrations/providers/gmail/importance";
import {
  GMAIL_REPLIES,
  buildGmailReply,
  classifyGmailQuestion,
  countUnread,
  filterToday,
  formatImportantAnswer,
  formatLatestAnswer,
  formatUnreadAnswer,
} from "../src/integrations/providers/gmail/gmailQuestion";
import { isSafeAppReturnUrl } from "../src/integrations/appReturnUrl";
import {
  GMAIL_PROVIDER,
  GMAIL_READONLY_SCOPE,
  type NormalizedGmailMessage,
  type RawGmailMessage,
} from "../src/integrations/providers/gmail/types";
import { GOOGLE_CALENDAR_PROVIDER } from "../src/integrations/providers/googleCalendar/types";

/**
 * Offline tests for Section 14 Gmail (read-only). Everything here is PURE — NO
 * database, NO real Gmail API (HTTP is faked), NO Anthropic. Covers OAuth
 * config/PKCE/URL building, faked token exchange + refresh, strict metadata
 * normalization (body/MIME/attachments stripped), deterministic importance
 * scoring, Gmail intent detection, answer formatting, provider error mapping,
 * and privacy guarantees. Run with: `npm test`.
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
  const TEST_CONFIG: GoogleOAuthConfig = {
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-secret-never-real",
    redirectUri: "https://example.ngrok.app/v1/integrations/gmail/callback",
    scopes: [GMAIL_READONLY_SCOPE],
  };

  /** Build a fake FetchLike that returns a fixed status + JSON body. */
  function fakeFetch(status: number, body: unknown): FetchLike {
    return async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    });
  }

  /** Build a normalized message for scoring/formatting tests. */
  function msg(over: Partial<NormalizedGmailMessage>): NormalizedGmailMessage {
    return {
      id: over.id ?? "m1",
      threadId: over.threadId ?? "t1",
      fromName: over.fromName ?? "Jane Doe",
      fromAddress: over.fromAddress ?? "jane@example.com",
      subject: over.subject ?? "Hello",
      receivedAt: over.receivedAt ?? null,
      unread: over.unread ?? false,
      important: over.important ?? false,
      labels: over.labels ?? ["INBOX"],
      snippet: over.snippet ?? "hi there",
      source: GMAIL_PROVIDER,
    };
  }

  // --- Provider registry ---------------------------------------------------

  check("catalog: gmail exists, is separate from calendar, read + compose", () => {
    const gmail = getProvider(GMAIL_PROVIDER);
    assert.ok(gmail, "gmail must be in the catalog");
    assert.equal(gmail?.provider, "gmail");
    assert.notEqual(GMAIL_PROVIDER, GOOGLE_CALENDAR_PROVIDER);
    assert.equal(gmail?.status, "available_readonly");
    // Section 16: read + draft/send capabilities.
    assert.ok(gmail?.capabilities.includes("email.read"));
    assert.ok(gmail?.capabilities.includes("email.draft"));
    assert.ok(gmail?.capabilities.includes("email.send"));
    // Requests read-only + the least-privilege compose scope (no modify/full mailbox).
    assert.ok(gmail?.defaultScopes.includes(GMAIL_READONLY_SCOPE));
    assert.ok(gmail?.defaultScopes.includes("https://www.googleapis.com/auth/gmail.compose"));
    assert.ok(!gmail?.defaultScopes.some((s) => /gmail\.modify|mail\.google\.com/.test(s)));
  });

  // --- OAuth config --------------------------------------------------------

  check("oauth: missing config throws a safe GoogleOAuthConfigError", () => {
    assert.equal(isGmailOAuthConfigured(), false);
    assert.throws(() => getGmailOAuthConfig(), GoogleOAuthConfigError);
  });

  check("oauth: resolves config from env and defaults to gmail.readonly", () => {
    const saved = {
      id: env.GOOGLE_OAUTH_CLIENT_ID,
      secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect: env.GMAIL_OAUTH_REDIRECT_URI,
      scopes: env.GMAIL_SCOPES,
    };
    try {
      env.GOOGLE_OAUTH_CLIENT_ID = "id.apps.googleusercontent.com";
      env.GOOGLE_OAUTH_CLIENT_SECRET = "secret";
      env.GMAIL_OAUTH_REDIRECT_URI = TEST_CONFIG.redirectUri;
      env.GMAIL_SCOPES = undefined;
      assert.equal(isGmailOAuthConfigured(), true);
      const config = getGmailOAuthConfig();
      assert.equal(config.clientId, "id.apps.googleusercontent.com");
      assert.equal(config.redirectUri, TEST_CONFIG.redirectUri);
      const def = getProvider(GMAIL_PROVIDER)?.defaultScopes ?? [];
      assert.deepEqual(config.scopes, def);
      // Section 16: defaults include read-only + compose; never a broader scope.
      assert.ok(config.scopes.some((s) => /gmail\.readonly/.test(s)), "includes read-only");
      assert.ok(config.scopes.some((s) => /gmail\.compose/.test(s)), "includes compose");
      assert.ok(!config.scopes.some((s) => /gmail\.modify|mail\.google\.com/.test(s)), "no broad scope");
    } finally {
      env.GOOGLE_OAUTH_CLIENT_ID = saved.id;
      env.GOOGLE_OAUTH_CLIENT_SECRET = saved.secret;
      env.GMAIL_OAUTH_REDIRECT_URI = saved.redirect;
      env.GMAIL_SCOPES = saved.scopes;
    }
  });

  check("scope: granted-scope check is by membership, not exact equality", () => {
    assert.equal(hasGmailReadonlyScope([GMAIL_READONLY_SCOPE]), true);
    assert.equal(
      hasGmailReadonlyScope([
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        GMAIL_READONLY_SCOPE,
      ]),
      true,
    );
    assert.equal(hasGmailReadonlyScope(["https://mail.google.com/"]), false);
    assert.equal(hasGmailReadonlyScope([]), false);
  });

  // --- PKCE + authorization URL --------------------------------------------

  check("pkce: challenge is base64url(sha256(verifier))", () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    assert.ok(codeVerifier.length >= 43);
    assert.equal(codeChallenge, createHash("sha256").update(codeVerifier).digest("base64url"));
  });

  check("url: authorization URL requests ONLY the gmail.readonly scope", () => {
    const url = new URL(
      buildAuthorizationUrl({ config: TEST_CONFIG, state: "state123", codeChallenge: "chal" }),
    );
    const p = url.searchParams;
    assert.equal(p.get("redirect_uri"), TEST_CONFIG.redirectUri);
    assert.equal(p.get("response_type"), "code");
    assert.equal(p.get("access_type"), "offline");
    assert.equal(p.get("code_challenge_method"), "S256");
    const scope = p.get("scope") ?? "";
    assert.ok(/gmail\.readonly/.test(scope), "requests gmail.readonly");
    // NO write scopes anywhere in the URL.
    assert.ok(!/gmail\.modify/.test(scope), "no gmail.modify");
    assert.ok(!/gmail\.send/.test(scope), "no gmail.send");
    assert.ok(!/gmail\.compose/.test(scope), "no gmail.compose");
    assert.ok(!/mail\.google\.com/.test(scope), "no full-mailbox scope");
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
        scope: GMAIL_READONLY_SCOPE,
      }),
    });
    assert.equal(tokens.accessToken, "ya29.fake");
    assert.equal(tokens.refreshToken, "1//fake");
    assert.deepEqual(tokens.scopes, [GMAIL_READONLY_SCOPE]);
  });

  await checkAsync("token: exchange failure never leaks the client secret", async () => {
    await assert.rejects(
      exchangeCodeForTokens({
        config: TEST_CONFIG,
        code: "bad",
        codeVerifier: "v",
        fetchImpl: fakeFetch(400, { error: "invalid_grant" }),
      }),
      (err: unknown) => {
        const m = err instanceof Error ? err.message : "";
        assert.ok(!m.includes(TEST_CONFIG.clientSecret), "must not leak client secret");
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
    assert.equal(refreshed.refreshToken, null);
  });

  // --- From-header parsing + normalization ---------------------------------

  check("parseFromHeader: handles named, quoted, and bare addresses", () => {
    assert.deepEqual(parseFromHeader('"Jane Doe" <jane@example.com>'), {
      name: "Jane Doe",
      address: "jane@example.com",
    });
    assert.deepEqual(parseFromHeader("Bob <bob@corp.com>"), {
      name: "Bob",
      address: "bob@corp.com",
    });
    assert.deepEqual(parseFromHeader("solo@x.com"), { name: null, address: "solo@x.com" });
    assert.deepEqual(parseFromHeader(""), { name: null, address: null });
  });

  check("internalDate: converts epoch-ms string to ISO, guards junk", () => {
    assert.equal(internalDateToIso("0"), null);
    assert.equal(internalDateToIso(undefined), null);
    assert.equal(internalDateToIso("not-a-number"), null);
    const iso = internalDateToIso("1752580920000");
    assert.ok(iso && !Number.isNaN(Date.parse(iso)));
  });

  check("normalize: keeps only safe fields; drops body/MIME/attachments/headers", () => {
    const raw: RawGmailMessage & { raw?: string; payload?: any } = {
      id: "msg1",
      threadId: "thr1",
      labelIds: ["INBOX", "UNREAD", "IMPORTANT", "Label_42", "CATEGORY_PERSONAL"],
      snippet: "Short safe snippet",
      internalDate: "1752580920000",
      payload: {
        headers: [
          { name: "From", value: '"Jane Doe" <jane@example.com>' },
          { name: "Subject", value: "Your invoice" },
          { name: "Date", value: "Tue, 15 Jul 2026 10:42:00 -0400" },
          { name: "To", value: "SECRET-recipient@example.com" },
          { name: "Delivered-To", value: "SECRET-delivered@example.com" },
        ],
        body: { data: "SECRET-BASE64-BODY" },
        parts: [{ filename: "secret.pdf", body: { attachmentId: "ATTACH-SECRET" } }],
      },
    };
    const n = normalizeGmailMessage(raw);
    assert.equal(n.id, "msg1");
    assert.equal(n.threadId, "thr1");
    assert.equal(n.fromName, "Jane Doe");
    assert.equal(n.fromAddress, "jane@example.com");
    assert.equal(n.subject, "Your invoice");
    assert.equal(n.unread, true);
    assert.equal(n.important, true);
    assert.equal(n.snippet, "Short safe snippet");
    assert.equal(n.source, "gmail");
    // Only whitelisted system/category labels survive (no user label).
    assert.ok(n.labels.includes("IMPORTANT"));
    assert.ok(n.labels.includes("CATEGORY_PERSONAL"));
    assert.ok(!n.labels.includes("Label_42"), "user-defined labels dropped");
    // No body, MIME, attachment, or non-whitelisted header survives.
    const blob = JSON.stringify(n);
    assert.ok(!blob.includes("SECRET"), "no body/attachment/recipient leakage");
    assert.ok(!blob.includes("ATTACH"), "no attachment id leakage");
    assert.ok(!("payload" in n), "no raw payload key");
    assert.ok(!("body" in n), "no body key");
  });

  // --- Importance scoring (deterministic) ----------------------------------

  const NOW = new Date("2026-07-15T18:00:00Z");

  check("importance: action-term detection is word-boundary", () => {
    assert.equal(hasActionTerm("Payment due tomorrow"), true);
    assert.equal(hasActionTerm("Interview scheduled"), true);
    assert.equal(hasActionTerm("your account statement"), true);
    assert.equal(hasActionTerm("the accountant called"), false, "no mid-word match");
    assert.equal(hasActionTerm("weekend plans"), false);
  });

  check("importance: IMPORTANT label + unread + recent scores high", () => {
    const m = msg({
      important: true,
      unread: true,
      receivedAt: "2026-07-15T12:00:00Z",
      subject: "Interview confirmation",
    });
    const { score } = scoreMessageImportance(m, NOW);
    // +5 important, +3 unread, +2 recent, +2 action, +2 direct = 14
    assert.ok(score >= IMPORTANCE_THRESHOLD, `score ${score} clears threshold`);
    assert.ok(score >= 12);
  });

  check("importance: promotions are downranked below threshold", () => {
    const m = msg({
      fromName: null,
      fromAddress: "deals@shop.com",
      subject: "50% off everything!",
      labels: ["INBOX", "CATEGORY_PROMOTIONS"],
      unread: true,
      receivedAt: "2026-07-15T12:00:00Z",
    });
    const { score } = scoreMessageImportance(m, NOW);
    assert.ok(score < IMPORTANCE_THRESHOLD, `promo score ${score} below threshold`);
  });

  check("importance: social messages are downranked", () => {
    const m = msg({
      fromName: null,
      fromAddress: "notify@social.com",
      subject: "You have 3 new followers",
      labels: ["INBOX", "CATEGORY_SOCIAL"],
      unread: true,
    });
    const { score } = scoreMessageImportance(m, NOW);
    assert.ok(score < IMPORTANCE_THRESHOLD);
  });

  check("importance: newsletter + no-reply patterns are penalized", () => {
    const m = msg({
      fromName: null,
      fromAddress: "no-reply@newsletter.example.com",
      subject: "Weekly newsletter digest",
      labels: ["INBOX"],
    });
    const { reasons } = scoreMessageImportance(m, NOW);
    assert.ok(reasons.includes("bulk"));
    assert.ok(reasons.includes("no_reply"));
  });

  check("importance: selectLikelyImportant filters + sorts by score then recency", () => {
    const high = msg({ id: "h", important: true, unread: true, subject: "Payment invoice", receivedAt: "2026-07-15T12:00:00Z" });
    const low = msg({ id: "l", labels: ["INBOX", "CATEGORY_PROMOTIONS"], subject: "sale" });
    const picked = selectLikelyImportant([low, high], NOW);
    assert.equal(picked.length, 1);
    assert.equal(picked[0].message.id, "h");
  });

  // --- Question classification ---------------------------------------------

  check("classify: the five required questions classify correctly", () => {
    assert.equal(classifyGmailQuestion("Do I have any important emails?"), "important");
    assert.equal(classifyGmailQuestion("Any important emails?"), "important");
    assert.equal(classifyGmailQuestion("What are my latest emails?"), "latest");
    assert.equal(classifyGmailQuestion("What emails did I get today?"), "today");
    assert.equal(classifyGmailQuestion("Do I have any unread emails?"), "unread");
  });

  check("classify: important wins over today/unread when combined", () => {
    assert.equal(classifyGmailQuestion("any important emails today?"), "important");
  });

  check("classify: ordinary messages are NOT Gmail questions", () => {
    assert.equal(classifyGmailQuestion("hey how are you"), "none");
    assert.equal(classifyGmailQuestion("what's on my calendar today"), "none");
    assert.equal(classifyGmailQuestion("remind me to call mom"), "none");
    assert.equal(classifyGmailQuestion("thanks!"), "none");
    assert.equal(classifyGmailQuestion(""), "none");
  });

  check("classify: a bare inbox question defaults to latest", () => {
    assert.equal(classifyGmailQuestion("check my inbox"), "latest");
    assert.equal(classifyGmailQuestion("do I have any emails?"), "latest");
  });

  // --- Formatting ----------------------------------------------------------

  check("format: no important messages gives the honest empty reply", () => {
    assert.equal(formatImportantAnswer([], "America/New_York", NOW), GMAIL_REPLIES.noImportant);
  });

  check("format: likely-important list uses hedged wording, never 'definitely'", () => {
    const out = formatImportantAnswer(
      [msg({ fromName: "Recruiter", subject: "Interview", unread: true, receivedAt: "2026-07-15T14:42:00Z" })],
      "America/New_York",
      NOW,
    );
    assert.ok(/look important/i.test(out));
    assert.ok(/Recruiter/.test(out));
    assert.ok(/Interview/.test(out));
    assert.ok(!/definitely/i.test(out), "never claims certainty");
  });

  check("format: latest list numbers sender — subject lines", () => {
    const out = formatLatestAnswer([
      msg({ fromName: "Alice", subject: "Lunch?" }),
      msg({ fromName: "Bank", subject: "Statement ready" }),
    ]);
    assert.ok(/Here are your latest emails/.test(out));
    assert.ok(/1\. Alice — Lunch\?/.test(out));
    assert.ok(/2\. Bank — Statement ready/.test(out));
  });

  check("format: unread count is singular/plural correct", () => {
    assert.ok(/no unread/i.test(formatUnreadAnswer(0)));
    assert.ok(/1 unread email\b/.test(formatUnreadAnswer(1)));
    assert.ok(/4 unread emails\b/.test(formatUnreadAnswer(4)));
  });

  check("format: today filters to the user's local calendar day", () => {
    const tz = "America/New_York";
    // 2026-07-15T03:00:00Z is still 2026-07-14 (23:00) in New York.
    const todays = filterToday(
      [
        msg({ id: "a", receivedAt: "2026-07-15T14:00:00Z" }), // 10:00 EDT 15th
        msg({ id: "b", receivedAt: "2026-07-15T03:00:00Z" }), // 23:00 EDT 14th
      ],
      tz,
      NOW,
    );
    assert.equal(todays.length, 1);
    assert.equal(todays[0].id, "a");
  });

  check("format: countUnread counts only unread", () => {
    assert.equal(countUnread([msg({ unread: true }), msg({ unread: false }), msg({ unread: true })]), 2);
  });

  check("buildGmailReply: dispatches each intent", () => {
    const tz = "America/New_York";
    const messages = [
      msg({ id: "1", important: true, unread: true, subject: "Payment due", receivedAt: "2026-07-15T14:00:00Z" }),
      msg({ id: "2", unread: false, subject: "Newsletter", labels: ["INBOX", "CATEGORY_PROMOTIONS"] }),
    ];
    assert.ok(/look important/i.test(buildGmailReply("important", messages, tz, NOW)));
    assert.ok(/latest emails/i.test(buildGmailReply("latest", messages, tz, NOW)));
    assert.ok(/unread/i.test(buildGmailReply("unread", messages, tz, NOW)));
    assert.ok(typeof buildGmailReply("today", messages, tz, NOW) === "string");
  });

  check("replies: disconnected / reconnect / transient are honest", () => {
    assert.ok(/isn’t connected/i.test(GMAIL_REPLIES.notConnected));
    assert.ok(/Integrations → Gmail/.test(GMAIL_REPLIES.notConnected));
    assert.ok(/reconnect/i.test(GMAIL_REPLIES.reconnect));
    assert.ok(/try again shortly/i.test(GMAIL_REPLIES.unavailable));
  });

  // --- Provider error classification ---------------------------------------

  check("classify: 403 API-disabled → gmail_api_disabled", () => {
    const body =
      '{"error":{"code":403,"message":"Gmail API has not been used in project 123 before or it is disabled.","status":"PERMISSION_DENIED","errors":[{"reason":"accessNotConfigured"}]}}';
    assert.equal(classifyGmailHttpError(403, body), "gmail_api_disabled");
  });

  check("classify: 403 insufficient scope → insufficient_scope", () => {
    const body = '{"error":{"message":"Request had insufficient authentication scopes."}}';
    assert.equal(classifyGmailHttpError(403, body), "insufficient_scope");
  });

  check("classify: 401/404/429/5xx map to safe codes", () => {
    assert.equal(classifyGmailHttpError(401, "{}"), "auth_failed");
    assert.equal(classifyGmailHttpError(404, "{}"), "mailbox_not_found");
    assert.equal(classifyGmailHttpError(429, "{}"), "provider_rate_limited");
    assert.equal(classifyGmailHttpError(503, "{}"), "provider_unavailable");
  });

  check("reconnect: only dead-grant reasons ask the user to reconnect", () => {
    assert.equal(isReconnectReason("invalid_grant"), true);
    assert.equal(isReconnectReason("no_refresh_token"), true);
    assert.equal(isReconnectReason("gmail_api_disabled"), false);
    assert.equal(isReconnectReason("provider_rate_limited"), false);
  });

  check("classify: transport exceptions map to precise reasons", () => {
    const withCause = (code: string) =>
      Object.assign(new TypeError("fetch failed"), { cause: { code } });
    assert.equal(classifyFetchException(Object.assign(new Error("x"), { name: "AbortError" })), "gmail_timeout");
    assert.equal(classifyFetchException(withCause("ENOTFOUND")), "dns_failure");
    assert.equal(classifyFetchException(withCause("ECONNRESET")), "connection_reset");
    assert.equal(classifyFetchException(withCause("ECONNREFUSED")), "connection_refused");
    assert.equal(classifyFetchException(withCause("UND_ERR_CONNECT_TIMEOUT")), "connect_timeout");
    assert.equal(classifyFetchException(new TypeError("fetch failed")), "network_failure");
  });

  // --- URL construction ----------------------------------------------------

  check("url: list request uses INBOX + bounded maxResults + newer_than:7d", () => {
    const url = buildGmailUrl("/users/me/messages", {
      labelIds: "INBOX",
      maxResults: "20",
      q: "newer_than:7d",
    });
    assert.equal(url.protocol, "https:");
    assert.equal(url.host, "gmail.googleapis.com");
    assert.equal(url.pathname, "/gmail/v1/users/me/messages");
    assert.equal(url.searchParams.get("labelIds"), "INBOX");
    assert.equal(url.searchParams.get("maxResults"), "20");
    assert.ok(Number(url.searchParams.get("maxResults")) <= 20, "bounded maxResults");
    assert.equal(url.searchParams.get("q"), "newer_than:7d");
  });

  check("url: metadata request uses format=metadata with only From/Subject/Date", () => {
    const url = buildGmailUrl("/users/me/messages/abc", {
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    assert.equal(url.searchParams.get("format"), "metadata");
    const headers = url.searchParams.getAll("metadataHeaders");
    assert.deepEqual(headers, ["From", "Subject", "Date"]);
    // Never full/raw, never a body/attachment header.
    assert.ok(!/format=full/.test(url.toString()));
    assert.ok(!/format=raw/.test(url.toString()));
    assert.ok(!headers.includes("To"), "no recipient header requested");
  });

  check("url: drops undefined/null query values", () => {
    const url = buildGmailUrl("/users/me/messages", {
      labelIds: "INBOX",
      q: undefined as unknown as string,
    });
    assert.equal(url.searchParams.has("q"), false);
    assert.ok(!url.toString().includes("undefined"));
  });

  check("url: an invalid base maps to malformed_request_url", () => {
    assert.throws(
      () => buildGmailUrl("/users/me/messages", {}, "not-a-url"),
      (err: unknown) => err instanceof GmailError && err.reason === "malformed_request_url",
    );
  });

  // --- gmailGet with faked HTTP --------------------------------------------

  await checkAsync("get: an empty inbox list is a success, not an error", async () => {
    const data = await gmailGet<{ messages?: unknown[] }>(
      "ya29.token",
      "/users/me/messages",
      { labelIds: "INBOX" },
      fakeFetch(200, {}),
    );
    assert.equal(data.messages, undefined);
  });

  await checkAsync("get: API-disabled 403 throws gmail_api_disabled, no token leak", async () => {
    const secretToken = "ya29.super-secret-token";
    await assert.rejects(
      gmailGet(
        secretToken,
        "/users/me/messages",
        {},
        fakeFetch(403, {
          error: { code: 403, message: "Gmail API has not been used in project 123 before or it is disabled." },
        }),
      ),
      (err: unknown) => {
        const e = err as GmailError;
        assert.equal(e.reason, "gmail_api_disabled");
        assert.ok(!e.message.includes(secretToken), "must not leak token");
        assert.ok(!/has not been used in project/i.test(e.message), "must not leak raw body");
        return true;
      },
    );
  });

  await checkAsync("get: 404 → mailbox_not_found", async () => {
    await assert.rejects(
      gmailGet("t", "/users/me/messages/x", {}, fakeFetch(404, { error: { message: "Not Found" } })),
      (err: unknown) => (err as GmailError).reason === "mailbox_not_found",
    );
  });

  await checkAsync("get: 429 → provider_rate_limited", async () => {
    await assert.rejects(
      gmailGet("t", "/users/me/messages", {}, fakeFetch(429, {})),
      (err: unknown) => (err as GmailError).reason === "provider_rate_limited",
    );
  });

  await checkAsync("get: 5xx → provider_unavailable", async () => {
    await assert.rejects(
      gmailGet("t", "/users/me/messages", {}, fakeFetch(503, {})),
      (err: unknown) => (err as GmailError).reason === "provider_unavailable",
    );
  });

  await checkAsync("get: a malformed (non-JSON) body → malformed_provider_response", async () => {
    const malformed: FetchLike = async () => ({ ok: true, status: 200, text: async () => "<html>" });
    await assert.rejects(
      gmailGet("t", "/users/me/messages", {}, malformed),
      (err: unknown) => (err as GmailError).reason === "malformed_provider_response",
    );
  });

  await checkAsync("get: timeout/DNS/reset map to precise transport reasons", async () => {
    const abort: FetchLike = async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const dns: FetchLike = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND gmail.googleapis.com" } });
    };
    const reset: FetchLike = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    };
    await assert.rejects(gmailGet("t", "/users/me/messages", {}, abort), (e: unknown) => (e as GmailError).reason === "gmail_timeout");
    await assert.rejects(gmailGet("t", "/users/me/messages", {}, dns), (e: unknown) => (e as GmailError).reason === "dns_failure");
    await assert.rejects(gmailGet("t", "/users/me/messages", {}, reset), (e: unknown) => (e as GmailError).reason === "connection_reset");
  });

  await checkAsync("get: a non-string access token → invalid_request_headers (no fetch)", async () => {
    const shouldNotRun: FetchLike = async () => {
      throw new Error("fetch must not run with an invalid token");
    };
    await assert.rejects(
      gmailGet({ access_token: "x" } as unknown as string, "/users/me/messages", {}, shouldNotRun),
      (err: unknown) => (err as GmailError).reason === "invalid_request_headers",
    );
  });

  await checkAsync("get: GET carries NO body (undici regression guard)", async () => {
    let seenBody: unknown = "SENTINEL";
    let seenMethod = "";
    const capturing: FetchLike = async (_url, init) => {
      seenBody = init.body;
      seenMethod = init.method;
      return { ok: true, status: 200, text: async () => JSON.stringify({}) };
    };
    await gmailGet("ya29.token", "/users/me/messages", { labelIds: "INBOX" }, capturing);
    assert.equal(seenMethod, "GET");
    assert.equal(seenBody, undefined);
  });

  await checkAsync("get: no token leakage anywhere in a thrown transport error", async () => {
    const secretToken = "ya29.SUPER-SECRET-DO-NOT-LEAK";
    const dnsFail: FetchLike = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND gmail.googleapis.com" } });
    };
    await assert.rejects(
      gmailGet(secretToken, "/users/me/messages", { labelIds: "INBOX" }, dnsFail),
      (err: unknown) => {
        const e = err as GmailError;
        const blob = JSON.stringify({ m: e.message, n: e.safeCauseName, c: e.safeCauseCode });
        assert.ok(!blob.includes(secretToken), "must not leak the access token");
        assert.equal(e.safeCauseCode, "ENOTFOUND");
        return true;
      },
    );
  });

  check("cause: safeFetchCause extracts only name/code/message", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET", message: "socket hang up" },
    });
    const safe = safeFetchCause(err);
    assert.equal(safe.name, "TypeError");
    assert.equal(safe.code, "ECONNRESET");
  });

  // --- One refresh + retry policy (DB-free via injected fakes) --------------

  await checkAsync("retry: a single 401 refreshes once then succeeds", async () => {
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
        if (token === "stale") throw new GmailError("auth_failed", "401", 401);
        return { ok: true };
      },
    });
    assert.deepEqual(data, { ok: true });
    assert.equal(refreshed, 1);
    assert.equal(calls, 2);
  });

  await checkAsync("retry: invalid refresh token propagates invalid_grant", async () => {
    await assert.rejects(
      requestWithAuthRetry({
        getAccessToken: async () => "stale",
        refresh: async () => {
          throw new GmailError("invalid_grant", "bad refresh");
        },
        doGet: async () => {
          throw new GmailError("auth_failed", "401", 401);
        },
      }),
      (err: unknown) => (err as GmailError).reason === "invalid_grant",
    );
  });

  await checkAsync("retry: a persistent 401 becomes invalid_grant and marks the grant dead", async () => {
    let markedDead = 0;
    await assert.rejects(
      requestWithAuthRetry({
        getAccessToken: async () => "stale",
        refresh: async () => "fresh",
        doGet: async () => {
          throw new GmailError("auth_failed", "401", 401);
        },
        onInvalidGrant: async () => {
          markedDead += 1;
        },
      }),
      (err: unknown) => (err as GmailError).reason === "invalid_grant",
    );
    assert.equal(markedDead, 1);
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

  // --- App-return-URL validation -------------------------------------------

  check("returnUrl: accepts app + Expo dev schemes, rejects open redirects", () => {
    assert.equal(isSafeAppReturnUrl("hulaai://integrations"), true);
    assert.equal(isSafeAppReturnUrl("exp://192.168.1.20:8081/--/integrations"), true);
    assert.equal(isSafeAppReturnUrl("https://evil.example.com/phish"), false);
    assert.equal(isSafeAppReturnUrl("javascript:alert(1)"), false);
    assert.equal(isSafeAppReturnUrl(""), false);
  });

  // --- Privacy sweep (defense in depth) ------------------------------------

  check("privacy: normalized output never contains raw payload/body/attachment keys", () => {
    const n = normalizeGmailMessage({
      id: "x",
      threadId: "y",
      labelIds: ["INBOX"],
      snippet: "s",
      internalDate: "1752580920000",
      payload: { headers: [{ name: "From", value: "a@b.com" }] },
    });
    const keys = Object.keys(n);
    for (const forbidden of ["payload", "body", "raw", "attachments", "headers", "mimeType"]) {
      assert.ok(!keys.includes(forbidden), `normalized output must not expose ${forbidden}`);
    }
  });

  console.log(`\nAll ${passed} Gmail (Section 14) tests passed.`);
}

main().catch((err) => {
  console.error("Gmail tests failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
