import { Router } from "express";

import { requireClerkAuth } from "../auth/clerk";
import { sanitizeAppReturnUrl } from "../integrations/appReturnUrl";
import { getProvider } from "../integrations/catalog";
import {
  recordIntegrationEvent,
  upsertIntegrationConnection,
} from "../integrations/connections";
import { storeCredentialSecrets } from "../integrations/credentials";
import { consumeOAuthState, createOAuthState } from "../integrations/oauthState";
import {
  GoogleOAuthConfigError,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkce,
  getGmailOAuthConfig,
} from "../integrations/providers/gmail/oauth";
import { GmailError, getGmailConnection } from "../integrations/providers/gmail/client";
import { runGmailDiagnostic } from "../integrations/providers/gmail/diagnostic";
import {
  fetchGmailIdentity,
  fetchRecentGmailMessages,
} from "../integrations/providers/gmail/messages";
import { GMAIL_PROVIDER } from "../integrations/providers/gmail/types";
import { getOrCreateUserByClerkId } from "../users/store";
import { logger } from "../utils/logger";

/**
 * Gmail OAuth + read-only message routes (Section 14).
 *
 * A SEPARATE provider from Google Calendar: its own connect + callback routes,
 * its own redirect URI, its own connection record. Registered BEFORE the generic
 * `/v1/me/integrations/:provider*` routes so these provider-specific paths win.
 * Least-privilege, READ-ONLY:
 *
 *   POST /v1/me/integrations/gmail/connect     — start OAuth (authed)
 *   GET  /v1/me/integrations/gmail/messages    — read recent inbox metadata (authed)
 *   GET  /v1/me/integrations/gmail/diagnostic  — safe read-path diagnostic (authed)
 *   GET  /v1/integrations/gmail/callback        — OAuth redirect (public)
 *
 * Tokens are stored encrypted server-side and NEVER returned to the app. Nothing
 * here logs a token, code, or client secret. There is no send/draft/modify path.
 */
export const gmailRouter = Router();

/** Read the first value of a possibly-repeated query param as a string. */
function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/** Escape a value for safe embedding inside an HTML attribute. */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * A polished, Hula-branded OAuth result page (no secrets, no external assets).
 * The URL scheme is already validated to be Hula's own app scheme or an Expo dev
 * scheme — never an arbitrary http(s) target.
 */
function resultPage(input: {
  title: string;
  body: string;
  accent: "ok" | "error";
  returnUrl?: string | null;
}): string {
  const safeUrl = input.returnUrl ? escapeHtmlAttr(input.returnUrl) : null;
  const accent = input.accent === "ok" ? "#7B4DFF" : "#F0A868";
  const button = safeUrl ? `<a class="btn" href="${safeUrl}">Return to Hula</a>` : "";
  const autoRedirect = safeUrl
    ? `<script>setTimeout(function(){try{window.location.href=${JSON.stringify(input.returnUrl)};}catch(e){}},400);</script>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtmlAttr(input.title)}</title><style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:radial-gradient(120% 80% at 50% -10%,#170D33 0%,#080A16 55%,#04050B 100%);color:#F6F8FF;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
main{max-width:400px;width:100%;text-align:center}
.orb{width:76px;height:76px;border-radius:24px;margin:0 auto 24px;background:linear-gradient(160deg,#0A0C18,#05060E);border:1px solid rgba(150,160,210,.28);box-shadow:0 0 40px ${accent}55;display:flex;align-items:center;justify-content:center}
.orb i{width:40px;height:26px;border:3px solid ${accent};border-radius:50%;transform:rotate(-24deg);box-shadow:0 0 18px ${accent}}
h1{font-size:22px;font-weight:700;margin:0 0 10px;letter-spacing:-.2px}
p{color:#8B93AA;line-height:1.55;margin:0 auto;max-width:320px;font-size:15px}
.btn{display:inline-block;margin-top:28px;padding:15px 40px;border-radius:999px;background:#F6F8FF;color:#0A0A0F;font-weight:600;font-size:16px;text-decoration:none}
</style></head><body><main><div class="orb"><i></i></div><h1>${escapeHtmlAttr(input.title)}</h1><p>${escapeHtmlAttr(input.body)}</p>${button}</main>${autoRedirect}</body></html>`;
}

function successPage(returnUrl: string | null): string {
  return resultPage({
    title: "Gmail connected",
    body: returnUrl
      ? "You’re all set. Returning you to Hula — tap below if it doesn’t happen automatically."
      : "You’re all set. You can return to Hula and text as usual.",
    accent: "ok",
    returnUrl,
  });
}

function errorPage(returnUrl: string | null): string {
  return resultPage({
    title: "Couldn’t connect Gmail",
    body: "Something went wrong connecting your Gmail. Please return to Hula and try again.",
    accent: "error",
    returnUrl,
  });
}

// --- Connect (authed): start OAuth ---------------------------------------

