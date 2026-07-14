import {
  confirmProposal,
  createActionProposal,
  finalizeProposal,
  listRecentProposalsByAction,
  revertProposalToProposed,
  type ActionProposalView,
  type CreateProposalInput,
} from "../../../actions/proposals";
import { GMAIL_PROVIDER } from "./types";
import type { GmailAction } from "./gmailActionExtract";

/**
 * Recent Hula-created Gmail draft reference (Section 16 — "send the draft").
 *
 * After Hula creates a REAL Gmail draft, it remembers a small, user-scoped,
 * expiring reference to that exact draft so a natural follow-up ("send the draft",
 * "send it", "send the draft to Rob") can send the ACTUAL draft — never a
 * reconstructed message and never a guessed draft id.
 *
 * Like `gmailClarification`, this REUSES the Section 12 proposal store instead of a
 * second persistence framework: each reference is a `confirmationRequired:false`
 * `ActionProposal` row under a dedicated pseudo `actionId`. That flag keeps it
 * INVISIBLE to the yes/no confirmation flow (`getActiveProposal` only returns
 * confirmation-requiring rows), so the two never collide. The row's redacted
 * `inputJson` carries ONLY safe identifiers (Gmail draft/message/thread ids,
 * recipient, subject) — never a token, raw MIME, or body.
 *
 * The row's own lifecycle IS the send state:
 *   - `proposed`  → an active, unsent draft reference (eligible to send)
 *   - `confirmed` → atomically CLAIMED for an in-flight send (guards duplicates)
 *   - `executed`  → the draft was sent (a repeat "send it" reports already-sent)
 * A failed send is released back to `proposed` so the user can safely retry.
 */

/** The pseudo action id under which a recent-draft reference is persisted. */
export const GMAIL_LAST_DRAFT_ACTION_ID = "email.lastDraft" as const;

/** How long a draft reference stays send-able before it expires. */
export const LAST_DRAFT_TTL_MS = 30 * 60 * 1000;

/** The redacted, SAFE reference to one Hula-created Gmail draft. */
export interface LastDraftData {
  kind: "gmail_last_draft";
  /** Gmail-issued draft id — used to send the ACTUAL draft (never reconstructed). */
  draftId: string;
  /** Gmail-issued message id of the draft, when returned. */
  messageId: string | null;
  /** Gmail thread id the draft belongs to, when known. */
  threadId: string | null;
  /** The resolved recipient address the draft was addressed to. */
  to: string;
  /** The recipient display name, when known. */
  toName: string | null;
  /** The draft subject (for safe re-display / matching). */
  subject: string;
  /** Whether the draft is a reply. */
  isReply: boolean;
  /** The originating draft action, for context. */
  action: GmailAction["action"];
}

/** A loaded reference plus derived state flags. */
export interface LoadedLastDraft {
  id: string;
  data: LastDraftData;
  status: ActionProposalView["status"];
  expired: boolean;
  createdAt: string;
}

// --- Pure prefilter + recipient hint (fully unit-testable) ---------------

// A leading COMPOSE verb makes the message a "create a draft/reply" request, not
// a "send my existing draft" one — those belong to the Gmail write handler.
const COMPOSE_LEAD_RE =
  /^(?:can you |could you |would you |please |pls |go ahead and )?(?:draft|write|compose|prepare|reply|respond)\b/i;
// A dictated body ("saying …") also means compose-new, never send-existing.
const DICTATED_BODY_RE =
  /\b(?:saying|that says|which says|telling (?:him|her|them)|to say)\b/i;
// EXPLICIT send of a DEFINITE existing draft: "send/email the|that|my (reply) draft".
const EXPLICIT_DRAFT_SEND_RE =
  /\b(?:send|email)\s+(?:the|that|my last|my)\s+(?:reply\s+)?draft\b/i;
// "send my last email" — the most recent thing Hula drafted.
const EXPLICIT_LAST_EMAIL_RE = /\bsend\s+my last\s+e-?mail\b/i;
// WEAK reference: a bare "send it/that/this" or "send the reply".
const WEAK_DRAFT_SEND_RE = /\bsend\s+(?:it|that|this|the reply)\b/i;

