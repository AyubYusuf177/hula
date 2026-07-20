import { Router } from "express";

import { requireClerkAuth } from "../auth/clerk";
import { sanitizeAppReturnUrl } from "../integrations/appReturnUrl";
import {
  recordIntegrationEvent,
  upsertIntegrationConnection,
} from "../integrations/connections";
import { storeCredentialSecrets } from "../integrations/credentials";
import { consumeOAuthState, createOAuthState } from "../integrations/oauthState";
import { resolveOAuthCallbackReplay } from "../integrations/oauthReplay";
import { getGoogleDriveConnection } from "../integrations/providers/googleDrive/client";
import {
  GoogleOAuthConfigError,
  buildAuthorizationUrl,
  driveCapabilitiesFromScopes,
  exchangeCodeForTokens,
  generatePkce,
  getGoogleDriveOAuthConfig,
} from "../integrations/providers/googleDrive/oauth";
import { fetchDriveIdentity } from "../integrations/providers/googleDrive/operations";
import { GOOGLE_DRIVE_PROVIDER } from "../integrations/providers/googleDrive/types";
import { getOrCreateUserByClerkId } from "../users/store";
import { logger } from "../utils/logger";

export const googleDriveRouter = Router();

function first(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function resultPage(ok: boolean, returnUrl: string | null): string {
  const title = ok ? "Google Drive connected" : "Couldn’t connect Google Drive";
  const body = ok
    ? "You’re all set. Return to Hula and text as usual."
    : "Please return to Hula and try connecting again.";
  const href = returnUrl ? escapeHtml(returnUrl) : null;
  const link = href ? `<a href="${href}">Return to Hula</a>` : "";
  const redirect = returnUrl
    ? `<script>setTimeout(function(){try{window.location.replace(${JSON.stringify(returnUrl)});}catch(e){}},400);</script>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080a16;color:#f6f8ff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:380px;padding:32px;text-align:center}p{color:#9aa3ba;line-height:1.55}a{display:inline-block;margin-top:20px;padding:14px 28px;border-radius:999px;background:#fff;color:#080a16;text-decoration:none;font-weight:600}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${link}</main>${redirect}</body></html>`;
}

googleDriveRouter.post(
  "/v1/me/integrations/google_drive/connect",
  requireClerkAuth,
  async (req, res) => {
    try {
      const config = getGoogleDriveOAuthConfig();
      const user = await getOrCreateUserByClerkId(req.clerkUserId as string);
      const appReturnUrl = sanitizeAppReturnUrl(
        (req.body as { appReturnUrl?: unknown } | undefined)?.appReturnUrl,
      );
      const { codeVerifier, codeChallenge } = generatePkce();
      const { state, expiresAt } = await createOAuthState({
        userId: user.id,
        provider: GOOGLE_DRIVE_PROVIDER,
        redirectUri: config.redirectUri,
        scopes: config.scopes,
        codeVerifier,
        appReturnUrl,
      });
      res.status(200).json({
        provider: GOOGLE_DRIVE_PROVIDER,
        authorizationUrl: buildAuthorizationUrl({ config, state, codeChallenge }),
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof GoogleOAuthConfigError) {
        res.status(400).json({ error: "google_drive_not_configured" });
        return;
      }
      logger.error("googleDrive.connect failed", { errorCode: "connect_failed" });
      res.status(500).json({ error: "google_drive_connect_failed" });
    }
  },
);

googleDriveRouter.get("/v1/integrations/google_drive/callback", async (req, res) => {
  const error = first(req.query.error);
  const code = first(req.query.code);
  const state = first(req.query.state);
  let appReturnUrl: string | null = null;
  if (error || !code || !state) {
    res.status(400).type("html").send(resultPage(false, null));
    return;
  }
  try {
    const consumed = await consumeOAuthState(state, GOOGLE_DRIVE_PROVIDER);
    if (!consumed) {
      const replay = await resolveOAuthCallbackReplay(state, GOOGLE_DRIVE_PROVIDER);
      if (replay) {
        appReturnUrl = sanitizeAppReturnUrl(replay.appReturnUrl);
        res.status(200).type("html").send(resultPage(true, appReturnUrl));
        return;
      }
      res.status(400).type("html").send(resultPage(false, null));
      return;
    }
    appReturnUrl = sanitizeAppReturnUrl(consumed.appReturnUrl);
    const tokens = await exchangeCodeForTokens({
      config: getGoogleDriveOAuthConfig(),
      code,
      codeVerifier: consumed.codeVerifier,
    });
    const grantedScopes = tokens.scopes.length > 0 ? tokens.scopes : consumed.scopes;
    const capabilities = driveCapabilitiesFromScopes(grantedScopes);
    const identity = await fetchDriveIdentity(tokens.accessToken);
    await upsertIntegrationConnection(consumed.userId, {
      provider: GOOGLE_DRIVE_PROVIDER,
      status: "connected",
      providerAccountId: identity.permissionId,
      providerAccountEmail: identity.email,
      displayName: identity.displayName,
      requestedScopes: consumed.scopes,
      grantedScopes,
      capabilities,
    });
    const connection = await getGoogleDriveConnection(consumed.userId);
    if (!connection) throw new Error("connection_missing");
    await storeCredentialSecrets(connection.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000)
        : null,
      scopes: grantedScopes,
    });
    await recordIntegrationEvent({
      userId: consumed.userId,
      provider: GOOGLE_DRIVE_PROVIDER,
      eventType: "oauth.connected",
      connectionId: connection.id,
      safeSummary: {
        scopeCount: grantedScopes.length,
        capabilityCount: capabilities.length,
        hasRefreshToken: Boolean(tokens.refreshToken),
      },
    });
    logger.info("googleDrive.callback connected", {
      scopeCount: grantedScopes.length,
      capabilityCount: capabilities.length,
    });
    res.status(200).type("html").send(resultPage(true, appReturnUrl));
  } catch {
    logger.error("googleDrive.callback failed", { errorCode: "callback_failed" });
    res.status(500).type("html").send(resultPage(false, appReturnUrl));
  }
});
