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
import { resolveOAuthCallbackReplay } from "../integrations/oauthReplay";
import {
  GoogleOAuthConfigError,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkce,
  getGoogleOAuthConfig,
} from "../integrations/providers/googleCalendar/oauth";
import {
  GoogleCalendarError,
  getGoogleCalendarConnection,
} from "../integrations/providers/googleCalendar/client";
import { runGoogleCalendarDiagnostic } from "../integrations/providers/googleCalendar/diagnostic";
import {
  fetchGoogleCalendarIdentity,
  fetchUpcomingGoogleCalendarEvents,
} from "../integrations/providers/googleCalendar/events";
import { GOOGLE_CALENDAR_PROVIDER } from "../integrations/providers/googleCalendar/types";
import type { CalendarRange } from "../integrations/providers/googleCalendar/types";
import { getOrCreateUserByClerkId } from "../users/store";
import { logger } from "../utils/logger";

/**
 * Google Calendar OAuth + read-only event routes (Section 11).
 *
 * Registered BEFORE the generic `/v1/me/integrations/:provider*` routes so these
 * provider-specific paths win. Least-privilege, READ-ONLY:
 *
 *   POST /v1/me/integrations/google_calendar/connect  — start OAuth (authed)
 *   GET  /v1/me/integrations/google_calendar/events    — read events (authed)
 *   GET  /v1/integrations/google_calendar/callback      — OAuth redirect (public)
 *
 * Tokens are stored encrypted server-side and NEVER returned to the app. Nothing
 * here logs a token, code, or client secret.
 */
export const googleCalendarRouter = Router();

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
 *
 * When a validated `returnUrl` is present, the page (a) auto-attempts a redirect
 * back into the Hula app and (b) shows a visible "Return to Hula" button as a
 * reliable fallback for environments (e.g. some Expo Go setups) where the auth
 * browser can't auto-close. The URL scheme is already validated to be Hula's own
 * app scheme or an Expo dev scheme — never an arbitrary http(s) target.
 */
function resultPage(input: {
  title: string;
  body: string;
  accent: "ok" | "error";
  returnUrl?: string | null;
}): string {
  const safeUrl = input.returnUrl ? escapeHtmlAttr(input.returnUrl) : null;
  const accent = input.accent === "ok" ? "#7B4DFF" : "#F0A868";
  const button = safeUrl
    ? `<a class="btn" href="${safeUrl}">Return to Hula</a>`
    : "";
  // `location.replace` rather than `location.href`: it does NOT push a history
  // entry, so dismissing the "Open in Hula?" prompt can't leave the browser able
  // to restore/back onto this URL and re-issue the callback GET — one real source
  // of the duplicate callback. This reduces the double request; it does not rely
  // on eliminating it, because a bfcache restore or prefetch can still re-issue a
  // GET. Correctness under replay is handled server-side (see `oauthReplay.ts`).
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
    title: "Google Calendar connected",
    body: returnUrl
      ? "You’re all set. Returning you to Hula — tap below if it doesn’t happen automatically."
      : "You’re all set. You can return to Hula and text as usual.",
    accent: "ok",
    returnUrl,
  });
}

function errorPage(returnUrl: string | null): string {
  return resultPage({
    title: "Couldn’t connect Google Calendar",
    body: "Something went wrong connecting your calendar. Please return to Hula and try again.",
    accent: "error",
    returnUrl,
  });
}

// --- Connect (authed): start OAuth ---------------------------------------

