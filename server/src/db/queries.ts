import type { BrainMessage } from "../ai/hulaBrain";
import { getOrCreateUserByClerkId } from "../users/store";
import { getPrisma } from "./prisma";

/**
 * Read-side query helpers for the authenticated inspection endpoints (Section 5).
 *
 * These power `GET /v1/me/messages` and `GET /v1/me/conversations`. They only
 * ever return rows that belong to the authenticated Hula user (scoped by the
 * internal `User.id` resolved from the Clerk user id) and they only select
 * safe, inspection-friendly fields — never raw provider payloads or secrets.
 */

/** Default number of messages returned when no limit is supplied. */
export const DEFAULT_MESSAGE_LIMIT = 50;
/** Hard cap on how many messages a single request may return. */
export const MAX_MESSAGE_LIMIT = 100;

/** Newest-first (`desc`) or oldest-first (`asc`) ordering by `createdAt`. */
export type MessageOrder = "asc" | "desc";

/**
 * Turn an untrusted `limit` query value into a safe integer in
 * `[1, MAX_MESSAGE_LIMIT]`. Missing, non-numeric, zero, and negative values
 * fall back to `DEFAULT_MESSAGE_LIMIT`; anything larger than the max is clamped
 * down. Pure and side-effect free so it can be unit tested without a database.
 */
export function clampMessageLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MESSAGE_LIMIT;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MESSAGE_LIMIT;
  return Math.min(n, MAX_MESSAGE_LIMIT);
}

/** Normalize an untrusted `order` query value; defaults to newest-first. */
export function parseMessageOrder(raw: string | undefined): MessageOrder {
  return raw?.trim().toLowerCase() === "asc" ? "asc" : "desc";
}

/** A single message as exposed by the inspection endpoint. Safe fields only. */
export interface MessageView {
  id: string;
  direction: "inbound" | "outbound";
  channel: string;
  provider: string;
  text: string | null;
  status: string | null;
  conversationId: string | null;
  createdAt: string; // ISO 8601
}

/** A conversation summary as exposed by the inspection endpoint. */
export interface ConversationView {
  id: string;
  channel: string;
  provider: string;
  messageCount: number;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/**
 * Return the authenticated user's most recent messages. Finds (or creates on
 * first sight) the Hula user for the Clerk id, then queries ONLY that user's
 * messages. Results are ordered by `createdAt` (newest first by default).
 */
export async function listRecentMessagesForUser(params: {
  clerkUserId: string;
  limit: number;
  order: MessageOrder;
}): Promise<MessageView[]> {
  const user = await getOrCreateUserByClerkId(params.clerkUserId);

  const rows = await getPrisma().message.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: params.order },
    take: params.limit,
    select: {
      id: true,
      direction: true,
      channel: true,
      provider: true,
      text: true,
      status: true,
      conversationId: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    channel: row.channel,
    provider: row.provider,
    text: row.text,
    status: row.status,
    conversationId: row.conversationId,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Default number of recent turns loaded as short-term memory for the brain. */
export const DEFAULT_BRAIN_HISTORY_LIMIT = 16;

/** A stored message row as needed to build brain history. */
interface BrainMessageRow {
  direction: "inbound" | "outbound";
  text: string | null;
}

/**
 * Pure: map stored rows to oldest-first brain turns. Inbound → `user`,
 * outbound → `assistant`; rows with no text are dropped. `rows` are expected
 * newest-first (as queried) and are reversed so the result ends with the most
 * recent turn. Pure and DB-free so it can be unit tested.
 */
export function mapRowsToBrainMessages(rows: BrainMessageRow[]): BrainMessage[] {
  const result: BrainMessage[] = [];
  // Reverse into oldest-first order for the model.
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row) continue;
    const text = row.text?.trim();
    if (!text) continue;
    result.push({
      role: row.direction === "inbound" ? "user" : "assistant",
      text,
    });
  }
  return result;
}

/**
 * Load the most recent turns for a conversation as short-term memory for the
 * brain. Returns oldest-first turns (ending with the latest message). Scoped to
 * a single conversation so no other thread's content can leak in.
 */
export async function listRecentBrainMessages(
  conversationId: string,
  limit: number = DEFAULT_BRAIN_HISTORY_LIMIT,
): Promise<BrainMessage[]> {
  const rows = await getPrisma().message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { direction: true, text: true },
  });
  return mapRowsToBrainMessages(rows);
}

/**
 * Return the authenticated user's conversations with a message count each.
 * Ordered by most recently active first. Scoped to the user's own rows only.
 */
export async function listConversationsForUser(params: {
  clerkUserId: string;
  limit: number;
}): Promise<ConversationView[]> {
  const user = await getOrCreateUserByClerkId(params.clerkUserId);

  const rows = await getPrisma().conversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: params.limit,
    select: {
      id: true,
      channel: true,
      provider: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    provider: row.provider,
    messageCount: row._count.messages,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}
