import { createActionProposal } from "../../../actions/proposals";
import { executeAction } from "../../../actions/executor";
import { logger } from "../../../utils/logger";
import { GmailError, isReconnectReason } from "./client";
import {
  getGmailDraftDetail,
  listGmailDrafts,
  type GmailDraftDetail,
} from "./drafts";
import { buildGmailRawPayload, MimeError } from "./mime";
import {
  extractGmailDraftCommand,
  rewriteDraftBody,
  type DraftBodyRewriter,
  type GmailDraftCommand,
  type TextGenerator,
} from "./gmailDraftExtract";
import {
  loadLatestGmailSelection,
  parseOrdinalReference,
  recordGmailSelection,
  resolveSelectionItem,
  type GmailSelectionData,
} from "./gmailSelection";
import { GMAIL_PROVIDER, type NormalizedGmailDraft } from "./types";

/**
 * Gmail DRAFT LIFECYCLE routing (Section 17) — list / open / edit / delete.
 *
 * Completes the draft story Section 16 started (create + send). The design rules
 * that matter, in order of how badly they'd hurt if broken:
 *
 *  1. DELETE vs CANCEL are different operations. "no, cancel" abandons a pending
 *     Hula action and touches NO Gmail data — it is handled entirely by the
 *     confirmation flow, which runs earlier in the cascade and never reaches here.
 *     "delete that draft" destroys real, unrecoverable user data and therefore
 *     requires an explicit confirmation of its own.
 *  2. EDIT never sends. Editing and sending are separate actions with separate
 *     phrasing; an edit only ever rewrites the draft in place.
 *  3. Every edit/delete RE-FETCHES the draft first. A stored reference can be
 *     stale — the user may have edited, sent, or deleted the draft in the Gmail UI
 *     since Hula last saw it — so acting on a remembered body would clobber newer
 *     content, and acting on a dead id must fail honestly.
 *  4. Positions resolve against the EXACT list last shown, never a re-search: a
 *     re-search can reorder, which would silently act on a different draft than the
 *     one the user is looking at.
 *
 * Never throws — every failure degrades to an honest reply.
 */

/** Max characters of a draft body shown verbatim in an iMessage inspect. */
const DRAFT_EXCERPT_MAX = 1200;

export const GMAIL_DRAFT_REPLIES = {
  notConnected: "Your Gmail isn’t connected yet. Connect it from Hula → Integrations → Gmail.",
  reconnect: "Your Gmail access needs reconnecting. Open Hula → Integrations → Gmail.",
  unavailable: "I couldn’t reach Gmail just now — mind trying again in a bit?",
  noDrafts: "You don’t have any drafts in Gmail right now.",
  noneToOpen: "I’m not sure which draft you mean — try “show me my drafts” first.",
  outOfRange: "I don’t have a draft at that position — try “show me my drafts” again.",
  ambiguous: "I’m not sure which draft you mean. Which one?",
  draftGone: "That draft isn’t in your Gmail anymore — it may have been sent or deleted already.",
  needInstruction: "What would you like me to change about it?",
  editFailed: "I couldn’t rewrite that draft — mind telling me the change again?",
} as const;

// --- Prefilter (PURE) ----------------------------------------------------

const DRAFT_NOUN_RE = /\bdrafts?\b/i;
// Edit phrasings that reference a draft implicitly ("make it shorter", "change
// Friday to Monday", "make the second one shorter").
const EDIT_HINT_RE =
  /\b(?:make (?:it|that|this|the)|change|reword|rewrite|shorten|lengthen|tweak|adjust|edit|fix|more (?:formal|professional|casual))\b/i;

/**
 * PURE: a cheap gate deciding whether a message is worth one model extraction.
 *
 * Matches an explicit draft noun ("delete that draft") or an implicit edit phrasing
 * ("make it shorter", "change Friday to Monday").
 *
 * The implicit branch is deliberately broad, and that is safe ONLY because of what
 * happens downstream: "change Friday to Monday" is genuinely ambiguous between
 * editing a draft and rescheduling an event — nothing in the words themselves can
 * settle it. Three things resolve it instead:
 *   1. the extractor is told to reject calendar-shaped requests outright,
 *   2. an edit with NO resolvable draft falls through (`handled:false`) rather than
 *      being answered, so a user with no drafts sees unchanged calendar behaviour,
 *   3. an edit is only ever applied to a draft that actually exists.
 * A false positive therefore costs one extraction, never a wrong write.
 */
export function looksLikeDraftCommand(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return DRAFT_NOUN_RE.test(t) || EDIT_HINT_RE.test(t);
}

// --- Formatting (PURE) ---------------------------------------------------

