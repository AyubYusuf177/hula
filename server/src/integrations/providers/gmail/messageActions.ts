import {
  GmailError,
  getGmailConnection,
  gmailGetForConnection,
  gmailRequestForConnection,
} from "./client";
import type { FetchLike } from "./oauth";
import {
  MUTABLE_SYSTEM_LABELS,
  type NormalizedGmailLabel,
  type RawGmailMessage,
} from "./types";

/**
 * Gmail MESSAGE MANAGEMENT provider layer (Section 17 / Phase 3.5).
 *
 * The only functions that change a message's state: label changes (read/unread,
 * star, archive, user labels), trash, and untrash. Every call needs the
 * `gmail.modify` scope — verified against Google's per-method reference.
 *
 * Two hard limits, both deliberate:
 *  - There is NO permanent-delete function here, and there never should be.
 *    `messages.delete` bypasses the trash irrecoverably and needs the far broader
 *    `https://mail.google.com/`. Trash is always recoverable; that is the whole
 *    reason it is the only removal Hula offers.
 *  - Label ids are ALLOWLISTED or resolved from the user's real labels. A label id
 *    is never taken from model output, so nothing can move mail to SPAM or forge a
 *    system label.
 */

/** Resolve the connected connection id, or throw a safe `not_connected`. */
async function requireConnectionId(userId: string): Promise<string> {
  const connection = await getGmailConnection(userId);
  if (!connection || connection.status !== "connected") {
    throw new GmailError("not_connected", "Gmail is not connected");
  }
  return connection.id;
}

/** Cap on messages one management call may touch (bounded fan-out). */
export const MODIFY_BATCH_CAP = 10;

/**
 * PURE: validate label ids before they reach Gmail.
 *
 * A system label must be on the mutable allowlist; a user label id (Gmail issues
 * ids like `Label_12`) must look like an id we resolved from `listGmailLabels`.
 * Anything else is dropped — an unrecognised label is never guessed at, because
 * the failure mode (filing mail under the wrong label, or into SPAM) is silent.
 */
export function validateLabelIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = (raw ?? "").trim();
    if (!id) continue;
    if (MUTABLE_SYSTEM_LABELS.has(id)) {
      out.push(id);
      continue;
    }
    // User-created labels: Gmail's own id shape. Never free text.
    if (/^Label_[A-Za-z0-9_-]+$/.test(id)) out.push(id);
  }
  return [...new Set(out)];
}

/** The safe result of a label change — Gmail-confirmed state only. */
export interface ModifiedGmailMessage {
  id: string;
  labelIds: string[];
}

/**
 * Apply a label change to ONE message (POST /users/me/messages/{id}/modify).
 *
 * Success requires Gmail to echo back the message id — a 2xx with no id is not
 * evidence the change landed, so it throws rather than being reported as done.
 * The returned `labelIds` are Gmail's OWN post-change state, which is what the
 * caller reports from (never the labels we asked for).
 */
export async function modifyGmailMessageLabels(
  userId: string,
  messageId: string,
  change: { addLabelIds?: string[]; removeLabelIds?: string[] },
  fetchImpl?: FetchLike,
): Promise<ModifiedGmailMessage> {
  const connectionId = await requireConnectionId(userId);
  const addLabelIds = validateLabelIds(change.addLabelIds ?? []);
  const removeLabelIds = validateLabelIds(change.removeLabelIds ?? []);
  if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
    throw new GmailError("malformed_provider_response", "No valid label change requested");
  }

  const body: Record<string, string[]> = {};
  if (addLabelIds.length > 0) body.addLabelIds = addLabelIds;
  if (removeLabelIds.length > 0) body.removeLabelIds = removeLabelIds;

  const res = await gmailRequestForConnection<RawGmailMessage>(
    connectionId,
    "POST",
    `/users/me/messages/${encodeURIComponent(messageId)}/modify`,
    { body },
    fetchImpl,
  );
  const id = typeof res.id === "string" ? res.id : "";
  if (!id) {
    throw new GmailError("malformed_provider_response", "Gmail did not confirm the change");
  }
  if (id !== messageId) {
    // Gmail confirming a DIFFERENT message than we targeted must never be reported
    // as the requested change succeeding.
    throw new GmailError(
      "malformed_provider_response",
      "Gmail confirmed a different message than requested",
    );
  }
  return {
    id,
    labelIds: Array.isArray(res.labelIds)
      ? res.labelIds.filter((l): l is string => typeof l === "string")
      : [],
  };
}

