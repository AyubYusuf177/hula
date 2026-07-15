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
import {
  TodoistOAuthConfigError,
  buildTodoistAuthorizationUrl,
  capabilitiesFromScopes,
  exchangeTodoistCodeForTokens,
  getTodoistOAuthConfig,
  isUsableTodoistGrant,
} from "../integrations/providers/todoist/oauth";
import { getTodoistConnection } from "../integrations/providers/todoist/client";
import { TODOIST_PROVIDER } from "../integrations/providers/todoist/types";
import { getOrCreateUserByClerkId } from "../users/store";
import { logger } from "../utils/logger";

/**
 * Todoist OAuth routes (Section 19).
 *
 * Registered BEFORE the generic `/v1/me/integrations/:provider*` routes so these
 * provider-specific paths win (disconnect is deliberately NOT re-implemented here
 * — the generic route already handles any known provider, and duplicating it
 * would be a second thing to keep correct).
 *
 *   POST /v1/me/integrations/todoist/connect   — start OAuth (authed)
 *   GET  /v1/integrations/todoist/callback     — OAuth redirect (public)
 *
 * Tokens are stored encrypted server-side and NEVER returned to the app. Nothing
 * here logs a token, an authorization code, a client secret, or a raw provider
 * body — only coded, countable facts.
 */
export const todoistRouter = Router();

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
 * The same Hula-branded OAuth result page the Google flows render (no secrets, no
 * external assets). See `routes/googleCalendar.ts` for why `location.replace` is
 * used rather than `location.href`.
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
    ? `<script>setTimeout(function(){try{window.location.replace(${JSON.stringify(input.returnUrl)});}catch(e){}},400);</script>`
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
    title: "Todoist connected",
    body: returnUrl
      ? "You’re all set. Returning you to Hula — tap below if it doesn’t happen automatically."
      : "You’re all set. You can return to Hula and text as usual.",
    accent: "ok",
    returnUrl,
  });
}

function errorPage(returnUrl: string | null): string {
  return resultPage({
    title: "Couldn’t connect Todoist",
    body: "Something went wrong connecting your Todoist. Please return to Hula and try again.",
    accent: "error",
    returnUrl,
  });
}

// --- Connect (authed): start OAuth ---------------------------------------

