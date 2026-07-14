import {
  GmailError,
  getGmailConnection,
  gmailGetForConnection,
  gmailRequestForConnection,
} from "./client";
import type { FetchLike } from "./oauth";
import { normalizeGmailMessage } from "./messages";
import { validateLabelIds } from "./messageActions";
import type { NormalizedGmailMessage, RawGmailMessage } from "./types";

/**
 * Gmail THREAD layer (Section 17 correction).
 *
 * WHY THIS EXISTS. Real testing showed the product was message-centric while Gmail's
 * UI is conversation-centric, and the gap produced two visible bugs:
 *
 *  1. One Robert Ellis conversation appeared as four separate results, because four
 *     messages of one thread each became a row.
 *  2. "Unstar the first one" reported success while the conversation stayed starred.
 *     Gmail stars a MESSAGE; the conversation row shows a star while ANY message in
 *     it is starred. Unstarring the one message we happened to resolve left the
 *     others starred, so the user saw no change — and we claimed success anyway.
 *
 * So the unit a user points at is the THREAD. This module owns that: it collapses
 * messages into conversations for display, and it performs conversation-level
 * mutations against Gmail's own thread endpoints.
 *
 * Reads stay metadata-only and bounded, exactly like the message layer.
 */

/** The raw shape (subset) of a Gmail `threads.get` response. */
interface RawGmailThread {
  id?: string;
  messages?: RawGmailMessage[];
}

/**
 * One conversation, as the user perceives it.
 *
 * `latest` is the message that represents the thread everywhere: display, summary,
 * and the star target. Gmail shows the newest message's sender/subject on the
 * conversation row, so anything else would describe a row the user cannot see.
 */
export interface GmailThreadRef {
  threadId: string;
  /** The newest message in the thread — what the conversation row shows. */
  latest: NormalizedGmailMessage;
  /** How many retrieved messages belong to this conversation (>= 1). */
  messageCount: number;
  /** True when ANY message is unread — Gmail bolds the row on the same rule. */
  unread: boolean;
  /** True when ANY message carries IMPORTANT. */
  important: boolean;
  /** Union of safe labels across the thread's retrieved messages. */
  labels: string[];
}

/** PURE: newest-first comparison by received time (unknown times sort last). */
function byNewest(a: NormalizedGmailMessage, b: NormalizedGmailMessage): number {
  const ta = a.receivedAt ? Date.parse(a.receivedAt) : 0;
  const tb = b.receivedAt ? Date.parse(b.receivedAt) : 0;
  return tb - ta;
}

/**
 * PURE: collapse messages into unique conversations, newest first.
 *
 * This is the fix for "one thread shown four times". Grouping is by REAL Gmail
 * threadId — never by subject, which would merge unrelated mail that happens to
 * share a subject line ("Invoice"). A message with no threadId is its own
 * conversation rather than being dropped or merged into a bucket.
 */
