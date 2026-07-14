import {
  createActionProposal,
  expireProposal,
  getLatestProposalByAction,
  updateProposalInput,
  type ActionProposalView,
  type CreateProposalInput,
} from "../../../actions/proposals";
import { GMAIL_PROVIDER } from "./types";
import type { GmailAction } from "./gmailActionExtract";

/**
 * Pending Gmail reply-target clarification (Section 16 live-fix).
 *
 * When a reply request matches several distinct threads, Hula lists them and
 * remembers the choice so the user's next message ("2", "the second one",
 * "actually 2") resolves DETERMINISTICALLY against the exact thread they picked —
 * the model never re-guesses.
 *
 * This deliberately REUSES the Section 12 proposal store rather than introducing a
 * second persistence framework: a clarification is a `proposed` `ActionProposal`
 * row with a dedicated pseudo `actionId` and `confirmationRequired:false`. That
 * last flag keeps it INVISIBLE to the yes/no confirmation flow (`getActiveProposal`
 * only returns confirmation-requiring rows), so the two never collide. The
 * candidate identifiers, the original action, and the drafted body are carried in
 * the row's redacted `inputJson` — never a token or raw provider payload.
 */

/** The pseudo action id under which a pending clarification is persisted. */
export const GMAIL_CLARIFICATION_ACTION_ID = "email.replyClarification" as const;

/** How long a clarification stays answerable before it expires. */
export const CLARIFICATION_TTL_MS = 10 * 60 * 1000;

/** One numbered option the user can choose between (safe metadata only). */
export interface ReplyCandidate {
  /** 1-based option number shown to the user. */
  index: number;
  /** The Gmail message id to build the reply from when chosen. */
  messageId: string;
  /** The thread the reply must stay in. */
  threadId: string;
  /** Sender display (name or address) — for safe re-display only. */
  sender: string;
  /** The message subject — for safe re-display only. */
  subject: string;
}

/** The redacted payload persisted for a pending reply clarification. */
export interface ReplyClarificationData {
  kind: "gmail_reply_clarification";
  /** The original reply action to run once a thread is chosen. */
  action: GmailAction["action"];
  /** The body the user asked to reply with (carried verbatim). */
  body: string;
  /** The numbered candidate threads. */
  candidates: ReplyCandidate[];
  /** The last option resolved, if any — for idempotency / correction. */
  resolvedIndex: number | null;
}

/** A loaded clarification plus whether it has already expired. */
export interface PendingClarification {
  id: string;
  data: ReplyClarificationData;
  expired: boolean;
}

// --- Pure selection parsing ----------------------------------------------

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
};

/**
 * PURE: read a numbered selection (or correction) from the user's reply, or null
 * when the message isn't a choice at all. Recognises: a bare number ("2", "2."),
 * "option/number N", corrections ("actually 2", "sorry, I meant 2", "make it 2",
 * "go with 2"), and ordinals ("the second one"). Returns the 1-based index the
 * user named — which the caller range-checks against the actual candidate count.
 * Returning null means "not a selection", so unrelated messages fall through.
 */
export function parseClarificationSelection(
  text: string | undefined,
): { index: number } | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;

  // A bare number, optionally with trailing punctuation ("2", "#2", "2.", "2)").
  let m = /^#?\s*(\d{1,2})[.)]?$/.exec(t);
  if (m) return { index: Number(m[1]) };

  // "option N" / "number N" / "#N" / correction verbs immediately before a number.
  m =
    /\b(?:option|number|no\.?|#|actually|(?:i\s*)?meant|make\s*it|go\s*with|let'?s\s*do)\s*(?:option\s*|number\s*)?(\d{1,2})\b/.exec(
      t,
    );
  if (m) return { index: Number(m[1]) };

  // An ordinal word ("the second one", "second").
  m = /\b(first|second|third|fourth|fifth|sixth)\b/.exec(t);
  if (m) {
    const idx = ORDINALS[m[1]!];
    if (idx) return { index: idx };
  }
  return null;
}