/** How the message qualifies as a draft-send follow-up. */
export type DraftSendMatch = "explicit" | "weak" | "none";

/**
 * PURE: classify whether a message is a "send my EXISTING draft" follow-up.
 *
 *  - "explicit": sends a DEFINITE existing draft ("send the draft", "send that
 *    draft", "send the reply draft", "email the draft", "send my last draft",
 *    "send my last email", "go ahead and send the draft"). Safe to intercept and
 *    answer honestly even when no reference exists.
 *  - "weak": a bare "send it" / "send that" / "send this" / "send the reply".
 *    Intercept ONLY when a real reference exists; otherwise fall through so an
 *    unrelated "send it" is never hijacked from normal chat.
 *  - "none": not a draft-send follow-up.
 *
 * A COMPOSE request ("draft a reply to Rob's email", "send Rob an email saying …",
 * "reply to Rob") is deliberately excluded — it carries a leading compose verb, a
 * dictated body, or an indefinite "a/an email" object — so it routes to the Gmail
 * write handler instead.
 */
export function classifyDraftSend(text: string | undefined): DraftSendMatch {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return "none";
  // Compose-new requests are never a send-existing follow-up.
  if (COMPOSE_LEAD_RE.test(t)) return "none";
  if (DICTATED_BODY_RE.test(t)) return "none";
  if (EXPLICIT_DRAFT_SEND_RE.test(t) || EXPLICIT_LAST_EMAIL_RE.test(t)) return "explicit";
  if (WEAK_DRAFT_SEND_RE.test(t)) return "weak";
  return "none";
}

const HINT_STOPWORDS = new Set([
  "the", "a", "an", "draft", "reply", "email", "e-mail", "mail", "message",
  "it", "that", "this", "one", "last", "my", "please", "now", "again",
]);

/**
 * PURE: extract an optional recipient hint from a "send the draft to Rob"-style
 * message ("to <name-or-address>"). Returns null when no explicit "to …" target
 * is present, so an un-targeted "send the draft" matches by recency alone.
 */
export function parseDraftRecipientHint(text: string | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const m = /\bto\s+([a-z0-9@._'+-][a-z0-9@._'\s+-]*)$/i.exec(t);
  if (!m) return null;
  const hint = m[1]!.replace(/[.!?,;:]+$/g, "").trim();
  return hint.length > 0 ? hint : null;
}

/** PURE: significant lowercase tokens of a string (drops stopwords/short words). */
function tokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return words.filter((w) => w.length >= 2 && !HINT_STOPWORDS.has(w));
}

/**
 * PURE: does a stored draft reference plausibly match a recipient hint? A literal
 * address matches by exact address or local-part; a name matches against the
 * recipient name tokens or the address local-part. Conservative — an empty hint
 * never matches (the caller only filters when a hint is present).
 */
export function draftRecipientMatches(data: LastDraftData, hint: string): boolean {
  const h = hint.trim().toLowerCase();
  if (!h) return false;
  const addr = (data.to ?? "").trim().toLowerCase();
  const localPart = addr.split("@")[0] ?? "";
  if (h === addr) return true;
  const hintTokens = tokens(hint);
  if (hintTokens.length === 0) return false;
  const nameTokens = new Set(tokens(data.toName ?? ""));
  return hintTokens.some(
    (tok) =>
      nameTokens.has(tok) ||
      (tok.length >= 3 && localPart.includes(tok)) ||
      (tok.length >= 3 && addr.includes(tok)),
  );
}

// --- Persistence (store-backed, injectable) ------------------------------

