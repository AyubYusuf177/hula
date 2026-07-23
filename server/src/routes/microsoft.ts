import { Router } from "express";

import { requireClerkAuth } from "../auth/clerk";
import { getPrisma } from "../db/prisma";
import { sanitizeAppReturnUrl } from "../integrations/appReturnUrl";
import { getProvider } from "../integrations/catalog";
import {
  recordIntegrationEvent,
  upsertIntegrationConnection,
} from "../integrations/connections";
import { storeCredentialSecrets } from "../integrations/credentials";
import { resolveOAuthCallbackReplay } from "../integrations/oauthReplay";
import { consumeOAuthState, createOAuthState } from "../integrations/oauthState";
import {
  MicrosoftConnectionError,
  fetchMicrosoftIdentity,
} from "../integrations/providers/microsoft/client";
import {
  MicrosoftOAuthConfigError,
  MicrosoftOAuthError,
  assertMicrosoftCallbackRedirect,
  buildMicrosoftAuthorizationUrl,
  exchangeMicrosoftCode,
  generateMicrosoftPkce,
  getMicrosoftOAuthConfig,
  microsoftCapabilitiesFromScopes,
} from "../integrations/providers/microsoft/oauth";
import {
  MICROSOFT_CALLBACK_PATH,
  MICROSOFT_PROVIDER,
} from "../integrations/providers/microsoft/types";
import { TokenVaultConfigError } from "../integrations/tokenVault";
import { getOrCreateUserByClerkId } from "../users/store";
import { logger } from "../utils/logger";

export const microsoftRouter = Router();

export type MicrosoftCallbackStage =
  | "consume_oauth_state"
  | "redirect_assertion"
  | "token_exchange"
  | "refresh_token_validation"
  | "graph_me"
  | "upsert_connection"
  | "connection_lookup"
  | "store_credentials"
  | "record_event";

type MicrosoftCallbackFailureReason =
  | "oauth_configuration_error"
  | "refresh_token_missing"
  | "credential_vault_error"
  | "persistence_failure"
  | "unexpected_error"
  | MicrosoftOAuthError["reason"]
  | MicrosoftConnectionError["reason"];

