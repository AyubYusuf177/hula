import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import type { SendblueOutboundResponse } from "./types";

/**
 * Minimal Sendblue REST client.
 *
 * Wraps the three endpoints Section 2 needs: send a message, send a typing
 * indicator, and mark a thread read. Uses the global `fetch` (Node 18+) so no
 * HTTP dependency is added. Secrets come from validated env and are NEVER
 * logged. Typing/read calls are best-effort and their failures are swallowed;
 * send failures are surfaced (thrown) so the caller can log them safely.
 */

const SENDBLUE_BASE_URL = "https://api.sendblue.co/api";

const ENDPOINTS = {
  sendMessage: `${SENDBLUE_BASE_URL}/send-message`,
  typingIndicator: `${SENDBLUE_BASE_URL}/send-typing-indicator`,
  markRead: `${SENDBLUE_BASE_URL}/mark-read`,
} as const;

/** Build auth headers. Never log these. */
function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": env.SENDBLUE_API_KEY ?? "",
    "sb-api-secret-key": env.SENDBLUE_API_SECRET ?? "",
  };
}

/** True only when both Sendblue credentials are configured. */
export function isSendblueConfigured(): boolean {
  return Boolean(env.SENDBLUE_API_KEY && env.SENDBLUE_API_SECRET);
}

/**
 * Include Hula's dedicated line as `from_number` when configured. Sendblue
 * requires it on send/typing/mark-read for multi-number accounts.
 */
function withFromNumber(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return env.SENDBLUE_HULA_NUMBER
    ? { ...body, from_number: env.SENDBLUE_HULA_NUMBER }
    : body;
}

/**
 * POST JSON to a Sendblue endpoint. Returns the parsed JSON body on a 2xx and
 * throws a redacted Error otherwise. The thrown message never includes headers,
 * credentials, or the full recipient handle.
 */
async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  if (!isSendblueConfigured()) {
    throw new Error("Sendblue credentials are not configured");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // Read a short snippet of the body for diagnostics without dumping secrets.
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      detail = "<unreadable body>";
    }
    throw new Error(`Sendblue request failed (${res.status}): ${detail}`);
  }

  try {
    return (await res.json()) as T;
  } catch {
    // Some endpoints (typing, mark-read) may return an empty body.
    return {} as T;
  }
}

/** Mask a handle for logs: keep only the last 4 characters. */
function maskHandle(handle: string): string {
  if (handle.length <= 4) return "****";
  return `****${handle.slice(-4)}`;
}

/**
 * Send a text message from Hula's dedicated line to `to`.
 * Throws on failure — callers should catch and log safely.
 */
export async function sendMessage(
  to: string,
  content: string,
): Promise<SendblueOutboundResponse> {
  const response = await postJson<SendblueOutboundResponse>(
    ENDPOINTS.sendMessage,
    withFromNumber({ number: to, content }),
  );

  logger.info("sendblue.sendMessage ok", {
    to: maskHandle(to),
    status: response.status,
  });
  return response;
}

/**
 * Send a typing indicator to `to`. Best-effort: Sendblue only honors this when
 * a recent conversation exists, so failures are logged and swallowed.
 */
export async function sendTypingIndicator(to: string): Promise<void> {
  try {
    await postJson(ENDPOINTS.typingIndicator, withFromNumber({ number: to }));
  } catch (err) {
    logger.warn("sendblue.sendTypingIndicator skipped", {
      to: maskHandle(to),
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}

/**
 * Mark the thread with `to` as read. Best-effort: read receipts may require
 * Sendblue account activation, so failures are logged and swallowed.
 */
export async function markRead(to: string): Promise<void> {
  try {
    await postJson(ENDPOINTS.markRead, withFromNumber({ number: to }));
  } catch (err) {
    logger.warn("sendblue.markRead skipped", {
      to: maskHandle(to),
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}
