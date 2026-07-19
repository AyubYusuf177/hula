import { createHmac, timingSafeEqual } from "node:crypto";
import express, { Router, type RequestHandler } from "express";

import { requireClerkAuth } from "../auth/clerk";
import { env } from "../config/env";
import { getPrisma } from "../db/prisma";
import { sanitizeAppReturnUrl } from "../integrations/appReturnUrl";
import {
  disconnectIntegrationConnection,
  recordIntegrationEvent,
  upsertIntegrationConnection,
} from "../integrations/connections";
import { readCredentialSecrets } from "../integrations/credentials";
import { consumeOAuthState, createOAuthState } from "../integrations/oauthState";
import { resolveOAuthCallbackReplay } from "../integrations/oauthReplay";
import {
  buildSlackAuthorizationUrl,
  exchangeSlackCode,
  getSlackOAuthConfig,
  revokeSlackCredentials,
  slackCapabilities,
  SlackOAuthError,
} from "../integrations/providers/slack/oauth";
import { persistSlackCredentials } from "../integrations/providers/slack/operations";
import { SLACK_PROVIDER, type SlackCredentials } from "../integrations/providers/slack/types";
import { getOrCreateUserByClerkId } from "../users/store";
import { logger } from "../utils/logger";

export const slackRouter = Router();
export const slackEventsRouter = Router();

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export type SlackCallbackQuery =
  | { kind: "authorized"; code: string; state: string }
  | { kind: "denied"; error: string }
  | { kind: "malformed"; missing: "code" | "state" };

export function classifySlackCallbackQuery(query: Record<string, unknown>): SlackCallbackQuery {
  const error = stringValue(query.error);
  if (error) return { kind: "denied", error };
  const code = stringValue(query.code);
  if (!code) return { kind: "malformed", missing: "code" };
  const state = stringValue(query.state);
  if (!state) return { kind: "malformed", missing: "state" };
  return { kind: "authorized", code, state };
}

