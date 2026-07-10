import { Router } from "express";

import { requireClerkAuth } from "../auth/clerk";
import { env } from "../config/env";
import { buildLinkMessageBody, createLinkSession } from "../users/linkSessions";
import { logger } from "../utils/logger";

/**
 * Link session routes.
 *
 * POST /v1/link-sessions creates a short-lived one-time connect code for the
 * signed-in Clerk user and returns everything the app needs to open a prefilled
 * iMessage compose to the Hula line. Requires a valid Clerk session token.
 */
export const linkSessionsRouter = Router();

/** Fallback Hula line if the env value isn't configured (matches Section 3). */
const DEFAULT_HULA_NUMBER = "+16465480761";

interface LinkSessionRequestBody {
  /** Optional display hint only — NEVER trusted for identity. */
  firstName?: string;
  displayName?: string;
}

/** First non-empty of firstName / first word of displayName, trimmed. */
function pickFirstName(body: LinkSessionRequestBody): string | undefined {
  const first = body.firstName?.trim();
  if (first) return first;
  const display = body.displayName?.trim();
  if (display) return display.split(/\s+/)[0];
  return undefined;
}

linkSessionsRouter.post(
  "/v1/link-sessions",
  requireClerkAuth,
  (req, res) => {
    // `requireClerkAuth` guarantees this is set on success.
    const clerkUserId = req.clerkUserId as string;

    const body = (req.body ?? {}) as LinkSessionRequestBody;
    const firstName = pickFirstName(body);

    const session = createLinkSession(clerkUserId);
    const hulaNumber = env.SENDBLUE_HULA_NUMBER ?? DEFAULT_HULA_NUMBER;
    const messageBody = buildLinkMessageBody(session.code, firstName);

    // Log the creation without exposing the user id, code, or number.
    logger.info("link-session created", {
      hasFirstName: Boolean(firstName),
      expiresInMs: session.expiresAt - session.createdAt,
    });

    res.status(201).json({
      code: session.code,
      hulaNumber,
      messageBody,
    });
  },
);
