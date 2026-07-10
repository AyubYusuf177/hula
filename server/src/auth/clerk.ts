import { verifyToken } from "@clerk/backend";
import type { RequestHandler } from "express";

import { env } from "../config/env";
import { logger } from "../utils/logger";

/**
 * Server-only Clerk authentication.
 *
 * The mobile app sends a short-lived Clerk session JWT in the
 * `Authorization: Bearer <token>` header. We verify it here with the
 * server-only `CLERK_SECRET_KEY` and read the Clerk user id from the `sub`
 * claim. The secret is never logged and never leaves the backend.
 */

/** True only when the Clerk secret is configured. */
export function isClerkConfigured(): boolean {
  return Boolean(env.CLERK_SECRET_KEY);
}

/** Pull the raw bearer token from an Authorization header, if present. */
function readBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

/**
 * Verify a Clerk session token and return the Clerk user id (`sub`). Returns
 * `null` on any failure (missing secret, invalid/expired token). Never throws
 * and never logs the token or the secret.
 */
export async function verifyClerkUserId(
  token: string,
): Promise<string | null> {
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
    });
    return typeof payload.sub === "string" && payload.sub.length > 0
      ? payload.sub
      : null;
  } catch {
    // Do not log the token or the underlying error detail (may echo the token).
    return null;
  }
}

/**
 * Express middleware that requires a valid Clerk session token. On success it
 * attaches `req.clerkUserId` for downstream handlers; otherwise it responds
 * with 401 (or 503 when the server has no Clerk secret configured).
 */
export const requireClerkAuth: RequestHandler = async (req, res, next) => {
  if (!isClerkConfigured()) {
    logger.error("clerk.auth secret not configured");
    res.status(503).json({ error: "auth_not_configured" });
    return;
  }

  const token = readBearerToken(req.header("authorization"));
  if (!token) {
    res.status(401).json({ error: "missing_bearer_token" });
    return;
  }

  const clerkUserId = await verifyClerkUserId(token);
  if (!clerkUserId) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  req.clerkUserId = clerkUserId;
  next();
};
