/**
 * Pending link sessions for the "Text Hula" connect flow.
 *
 * Flow:
 *   1. Signed-in app user taps "Text hula".
 *   2. Backend creates a pending LinkSession with a short one-time code.
 *   3. App opens iMessage to the Hula number prefilled with a natural message
 *      that embeds the code (e.g. "Hey Hula, it's Ayub. Connect my account:
 *      HULA-8K2Q").
 *   4. User sends it; the Sendblue webhook receives the inbound message.
 *   5. Backend extracts the code, links the sender handle to the Clerk user,
 *      and marks the code used.
 *
 * Section 3: IN-MEMORY ONLY. Codes expire (~10 min) and are single-use. Moves to
 * Postgres in Section 4. Do not add a database here.
 */

/** Prefix on every generated code, e.g. "HULA-8K2Q". */
const CODE_PREFIX = "HULA-";

/** Number of random characters after the prefix. */
const CODE_LENGTH = 4;

/**
 * Unambiguous alphabet (no 0/O/1/I) so a user glancing at the prefilled message
 * never sees a confusing code. Only ever set by the app, but kept friendly.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Codes are valid for 10 minutes after creation. */
const CODE_TTL_MS = 10 * 60 * 1000;

export interface LinkSession {
  /** Full code including prefix, e.g. "HULA-8K2Q". */
  code: string;
  clerkUserId: string;
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms
  used: boolean;
}

/** In-memory store keyed by the full uppercase code. */
const sessionsByCode = new Map<string, LinkSession>();

function randomCode(): string {
  let body = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const idx = Math.floor(Math.random() * CODE_ALPHABET.length);
    body += CODE_ALPHABET[idx];
  }
  return `${CODE_PREFIX}${body}`;
}

/** Drop expired sessions so the map can't grow without bound. */
function sweepExpired(now: number): void {
  for (const [code, session] of sessionsByCode) {
    if (session.expiresAt <= now) sessionsByCode.delete(code);
  }
}

/**
 * Create and store a pending link session for a verified Clerk user. The code is
 * unique among currently-active sessions.
 */
export function createLinkSession(clerkUserId: string): LinkSession {
  const now = Date.now();
  sweepExpired(now);

  let code = randomCode();
  while (sessionsByCode.has(code)) code = randomCode();

  const session: LinkSession = {
    code,
    clerkUserId,
    createdAt: now,
    expiresAt: now + CODE_TTL_MS,
    used: false,
  };
  sessionsByCode.set(code, session);
  return session;
}

/**
 * Build the natural, prefilled first message. The app never asks the user to
 * type the code — it is embedded here and sent as-is.
 *
 *   "Hey Hula, it's Ayub. Connect my account: HULA-8K2Q"
 *   "Hey Hula, it's me. Connect my account: HULA-8K2Q"  (no first name)
 */
export function buildLinkMessageBody(
  code: string,
  firstName?: string,
): string {
  const who = firstName?.trim() ? firstName.trim() : "me";
  return `Hey Hula, it's ${who}. Connect my account: ${code}`;
}

/**
 * Find the first Hula link code inside an inbound message, normalized to
 * uppercase. Returns `undefined` when no code-shaped token is present.
 */
export function extractLinkCode(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = new RegExp(
    `${CODE_PREFIX}[${CODE_ALPHABET}]{${CODE_LENGTH}}`,
    "i",
  ).exec(text);
  return match ? match[0].toUpperCase() : undefined;
}

/**
 * Return a still-valid (not expired, not used) session for a code, or
 * `undefined`. Does NOT consume it — the caller decides whether to link.
 */
export function getValidLinkSession(code: string): LinkSession | undefined {
  const session = sessionsByCode.get(code.toUpperCase());
  if (!session) return undefined;
  if (session.used) return undefined;
  if (session.expiresAt <= Date.now()) {
    sessionsByCode.delete(session.code);
    return undefined;
  }
  return session;
}

/** Mark a code as used so it can never link again. */
export function markLinkCodeUsed(code: string): void {
  const session = sessionsByCode.get(code.toUpperCase());
  if (session) session.used = true;
}

/** Test/util only: clear all pending sessions. */
export function _resetLinkSessions(): void {
  sessionsByCode.clear();
}
