import { getPrisma } from "../../../db/prisma";
import { logger } from "../../../utils/logger";
import { readCredentialSecrets, updateAccessToken } from "../../credentials";
import {
  getGoogleOAuthConfig,
  refreshAccessToken,
  type FetchLike,
} from "./oauth";
import { GOOGLE_CALENDAR_PROVIDER } from "./types";

/**
 * Google Calendar client plumbing (Section 11) — READ-ONLY.
 *
 * Resolves a user's connection, hands out a VALID access token (refreshing it
 * server-side when it is close to expiry), and performs authenticated GET calls
 * against the Calendar API. Tokens never leave the backend and are never logged.
 */

/** Refresh a little before the token actually expires to avoid edge failures. */
const EXPIRY_SKEW_MS = 60 * 1000;

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Machine-readable failure reasons, safe to log/return. */
export type GoogleCalendarErrorReason =
  | "not_connected"
  | "expired"
  | "no_refresh_token"
  | "request_failed";

/** A safe error for calendar reads. Never carries token material. */
export class GoogleCalendarError extends Error {
  reason: GoogleCalendarErrorReason;
  constructor(reason: GoogleCalendarErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "GoogleCalendarError";
    this.reason = reason;
  }
}

/** A connected Google Calendar connection for a user (id + status only). */
export interface GoogleCalendarConnectionRef {
  id: string;
  status: string;
}

/** Find a user's Google Calendar connection row, or null. No tokens read. */
export async function getGoogleCalendarConnection(
  userId: string,
): Promise<GoogleCalendarConnectionRef | null> {
  const row = await getPrisma().integrationConnection.findUnique({
    where: {
      userId_provider: { userId, provider: GOOGLE_CALENDAR_PROVIDER },
    },
    select: { id: true, status: true },
  });
  return row ?? null;
}

/** Mark a connection unhealthy (expired/error) after a token failure. */
async function markConnection(
  connectionId: string,
  status: "expired" | "error",
): Promise<void> {
  try {
    await getPrisma().integrationConnection.update({
      where: { id: connectionId },
      data: { status },
    });
  } catch (err) {
    logger.error("googleCalendar.markConnection failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}

/**
 * Return a currently-valid access token for a connection, refreshing it if it is
 * missing/expired. SERVER-ONLY — the returned token must never leave the backend.
 *
 * On a refresh failure (or no refresh token available for an expired access
 * token) the connection is marked `expired` and a `GoogleCalendarError` is thrown.
 */
export async function getValidGoogleCalendarAccessToken(
  connectionId: string,
  fetchImpl?: FetchLike,
): Promise<string> {
  const secrets = await readCredentialSecrets(connectionId);
  if (!secrets || (!secrets.accessToken && !secrets.refreshToken)) {
    throw new GoogleCalendarError("not_connected", "No stored Google credentials");
  }

  const expiresAt = secrets.accessTokenExpiresAt?.getTime() ?? 0;
  const stillValid =
    secrets.accessToken && expiresAt > Date.now() + EXPIRY_SKEW_MS;
  if (stillValid && secrets.accessToken) return secrets.accessToken;

  // Need a refresh. Without a refresh token there's nothing we can do.
  if (!secrets.refreshToken) {
    await markConnection(connectionId, "expired");
    throw new GoogleCalendarError(
      "no_refresh_token",
      "Access token expired and no refresh token is stored",
    );
  }

  try {
    const config = getGoogleOAuthConfig();
    const refreshed = await refreshAccessToken({
      config,
      refreshToken: secrets.refreshToken,
      fetchImpl,
    });
    const newExpiry = refreshed.expiresIn
      ? new Date(Date.now() + refreshed.expiresIn * 1000)
      : null;
    await updateAccessToken(connectionId, refreshed.accessToken, newExpiry);
    return refreshed.accessToken;
  } catch (err) {
    await markConnection(connectionId, "expired");
    // Redacted — never surface the underlying token/secret detail.
    logger.error("googleCalendar.refresh failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    throw new GoogleCalendarError("expired", "Failed to refresh Google access token");
  }
}

/**
 * Authenticated GET against the Google Calendar API. Returns parsed JSON. Throws
 * `GoogleCalendarError("request_failed")` on a non-2xx response (no token in the
 * message). `fetchImpl` is injectable for tests.
 */
export async function googleCalendarGet<T>(
  accessToken: string,
  path: string,
  query: Record<string, string>,
  fetchImpl?: FetchLike,
): Promise<T> {
  const doFetch = fetchImpl ?? (fetch as unknown as FetchLike);
  const qs = new URLSearchParams(query).toString();
  const url = `${GOOGLE_CALENDAR_API}${path}${qs ? `?${qs}` : ""}`;

  const res = await doFetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
    body: "",
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      detail = "<unreadable body>";
    }
    throw new GoogleCalendarError(
      "request_failed",
      `Google Calendar request failed (${res.status}): ${detail}`,
    );
  }
  return JSON.parse(await res.text()) as T;
}
