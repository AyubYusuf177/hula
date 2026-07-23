import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { env } from "../src/config/env";
import { getProvider, isKnownProvider } from "../src/integrations/catalog";
import {
  toIntegrationStatusItem,
  type IntegrationConnectionView,
} from "../src/integrations/connections";
import { generateStateToken } from "../src/integrations/oauthState";
import {
  classifyMicrosoftRefreshFailure,
  fetchMicrosoftIdentity,
  refreshMicrosoftConnectionCredential,
} from "../src/integrations/providers/microsoft/client";
import type { CredentialSecrets } from "../src/integrations/credentials";
import {
  MICROSOFT_AUTHORIZE_URL,
  MICROSOFT_TOKEN_URL,
  MicrosoftOAuthConfigError,
  MicrosoftOAuthError,
  assertMicrosoftCallbackRedirect,
  buildMicrosoftAuthorizationUrl,
  exchangeMicrosoftCode,
  generateMicrosoftPkce,
  getMicrosoftOAuthConfig,
  microsoftCapabilitiesFromScopes,
  normalizeMicrosoftScopes,
  refreshMicrosoftToken,
  validateMicrosoftRedirectUri,
  type MicrosoftFetch,
  type MicrosoftOAuthConfig,
} from "../src/integrations/providers/microsoft/oauth";
import {
  MICROSOFT_AUTHORITY,
  MICROSOFT_CALLBACK_PATH,
} from "../src/integrations/providers/microsoft/types";
import { microsoftCallbackFailureMeta } from "../src/routes/microsoft";

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const CONFIG: MicrosoftOAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret-never-log",
  redirectUri: `https://hula.example${MICROSOFT_CALLBACK_PATH}`,
  scopes: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "User.Read",
    "Mail.ReadWrite",
    "Mail.Send",
    "Calendars.ReadWrite",
    "Files.Read",
  ],
};