export function dedupeToThreads(
  messages: readonly NormalizedGmailMessage[],
): GmailThreadRef[] {
  const groups = new Map<string, NormalizedGmailMessage[]>();
  for (const message of messages) {
    // No threadId -> the message stands alone. Keyed by its own id so two such
    // messages never collapse into one another.
    const key = message.threadId || `message:${message.id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(message);
    else groups.set(key, [message]);
  }

  const refs: GmailThreadRef[] = [];
  for (const [key, bucket] of groups) {
    const ordered = [...bucket].sort(byNewest);
    const latest = ordered[0];
    if (!latest) continue;
    refs.push({
      threadId: latest.threadId || key,
      latest,
      messageCount: ordered.length,
      // Gmail treats a conversation as unread/important if ANY message is.
      unread: ordered.some((m) => m.unread),
      important: ordered.some((m) => m.important),
      labels: [...new Set(ordered.flatMap((m) => m.labels))],
    });
  }
  return refs.sort((a, b) => byNewest(a.latest, b.latest));
}

// --- Provider: thread state (READ) ---------------------------------------

/**
 * The RAW label state of one conversation — every message and its labels.
 *
 * Deliberately raw: `NormalizedGmailMessage` drops labels outside the safe display
 * allowlist (TRASH among them), which is exactly what postcondition verification
 * needs to see. Verification asks "did Gmail really end up in the expected state?",
 * so it must read Gmail's own labels, not our display projection.
 */
export interface GmailThreadState {
  threadId: string;
  messages: { id: string; labelIds: string[] }[];
}

/** Resolve the connected connection id, or throw a safe `not_connected`. */
async function requireConnectionId(userId: string): Promise<string> {
  const connection = await getGmailConnection(userId);
  if (!connection || connection.status !== "connected") {
    throw new GmailError("not_connected", "Gmail is not connected");
  }
  return connection.id;
}

/** PURE: project a raw thread payload into its label state. */
function toThreadState(raw: RawGmailThread, threadId: string): GmailThreadState {
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  return {
    threadId: typeof raw.id === "string" && raw.id ? raw.id : threadId,
    messages: messages
      .map((m) => ({
        id: typeof m?.id === "string" ? m.id : "",
        labelIds: Array.isArray(m?.labelIds)
          ? m.labelIds.filter((l): l is string => typeof l === "string")
          : [],
      }))
      .filter((m) => m.id.length > 0),
  };
}

/**
 * Fetch ONE conversation's label state (GET /users/me/threads/{id}).
 *
 * `format=minimal` returns ids + labelIds and no headers or body — everything
 * verification needs and nothing it doesn't.
 */
export async function fetchGmailThreadState(
  userId: string,
  threadId: string,
  fetchImpl?: FetchLike,
): Promise<GmailThreadState> {
  const connectionId = await requireConnectionId(userId);
  const raw = await gmailGetForConnection<RawGmailThread>(
    connectionId,
    `/users/me/threads/${encodeURIComponent(threadId)}`,
    { format: "minimal" },
    fetchImpl,
  );
  const state = toThreadState(raw, threadId);
  if (state.messages.length === 0) {
    throw new GmailError("malformed_provider_response", "Gmail returned no messages for the thread");
  }
  return state;
}

/**
 * Fetch ONE conversation's messages as normalized metadata (GET threads/{id}).
 *
 * Used to resolve the newest message of a thread for display or as a star target.
 */
export async function fetchGmailThreadMessages(
  userId: string,
  threadId: string,
  fetchImpl?: FetchLike,
): Promise<NormalizedGmailMessage[]> {
  const connectionId = await requireConnectionId(userId);
  const raw = await gmailGetForConnection<RawGmailThread>(
    connectionId,
    `/users/me/threads/${encodeURIComponent(threadId)}`,
    { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] },
    fetchImpl,
  );
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  return messages.map(normalizeGmailMessage).sort(byNewest);
}

// --- Provider: thread mutations (WRITE) ----------------------------------

/**
 * Apply a label change to a whole CONVERSATION (POST threads/{id}/modify).
 *
 * Gmail applies the change to every message in the thread, which is precisely what
 * the conversation-level actions need: removing STARRED here clears every star the
 * row could be showing, where the old per-message call left the others behind.
 *
 * Label ids go through the same allowlist as the message path — a label id is never
 * taken from model output.
 */
export async function modifyGmailThreadLabels(
  userId: string,
  threadId: string,
  change: { addLabelIds?: string[]; removeLabelIds?: string[] },
  fetchImpl?: FetchLike,
): Promise<GmailThreadState> {
  const connectionId = await requireConnectionId(userId);
  const addLabelIds = validateLabelIds(change.addLabelIds ?? []);
  const removeLabelIds = validateLabelIds(change.removeLabelIds ?? []);
  if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
    throw new GmailError("malformed_provider_response", "No valid label change requested");
  }

  const body: Record<string, string[]> = {};
  if (addLabelIds.length > 0) body.addLabelIds = addLabelIds;
  if (removeLabelIds.length > 0) body.removeLabelIds = removeLabelIds;

  const res = await gmailRequestForConnection<RawGmailThread>(
    connectionId,
    "POST",
    `/users/me/threads/${encodeURIComponent(threadId)}/modify`,
    { body },
    fetchImpl,
  );
  return confirmThread(res, threadId, "change");
}

/** Move a whole conversation to the trash (POST threads/{id}/trash). RECOVERABLE. */
export async function trashGmailThread(
  userId: string,
  threadId: string,
  fetchImpl?: FetchLike,
): Promise<GmailThreadState> {
  return threadTrashOp(userId, threadId, "trash", fetchImpl);
}

/** Restore a whole conversation from the trash (POST threads/{id}/untrash). */
export async function untrashGmailThread(
  userId: string,
  threadId: string,
  fetchImpl?: FetchLike,
): Promise<GmailThreadState> {
  return threadTrashOp(userId, threadId, "untrash", fetchImpl);
}

async function threadTrashOp(
  userId: string,
  threadId: string,
  op: "trash" | "untrash",
  fetchImpl?: FetchLike,
): Promise<GmailThreadState> {
  const connectionId = await requireConnectionId(userId);
  const res = await gmailRequestForConnection<RawGmailThread>(
    connectionId,
    "POST",
    `/users/me/threads/${encodeURIComponent(threadId)}/${op}`,
    {},
    fetchImpl,
  );
  return confirmThread(res, threadId, op);
}

/**
 * Gmail must echo back the thread we targeted. A 2xx confirming a DIFFERENT thread
 * is never treated as our change succeeding — that is how the wrong conversation
 * gets reported as done.
 */
function confirmThread(raw: RawGmailThread, threadId: string, op: string): GmailThreadState {
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) {
    throw new GmailError("malformed_provider_response", `Gmail did not confirm the ${op}`);
  }
  if (id !== threadId) {
    throw new GmailError(
      "malformed_provider_response",
      "Gmail confirmed a different thread than requested",
    );
  }
  return toThreadState(raw, threadId);
}