googleCalendarRouter.post(
  "/v1/me/integrations/google_calendar/connect",
  requireClerkAuth,
  async (req, res) => {
    const clerkUserId = req.clerkUserId as string;
    try {
      const config = getGoogleOAuthConfig();
      const user = await getOrCreateUserByClerkId(clerkUserId);

      // Optional app deep-link to return the user to Hula after the callback.
      // Strictly validated — arbitrary http(s) targets are rejected so this can
      // never become an open redirect.
      const appReturnUrl = sanitizeAppReturnUrl(
        (req.body as { appReturnUrl?: unknown } | undefined)?.appReturnUrl,
      );

      const { codeVerifier, codeChallenge } = generatePkce();
      const { state, expiresAt } = await createOAuthState({
        userId: user.id,
        provider: GOOGLE_CALENDAR_PROVIDER,
        redirectUri: config.redirectUri,
        scopes: config.scopes,
        codeVerifier,
        appReturnUrl,
      });

      const authorizationUrl = buildAuthorizationUrl({ config, state, codeChallenge });
      logger.info("googleCalendar.connect started");
      res.status(200).json({
        provider: GOOGLE_CALENDAR_PROVIDER,
        authorizationUrl,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof GoogleOAuthConfigError) {
        // Missing config is a safe, expected 400 — never a 500 crash.
        res.status(400).json({ error: "google_calendar_not_configured" });
        return;
      }
      logger.error("googleCalendar.connect failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
      res.status(500).json({ error: "google_calendar_connect_failed" });
    }
  },
);

// --- Events (authed): read-only -----------------------------------------

const VALID_RANGES: readonly CalendarRange[] = ["today", "tomorrow", "week", "next"];

function parseRange(value: string | undefined): CalendarRange {
  return VALID_RANGES.includes(value as CalendarRange) ? (value as CalendarRange) : "week";
}

function parseLimit(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(1, Math.trunc(n)), 25);
}

googleCalendarRouter.get(
  "/v1/me/integrations/google_calendar/events",
  requireClerkAuth,
  async (req, res) => {
    const clerkUserId = req.clerkUserId as string;
    const range = parseRange(firstQueryValue(req.query.range));
    const limit = parseLimit(firstQueryValue(req.query.limit));

    try {
      const user = await getOrCreateUserByClerkId(clerkUserId);
      const events = await fetchUpcomingGoogleCalendarEvents(user.id, {
        range,
        maxResults: limit,
      });
      logger.info("googleCalendar.events served", { range, count: events.length });
      res.status(200).json({ provider: GOOGLE_CALENDAR_PROVIDER, range, events });
    } catch (err) {
      if (err instanceof GoogleCalendarError) {
        if (err.reason === "not_connected") {
          res.status(409).json({ error: "google_calendar_not_connected" });
          return;
        }
        // A precise, SAFE error code (never the raw provider body). 502 marks a
        // provider-side problem; the app treats it as a transient read error and
        // does NOT flip the connection to disconnected.
        logger.info("googleCalendar.events unavailable", {
          provider: GOOGLE_CALENDAR_PROVIDER,
          errorCode: err.reason,
          httpStatus: err.httpStatus,
        });
        res.status(502).json({ error: "google_calendar_unavailable", errorCode: err.reason });
        return;
      }
      logger.error("googleCalendar.events failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
      res.status(500).json({ error: "google_calendar_events_failed" });
    }
  },
);

// --- Callback (public): OAuth redirect target ----------------------------

googleCalendarRouter.get(
  "/v1/integrations/google_calendar/callback",
  async (req, res) => {
    const error = firstQueryValue(req.query.error);
    const code = firstQueryValue(req.query.code);
    const state = firstQueryValue(req.query.state);

    // Return URL only becomes known after we consume the (validated) state.
    let appReturnUrl: string | null = null;

    // User denied consent, or a malformed callback.
    if (error || !code || !state) {
      logger.info("googleCalendar.callback denied/invalid", { hasError: Boolean(error) });
      res.status(400).type("html").send(errorPage(null));
      return;
    }

    try {
      // Validate + consume the anti-CSRF state (single use). This atomic claim is
      // still the ONLY path that can reach a token exchange.
      const consumed = await consumeOAuthState(state, GOOGLE_CALENDAR_PROVIDER);
      if (!consumed) {
        // The state didn't claim. Before calling this a failure, check whether it
        // is an exact replay of a callback that ALREADY SUCCEEDED — the real
        // device bug, where the browser re-issued the same GET and the error page
        // landed on top of a genuine connection. This proves the outcome against
        // the connection itself; it performs no exchange and writes nothing.
        const replay = await resolveOAuthCallbackReplay(state, GOOGLE_CALENDAR_PROVIDER);
        if (replay) {
          logger.info("googleCalendar.callback replayed after success", {
            willReturnToApp: Boolean(replay.appReturnUrl),
          });
          res
            .status(200)
            .type("html")
            .send(successPage(sanitizeAppReturnUrl(replay.appReturnUrl)));
          return;
        }
        logger.info("googleCalendar.callback rejected state");
        res.status(400).type("html").send(errorPage(null));
        return;
      }
      // Re-validate defensively even though it was validated at connect time.
      appReturnUrl = sanitizeAppReturnUrl(consumed.appReturnUrl);

      const config = getGoogleOAuthConfig();
      const tokens = await exchangeCodeForTokens({
        config,
        code,
        codeVerifier: consumed.codeVerifier,
      });

      // Best-effort safe identity (the primary calendar id is the account email).
      let email: string | null = null;
      try {
        const identity = await fetchGoogleCalendarIdentity(tokens.accessToken);
        email = identity.email;
      } catch (identityErr) {
        logger.error("googleCalendar.callback identity failed", {
          reason: identityErr instanceof Error ? identityErr.message : "unknown error",
        });
      }

      const grantedScopes = tokens.scopes.length > 0 ? tokens.scopes : consumed.scopes;
      const capabilities = getProvider(GOOGLE_CALENDAR_PROVIDER)?.capabilities ?? [];

      await upsertIntegrationConnection(consumed.userId, {
        provider: GOOGLE_CALENDAR_PROVIDER,
        status: "connected",
        providerAccountEmail: email,
        grantedScopes,
        requestedScopes: consumed.scopes,
        capabilities,
      });

      const connection = await getGoogleCalendarConnection(consumed.userId);
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
        provider: GOOGLE_CALENDAR_PROVIDER,
        eventType: "oauth.connected",
        connectionId: connection.id,
        safeSummary: { scopeCount: grantedScopes.length, hasRefreshToken: Boolean(tokens.refreshToken) },
      });

      // Tokens are persisted and the connection is marked connected BEFORE we
      // render success or redirect — backend state is the source of truth.
      logger.info("googleCalendar.callback connected", {
        scopeCount: grantedScopes.length,
        willReturnToApp: Boolean(appReturnUrl),
      });
      res.status(200).type("html").send(successPage(appReturnUrl));
    } catch (err) {
      logger.error("googleCalendar.callback failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
      res.status(500).type("html").send(errorPage(appReturnUrl));
    }
  },
);

// --- Diagnostic (authed): current user only, no secrets ------------------

/**
 * Safe read-path diagnostic for the signed-in user's Google Calendar. Returns
 * booleans + one coded reason so a developer can pinpoint (e.g.) a disabled
 * Calendar API. NEVER returns a token, encrypted value, raw Google payload, or
 * OAuth secret. Removable/development-friendly.
 */
googleCalendarRouter.get(
  "/v1/me/integrations/google_calendar/diagnostic",
  requireClerkAuth,
  async (req, res) => {
    const clerkUserId = req.clerkUserId as string;
    try {
      const user = await getOrCreateUserByClerkId(clerkUserId);
      const diagnostic = await runGoogleCalendarDiagnostic(user.id);
      logger.info("googleCalendar.diagnostic served", {
        provider: GOOGLE_CALENDAR_PROVIDER,
        errorStage: diagnostic.errorStage,
        errorCode: diagnostic.errorCode,
        safeErrorName: diagnostic.safeErrorName,
        safeCauseCode: diagnostic.safeCauseCode,
      });
      res.status(200).json(diagnostic);
    } catch (err) {
      logger.error("googleCalendar.diagnostic failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
      res.status(500).json({ error: "google_calendar_diagnostic_failed" });
    }
  },
);
