import { Router } from "express";

import { requireClerkAuth } from "../auth/clerk";
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
  getGoogleOAuthConfig,
} from "../integrations/providers/googleCalendar/oauth";
import {
  GoogleCalendarError,
  getGoogleCalendarConnection,
} from "../integrations/providers/googleCalendar/client";
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

/** A minimal, safe HTML page for the OAuth callback (no secrets, no scripts). */
function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0b0f;color:#f5f5f7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}main{max-width:420px;text-align:center}h1{font-size:20px;margin:0 0 12px}p{color:#a1a1aa;line-height:1.5;margin:0}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

const SUCCESS_HTML = htmlPage(
  "Google Calendar connected",
  "You’re all set. You can return to Hula and text as usual.",
);
const GENERIC_ERROR_HTML = htmlPage(
  "Couldn’t connect Google Calendar",
  "Something went wrong connecting your calendar. Please return to Hula and try again.",
);

// --- Connect (authed): start OAuth ---------------------------------------

googleCalendarRouter.post(
  "/v1/me/integrations/google_calendar/connect",
  requireClerkAuth,
  async (req, res) => {
    const clerkUserId = req.clerkUserId as string;
    try {
      const config = getGoogleOAuthConfig();
      const user = await getOrCreateUserByClerkId(clerkUserId);

      const { codeVerifier, codeChallenge } = generatePkce();
      const { state, expiresAt } = await createOAuthState({
        userId: user.id,
        provider: GOOGLE_CALENDAR_PROVIDER,
        redirectUri: config.redirectUri,
        scopes: config.scopes,
        codeVerifier,
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
      if (err instanceof GoogleCalendarError && err.reason === "not_connected") {
        res.status(409).json({ error: "google_calendar_not_connected" });
        return;
      }
      if (err instanceof GoogleCalendarError) {
        // Expired / refresh / request failure — safe, non-500 signal.
        res.status(502).json({ error: "google_calendar_unavailable" });
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

    // User denied consent, or a malformed callback.
    if (error || !code || !state) {
      logger.info("googleCalendar.callback denied/invalid", { hasError: Boolean(error) });
      res.status(400).type("html").send(GENERIC_ERROR_HTML);
      return;
    }

    try {
      // Validate + consume the anti-CSRF state (single use).
      const consumed = await consumeOAuthState(state, GOOGLE_CALENDAR_PROVIDER);
      if (!consumed) {
        logger.info("googleCalendar.callback rejected state");
        res.status(400).type("html").send(GENERIC_ERROR_HTML);
        return;
      }

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

      logger.info("googleCalendar.callback connected", { scopeCount: grantedScopes.length });
      res.status(200).type("html").send(SUCCESS_HTML);
    } catch (err) {
      logger.error("googleCalendar.callback failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
      res.status(500).type("html").send(GENERIC_ERROR_HTML);
    }
  },
);