gmailRouter.post(
  "/v1/me/integrations/gmail/connect",
  requireClerkAuth,
  async (req, res) => {
    const clerkUserId = req.clerkUserId as string;
    try {
      const config = getGmailOAuthConfig();
      const user = await getOrCreateUserByClerkId(clerkUserId);

      const appReturnUrl = sanitizeAppReturnUrl(
        (req.body as { appReturnUrl?: unknown } | undefined)?.appReturnUrl,
      );

      const { codeVerifier, codeChallenge } = generatePkce();
      const { state, expiresAt } = await createOAuthState({
        userId: user.id,
        provider: GMAIL_PROVIDER,
        redirectUri: config.redirectUri,
        scopes: config.scopes,
        codeVerifier,
        appReturnUrl,
      });

      const authorizationUrl = buildAuthorizationUrl({ config, state, codeChallenge });
      logger.info("gmail.connect started");
      res.status(200).json({
        provider: GMAIL_PROVIDER,
        authorizationUrl,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof GoogleOAuthConfigError) {
        res.status(400).json({ error: "gmail_not_configured" });
        return;
      }
      logger.error("gmail.connect failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
      res.status(500).json({ error: "gmail_connect_failed" });
    }
  },
);

// --- Messages (authed): read-only ----------------------------------------

function parseLimit(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(1, Math.trunc(n)), 20);
}

gmailRouter.get(
  "/v1/me/integrations/gmail/messages",
  requireClerkAuth,
  async (req, res) => {
    const clerkUserId = req.clerkUserId as string;
    const limit = parseLimit(firstQueryValue(req.query.limit));

    try {
      const user = await getOrCreateUserByClerkId(clerkUserId);
      const messages = await fetchRecentGmailMessages(user.id, { maxResults: limit });
      logger.info("gmail.messages served", { count: messages.length });
      res.status(200).json({ provider: GMAIL_PROVIDER, messages });
    } catch (err) {
      if (err instanceof GmailError) {
        if (err.reason === "not_connected") {
          res.status(409).json({ error: "gmail_not_connected" });
          return;
        }
        // A precise, SAFE error code (never the raw provider body). 502 marks a
        // provider-side problem; the app treats it as a transient read error and
        // does NOT flip the connection to disconnected.
        logger.info("gmail.messages unavailable", {
          provider: GMAIL_PROVIDER,
          errorCode: err.reason,
          httpStatus: err.httpStatus,
        });
        res.status(502).json({ error: "gmail_unavailable", errorCode: err.reason });
        return;
      }
      logger.error("gmail.messages failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
      res.status(500).json({ error: "gmail_messages_failed" });
    }
  },
);

// --- Diagnostic (authed): current user only, no secrets ------------------

gmailRouter.get(
  "/v1/me/integrations/gmail/diagnostic",
  requireClerkAuth,
  async (req, res) => {
    const clerkUserId = req.clerkUserId as string;
    try {
      const user = await getOrCreateUserByClerkId(clerkUserId);
      const diagnostic = await runGmailDiagnostic(user.id);
      logger.info("gmail.diagnostic served", {
        provider: GMAIL_PROVIDER,
        errorStage: diagnostic.errorStage,
        errorCode: diagnostic.errorCode,
        safeErrorName: diagnostic.safeErrorName,
        safeCauseCode: diagnostic.safeCauseCode,
      });
      res.status(200).json(diagnostic);
    } catch (err) {
      logger.error("gmail.diagnostic failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
      res.status(500).json({ error: "gmail_diagnostic_failed" });
    }
  },
);

// --- Callback (public): OAuth redirect target ----------------------------

gmailRouter.get("/v1/integrations/gmail/callback", async (req, res) => {
  const error = firstQueryValue(req.query.error);
  const code = firstQueryValue(req.query.code);
  const state = firstQueryValue(req.query.state);

  let appReturnUrl: string | null = null;

  if (error || !code || !state) {
    logger.info("gmail.callback denied/invalid", { hasError: Boolean(error) });
    res.status(400).type("html").send(errorPage(null));
    return;
  }

  try {
    // Validate + consume the anti-CSRF state (single use). The provider filter
    // ensures a Calendar state can never be consumed as a Gmail one.
    const consumed = await consumeOAuthState(state, GMAIL_PROVIDER);
    if (!consumed) {
      logger.info("gmail.callback rejected state");
      res.status(400).type("html").send(errorPage(null));
      return;
    }
    appReturnUrl = sanitizeAppReturnUrl(consumed.appReturnUrl);

    const config = getGmailOAuthConfig();
    const tokens = await exchangeCodeForTokens({
      config,
      code,
      codeVerifier: consumed.codeVerifier,
    });

    // Best-effort safe identity (the Gmail profile's emailAddress).
    let email: string | null = null;
    try {
      const identity = await fetchGmailIdentity(tokens.accessToken);
      email = identity.email;
    } catch (identityErr) {
      logger.error("gmail.callback identity failed", {
        reason: identityErr instanceof Error ? identityErr.message : "unknown error",
      });
    }

    const grantedScopes = tokens.scopes.length > 0 ? tokens.scopes : consumed.scopes;
    const capabilities = getProvider(GMAIL_PROVIDER)?.capabilities ?? [];

    await upsertIntegrationConnection(consumed.userId, {
      provider: GMAIL_PROVIDER,
      status: "connected",
      providerAccountEmail: email,
      grantedScopes,
      requestedScopes: consumed.scopes,
      capabilities,
    });

    const connection = await getGmailConnection(consumed.userId);
    if (!connection) throw new Error("connection row missing after upsert");

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
      provider: GMAIL_PROVIDER,
      eventType: "oauth.connected",
      connectionId: connection.id,
      safeSummary: {
        scopeCount: grantedScopes.length,
        hasRefreshToken: Boolean(tokens.refreshToken),
      },
    });

    logger.info("gmail.callback connected", {
      scopeCount: grantedScopes.length,
      willReturnToApp: Boolean(appReturnUrl),
    });
    res.status(200).type("html").send(successPage(appReturnUrl));
  } catch (err) {
    logger.error("gmail.callback failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).type("html").send(errorPage(appReturnUrl));
  }
});