function draftLabel(draft: NormalizedGmailDraft): string {
  const name = (draft.toName ?? "").trim();
  if (name) return name;
  const addr = (draft.to ?? "").trim();
  return addr || "(no recipient)";
}

function draftSubject(draft: NormalizedGmailDraft): string {
  const s = (draft.subject ?? "").trim();
  return s.length > 0 ? s : "(no subject)";
}

/** PURE: a numbered, iMessage-friendly draft list. */
export function formatDraftList(drafts: readonly NormalizedGmailDraft[]): string {
  if (drafts.length === 0) return GMAIL_DRAFT_REPLIES.noDrafts;
  const lines = drafts.map(
    (d, i) => `${i + 1}. To ${draftLabel(d)} — ${draftSubject(d)}`,
  );
  const noun = drafts.length === 1 ? "draft" : "drafts";
  return `You have ${drafts.length} ${noun}:\n${lines.join("\n")}`;
}

/** PURE: show ONE draft's real content, bounded for iMessage. */
export function formatDraftDetail(detail: GmailDraftDetail): string {
  const { draft, body } = detail;
  const text = body.trim();
  const excerpt =
    text.length <= DRAFT_EXCERPT_MAX ? text : `${text.slice(0, DRAFT_EXCERPT_MAX).trimEnd()}…`;
  const header = `Draft to ${draftLabel(draft)}\nSubject: ${draftSubject(draft)}`;
  return excerpt ? `${header}\n\n${excerpt}` : `${header}\n\n(This draft is empty.)`;
}

/** PURE: the preview shown before a DESTRUCTIVE draft deletion. */
export function formatDeleteDraftPreview(draft: NormalizedGmailDraft): string {
  return `I’ll delete the draft to ${draftLabel(draft)} (“${draftSubject(draft)}”). Gmail can’t undo that — want me to go ahead?`;
}

// --- Draft resolution ----------------------------------------------------

