import { getPrisma } from "../db/prisma";
import { getOrCreateUserByClerkId } from "./store";

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
 *   5. Backend extracts the code, links the sender handle to the user, and
 *      marks the code used.
 *
 * Section 4: DATABASE-BACKED via Prisma. Sessions now survive a backend restart.
 * Codes expire (~10 min) and are single-use. The pure helpers below
 * (`buildLinkMessageBody`, `extractLinkCode`) do NOT touch the database.
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

/** A pending/used link session as returned to callers. */
export interface LinkSession {
  /** Full code including prefix, e.g. "HULA-8K2Q". */
  code: string;
  /** Internal Hula user id that owns this session. */
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

function randomCode(): string {
  let body = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const idx = Math.floor(Math.random() * CODE_ALPHABET.length);
    body += CODE_ALPHABET[idx];
  }
  return `${CODE_PREFIX}${body}`;
}

/** Generate a code not already present in the database. */
async function generateUniqueCode(): Promise<string> {
  const prisma = getPrisma();
  // Collisions are astronomically unlikely (~1M combos), but never reuse a code.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomCode();
    const existing = await prisma.linkSession.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!existing) return code;
  }
  // Extremely unlikely fallback: append the clock to guarantee uniqueness.
  return `${randomCode()}${Date.now().toString(36).toUpperCase().slice(-2)}`;
}

/**
 * Create and store a pending link session for a Clerk user. Ensures the Hula
 * user exists first, then persists a fresh one-time code.
 */
export async function createLinkSession(
  clerkUserId: string,
): Promise<LinkSession> {
  const user = await getOrCreateUserByClerkId(clerkUserId);
  const code = await generateUniqueCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  const session = await getPrisma().linkSession.create({
    data: {
      code,
      userId: user.id,
      status: "pending",
      expiresAt,
    },
    select: { code: true, userId: true, createdAt: true, expiresAt: true },
  });

  return {
    code: session.code,
    userId: session.userId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
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
 * Return a still-valid (pending, not expired) session for a code, or
 * `undefined`. Does NOT consume it — the caller decides whether to link.
 */
export async function getValidLinkSession(
  code: string,
): Promise<LinkSession | undefined> {
  const session = await getPrisma().linkSession.findUnique({
    where: { code: code.toUpperCase() },
    select: {
      code: true,
      userId: true,
      status: true,
      createdAt: true,
      expiresAt: true,
    },
  });
  if (!session) return undefined;
  if (session.status !== "pending") return undefined;
  if (session.expiresAt.getTime() <= Date.now()) return undefined;
  return {
    code: session.code,
    userId: session.userId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

/** Mark a code as used so it can never link again. */
export async function markLinkCodeUsed(code: string): Promise<void> {
  await getPrisma().linkSession.updateMany({
    where: { code: code.toUpperCase(), status: "pending" },
    data: { status: "used", usedAt: new Date() },
  });
}