/** PURE: validate that a redacted proposal input is a last-draft payload. */
export function parseLastDraftData(
  input: Record<string, unknown> | null,
): LastDraftData | null {
  if (!input || input.kind !== "gmail_last_draft") return null;
  const draftId = input.draftId;
  const to = input.to;
  const subject = input.subject;
  const action = input.action;
  if (typeof draftId !== "string" || draftId.length === 0) return null;
  if (typeof to !== "string" || to.length === 0) return null;
  if (typeof subject !== "string") return null;
  if (typeof action !== "string") return null;
  return {
    kind: "gmail_last_draft",
    draftId,
    messageId: typeof input.messageId === "string" ? input.messageId : null,
    threadId: typeof input.threadId === "string" ? input.threadId : null,
    to,
    toName: typeof input.toName === "string" ? input.toName : null,
    subject,
    isReply: input.isReply === true,
    action: action as GmailAction["action"],
  };
}

/** Injectable persistence so the whole flow runs with NO database in tests. */
export interface LastDraftStore {
  create?: (userId: string, input: CreateProposalInput) => Promise<{ id: string }>;
  listRecent?: (userId: string, actionId: string) => Promise<ActionProposalView[]>;
  claim?: (userId: string, id: string) => Promise<ActionProposalView | null>;
  markSent?: (userId: string, id: string) => Promise<void>;
  release?: (userId: string, id: string) => Promise<void>;
}

/** The safe preview text stored alongside a reference (never shown as an action). */
function referencePreview(data: LastDraftData): string {
  const label = data.toName ? `${data.toName} <${data.to}>` : data.to;
  return `Draft ready to send to ${label}.`;
}

/**
 * Persist a reference to a just-created Hula draft. Stored as a
 * `confirmationRequired:false` proposal so the confirmation flow never sees it.
 * Best-effort at the call site — the caller must not let a failure here block the
 * "draft created" reply.
 */
export async function recordLastDraft(
  userId: string,
  data: LastDraftData,
  store: LastDraftStore = {},
): Promise<{ id: string }> {
  const create = store.create ?? createActionProposal;
  return create(userId, {
    provider: GMAIL_PROVIDER,
    actionId: GMAIL_LAST_DRAFT_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: data as unknown as Record<string, unknown>,
    previewText: referencePreview(data),
    ttlMs: LAST_DRAFT_TTL_MS,
  });
}

/**
 * Load recent last-draft references for a user (newest first), each with derived
 * `status`/`expired`/`createdAt`. Invalid payloads are dropped.
 */
export async function loadRecentLastDrafts(
  userId: string,
  store: LastDraftStore = {},
): Promise<LoadedLastDraft[]> {
  const listRecent = store.listRecent ?? listRecentProposalsByAction;
  const rows = await listRecent(userId, GMAIL_LAST_DRAFT_ACTION_ID);
  const out: LoadedLastDraft[] = [];
  for (const row of rows) {
    const data = parseLastDraftData(row.input);
    if (!data) continue;
    out.push({
      id: row.id,
      data,
      status: row.status,
      expired: Date.parse(row.expiresAt) <= Date.now(),
      createdAt: row.createdAt,
    });
  }
  return out;
}

/**
 * Atomically CLAIM a reference for sending (proposed → confirmed). Returns true
 * only when THIS call won the claim, so a concurrent/repeat "send it" can never
 * send the same draft twice. Returns false if it was already claimed/sent.
 */
export async function claimLastDraft(
  userId: string,
  id: string,
  store: LastDraftStore = {},
): Promise<boolean> {
  const claim = store.claim ?? confirmProposal;
  const claimed = await claim(userId, id);
  return claimed !== null;
}

/** Mark a claimed reference as sent (confirmed → executed). */
export async function markLastDraftSent(
  userId: string,
  id: string,
  store: LastDraftStore = {},
): Promise<void> {
  const mark = store.markSent ?? ((u: string, i: string) => finalizeProposal(u, i, "executed"));
  await mark(userId, id);
}

/** Release a claim back to sendable (confirmed → proposed) after a failed send. */
export async function releaseLastDraft(
  userId: string,
  id: string,
  store: LastDraftStore = {},
): Promise<void> {
  const release = store.release ?? revertProposalToProposed;
  await release(userId, id);
}