/**
 * Move ONE message to the trash (POST /users/me/messages/{id}/trash).
 *
 * RECOVERABLE — Gmail keeps trashed mail for ~30 days, and `untrashGmailMessage`
 * restores it. This is the ONLY removal Hula performs; permanent deletion is not
 * implemented at any layer.
 */
export async function trashGmailMessage(
  userId: string,
  messageId: string,
  fetchImpl?: FetchLike,
): Promise<ModifiedGmailMessage> {
  return trashOp(userId, messageId, "trash", fetchImpl);
}

/** Restore ONE message from the trash (POST /users/me/messages/{id}/untrash). */
export async function untrashGmailMessage(
  userId: string,
  messageId: string,
  fetchImpl?: FetchLike,
): Promise<ModifiedGmailMessage> {
  return trashOp(userId, messageId, "untrash", fetchImpl);
}

async function trashOp(
  userId: string,
  messageId: string,
  op: "trash" | "untrash",
  fetchImpl?: FetchLike,
): Promise<ModifiedGmailMessage> {
  const connectionId = await requireConnectionId(userId);
  const res = await gmailRequestForConnection<RawGmailMessage>(
    connectionId,
    "POST",
    `/users/me/messages/${encodeURIComponent(messageId)}/${op}`,
    {},
    fetchImpl,
  );
  const id = typeof res.id === "string" ? res.id : "";
  if (!id) {
    throw new GmailError("malformed_provider_response", `Gmail did not confirm the ${op}`);
  }
  if (id !== messageId) {
    throw new GmailError(
      "malformed_provider_response",
      `Gmail confirmed a different message than requested`,
    );
  }
  return {
    id,
    labelIds: Array.isArray(res.labelIds)
      ? res.labelIds.filter((l): l is string => typeof l === "string")
      : [],
  };
}

/** The raw shape (subset) of a Gmail `labels.list` response. */
interface RawGmailLabelList {
  labels?: { id?: string; name?: string; type?: string }[];
}

/**
 * List the user's real Gmail labels (GET /users/me/labels).
 *
 * Read-only and satisfied by `gmail.readonly`, which every connection already has —
 * so label RESOLUTION works even on a connection that hasn't granted `gmail.modify`
 * yet. This is how a label name from the user ("Work") becomes a real Gmail label
 * id: we never invent one, and we never create a label that doesn't exist.
 */
export async function listGmailLabels(
  userId: string,
  fetchImpl?: FetchLike,
): Promise<NormalizedGmailLabel[]> {
  const connectionId = await requireConnectionId(userId);
  const data = await gmailGetForConnection<RawGmailLabelList>(
    connectionId,
    "/users/me/labels",
    {},
    fetchImpl,
  );
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const out: NormalizedGmailLabel[] = [];
  for (const l of labels) {
    const id = typeof l?.id === "string" ? l.id : "";
    const name = typeof l?.name === "string" ? l.name : "";
    if (!id || !name) continue;
    out.push({ id, name, type: typeof l.type === "string" ? l.type : null });
  }
  return out;
}

/**
 * PURE: find the user's label by name, case-insensitively.
 *
 * Returns null when no label matches — the caller then tells the user the label
 * doesn't exist rather than creating one. Creating labels silently would clutter a
 * real mailbox with typos ("Wrok").
 */
export function findLabelByName(
  labels: readonly NormalizedGmailLabel[],
  name: string,
): NormalizedGmailLabel | null {
  const target = (name ?? "").trim().toLowerCase();
  if (!target) return null;
  return labels.find((l) => l.name.toLowerCase() === target) ?? null;
}