/** Build allowlisted callback metadata without serializing the thrown error. */
export function microsoftCallbackFailureMeta(
  stage: MicrosoftCallbackStage,
  error: unknown,
): {
  stage: MicrosoftCallbackStage;
  reason: MicrosoftCallbackFailureReason;
  aadstsCode?: string;
} {
  if (error instanceof MicrosoftOAuthError) {
    return {
      stage,
      reason: error.reason,
      ...(error.aadstsCode ? { aadstsCode: error.aadstsCode } : {}),
    };
  }
  if (error instanceof MicrosoftConnectionError) {
    return { stage, reason: error.reason };
  }
  if (error instanceof MicrosoftOAuthConfigError) {
    return {
      stage,
      reason:
        stage === "refresh_token_validation"
          ? "refresh_token_missing"
          : "oauth_configuration_error",
    };
  }
  if (error instanceof TokenVaultConfigError) {
    return { stage, reason: "credential_vault_error" };
  }
  if (
    stage === "consume_oauth_state" ||
    stage === "upsert_connection" ||
    stage === "connection_lookup" ||
    stage === "store_credentials" ||
    stage === "record_event"
  ) {
    return { stage, reason: "persistence_failure" };
  }
  return { stage, reason: "unexpected_error" };
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resultPage(ok: boolean, returnUrl: string | null): string {
  const title = ok ? "Microsoft 365 connected" : "Couldn’t connect Microsoft 365";
  const body = ok
    ? "Your Microsoft account is connected. Return to Hula to see the granted capabilities."
    : "Return to Hula and try connecting your Microsoft account again.";
  const safeUrl = returnUrl ? escapeHtml(returnUrl) : null;
  const link = safeUrl ? `<a href="${safeUrl}">Return to Hula</a>` : "";
  const redirect = returnUrl
    ? `<script>setTimeout(function(){try{window.location.replace(${JSON.stringify(returnUrl)});}catch(e){}},400);</script>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080a16;color:#f6f8ff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:400px;padding:32px;text-align:center}p{color:#9aa3ba;line-height:1.55}a{display:inline-block;margin-top:22px;padding:14px 28px;border-radius:999px;background:#fff;color:#080a16;text-decoration:none;font-weight:600}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${link}</main>${redirect}</body></html>`;
}

microsoftRouter.post(
  "/v1/me/integrations/microsoft/connect",
  requireClerkAuth,
  async (req, res) => {
    try {
      const config = getMicrosoftOAuthConfig();
      const user = await getOrCreateUserByClerkId(req.clerkUserId as string);
      const appReturnUrl = sanitizeAppReturnUrl(
        (req.body as { appReturnUrl?: unknown } | undefined)?.appReturnUrl,
      );
      const { codeVerifier, codeChallenge } = generateMicrosoftPkce();
      const pending = await createOAuthState({
        userId: user.id,
        provider: MICROSOFT_PROVIDER,
        redirectUri: config.redirectUri,
        scopes: config.scopes,
        codeVerifier,
        appReturnUrl,
      });
      logger.info("microsoft.connect started", {
        scopeCount: config.scopes.length,
      });
      res.status(200).json({
        provider: MICROSOFT_PROVIDER,
        authorizationUrl: buildMicrosoftAuthorizationUrl({
          config,
          state: pending.state,
          codeChallenge,
        }),
        expiresAt: pending.expiresAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof MicrosoftOAuthConfigError) {
        res.status(400).json({ error: "microsoft_not_configured" });
        return;
      }
      logger.error("microsoft.connect failed", { errorCode: "connect_failed" });
      res.status(500).json({ error: "microsoft_connect_failed" });
    }
  },
);

microsoftRouter.get(MICROSOFT_CALLBACK_PATH, async (req, res) => {
  const providerError = firstQueryValue(req.query.error);
  const code = firstQueryValue(req.query.code);
  const state = firstQueryValue(req.query.state);
  let returnUrl: string | null = null;
  let connectionId: string | null = null;
  let stage: MicrosoftCallbackStage = "consume_oauth_state";

  if (providerError || !code || !state) {
    logger.info("microsoft.callback denied/invalid", {
      denied: Boolean(providerError),
    });
    res.status(400).type("html").send(resultPage(false, null));
    return;
  }

  try {
    stage = "consume_oauth_state";
    const consumed = await consumeOAuthState(state, MICROSOFT_PROVIDER);
    if (!consumed) {
      const replay = await resolveOAuthCallbackReplay(state, MICROSOFT_PROVIDER);
      if (replay) {
        returnUrl = sanitizeAppReturnUrl(replay.appReturnUrl);
        res.status(200).type("html").send(resultPage(true, returnUrl));
        return;
      }
      res.status(400).type("html").send(resultPage(false, null));
      return;
    }
    returnUrl = sanitizeAppReturnUrl(consumed.appReturnUrl);
    stage = "redirect_assertion";
    const config = getMicrosoftOAuthConfig();
    assertMicrosoftCallbackRedirect(consumed.redirectUri, config.redirectUri);
    if (!consumed.codeVerifier) {
      throw new MicrosoftOAuthConfigError("Microsoft OAuth PKCE verifier is missing");
    }

    stage = "token_exchange";
    const tokens = await exchangeMicrosoftCode({
      config,
      code,
      codeVerifier: consumed.codeVerifier,
    });
    stage = "refresh_token_validation";
    if (!tokens.refreshToken) {
      throw new MicrosoftOAuthConfigError("Microsoft OAuth did not grant offline access");
    }
    stage = "graph_me";
    const identity = await fetchMicrosoftIdentity(tokens.accessToken);
    const capabilities = microsoftCapabilitiesFromScopes(tokens.scopes);
    const requiredCapabilities =
      getProvider(MICROSOFT_PROVIDER)?.requiredCapabilities ?? [];
    const grantedCapabilitySet = new Set<string>(capabilities);

    stage = "upsert_connection";
    await upsertIntegrationConnection(consumed.userId, {
      provider: MICROSOFT_PROVIDER,
      status: "connected",
      providerAccountId: identity.id,
      providerAccountEmail: identity.email,
      displayName: identity.displayName ?? identity.email ?? "Microsoft 365",
      requestedScopes: consumed.scopes,
      grantedScopes: tokens.scopes,
      capabilities,
    });
    stage = "connection_lookup";
    const connection = await getPrisma().integrationConnection.findUnique({
      where: {
        userId_provider: {
          userId: consumed.userId,
          provider: MICROSOFT_PROVIDER,
        },
      },
      select: { id: true },
    });
    if (!connection) throw new Error("microsoft_connection_missing");
    connectionId = connection.id;
    stage = "store_credentials";
    await storeCredentialSecrets(connection.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000)
        : null,
      scopes: tokens.scopes,
    });
    stage = "record_event";
    await recordIntegrationEvent({
      userId: consumed.userId,
      provider: MICROSOFT_PROVIDER,
      eventType: "oauth.connected",
      connectionId: connection.id,
      safeSummary: {
        scopeCount: tokens.scopes.length,
        capabilityCount: capabilities.length,
        partial: requiredCapabilities.some(
          (capability) => !grantedCapabilitySet.has(capability),
        ),
        hasRefreshToken: true,
      },
    });
    logger.info("microsoft.callback connected", {
      scopeCount: tokens.scopes.length,
      capabilityCount: capabilities.length,
      willReturnToApp: Boolean(returnUrl),
    });
    res.status(200).type("html").send(resultPage(true, returnUrl));
  } catch (error) {
    if (connectionId) {
      try {
        await getPrisma().integrationConnection.update({
          where: { id: connectionId },
          data: { status: "error" },
        });
      } catch {
        // The callback still fails closed; never surface database details.
      }
    }
    logger.error(
      "microsoft.callback stage_failed",
      microsoftCallbackFailureMeta(stage, error),
    );
    res.status(500).type("html").send(resultPage(false, returnUrl));
  }
});