function callbackPage(ok: boolean, appReturnUrl: string | null): string {
  const safeReturnUrl = appReturnUrl?.replace(/["<>]/g, "") ?? null;
  const autoReturn = safeReturnUrl
    ? `<script>setTimeout(function(){try{window.location.replace(${JSON.stringify(safeReturnUrl)});}catch(e){}},400);</script>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Slack ${ok ? "connected" : "connection failed"}</title></head><body style="background:#080a16;color:#f6f8ff;font-family:system-ui;text-align:center;padding:64px 24px"><h1>${ok ? "Slack connected" : "Couldn’t connect Slack"}</h1><p>${ok ? "Returning you to Hula. Tap below if it doesn’t happen automatically." : "Return to Hula and try again."}</p>${safeReturnUrl ? `<a style="color:#fff" href="${safeReturnUrl}">Return to Hula</a>` : ""}${autoReturn}</body></html>`;
}

export function slackAuthorizationSafeMetadata(config: ReturnType<typeof getSlackOAuthConfig>): Record<string, unknown> {
  const authorization = new URL(buildSlackAuthorizationUrl(config, "redacted"));
  const redirect = new URL(config.redirectUri);
  return {
    provider: SLACK_PROVIDER,
    authorizationHost: authorization.host,
    authorizationPath: authorization.pathname,
    botScopeCount: config.botScopes.length,
    userScopeCount: config.userScopes.length,
    redirectHost: redirect.host,
    redirectPath: redirect.pathname,
    hasState: true,
    hasDevelopmentTeamHint: Boolean(config.developmentTeamId),
  };
}

export function buildSlackConnectResponse(
  config: ReturnType<typeof getSlackOAuthConfig>,
  state: string,
  expiresAt: Date,
): { provider: string; authorizationUrl: string; expiresAt: string } {
  return {
    provider: SLACK_PROVIDER,
    authorizationUrl: buildSlackAuthorizationUrl(config, state),
    expiresAt: expiresAt.toISOString(),
  };
}

slackRouter.post(
  "/v1/me/integrations/slack/connect",
  requireClerkAuth,
  async (req, res) => {
    try {
      const config = getSlackOAuthConfig();
      const user = await getOrCreateUserByClerkId(req.clerkUserId as string);
      const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
      const appReturnUrl = sanitizeAppReturnUrl(body.appReturnUrl);
      const requestedScopes = [
        ...config.botScopes,
        ...config.userScopes.map((scope) => `user:${scope}`),
      ];
      const state = await createOAuthState({
        userId: user.id,
        provider: SLACK_PROVIDER,
        redirectUri: config.redirectUri,
        scopes: requestedScopes,
        codeVerifier: null,
        appReturnUrl,
      });
      logger.info("slack.connect started", slackAuthorizationSafeMetadata(config));
      res.json(buildSlackConnectResponse(config, state.state, state.expiresAt));
    } catch (error) {
      if (error instanceof SlackOAuthError) {
        res.status(400).json({ error: error.code });
        return;
      }
      logger.error("slack.connect failed", { reason: error instanceof Error ? error.name : "unknown" });
      res.status(500).json({ error: "slack_connect_failed" });
    }
  },
);

slackRouter.get("/v1/integrations/slack/callback", async (req, res) => {
  const callback = classifySlackCallbackQuery(req.query);
  if (callback.kind !== "authorized") {
    logger.info("slack.callback denied/invalid", {
      reason: callback.kind === "denied" ? "user_denied" : `missing_${callback.missing}`,
    });
    res.status(400).type("html").send(callbackPage(false, null));
    return;
  }
  const { code, state } = callback;

  let appReturnUrl: string | null = null;
  try {
    const consumed = await consumeOAuthState(state, SLACK_PROVIDER);
    if (!consumed) {
      const replay = await resolveOAuthCallbackReplay(state, SLACK_PROVIDER);
      res.status(replay ? 200 : 400).type("html").send(
        callbackPage(Boolean(replay), sanitizeAppReturnUrl(replay?.appReturnUrl)),
      );
      return;
    }
    appReturnUrl = sanitizeAppReturnUrl(consumed.appReturnUrl);
    const config = getSlackOAuthConfig();
    const credentials = await exchangeSlackCode(config, code);
    const capabilities = slackCapabilities(credentials.botScopes, credentials.userScopes);
    if (!credentials.botScopes.includes("channels:read") || !capabilities.includes("slack.read")) {
      throw new SlackOAuthError("Required Slack channel read permission was not granted", "missing_scope");
    }
    const grantedScopes = [
      ...credentials.botScopes,
      ...credentials.userScopes.map((scope) => `user:${scope}`),
    ];
    let connection = await getPrisma().integrationConnection.findUnique({
      where: { userId_provider: { userId: consumed.userId, provider: SLACK_PROVIDER } },
      select: { id: true },
    });
    // A new row is needed to own encrypted credentials. Keep it non-connected
    // until encryption succeeds; an existing healthy installation remains
    // untouched until its replacement credentials are safely stored.
    if (!connection) {
      await upsertIntegrationConnection(consumed.userId, {
        provider: SLACK_PROVIDER,
        status: "error",
        providerAccountId: credentials.teamId,
        displayName: credentials.teamName,
        grantedScopes: [],
        requestedScopes: consumed.scopes,
        capabilities: [],
      });
      connection = await getPrisma().integrationConnection.findUnique({
        where: { userId_provider: { userId: consumed.userId, provider: SLACK_PROVIDER } },
        select: { id: true },
      });
    }
    if (!connection) throw new Error("slack_connection_missing");
    await persistSlackCredentials(connection.id, credentials);
    await upsertIntegrationConnection(consumed.userId, {
      provider: SLACK_PROVIDER,
      status: "connected",
      providerAccountId: credentials.teamId,
      displayName: credentials.teamName,
      grantedScopes,
      requestedScopes: consumed.scopes,
      capabilities,
    });
    await recordIntegrationEvent({
      userId: consumed.userId,
      provider: SLACK_PROVIDER,
      eventType: "oauth.connected",
      connectionId: connection.id,
      safeSummary: {
        scopeCount: credentials.botScopes.length,
        userScopeCount: credentials.userScopes.length,
        capabilityCount: capabilities.length,
        rotationEnabled: Boolean(credentials.botRefreshToken || credentials.userRefreshToken),
      },
    });
    res.type("html").send(callbackPage(true, appReturnUrl));
  } catch (error) {
    logger.error("slack.callback failed", { reason: error instanceof Error ? error.name : "unknown" });
    res.status(error instanceof SlackOAuthError && error.code === "missing_scope" ? 403 : 500)
      .type("html")
      .send(callbackPage(false, appReturnUrl));
  }
});

slackRouter.post(
  "/v1/me/integrations/slack/disconnect",
  requireClerkAuth,
  async (req, res) => {
    try {
      const user = await getOrCreateUserByClerkId(req.clerkUserId as string);
      const connection = await getPrisma().integrationConnection.findUnique({
        where: { userId_provider: { userId: user.id, provider: SLACK_PROVIDER } },
        select: { id: true, status: true },
      });
      if (!connection || connection.status === "disconnected") {
        res.json({ ok: true, changed: false });
        return;
      }
      const stored = await readCredentialSecrets(connection.id);
      if (stored?.accessToken) {
        let credentials: SlackCredentials;
        try {
          credentials = JSON.parse(stored.accessToken) as SlackCredentials;
        } catch {
          res.status(500).json({ error: "slack_credentials_invalid" });
          return;
        }
        const revocation = await revokeSlackCredentials(getSlackOAuthConfig(), credentials);
        if (revocation.failed > 0) {
          logger.error("slack.revoke incomplete", {
            attemptedCount: revocation.attempted,
            failedCount: revocation.failed,
          });
        }
        const changed = await disconnectIntegrationConnection(user.id, SLACK_PROVIDER);
        await recordIntegrationEvent({
          userId: user.id,
          provider: SLACK_PROVIDER,
          eventType: "oauth.disconnected",
          connectionId: connection.id,
          safeSummary: {
            remoteRevocationAttempted: revocation.attempted > 0,
            remoteRevocationComplete: revocation.failed === 0,
          },
        });
        res.json({ ok: true, changed, remoteRevocationComplete: revocation.failed === 0 });
        return;
      }
      const changed = await disconnectIntegrationConnection(user.id, SLACK_PROVIDER);
      await recordIntegrationEvent({
        userId: user.id,
        provider: SLACK_PROVIDER,
        eventType: "oauth.disconnected",
        connectionId: connection.id,
        safeSummary: { remoteRevocationAttempted: Boolean(stored?.accessToken) },
      });
      res.json({ ok: true, changed });
    } catch (error) {
      logger.error("slack.disconnect failed", { reason: error instanceof Error ? error.name : "unknown" });
      res.status(500).json({ error: "slack_disconnect_failed" });
    }
  },
);

export function verifySlackSignature(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  signingSecret: string,
  now = Date.now(),
): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp) * 1_000) > 5 * 60 * 1_000) return false;
  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody.toString("utf8")}`)
    .digest("hex")}`;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(signature);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export class SlackEventDeduper {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = 10 * 60 * 1_000) {}

  claim(eventId: string, now = Date.now()): boolean {
    for (const [id, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(id);
    }
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, now);
    return true;
  }
}

