import {
  createActionProposal,
  listRecentProposalsByAction,
  type ActionProposalView,
  type CreateProposalInput,
} from "../../../actions/proposals";
import { GMAIL_PROVIDER } from "./types";
import type { GmailMutationAction } from "./gmailVerify";

/**
 * Gmail ENTITY CONTEXT (Section 17 correction).
 *
 * WHY THIS EXISTS. From the real transcript:
 *
 *   User: "Star the second one"     Hula: "Starred 1 email."
 *   User: "Now unstar it"           Hula: "Which email do you mean?"
 *
 * Hula remembered the numbered LIST it had shown, and nothing else. So "it" — the
 * thing it had just acted on, one message earlier — resolved to nothing. A person
 * would never lose that thread of the conversation, and the user is right to read it
 * as broken.
 *
 * A numbered list and "the email you just starred" are DIFFERENT memories with
 * different lifetimes, and conflating them is what produced the failure:
 *
 *  - `gmailSelection` (separate module) remembers the ordered result set, so "the
 *    second one" keeps meaning position 2 of the list on screen.
 *  - THIS module remembers the entity the conversation is ABOUT: the one explicitly
 *    picked, and the one an action VERIFIABLY landed on. That is what "it", "that
 *    email", "the one you just starred" and "undo that" resolve against.
 *
 * The `acted` entry is written ONLY after a postcondition-verified mutation. An
 * unverified or failed action leaves it untouched, so "undo that" can never reverse
 * something that never happened.
 *
 * Storage REUSES the Section 12 proposal store (as `gmailSelection` and
 * `gmailDraftContext` already do) rather than adding another persistence mechanism:
 * one `confirmationRequired:false` row under a dedicated pseudo `actionId`, which
 * keeps it invisible to the yes/no confirmation flow and survives a process restart.
 * The payload carries safe identifiers and display labels only — never a body.
 */

/** The pseudo action id under which entity context is persisted. */
export const GMAIL_ENTITY_CONTEXT_ACTION_ID = "email.entityContext" as const;

/**
 * How long the conversation stays "about" an entity.
 *
 * Longer than the 30-minute result-set window on purpose: "unstar it" or "undo that"
 * arrives in the flow of conversation, but a user may also come back after a
 * meeting. Two hours is long enough to be useful and short enough that a stale "it"
 * cannot silently mutate the wrong email — after it lapses, we ask.
 */
export const ENTITY_CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;

/** The identity of one Gmail conversation, as safe identifiers + display labels. */
export interface GmailEntityRef {
  /** The Gmail thread — the conversation the user sees. */
  threadId: string;
  /** The message that represents it (newest at the time we resolved it). */
  messageId: string;
  /** Display label: the sender. Never content. */
  label: string;
  subject: string;
}

/** An action that VERIFIABLY landed, plus what it proved. */
export interface GmailActedEntity {
  entity: GmailEntityRef;
  action: GmailMutationAction;
  /** The user's real label id, for add_label/remove_label. */
  labelId: string | null;
  /** The user-facing label name, for a truthful reply ("the Work label"). */
  labelName: string | null;
  /** ISO instant the action was verified. */
  at: string;
}

/** The safe, redacted payload describing the conversation's current subject. */
export interface GmailEntityContextData {
  kind: "gmail_entity_context";
  /** The entity the user explicitly picked ("the second one"), when they did. */
  selected: GmailEntityRef | null;
  /** The entity an action verifiably landed on. Only ever written after proof. */
  acted: GmailActedEntity | null;
}

/** A loaded context row. */
export interface LoadedGmailEntityContext {
  id: string;
  data: GmailEntityContextData;
  createdAt: string;
}

// --- Reference detection (PURE) ------------------------------------------

/**
 * PURE: does this message point at the entity we just ACTED on?
 *
 * "the one you just starred", "undo that", "the email you just archived". These are
 * distinct from "the second one" (a position) and from a bare "it" (which resolves
 * by priority, not by naming the action).
 */
export function referencesLastActed(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  // "the one you just starred" / "the email you just archived" — an explicit
  // reference to our own last action.
  if (/\byou\s+(?:just|already)\s+\w+/.test(t)) return true;
  if (/\bundo\b/.test(t)) return true;
  return false;
}

/**
 * PURE: does this message point at a single entity by pronoun, with no position?
 *
 * "unstar it", "archive that one", "reply to it". Deliberately narrow: a pronoun
 * alone is only a reference when there is nothing else to go on, and the caller
 * resolves it by priority (acted -> selected -> a single-result set) rather than
 * guessing.
 */
export function referencesPronoun(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  return /\b(?:it|that|this|them|those|these)\b/.test(t);
}

// --- Persistence ---------------------------------------------------------