function response(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  await check("catalog: one unified provider requests approved scopes and no Teams/write-file scope", () => {
    assert.equal(isKnownProvider("microsoft"), true);
    const microsoft = getProvider("microsoft");
    assert.deepEqual(microsoft?.defaultScopes, CONFIG.scopes);
    assert.ok(microsoft?.capabilities.includes("onedrive.write"));
    assert.equal(microsoft?.capabilities.some((capability) => /teams\.(?:read|send|discovery)/.test(capability)), false);
    assert.equal(microsoft?.defaultScopes.some((scope) => /team|chat|channel/i.test(scope)), false);
    assert.equal(microsoft?.defaultScopes.includes("Files.ReadWrite"), false);
    assert.ok(getProvider("google_calendar"), "Google provider must remain registered");
    assert.ok(getProvider("gmail"), "Gmail provider must remain registered");
    assert.ok(getProvider("google_drive"), "Google Drive provider must remain registered");
  });

  await check("config: exact env names resolve a common-authority confidential client", () => {
    const saved = {
      id: env.MICROSOFT_OAUTH_CLIENT_ID,
      secret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
      redirect: env.MICROSOFT_OAUTH_REDIRECT_URI,
      encryptionKey: env.INTEGRATION_TOKEN_ENCRYPTION_KEY,
    };
    try {
      env.MICROSOFT_OAUTH_CLIENT_ID = CONFIG.clientId;
      env.MICROSOFT_OAUTH_CLIENT_SECRET = CONFIG.clientSecret;
      env.MICROSOFT_OAUTH_REDIRECT_URI = CONFIG.redirectUri;
      env.INTEGRATION_TOKEN_ENCRYPTION_KEY = "test-key-is-never-used-by-this-pure-config-check";
      assert.deepEqual(getMicrosoftOAuthConfig(), CONFIG);
      assert.equal(MICROSOFT_AUTHORITY.includes("/common/oauth2/v2.0"), true);
    } finally {
      env.MICROSOFT_OAUTH_CLIENT_ID = saved.id;
      env.MICROSOFT_OAUTH_CLIENT_SECRET = saved.secret;
      env.MICROSOFT_OAUTH_REDIRECT_URI = saved.redirect;
      env.INTEGRATION_TOKEN_ENCRYPTION_KEY = saved.encryptionKey;
    }
  });

  await check("redirect: only exact HTTPS callback paths are accepted", () => {
    assert.equal(validateMicrosoftRedirectUri(CONFIG.redirectUri), CONFIG.redirectUri);
    assert.throws(
      () => validateMicrosoftRedirectUri("https://hula.example/wrong"),
      MicrosoftOAuthConfigError,
    );
    assert.throws(
      () => validateMicrosoftRedirectUri(`${CONFIG.redirectUri}?next=x`),
      MicrosoftOAuthConfigError,
    );
    assert.throws(
      () => assertMicrosoftCallbackRedirect(CONFIG.redirectUri, "https://other.example/v1/integrations/microsoft/callback"),
      MicrosoftOAuthConfigError,
    );
  });

  await check("PKCE/state: values are random and the challenge is RFC 7636 S256", () => {
    const first = generateMicrosoftPkce();
    const second = generateMicrosoftPkce();
    assert.notEqual(first.codeVerifier, second.codeVerifier);
    assert.equal(
      first.codeChallenge,
      createHash("sha256").update(first.codeVerifier).digest("base64url"),
    );
    const stateA = generateStateToken();
    const stateB = generateStateToken();
    assert.notEqual(stateA, stateB);
    assert.ok(stateA.length >= 43);
  });

  await check("authorization URL: common v2 authority, state, PKCE and exact scope serialization", () => {
    const url = new URL(buildMicrosoftAuthorizationUrl({
      config: CONFIG,
      state: "secure-state",
      codeChallenge: "s256-challenge",
    }));
    assert.equal(`${url.origin}${url.pathname}`, MICROSOFT_AUTHORIZE_URL);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("response_mode"), "query");
    assert.equal(url.searchParams.get("redirect_uri"), CONFIG.redirectUri);
    assert.equal(url.searchParams.get("state"), "secure-state");
    assert.equal(url.searchParams.get("code_challenge"), "s256-challenge");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.deepEqual(url.searchParams.get("scope")?.split(" "), CONFIG.scopes);
  });

  await check("scope normalization and capabilities use actual grants, case-insensitively", () => {
    assert.deepEqual(normalizeMicrosoftScopes("User.Read user.read Files.Read"), [
      "User.Read",
      "Files.Read",
    ]);
    assert.deepEqual(microsoftCapabilitiesFromScopes([
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
      "Files.Read",
    ]), [
      "microsoft.identity",
      "outlook_mail.read",
      "outlook_mail.write",
      "outlook_mail.send",
      "outlook_calendar.read",
      "outlook_calendar.write",
      "onedrive.read",
    ]);
    assert.deepEqual(microsoftCapabilitiesFromScopes(["User.Read", "Files.Read"]), [
      "microsoft.identity",
      "onedrive.read",
    ]);
    assert.deepEqual(microsoftCapabilitiesFromScopes(["Files.ReadWrite"]), [
      "onedrive.read",
      "onedrive.write",
    ]);
  });

  await check("partial grant: safe status exposes capabilities and missing defaults, never credentials", () => {
    const connection: IntegrationConnectionView = {
      provider: "microsoft",
      status: "connected",
      displayName: "Microsoft 365",
      providerAccountEmail: "person@example.com",
      grantedScopes: ["User.Read", "Files.Read"],
      capabilities: ["microsoft.identity", "onedrive.read"],
      connectedAt: "2026-07-21T12:00:00.000Z",
      disconnectedAt: null,
      lastSyncedAt: null,
      updatedAt: "2026-07-21T12:00:00.000Z",
    };
    const catalog = getProvider("microsoft");
    assert.ok(catalog);
    const status = toIntegrationStatusItem(catalog, connection);
    assert.equal(status.partial, true);
    assert.deepEqual(status.grantedCapabilities, connection.capabilities);
    assert.ok(status.missingCapabilities.includes("outlook_mail.read"));
    assert.equal(JSON.stringify(status).includes("token"), false);
    assert.equal(JSON.stringify(status).includes("client-secret"), false);
  });

  await check("token exchange: sends confidential secret, code, exact redirect and PKCE only to token endpoint", async () => {
    let capturedUrl = "";
    let params = new URLSearchParams();
    const fetchImpl: MicrosoftFetch = async (url, init) => {
      capturedUrl = url;
      params = new URLSearchParams(String(init.body));
      return response(200, {
        access_token: "access-value",
        refresh_token: "refresh-value",
        expires_in: 3600,
        scope: "User.Read Files.Read",
      });
    };
    const tokens = await exchangeMicrosoftCode({
      config: CONFIG,
      code: "authorization-code",
      codeVerifier: "pkce-verifier",
      fetchImpl,
    });
    assert.equal(capturedUrl, MICROSOFT_TOKEN_URL);
    assert.equal(params.get("client_secret"), CONFIG.clientSecret);
    assert.equal(params.get("code"), "authorization-code");
    assert.equal(params.get("code_verifier"), "pkce-verifier");
    assert.equal(params.get("redirect_uri"), CONFIG.redirectUri);
    assert.deepEqual(tokens.scopes, ["User.Read", "Files.Read"]);
  });

  await check("token exchange: missing actual scope is malformed rather than assuming requested scopes", async () => {
    await assert.rejects(
      exchangeMicrosoftCode({
        config: CONFIG,
        code: "code",
        codeVerifier: "verifier",
        fetchImpl: async () => response(200, { access_token: "token" }),
      }),
      (error: unknown) => error instanceof MicrosoftOAuthError && error.reason === "malformed_response",
    );
  });

  await check("identity: GET /me is authoritative and mail falls back to userPrincipalName", async () => {
    let requestUrl = "";
    let authorization = "";
    const identity = await fetchMicrosoftIdentity("access-token", async (url, init) => {
      requestUrl = url;
      authorization = String((init.headers as Record<string, string>).authorization);
      return response(200, {
        id: "account-id",
        displayName: "Adele",
        mail: null,
        userPrincipalName: "adele@example.com",
      });
    });
    const url = new URL(requestUrl);
    assert.equal(url.pathname, "/v1.0/me");
    assert.equal(url.searchParams.get("$select"), "id,displayName,mail,userPrincipalName");
    assert.equal(authorization, "Bearer access-token");
    assert.deepEqual(identity, {
      id: "account-id",
      displayName: "Adele",
      email: "adele@example.com",
    });
  });

  await check("refresh: replaces rotated refresh token and persists refreshed actual grant", async () => {
    const storedCalls: Array<{ connectionId: string; secrets: CredentialSecrets }> = [];
    const grantUpdates: Array<{ scopes: string[]; capabilities: string[] }> = [];
    const accessToken = await refreshMicrosoftConnectionCredential({
      connectionId: "conn-1",
      refreshToken: "old-refresh",
      grantedScopes: ["User.Read", "Files.Read"],
      config: CONFIG,
      now: new Date("2026-07-21T12:00:00.000Z"),
      fetchImpl: async (_url, init) => {
        const params = new URLSearchParams(String(init.body));
        assert.equal(params.get("refresh_token"), "old-refresh");
        assert.equal(params.get("scope"), "User.Read Files.Read offline_access");
        return response(200, {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "User.Read Mail.ReadWrite Files.Read",
        });
      },
      storeCredential: async (connectionId, secrets) => {
        storedCalls.push({ connectionId, secrets });
      },
      updateGrant: async (_connectionId, scopes, capabilities) => {
        grantUpdates.push({ scopes, capabilities });
      },
    });
    const stored = storedCalls[0];
    const updated = grantUpdates[0];
    assert.ok(stored);
    assert.ok(updated);
    assert.equal(accessToken, "new-access");
    assert.equal(stored.connectionId, "conn-1");
    assert.equal(stored.secrets.refreshToken, "new-refresh");
    assert.equal(
      stored.secrets.accessTokenExpiresAt?.toISOString(),
      "2026-07-21T13:00:00.000Z",
    );
    assert.deepEqual(updated.scopes, ["User.Read", "Mail.ReadWrite", "Files.Read"]);
    assert.deepEqual(updated.capabilities, [
      "microsoft.identity",
      "outlook_mail.read",
      "outlook_mail.write",
      "onedrive.read",
    ]);
  });

  await check("invalid_grant and provider payloads never leak token, code, or secret", async () => {
    const sensitive = "refresh-token-sensitive";
    let caught: unknown;
    try {
      await refreshMicrosoftToken({
        config: CONFIG,
        refreshToken: sensitive,
        grantedScopes: ["User.Read"],
        fetchImpl: async () => response(400, {
          error: "invalid_grant",
          error_description: `leak ${sensitive} ${CONFIG.clientSecret}`,
        }),
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof MicrosoftOAuthError);
    assert.equal(caught.reason, "invalid_grant");
    const rendered = `${caught.name}:${caught.message}:${JSON.stringify(caught)}`;
    assert.equal(rendered.includes(sensitive), false);
    assert.equal(rendered.includes(CONFIG.clientSecret), false);
    assert.equal(rendered.includes("error_description"), false);
    assert.deepEqual(classifyMicrosoftRefreshFailure(caught), {
      status: "expired",
      reason: "reconnect_required",
    });
    assert.deepEqual(
      classifyMicrosoftRefreshFailure(new MicrosoftOAuthError("network_failure")),
      { status: "error", reason: "token_refresh_failed" },
    );
  });

  await check("callback diagnostics expose only allowlisted stage, reason, and AADSTS code", async () => {
    const traceId = "11111111-2222-3333-4444-555555555555";
    const correlationId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const rawDescription =
      `AADSTS7000215 hostile authorization-code access-token refresh-token ` +
      `${CONFIG.clientSecret} trace ${traceId} correlation ${correlationId}`;
    const providerPayload = {
      error: "invalid_client",
      error_description: rawDescription,
      error_codes: [7000215],
      trace_id: traceId,
      correlation_id: correlationId,
    };
    let caught: unknown;
    try {
      await exchangeMicrosoftCode({
        config: CONFIG,
        code: "authorization-code",
        codeVerifier: "pkce-verifier",
        fetchImpl: async () => response(401, providerPayload),
      });
    } catch (error) {
      caught = error;
    }
    const tokenMeta = microsoftCallbackFailureMeta("token_exchange", caught);
    assert.deepEqual(tokenMeta, {
      stage: "token_exchange",
      reason: "invalid_client",
      aadstsCode: "AADSTS7000215",
    });
    const rendered = JSON.stringify(tokenMeta);
    assert.equal(rendered.includes("authorization-code"), false);
    assert.equal(rendered.includes("access-token"), false);
    assert.equal(rendered.includes("refresh-token"), false);
    assert.equal(rendered.includes(CONFIG.clientSecret), false);
    assert.equal(rendered.includes("error_description"), false);
    assert.equal(rendered.includes(rawDescription), false);
    assert.equal(rendered.includes("trace_id"), false);
    assert.equal(rendered.includes("correlation_id"), false);
    assert.equal(rendered.includes(traceId), false);
    assert.equal(rendered.includes(correlationId), false);
    assert.deepEqual(
      microsoftCallbackFailureMeta(
        "refresh_token_validation",
        new MicrosoftOAuthConfigError("sensitive-value"),
      ),
      { stage: "refresh_token_validation", reason: "refresh_token_missing" },
    );
    assert.deepEqual(
      microsoftCallbackFailureMeta(
        "record_event",
        new Error("raw database payload must not be logged"),
      ),
      { stage: "record_event", reason: "persistence_failure" },
    );
  });

  await check("AADSTS fallback extraction is bounded and rejects hostile diagnostic values", async () => {
    let fallbackError: unknown;
    try {
      await exchangeMicrosoftCode({
        config: CONFIG,
        code: "authorization-code",
        codeVerifier: "pkce-verifier",
        fetchImpl: async () => response(400, {
          error: "invalid_grant",
          error_description:
            `AADSTS9002313 ${CONFIG.clientSecret} authorization-code trace-id-value`,
          trace_id: "trace-id-value",
          correlation_id: "correlation-id-value",
        }),
      });
    } catch (error) {
      fallbackError = error;
    }
    assert.deepEqual(
      microsoftCallbackFailureMeta("token_exchange", fallbackError),
      {
        stage: "token_exchange",
        reason: "invalid_grant",
        aadstsCode: "AADSTS9002313",
      },
    );

    let hostileCodeError: unknown;
    try {
      await exchangeMicrosoftCode({
        config: CONFIG,
        code: "authorization-code",
        codeVerifier: "pkce-verifier",
        fetchImpl: async () => response(401, {
          error: "invalid_client",
          error_codes: [`7000215 ${CONFIG.clientSecret}`],
          error_description: "no machine-readable identifier",
        }),
      });
    } catch (error) {
      hostileCodeError = error;
    }
    assert.deepEqual(
      microsoftCallbackFailureMeta("token_exchange", hostileCodeError),
      { stage: "token_exchange", reason: "invalid_client" },
    );
  });

  console.log(`\nAll ${passed} Microsoft Phase 1 tests passed.`);
}

main().catch((error) => {
  console.error(
    "Microsoft Phase 1 tests failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
});