export type SlackEventDecision =
  | { kind: "challenge"; challenge: unknown }
  | { kind: "duplicate" }
  | { kind: "accepted" };

export function classifySlackEvent(
  payload: Record<string, unknown>,
  deduper: SlackEventDeduper,
  now = Date.now(),
): SlackEventDecision {
  if (payload.type === "url_verification") {
    return { kind: "challenge", challenge: payload.challenge };
  }
  const eventId = typeof payload.event_id === "string" ? payload.event_id : "";
  if (!eventId || !deduper.claim(eventId, now)) return { kind: "duplicate" };
  return { kind: "accepted" };
}

export function createSlackEventsHandler(
  options: { signingSecret?: string; deduper?: SlackEventDeduper; now?: () => number } = {},
): RequestHandler {
  const deduper = options.deduper ?? new SlackEventDeduper();
  const now = options.now ?? Date.now;
  return (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signingSecret = options.signingSecret ?? env.SLACK_SIGNING_SECRET;
    if (!signingSecret || !verifySlackSignature(
      rawBody,
      stringValue(req.header("x-slack-request-timestamp")),
      stringValue(req.header("x-slack-signature")),
      signingSecret,
      now(),
    )) {
      res.status(401).json({ error: "invalid_signature" });
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    const decision = classifySlackEvent(payload, deduper, now());
    if (decision.kind === "challenge") {
      res.json({ challenge: decision.challenge });
      return;
    }
    if (decision.kind === "duplicate") {
      res.status(200).send();
      return;
    }
    // Events are delivery hints only. Provider content is deliberately ignored:
    // it cannot choose a tool, resolve a target, confirm, or cause a user-visible action.
    res.status(200).send();
  };
}

slackEventsRouter.post(
  "/v1/integrations/slack/events",
  express.raw({ type: "application/json", limit: "1mb" }),
  createSlackEventsHandler(),
);