/** PURE: does a draft match a recipient hint ("the draft to Rob")? */
export function draftMatchesHint(draft: NormalizedGmailDraft, hint: string): boolean {
  const h = hint.trim().toLowerCase();
  if (!h) return false;
  const addr = (draft.to ?? "").toLowerCase();
  const name = (draft.toName ?? "").toLowerCase();
  if (h === addr) return true;
  const tokens = h.match(/[a-z0-9']+/g) ?? [];
  return tokens.some(
    (tok) =>
      tok.length >= 2 &&
      (name.split(/\s+/).includes(tok) ||
        (tok.length >= 3 && addr.includes(tok))),
  );
}

type Resolution =
  | { kind: "one"; draft: NormalizedGmailDraft }
  | { kind: "reply"; reply: string }
  /** The user has NO drafts at all — distinct from "which one?". */
  | { kind: "empty" };

export interface GmailDraftLifecycleDeps {
  extract?: (params: { text: string; generate?: TextGenerator }) => Promise<GmailDraftCommand | null>;
  generate?: TextGenerator;
  list?: typeof listGmailDrafts;
  getDetail?: typeof getGmailDraftDetail;
  rewrite?: DraftBodyRewriter;
  propose?: typeof createActionProposal;
  execute?: typeof executeAction;
  recordSelection?: typeof recordGmailSelection;
  loadSelection?: typeof loadLatestGmailSelection;
}

export interface GmailDraftLifecycleResult {
  handled: boolean;
  reply?: string;
  action?: GmailDraftCommand["action"];
}

/** Map a provider error to an honest reply. */
function replyForError(err: GmailError): string {
  if (err.reason === "not_connected") return GMAIL_DRAFT_REPLIES.notConnected;
  if (err.reason === "insufficient_scope" || isReconnectReason(err.reason)) {
    return GMAIL_DRAFT_REPLIES.reconnect;
  }
  if (err.reason === "mailbox_not_found") return GMAIL_DRAFT_REPLIES.draftGone;
  return GMAIL_DRAFT_REPLIES.unavailable;
}

/**
 * Resolve WHICH draft the user means, in priority order:
 *   1. an explicit position against the list Hula last showed,
 *   2. a recipient hint matched against the live draft list,
 *   3. the only draft, when there is exactly one.
 * Anything else asks. Never picks arbitrarily among several.
 */
async function resolveDraft(
  userId: string,
  text: string | undefined,
  command: GmailDraftCommand,
  deps: GmailDraftLifecycleDeps,
): Promise<Resolution> {
  const list = deps.list ?? listGmailDrafts;
  const loadSelection = deps.loadSelection ?? loadLatestGmailSelection;

  // 1. Positional reference against the EXACT list last shown.
  const ref =
    command.ordinal && command.ordinal >= 1
      ? { position: command.ordinal }
      : parseOrdinalReference(text);
  if (ref) {
    const selection = await loadSelection(userId);
    if (selection && selection.data.itemKind === "drafts") {
      const item = resolveSelectionItem(selection.data, ref);
      if (!item) return { kind: "reply", reply: GMAIL_DRAFT_REPLIES.outOfRange };
      // Rebuild a minimal draft handle from the remembered entry; the caller
      // re-fetches the live draft before doing anything with it.
      return {
        kind: "one",
        draft: {
          draftId: item.id,
          messageId: null,
          threadId: item.threadId,
          to: null,
          toName: item.label || null,
          subject: item.subject || null,
          snippet: null,
          source: GMAIL_PROVIDER,
        },
      };
    }
    // A position with no remembered list can't be resolved safely.
    return { kind: "reply", reply: GMAIL_DRAFT_REPLIES.noneToOpen };
  }

  const drafts = await list(userId);
  if (drafts.length === 0) return { kind: "empty" };

  // 2. Recipient hint.
  const hint = (command.recipientHint ?? "").trim();
  if (hint) {
    const matches = drafts.filter((d) => draftMatchesHint(d, hint));
    if (matches.length === 1) return { kind: "one", draft: matches[0]! };
    if (matches.length > 1) {
      return { kind: "reply", reply: formatDraftList(matches) };
    }
    return { kind: "reply", reply: `I couldn’t find a draft to ${hint}.` };
  }

  // 3. Exactly one draft — unambiguous.
  if (drafts.length === 1) return { kind: "one", draft: drafts[0]! };

  // Several drafts and no way to tell them apart — ask, never guess.
  return { kind: "reply", reply: formatDraftList(drafts) };
}

// --- Orchestrator --------------------------------------------------------

/**
 * Handle a draft lifecycle command from an already-linked user. Returns
 * `{ handled:false }` for anything that isn't one (and when the model can't be
 * reached) so the caller falls through unchanged. Never throws.
 */
export async function handleGmailDraftLifecycle(
  userId: string,
  text: string | undefined,
  deps: GmailDraftLifecycleDeps = {},
): Promise<GmailDraftLifecycleResult> {
  if (!looksLikeDraftCommand(text)) return { handled: false };

  const extract = deps.extract ?? extractGmailDraftCommand;
  const command = await extract({ text: text ?? "", generate: deps.generate });
  if (!command || command.action === "not_draft_command") return { handled: false };

  try {
    switch (command.action) {
      case "list_drafts":
        return await runList(userId, deps);
      case "open_draft":
        return await runOpen(userId, text, command, deps);
      case "edit_draft":
        return await runEdit(userId, text, command, deps);
      case "delete_draft":
        return await runDelete(userId, text, command, deps);
      default:
        return { handled: false };
    }
  } catch (err) {
    if (err instanceof GmailError) {
      logger.error("gmail.draftLifecycle failed", {
        provider: GMAIL_PROVIDER,
        operation: `draft.${command.action}`,
        errorCode: err.reason,
        httpStatus: err.httpStatus,
      });
      return { handled: true, action: command.action, reply: replyForError(err) };
    }
    logger.error("gmail.draftLifecycle failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: true, action: command.action, reply: GMAIL_DRAFT_REPLIES.unavailable };
  }
}

/** Remember the list just shown so "the second one" resolves to the right draft. */
async function rememberDrafts(
  userId: string,
  drafts: readonly NormalizedGmailDraft[],
  deps: GmailDraftLifecycleDeps,
): Promise<void> {
  const record = deps.recordSelection ?? recordGmailSelection;
  const data: GmailSelectionData = {
    kind: "gmail_selection",
    itemKind: "drafts",
    items: drafts.map((d) => ({
      id: d.draftId,
      threadId: d.threadId,
      label: draftLabel(d),
      subject: draftSubject(d),
    })),
  };
  try {
    await record(userId, data);
  } catch (err) {
    // Best-effort: losing the selection only costs the "second one" shortcut.
    logger.error("gmail.draftLifecycle selection record failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}

async function runList(
  userId: string,
  deps: GmailDraftLifecycleDeps,
): Promise<GmailDraftLifecycleResult> {
  const list = deps.list ?? listGmailDrafts;
  const drafts = await list(userId);
  if (drafts.length > 0) await rememberDrafts(userId, drafts, deps);
  return { handled: true, action: "list_drafts", reply: formatDraftList(drafts) };
}

async function runOpen(
  userId: string,
  text: string | undefined,
  command: GmailDraftCommand,
  deps: GmailDraftLifecycleDeps,
): Promise<GmailDraftLifecycleResult> {
  const getDetail = deps.getDetail ?? getGmailDraftDetail;
  const resolved = await resolveDraft(userId, text, command, deps);
  if (resolved.kind === "empty") {
    return { handled: true, action: "open_draft", reply: GMAIL_DRAFT_REPLIES.noDrafts };
  }
  if (resolved.kind === "reply") {
    return { handled: true, action: "open_draft", reply: resolved.reply };
  }
  // Always read the LIVE draft, never a remembered snapshot.
  const detail = await getDetail(userId, resolved.draft.draftId);
  return { handled: true, action: "open_draft", reply: formatDraftDetail(detail) };
}

async function runEdit(
  userId: string,
  text: string | undefined,
  command: GmailDraftCommand,
  deps: GmailDraftLifecycleDeps,
): Promise<GmailDraftLifecycleResult> {
  const getDetail = deps.getDetail ?? getGmailDraftDetail;
  const rewrite = deps.rewrite ?? rewriteDraftBody;
  const execute = deps.execute ?? executeAction;

  const instruction = (command.editInstruction ?? "").trim() || (text ?? "").trim();
  if (!instruction) {
    return { handled: true, action: "edit_draft", reply: GMAIL_DRAFT_REPLIES.needInstruction };
  }

  const resolved = await resolveDraft(userId, text, command, deps);
  if (resolved.kind === "empty") {
    // No draft exists to edit, so this was never a draft command — most likely a
    // calendar reschedule ("change Friday to Monday"). Fall through UNHANDLED so
    // the later handlers see it exactly as they would have before Section 17.
    return { handled: false };
  }
  if (resolved.kind === "reply") {
    return { handled: true, action: "edit_draft", reply: resolved.reply };
  }

  // RE-FETCH: edit the draft's CURRENT content, not a remembered copy.
  const detail = await getDetail(userId, resolved.draft.draftId);
  const to = detail.draft.to ?? "";
  if (!to) {
    return { handled: true, action: "edit_draft", reply: GMAIL_DRAFT_REPLIES.unavailable };
  }

  const newBody = await rewrite({
    currentBody: detail.body,
    instruction,
    subject: detail.draft.subject ?? "",
    recipient: to,
  });
  // An empty rewrite is a failure, NOT an instruction to blank the draft.
  if (!newBody.trim()) {
    return { handled: true, action: "edit_draft", reply: GMAIL_DRAFT_REPLIES.editFailed };
  }

  // Gmail's update REPLACES the draft, so the rebuilt MIME must carry the original
  // threading headers or an edited reply detaches from its thread.
  let raw: string;
  try {
    const payload = buildGmailRawPayload(
      {
        to,
        subject: detail.draft.subject ?? "",
        body: newBody,
        inReplyTo: detail.inReplyTo ?? undefined,
        references: detail.references ?? undefined,
      },
      detail.draft.threadId ?? undefined,
    );
    raw = payload.raw;
  } catch (err) {
    logger.error("gmail.draftLifecycle mime failed", {
      errorCode: err instanceof MimeError ? err.reason : "unknown",
    });
    return { handled: true, action: "edit_draft", reply: GMAIL_DRAFT_REPLIES.editFailed };
  }

  const result = await execute(userId, "email.updateDraft", {
    input: {
      draftId: detail.draft.draftId,
      raw,
      threadId: detail.draft.threadId ?? "",
      label: draftLabel(detail.draft),
    },
  });
  return { handled: true, action: "edit_draft", reply: result.userMessage };
}

async function runDelete(
  userId: string,
  text: string | undefined,
  command: GmailDraftCommand,
  deps: GmailDraftLifecycleDeps,
): Promise<GmailDraftLifecycleResult> {
  const getDetail = deps.getDetail ?? getGmailDraftDetail;
  const propose = deps.propose ?? createActionProposal;

  const resolved = await resolveDraft(userId, text, command, deps);
  if (resolved.kind === "empty") {
    return { handled: true, action: "delete_draft", reply: GMAIL_DRAFT_REPLIES.noDrafts };
  }
  if (resolved.kind === "reply") {
    return { handled: true, action: "delete_draft", reply: resolved.reply };
  }

  // RE-FETCH so the preview describes the draft that actually exists right now —
  // and so a draft already gone fails here rather than at execution.
  const detail = await getDetail(userId, resolved.draft.draftId);

  // Nothing is deleted here. Deletion is irreversible in Gmail, so it only ever
  // happens after an explicit confirmation resolves this proposal.
  const preview = formatDeleteDraftPreview(detail.draft);
  await propose(userId, {
    provider: GMAIL_PROVIDER,
    actionId: "email.deleteDraft",
    riskLevel: "write",
    confirmationRequired: true,
    input: {
      draftId: detail.draft.draftId,
      label: draftLabel(detail.draft),
    },
    previewText: preview,
  });
  return { handled: true, action: "delete_draft", reply: preview };
}