/** PURE: validate a redacted proposal input as entity context. */
export function parseGmailEntityContextData(
  input: Record<string, unknown> | null,
): GmailEntityContextData | null {
  if (!input || input.kind !== "gmail_entity_context") return null;
  return {
    kind: "gmail_entity_context",
    selected: parseEntity(input.selected),
    acted: parseActed(input.acted),
  };
}

/** PURE: validate one entity ref. Both ids are required — a ref without them is unusable. */
function parseEntity(raw: unknown): GmailEntityRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const threadId = typeof r.threadId === "string" ? r.threadId : "";
  const messageId = typeof r.messageId === "string" ? r.messageId : "";
  if (!threadId || !messageId) return null;
  return {
    threadId,
    messageId,
    label: typeof r.label === "string" ? r.label : "",
    subject: typeof r.subject === "string" ? r.subject : "",
  };
}

/** PURE: validate the acted-on record. */
function parseActed(raw: unknown): GmailActedEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const entity = parseEntity(r.entity);
  if (!entity) return null;
  const action = typeof r.action === "string" ? r.action : "";
  if (!action) return null;
  return {
    entity,
    action: action as GmailMutationAction,
    labelId: typeof r.labelId === "string" ? r.labelId : null,
    labelName: typeof r.labelName === "string" ? r.labelName : null,
    at: typeof r.at === "string" ? r.at : new Date(0).toISOString(),
  };
}

/** Injectable persistence so the whole flow runs with NO database in tests. */
export interface GmailEntityContextStore {
  create?: (userId: string, input: CreateProposalInput) => Promise<{ id: string }>;
  listRecent?: (userId: string, actionId: string) => Promise<ActionProposalView[]>;
}

/**
 * Load the most recent NON-expired entity context, or null.
 *
 * An expired row is SKIPPED, never used: a stale "it" must ask rather than mutate an
 * email the user stopped talking about an hour ago.
 */
export async function loadGmailEntityContext(
  userId: string,
  store: GmailEntityContextStore = {},
): Promise<LoadedGmailEntityContext | null> {
  const listRecent = store.listRecent ?? listRecentProposalsByAction;
  const rows = await listRecent(userId, GMAIL_ENTITY_CONTEXT_ACTION_ID);
  for (const row of rows) {
    const data = parseGmailEntityContextData(row.input);
    if (!data) continue;
    if (Date.parse(row.expiresAt) <= Date.now()) continue;
    return { id: row.id, data, createdAt: row.createdAt };
  }
  return null;
}

/**
 * Write the context. Best-effort at every call site: losing it costs the "it"
 * shortcut, never the action itself.
 */
async function writeContext(
  userId: string,
  data: GmailEntityContextData,
  store: GmailEntityContextStore,
): Promise<{ id: string }> {
  const create = store.create ?? createActionProposal;
  return create(userId, {
    provider: GMAIL_PROVIDER,
    actionId: GMAIL_ENTITY_CONTEXT_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: data as unknown as Record<string, unknown>,
    previewText: "Gmail conversation context.",
    ttlMs: ENTITY_CONTEXT_TTL_MS,
  });
}

/**
 * Remember the entity the user explicitly picked ("the second one").
 *
 * Preserves any existing `acted` record: picking a new email does not un-happen the
 * action we performed on the previous one.
 */
export async function recordSelectedEntity(
  userId: string,
  entity: GmailEntityRef,
  store: GmailEntityContextStore = {},
): Promise<{ id: string }> {
  const existing = await loadGmailEntityContext(userId, store);
  return writeContext(
    userId,
    { kind: "gmail_entity_context", selected: entity, acted: existing?.data.acted ?? null },
    store,
  );
}

/**
 * Remember an action that VERIFIABLY landed.
 *
 * The single caller rule that makes "undo that" safe: this runs ONLY after the
 * postcondition was read back from Gmail and matched. An accepted-but-unverified
 * mutation must never reach here, or "undo" would offer to reverse a change that
 * never took effect.
 *
 * The acted entity also becomes the selected one — after "star the second one", both
 * "it" and "that email" mean that conversation.
 */
export async function recordActedEntity(
  userId: string,
  acted: GmailActedEntity,
  store: GmailEntityContextStore = {},
): Promise<{ id: string }> {
  return writeContext(
    userId,
    { kind: "gmail_entity_context", selected: acted.entity, acted },
    store,
  );
}

/**
 * Clear the acted record (used after an undo is itself performed, so "undo that"
 * cannot ping-pong forever on one stale memory).
 */
export async function clearActedEntity(
  userId: string,
  store: GmailEntityContextStore = {},
): Promise<void> {
  const existing = await loadGmailEntityContext(userId, store);
  if (!existing) return;
  await writeContext(
    userId,
    { kind: "gmail_entity_context", selected: existing.data.selected, acted: null },
    store,
  );
}