todoistRouter.post(
  "/v1/me/integrations/todoist/connect",
  requireClerkAuth,
  async (req, res) => {
    const clerkUserId = req.clerkUserId as string;
    try {
      const config = getTodoistOAuthConfig();
      const user = await getOrCreateUserByClerkId(clerkUserId);

      const appReturnUrl = sanitizeAppReturnUrl(
        (req.body as { appReturnUrl?: unknown } | undefined)?.appReturnUrl,
      );

      // `codeVerifier: null` — Todoist requires PKCE for PUBLIC clients only, and
      // Hula is a confidential client authenticating with a real client_secret.
      // CSRF protection is the single-use state row, exactly as for Google.
      const { state, expiresAt } = await createOAuthState({
        userId: user.id,
        provider: TODOIST_PROVIDER,
        redirectUri: config.redirectUri,
        scopes: config.scopes,
        codeVerifier: null,
        appReturnUrl,
      });

      const authorizationUrl = buildTodoistAuthorizationUrl({ config, state });
      logger.info("todoist.connect started", { scopeCount: config.scopes.length });
      res.status(200).json({
        provider: TODOIST_PROVIDER,
        authorizationUrl,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof TodoistOAuthConfigError) {
        res.status(400).json({ error: "todoist_not_configured" });
        return;
      }
      logger.error("todoist.connect failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
      res.status(500).json({ error: "todoist_connect_failed" });
    }
  },
);

// --- Callback (public): OAuth redirect target ----------------------------

todoistRouter.get("/v1/integrations/todoist/callback", async (req, res) => {
  const error = firstQueryValue(req.query.error);
  const code = firstQueryValue(req.query.code);
  const state = firstQueryValue(req.query.state);

  let appReturnUrl: string | null = null;

  // User denied consent, or a malformed callback.
  if (error || !code || !state) {
    logger.info("todoist.callback denied/invalid", { hasError: Boolean(error) });
    res.status(400).type("html").send(errorPage(null));
    return;
  }

  try {
    // Validate + consume the anti-CSRF state (single use). This atomic claim is
    // the ONLY path that can reach a token exchange.
    const consumed = await consumeOAuthState(state, TODOIST_PROVIDER);
    if (!consumed) {
      // Before calling this a failure, check whether it is an exact replay of a
      // callback that ALREADY SUCCEEDED — the browser re-issuing the same GET.
      // This proves the outcome against the connection itself; it exchanges
      // nothing and writes nothing. Shared with the Google flows.
      const replay = await resolveOAuthCallbackReplay(state, TODOIST_PROVIDER);
      if (replay) {
        logger.info("todoist.callback replayed after success", {
          willReturnToApp: Boolean(replay.appReturnUrl),
        });
        res.status(200).type("html").send(successPage(sanitizeAppReturnUrl(replay.appReturnUrl)));
        return;
      }
      logger.info("todoist.callback rejected state");
      res.status(400).type("html").send(errorPage(null));
      return;
    }
    appReturnUrl = sanitizeAppReturnUrl(consumed.appReturnUrl);

    const config = getTodoistOAuthConfig();
    const tokens = await exchangeTodoistCodeForTokens({ config, code });

    // Trust what Todoist says was GRANTED over what we requested. Falling back to
    // the requested scopes only when Todoist returns none keeps a silent partial
    // consent from being recorded as a full grant.
    const grantedScopes = tokens.scopes.length > 0 ? tokens.scopes : consumed.scopes;

    // A grant with neither read nor write can do nothing at all — that is the one
    // case that genuinely is not a connection. Anything else (notably read_write
    // WITHOUT delete) is a real, working integration and must connect normally.
    if (!isUsableTodoistGrant(grantedScopes)) {
      logger.info("todoist.callback unusable grant", { scopeCount: grantedScopes.length });
      res.status(400).type("html").send(errorPage(appReturnUrl));
      return;
    }

    // Capabilities are derived from the GRANTED scopes, never the catalog's
    // requested list — so a user who declined delete gets tasks.read + tasks.write
    // and the delete action alone refuses.
    const capabilities = capabilitiesFromScopes(grantedScopes);

    await upsertIntegrationConnection(consumed.userId, {
      provider: TODOIST_PROVIDER,
      status: "connected",
      grantedScopes,
      requestedScopes: consumed.scopes,
      capabilities,
    });

    const connection = await getTodoistConnection(consumed.userId);
    if (!connection) throw new Error("connection row missing after upsert");

    await storeCredentialSecrets(connection.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      // Todoist returns expires_in on modern apps and a ~10-year value for legacy
      // (refresh-disabled) apps. Both are recorded truthfully; a null means the
      // token does not expire and must never be refreshed.
      accessTokenExpiresAt: tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000)
        : null,
      scopes: grantedScopes,
    });

    await recordIntegrationEvent({
      userId: consumed.userId,
      provider: TODOIST_PROVIDER,
      eventType: "oauth.connected",
      connectionId: connection.id,
      safeSummary: {
        scopeCount: grantedScopes.length,
        hasRefreshToken: Boolean(tokens.refreshToken),
        capabilities,
      },
    });

    logger.info("todoist.callback connected", {
      scopeCount: grantedScopes.length,
      capabilityCount: capabilities.length,
      willReturnToApp: Boolean(appReturnUrl),
    });
    res.status(200).type("html").send(successPage(appReturnUrl));
  } catch (err) {
    logger.error("todoist.callback failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).type("html").send(errorPage(appReturnUrl));
  }
});