// --- Persistence (store-backed, injectable) ------------------------------

/** PURE: validate that a redacted proposal input is a clarification payload. */
export function parseReplyClarificationData(
  input: Record<string, unknown> | null,
): ReplyClarificationData | null {
  if (!input || input.kind !== "gmail_reply_clarification") return null;
  const action = input.action;
  const body = input.body;
  const rawCandidates = input.candidates;
  if (typeof action !== "string" || typeof body !== "string") return null;
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) return null;

  const candidates: ReplyCandidate[] = [];
  for (const c of rawCandidates) {
    if (!c || typeof c !== "object") return null;
    const r = c as Record<string, unknown>;
    if (
      typeof r.index !== "number" ||
      typeof r.messageId !== "string" ||
      typeof r.threadId !== "string" ||
      typeof r.sender !== "string" ||
      typeof r.subject !== "string"
    ) {
      return null;
    }
    candidates.push({
      index: r.index,
      messageId: r.messageId,
      threadId: r.threadId,
      sender: r.sender,
      subject: r.subject,
    });
  }
  const resolvedIndex =
    typeof input.resolvedIndex === "number" ? input.resolvedIndex : null;
  return {
    kind: "gmail_reply_clarification",
    action: action as GmailAction["action"],
    body,
    candidates,
    resolvedIndex,
  };
}

/** Injectable persistence so the flow runs with NO database in tests. */
export interface ClarificationStore {
  create?: (userId: string, input: CreateProposalInput) => Promise<{ id: string }>;
  getLatest?: (
    userId: string,
    actionId: string,
  ) => Promise<ActionProposalView | null>;
  updateInput?: (
    userId: string,
    id: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
  expire?: (userId: string, id: string) => Promise<void>;
}

/**
 * Persist a new pending reply clarification for a user and return its id. Stored
 * as a `confirmationRequired:false` proposal so the confirmation flow never sees
 * it. `previewText` is the exact numbered list the user was shown.
 */
export async function createReplyClarification(
  userId: string,
  data: ReplyClarificationData,
  previewText: string,
  store: ClarificationStore = {},
): Promise<{ id: string }> {
  const create = store.create ?? createActionProposal;
  return create(userId, {
    provider: GMAIL_PROVIDER,
    actionId: GMAIL_CLARIFICATION_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: data as unknown as Record<string, unknown>,
    previewText,
    ttlMs: CLARIFICATION_TTL_MS,
  });
}

/**
 * Load the user's most recent pending clarification (with an `expired` flag), or
 * null when there is none / the stored payload is not a valid clarification.
 */
export async function loadReplyClarification(
  userId: string,
  store: ClarificationStore = {},
): Promise<PendingClarification | null> {
  const getLatest = store.getLatest ?? getLatestProposalByAction;
  const view = await getLatest(userId, GMAIL_CLARIFICATION_ACTION_ID);
  if (!view) return null;
  const data = parseReplyClarificationData(view.input);
  if (!data) return null;
  return {
    id: view.id,
    data,
    expired: Date.parse(view.expiresAt) <= Date.now(),
  };
}

/** Record the option a clarification resolved to (for idempotency/correction). */
export async function markClarificationResolved(
  userId: string,
  id: string,
  data: ReplyClarificationData,
  resolvedIndex: number,
  store: ClarificationStore = {},
): Promise<void> {
  const updateInput = store.updateInput ?? updateProposalInput;
  await updateInput(userId, id, {
    ...(data as unknown as Record<string, unknown>),
    resolvedIndex,
  });
}

/** Expire a clarification the user answered too late. */
export async function expireReplyClarification(
  userId: string,
  id: string,
  store: ClarificationStore = {},
): Promise<void> {
  const expire = store.expire ?? expireProposal;
  await expire(userId, id);
}
