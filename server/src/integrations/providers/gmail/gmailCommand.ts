import { createActionProposal } from "../../../actions/proposals";
import { executeAction } from "../../../actions/executor";
import { getUserTimezone } from "../../../reminders/reminders";
import { logger } from "../../../utils/logger";
import { getConnectionForUserProvider } from "../../connections";
import { GmailError, isReconnectReason } from "./client";
import { displaySender, displaySubject, formatEmailList } from "./gmailDisplay";
import {
  loadGmailEntityContext,
  recordActedEntity,
  recordSelectedEntity,
  referencesLastActed,
  referencesPronoun,
  type GmailEntityRef,
} from "./gmailEntityContext";
import {
  extractGmailIntent,
  type GmailIntent,
  type GmailManageAction,
  type TextGenerator,
} from "./gmailIntentExtract";
import { searchGmailMessages, type GmailSearchCriteria } from "./gmailSearch";
import { localToday } from "./gmailSearchQuestion";
import {
  loadLatestGmailSelection,
  parseOrdinalReference,
  recordGmailSelection,
  referencesLastResults,
  resolveSelectionItem,
} from "./gmailSelection";
import { dedupeToThreads, fetchGmailThreadState, type GmailThreadRef } from "./gmailThreads";
import { findLabelByName, listGmailLabels, MODIFY_BATCH_CAP } from "./messageActions";
import {
  DEFAULT_RESULT_CAP,
  MAX_RELEVANCE_CANDIDATES,
  RelevanceUnavailableError,
  selectRelevantThreads,
  type RelevanceJudge,
} from "./gmailRelevance";
import { expectationFor, reverseOf, verifyThreadState, type GmailMutationAction } from "./gmailVerify";
import { GMAIL_MODIFY_SCOPE, GMAIL_PROVIDER } from "./types";

/**
 * UNIFIED Gmail command handling (Section 17 correction).
 *
 * ONE stage that interprets a Gmail request completely, resolves what the user is
 * pointing at, acts deterministically, VERIFIES the result against Gmail's real
 * state, and remembers what it did. It replaces the keyword-first message-command
 * routing that produced every failure in the real transcript:
 *
 *  - "Star the first one" / "Unstar the first one" acted on a MESSAGE while the user
 *    was looking at a CONVERSATION, so the visible star never moved. -> everything
 *    here resolves to a thread (`gmailThreads`) and mutates at the level Gmail's UI
 *    uses.
 *  - "Now unstar it" -> "Which email do you mean?", because only the numbered list
 *    was remembered. -> `gmailEntityContext` remembers the entity the conversation
 *    is about, including the one we just acted on.
 *  - "Do I have any important emails regarding work?" dropped the word "work". ->
 *    the whole message becomes one structured intent, and topic is judged
 *    semantically (`gmailRelevance`).
 *  - "It's still starred" fell through to the generic model, which promised to "take
 *    another look" and then claimed success. -> a state complaint is a Gmail
 *    operation here; it re-reads Gmail and answers from the real state.
 *
 * The model names a scope. It never picks an id, never builds a query, never calls
 * Gmail, and can never report success. Never throws — every failure degrades to an
 * honest reply.
 */

/** Above this many conversations, even a reversible change gets a confirmation. */
const BULK_CONFIRM_THRESHOLD = 2;
/** Candidate window for a topical/importance search. */
const CANDIDATE_DAYS = 30;

export const GMAIL_CMD_REPLIES = {
  notConnected: "Your Gmail isn’t connected yet. Connect it from Hula → Integrations → Gmail.",
  reconnect:
    "I don’t have permission to manage your emails yet — reconnect Gmail in Hula to let me mark, star, archive, and trash.",
  unavailable: "I couldn’t reach Gmail just now — mind trying again in a bit?",
  noTarget: "Which email do you mean?",
  outOfRange: "I don’t have an email at that position — mind showing me the list again?",
  noSelection: "I’m not sure which email you mean — show me the list first, then tell me which one.",
  notFound: "I couldn’t find that email.",
  needLabel: "Which label should I use?",
  noSuchLabel: (name: string) =>
    `You don’t have a label called “${name}” in Gmail. I won’t create one — make it in Gmail first and I’ll apply it.`,
  nothingToUndo: "I don’t have a recent change of mine to undo.",
  cannotUndo: (what: string) => `I can’t undo ${what} — that one can’t be reversed.`,
  noneQualify: (topic: string) => `I couldn’t find any emails about ${topic}.`,
  /**
   * Distinct from `noneQualify` on purpose: we read the inbox but couldn't work out
   * which conversations were about the topic. Saying "none" here would be a false
   * claim about their mail.
   */
  cannotJudge: (topic: string) =>
    `I found your recent emails but couldn’t work out which ones are about ${topic} just now — mind trying again in a moment?`,
  noneImportant: "I couldn’t find any recent emails that look important.",
  noResults: "I couldn’t find any emails matching that.",
} as const;

// --- Prefilter (PURE) ----------------------------------------------------

const MANAGE_VERB_RE =
  /\b(?:mark|marked|star|starred|stars|unstar|unstarred|archive|archived|unarchive|trash|trashed|bin|binned|restore|restored|untrash|delete|deleted|remove|label|labell?ed|flag|unflag|read|unread)\b/i;
const EMAILISH_RE = /\b(?:e-?mails?|inbox|gmail|messages?|msg|mail|newsletters?|conversations?|threads?)\b/i;
const UNDO_RE = /\b(?:undo|revert|put\s+(?:it|that|them)\s+back|never\s*mind)\b/i;
/** A complaint that our claimed state is wrong ("it's still starred"). */
const STATE_COMPLAINT_RE =
  /\b(?:still|didn'?t\s+work|hasn'?t\s+changed|isn'?t\s+(?:un)?\w+ed|not\s+(?:un)?\w+ed|wrong\s+(?:one|email))\b/i;
/** Importance / triage language. */
const IMPORTANCE_RE =
  /\b(?:important|urgent|priority|critical|needs?\s+(?:my\s+)?attention|needs?\s+(?:a\s+)?repl(?:y|ies)|action\s+required|time.sensitive)\b/i;
/** A topic marker — "about X", "regarding X", "related to X". */
const TOPIC_RE = /\b(?:about|regarding|re:|related\s+to|concerning|to\s+do\s+with|on\s+the\s+subject\s+of)\b/i;
/** A vague "anything ..." question, which carries no email noun of its own. */
const ANYTHING_RE = /\b(?:anything|any\s+of\s+(?:them|these|those)|do\s+i\s+have\s+any)\b/i;

/**
 * PURE: is this message plausibly a Gmail command worth ONE interpretation?
 *
 * A cheap gate, and deliberately only a gate: it decides whether the message
 * CONCERNS Gmail, and then hands the COMPLETE text to the interpreter. It never
 * decides what the message means — that is exactly the mistake that lost the word
 * "work" from "important emails regarding work".
 *
 * A false positive costs one extraction returning `not_gmail`, after which routing
 * falls through unchanged. A false negative is what reaches the generic model and
 * gets fabricated, so this leans permissive on purpose.
 */
export function looksLikeGmailCommand(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (looksLikeManagementIntent(t)) return true;
  // "Do I have any important emails regarding work?" / "anything urgent about my job?"
  if ((IMPORTANCE_RE.test(t) || TOPIC_RE.test(t)) && (EMAILISH_RE.test(t) || ANYTHING_RE.test(t))) {
    return true;
  }
  return false;
}

/**
 * PURE: is this UNAMBIGUOUSLY a request to change or check email state?
 *
 * Narrower than `looksLikeGmailCommand`, and it exists for exactly one job: the
 * honesty guard. When the interpreter is unreachable we normally fall through, but
 * a message like "unstar it" or "it's still starred" must NEVER reach the generic
 * model — that is the path that produced "Let me take another look and remove that
 * star for you", followed by a claim of success over an unchanged inbox. For these,
 * an honest "I couldn't reach Gmail" is the only acceptable answer.
 */
export function looksLikeManagementIntent(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const emailish = EMAILISH_RE.test(t);
  // A bare pronoun counts: "Now unstar it" names no email and no position, and that
  // is precisely the message the old prefilter dropped on the floor. Once a list is
  // on screen, people stop naming the object they are plainly pointing at.
  const pointsAtSomething =
    referencesLastResults(t) || referencesLastActed(t) || referencesPronoun(t);

  // "Star the first one", "unstar it", "archive those".
  if (MANAGE_VERB_RE.test(t) && (emailish || pointsAtSomething)) return true;
  // "Undo that."
  if (UNDO_RE.test(t) && (emailish || pointsAtSomething)) return true;
  // "It's still starred." — a complaint that our claim was wrong.
  if (STATE_COMPLAINT_RE.test(t) && (MANAGE_VERB_RE.test(t) || pointsAtSomething)) return true;
  return false;
}

// --- Capability ----------------------------------------------------------

export type ModifyCapability = "not_connected" | "connected_no_modify" | "connected_modify";

/** Default capability check: connected AND holding `gmail.modify`. */
async function defaultModifyCapability(userId: string): Promise<ModifyCapability> {
  const conn = await getConnectionForUserProvider(userId, GMAIL_PROVIDER);
  if (!conn || conn.status !== "connected") return "not_connected";
  return conn.grantedScopes.includes(GMAIL_MODIFY_SCOPE)
    ? "connected_modify"
    : "connected_no_modify";
}

// --- Operation -> Gmail label change (PURE) ------------------------------

/** How one conversation-level action is performed. */
export interface MutationPlan {
  actionId: "email.modifyLabels" | "email.trash" | "email.untrash";
  addLabelIds: string[];
  removeLabelIds: string[];
  /**
   * `thread` changes every message (the conversation-level default).
   * `latest_message` changes only the newest message — used for STAR, because that
   * is exactly what clicking the star in Gmail's own UI does.
   */
  mode: "thread" | "latest_message";
  /** Past-tense phrase for the reply ("starred"). */
  summary: string;
  /** Present-tense phrase for a confirmation preview ("star"). */
  verb: string;
}

/**
 * PURE: map an action to its Gmail plan.
 *
 * The star/unstar asymmetry is the fix for the transcript, and it is deliberate:
 *  - STAR mirrors the UI and stars the newest message, so the row shows one star.
 *  - UNSTAR must clear the WHOLE conversation, because a single leftover starred
 *    message keeps the row starred — which is precisely what the user saw when we
 *    claimed to have unstarred it.
 * Everything else is what Gmail's UI does to a conversation.
 */
export function planFor(action: GmailManageAction, labelId?: string | null): MutationPlan | null {
  switch (action) {
    case "star":
      return {
        actionId: "email.modifyLabels",
        addLabelIds: ["STARRED"],
        removeLabelIds: [],
        mode: "latest_message",
        summary: "starred",
        verb: "star",
      };
    case "unstar":
      return {
        actionId: "email.modifyLabels",
        addLabelIds: [],
        removeLabelIds: ["STARRED"],
        mode: "thread",
        summary: "unstarred",
        verb: "unstar",
      };
    case "archive":
      return {
        actionId: "email.modifyLabels",
        addLabelIds: [],
        removeLabelIds: ["INBOX"],
        mode: "thread",
        summary: "archived",
        verb: "archive",
      };
    case "unarchive":
      return {
        actionId: "email.modifyLabels",
        addLabelIds: ["INBOX"],
        removeLabelIds: [],
        mode: "thread",
        summary: "moved back to your inbox",
        verb: "move back to your inbox",
      };
    case "mark_read":
      return {
        actionId: "email.modifyLabels",
        addLabelIds: [],
        removeLabelIds: ["UNREAD"],
        mode: "thread",
        summary: "marked as read",
        verb: "mark as read",
      };
    case "mark_unread":
      return {
        actionId: "email.modifyLabels",
        addLabelIds: ["UNREAD"],
        removeLabelIds: [],
        mode: "thread",
        summary: "marked as unread",
        verb: "mark as unread",
      };
    case "trash":
      return {
        actionId: "email.trash",
        addLabelIds: [],
        removeLabelIds: [],
        mode: "thread",
        summary: "moved to trash",
        verb: "move to your Gmail trash",
      };
    case "untrash":
      return {
        actionId: "email.untrash",
        addLabelIds: [],
        removeLabelIds: [],
        mode: "thread",
        summary: "restored",
        verb: "restore",
      };
    case "add_label": {
      const id = (labelId ?? "").trim();
      if (!id) return null;
      return {
        actionId: "email.modifyLabels",
        addLabelIds: [id],
        removeLabelIds: [],
        mode: "thread",
        summary: "labelled",
        verb: "label",
      };
    }
    case "remove_label": {
      const id = (labelId ?? "").trim();
      if (!id) return null;
      return {
        actionId: "email.modifyLabels",
        addLabelIds: [],
        removeLabelIds: [id],
        mode: "thread",
        summary: "unlabelled",
        verb: "remove the label from",
      };
    }
    default:
      return null;
  }
}

// --- Deps ----------------------------------------------------------------

export interface GmailCommandDeps {
  getTimezone?: (userId: string) => Promise<string | undefined>;
  extract?: (params: {
    text: string;
    todayLocal: string;
    timezone: string | undefined;
    generate?: TextGenerator;
  }) => Promise<GmailIntent | null>;
  generate?: TextGenerator;
  search?: typeof searchGmailMessages;
  judge?: RelevanceJudge;
  listLabels?: typeof listGmailLabels;
  loadSelection?: typeof loadLatestGmailSelection;
  recordSelection?: typeof recordGmailSelection;
  loadContext?: typeof loadGmailEntityContext;
  recordActed?: typeof recordActedEntity;
  recordSelected?: typeof recordSelectedEntity;
  fetchThreadState?: typeof fetchGmailThreadState;
  propose?: typeof createActionProposal;
  execute?: typeof executeAction;
  modifyCapability?: (userId: string) => Promise<ModifyCapability>;
  now?: Date;
}

export interface GmailCommandResult {
  handled: boolean;
  reply?: string;
  /** The operation taken, for safe logging (never contents). */
  operation?: string;
}

// --- Target resolution ---------------------------------------------------

/** A resolved set of conversations, or a reply to send instead. */
type TargetResolution =
  | { kind: "targets"; entities: GmailEntityRef[] }
  | { kind: "reply"; reply: string };

/**
 * Resolve WHICH conversations the user means.
 *
 * Priority is the whole design, and it mirrors how a person tracks a conversation:
 *   1. an explicit position ("the second one") -> the list on screen,
 *   2. an explicit reference to our last action ("the one you just starred"),
 *   3. "those"/"all of them" -> the whole list on screen,
 *   4. a bare pronoun ("unstar it") -> what we just acted on, else what was picked,
 *      else a single-result list,
 *   5. a named sender,
 *   6. otherwise ASK. Never guess — a guess mutates the wrong email.
 */
async function resolveTargets(
  userId: string,
  text: string | undefined,
  intent: GmailIntent,
  deps: GmailCommandDeps,
): Promise<TargetResolution> {
  const loadSelection = deps.loadSelection ?? loadLatestGmailSelection;
  const loadContext = deps.loadContext ?? loadGmailEntityContext;

  const ref =
    intent.ordinal && intent.ordinal >= 1 ? { position: intent.ordinal } : parseOrdinalReference(text);

  // 1 + 3: a position, or the whole list.
  if (ref || intent.all === true || intent.reference === "last_result_set") {
    const selection = await loadSelection(userId);
    if (!selection || selection.data.itemKind !== "messages") {
      return { kind: "reply", reply: GMAIL_CMD_REPLIES.noSelection };
    }
    if (ref) {
      const item = resolveSelectionItem(selection.data, ref);
      // An out-of-range position ASKS. Clamping to the nearest item would act on an
      // email the user never pointed at.
      if (!item) return { kind: "reply", reply: GMAIL_CMD_REPLIES.outOfRange };
      return { kind: "targets", entities: [toEntity(item)] };
    }
    const items = selection.data.items.slice(0, MODIFY_BATCH_CAP);
    if (items.length === 0) return { kind: "reply", reply: GMAIL_CMD_REPLIES.noSelection };
    return { kind: "targets", entities: items.map(toEntity) };
  }

  // 2 + 4: our last action, or a bare pronoun.
  const wantsActed = intent.reference === "last_acted" || referencesLastActed(text);
  const wantsPronoun = intent.reference === "pronoun";
  if (wantsActed || wantsPronoun) {
    const context = await loadContext(userId);
    const acted = context?.data.acted ?? null;
    // "the one you just starred" means EXACTLY that — never a fallback to something
    // else we happen to remember.
    if (wantsActed) {
      return acted
        ? { kind: "targets", entities: [acted.entity] }
        : { kind: "reply", reply: GMAIL_CMD_REPLIES.noTarget };
    }
    const entity = acted?.entity ?? context?.data.selected ?? null;
    if (entity) return { kind: "targets", entities: [entity] };
    // A pronoun with a single result on screen is unambiguous.
    const selection = await loadSelection(userId);
    const only = selection?.data.itemKind === "messages" && selection.data.items.length === 1
      ? selection.data.items[0]
      : null;
    if (only) return { kind: "targets", entities: [toEntity(only)] };
    return { kind: "reply", reply: GMAIL_CMD_REPLIES.noTarget };
  }

  // 5: a named sender — resolved to CONVERSATIONS, not messages.
  const sender = (intent.sender ?? "").trim();
  if (sender) {
    const search = deps.search ?? searchGmailMessages;
    const found = await search(userId, { from: sender, newerThanDays: CANDIDATE_DAYS }, { maxResults: 10 });
    const threads = dedupeToThreads(found);
    if (threads.length === 0) return { kind: "reply", reply: GMAIL_CMD_REPLIES.notFound };
    // Several distinct conversations is genuinely ambiguous — ask.
    if (threads.length > 1) return { kind: "reply", reply: GMAIL_CMD_REPLIES.noTarget };
    return { kind: "targets", entities: [threadToEntity(threads[0]!)] };
  }

  return { kind: "reply", reply: GMAIL_CMD_REPLIES.noTarget };
}

/** PURE: a remembered list item -> an entity. */
function toEntity(item: {
  id: string;
  threadId: string | null;
  label: string;
  subject: string;
}): GmailEntityRef {
  return {
    // A remembered item with no thread id predates thread-awareness; treating the
    // message as its own conversation is correct and keeps old context usable.
    threadId: item.threadId || item.id,
    messageId: item.id,
    label: item.label,
    subject: item.subject,
  };
}

/** PURE: a conversation -> an entity. */
function threadToEntity(thread: GmailThreadRef): GmailEntityRef {
  return {
    threadId: thread.threadId,
    messageId: thread.latest.id,
    label: displaySender(thread.latest),
    subject: displaySubject(thread.latest),
  };
}

/** PURE: a human phrase for a preview ("the email from Rob" / "3 conversations"). */
function targetPhrase(entities: readonly GmailEntityRef[]): string {
  if (entities.length === 1) {
    const label = entities[0]?.label?.trim();
    return label ? `the email from ${label}` : "that email";
  }
  return `${entities.length} conversations`;
}

/** Map a provider error to an honest reply. */
function replyForError(err: GmailError): string {
  if (err.reason === "not_connected") return GMAIL_CMD_REPLIES.notConnected;
  if (err.reason === "insufficient_scope" || isReconnectReason(err.reason)) {
    return GMAIL_CMD_REPLIES.reconnect;
  }
  return GMAIL_CMD_REPLIES.unavailable;
}

// --- Orchestrator --------------------------------------------------------

/**
 * Handle a Gmail command from an already-linked user. Returns `{ handled:false }`
 * only when this is not a Gmail command (or the interpreter is unreachable), so the
 * caller falls through unchanged. Never throws.
 */
export async function handleGmailCommand(
  userId: string,
  text: string | undefined,
  deps: GmailCommandDeps = {},
): Promise<GmailCommandResult> {
  if (!looksLikeGmailCommand(text)) return { handled: false };

  const getTz = deps.getTimezone ?? getUserTimezone;
  const extract = deps.extract ?? extractGmailIntent;
  const now = deps.now ?? new Date();

  let timezone: string | undefined;
  try {
    timezone = await getTz(userId);
  } catch {
    timezone = undefined;
  }

  const intent = await extract({
    text: text ?? "",
    todayLocal: localToday(now, timezone),
    timezone,
    generate: deps.generate,
  });
  if (!intent) {
    // The interpreter is unreachable or returned nonsense. A vague list question can
    // safely fall through; a request to CHANGE or CHECK state must not, because the
    // generic model has no inbox and would answer it with a promise. Failing
    // honestly is the only truthful option here.
    if (looksLikeManagementIntent(text)) {
      return { handled: true, operation: "unavailable", reply: GMAIL_CMD_REPLIES.unavailable };
    }
    return { handled: false };
  }
  // A confident "this isn't Gmail" falls through unchanged.
  if (intent.operation === "not_gmail") return { handled: false };

  try {
    switch (intent.operation) {
      case "list":
        return await runList(userId, intent, timezone, now, deps);
      case "manage":
        return await runManage(userId, text, intent, deps);
      case "undo":
        return await runUndo(userId, deps);
      case "verify_state":
        return await runVerifyState(userId, text, intent, deps);
      default:
        return { handled: false };
    }
  } catch (err) {
    if (err instanceof GmailError) {
      logger.error("gmail.command failed", {
        provider: GMAIL_PROVIDER,
        operation: `command.${intent.operation}`,
        errorCode: err.reason,
        httpStatus: err.httpStatus,
      });
      return { handled: true, operation: intent.operation, reply: replyForError(err) };
    }
    // We reached Gmail but couldn't judge the topic. Report THAT, not an empty inbox.
    if (err instanceof RelevanceUnavailableError) {
      logger.error("gmail.command relevance unavailable", { reason: err.message });
      return {
        handled: true,
        operation: intent.operation,
        reply: GMAIL_CMD_REPLIES.cannotJudge((intent.topic ?? "that").trim()),
      };
    }
    logger.error("gmail.command failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { handled: true, operation: intent.operation, reply: GMAIL_CMD_REPLIES.unavailable };
  }
}

// --- LIST ----------------------------------------------------------------

/**
 * PURE: turn a validated intent into typed search criteria.
 *
 * The TOPIC is deliberately absent: it never becomes a Gmail query term. Gmail's `q`
 * is a DSL, and a topic is the user's own words — matching "work" literally would
 * both miss the interview email that never says "work" and match a promotion that
 * happens to. Retrieval stays broad-but-bounded on real metadata; MEANING is judged
 * afterwards, over content, by `gmailRelevance`.
 */
export function criteriaFor(intent: GmailIntent): GmailSearchCriteria {
  const criteria: GmailSearchCriteria = {};
  if (intent.sender) criteria.from = intent.sender;
  if (intent.recipient) criteria.to = intent.recipient;
  if (intent.subject) criteria.subject = intent.subject;
  if (intent.unread === true) criteria.unread = true;
  if (intent.unread === false) criteria.unread = false;
  if (intent.starred === true) criteria.starred = true;
  if (intent.hasAttachment === true) criteria.hasAttachment = true;
  if (intent.after) criteria.after = intent.after;
  if (intent.before) criteria.before = intent.before;
  if (intent.mailbox === "sent") criteria.scope = "sent";
  else if (intent.mailbox === "anywhere") criteria.scope = "anywhere";
  else criteria.scope = "inbox";
  // A window always exists so retrieval can never be unbounded.
  criteria.newerThanDays =
    intent.newerThanDays && intent.newerThanDays >= 1 ? intent.newerThanDays : CANDIDATE_DAYS;
  return criteria;
}

async function runList(
  userId: string,
  intent: GmailIntent,
  timezone: string | undefined,
  now: Date,
  deps: GmailCommandDeps,
): Promise<GmailCommandResult> {
  const search = deps.search ?? searchGmailMessages;

  // 1. Bounded candidate retrieval from real Gmail metadata.
  const messages = await search(userId, criteriaFor(intent), {
    maxResults: MAX_RELEVANCE_CANDIDATES,
  });

  // 2. Deduplicate to conversations. This is what stops one Robert Ellis thread from
  //    filling the answer with four rows.
  const threads = dedupeToThreads(messages);
  if (threads.length === 0) {
    return { handled: true, operation: "list", reply: GMAIL_CMD_REPLIES.noResults };
  }

  // 3 + 4. Importance is deterministic; topic is judged semantically. Only what
  //        genuinely qualifies survives.
  const selected = await selectRelevantThreads(
    threads,
    {
      topic: intent.topic,
      importantOnly: intent.importantOnly === true || intent.needsActionOnly === true,
      count: intent.count,
      now,
    },
    { judge: deps.judge, generate: deps.generate },
  );

  if (selected.length === 0) {
    const topic = (intent.topic ?? "").trim();
    return {
      handled: true,
      operation: "list",
      reply: topic
        ? GMAIL_CMD_REPLIES.noneQualify(topic)
        : intent.importantOnly
          ? GMAIL_CMD_REPLIES.noneImportant
          : GMAIL_CMD_REPLIES.noResults,
    };
  }

  // 5. Remember EXACTLY what was shown, in order, so "the second one" resolves to
  //    the conversation the user is looking at — including its thread id.
  const record = deps.recordSelection ?? recordGmailSelection;
  try {
    await record(userId, {
      kind: "gmail_selection",
      itemKind: "messages",
      items: selected.map((t) => ({
        id: t.latest.id,
        threadId: t.threadId,
        label: displaySender(t.latest),
        subject: displaySubject(t.latest),
        receivedAt: t.latest.receivedAt,
      })),
    });
  } catch (err) {
    logger.error("gmail.command selection record failed", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }

  const body = formatEmailList(
    selected.map((t) => ({ message: t.latest })),
    timezone,
    now,
  );
  return { handled: true, operation: "list", reply: `${listHeader(intent, selected.length)}\n\n${body}` };
}

/**
 * PURE: the header for a list reply.
 *
 * Says what was actually found. The old flow said "Here are 5" because five was the
 * fetch size, not an answer — so the count only appears when the user asked for one.
 */
export function listHeader(intent: GmailIntent, count: number): string {
  const topic = (intent.topic ?? "").trim();
  const important = intent.importantOnly === true;
  const noun = count === 1 ? "email" : "emails";

  if (intent.count && intent.count >= 1) {
    return `Here ${count === 1 ? "is" : "are"} your ${count} most recent ${noun}:`;
  }
  if (topic && important) return `Here ${count === 1 ? "is" : "are"} the important ${topic} ${noun} I found:`;
  if (topic) return `Here ${count === 1 ? "is" : "are"} the ${noun} I found about ${topic}:`;
  if (important) return `Here ${count === 1 ? "is" : "are"} the ${noun} that look important:`;
  return `Here ${count === 1 ? "is" : "are"} what I found:`;
}

// --- MANAGE --------------------------------------------------------------

async function runManage(
  userId: string,
  text: string | undefined,
  intent: GmailIntent,
  deps: GmailCommandDeps,
): Promise<GmailCommandResult> {
  const action = intent.manageAction;
  if (!action) return { handled: true, operation: "manage", reply: GMAIL_CMD_REPLIES.noTarget };

  // Capability FIRST, once the request is understood: a user without gmail.modify
  // gets a specific reconnect instruction, and the request is never handed to the
  // model, which would deny a capability that exists.
  const capability = deps.modifyCapability
    ? await deps.modifyCapability(userId)
    : await defaultModifyCapability(userId);
  if (capability === "not_connected") {
    return { handled: true, operation: "manage", reply: GMAIL_CMD_REPLIES.notConnected };
  }
  if (capability === "connected_no_modify") {
    return { handled: true, operation: "manage", reply: GMAIL_CMD_REPLIES.reconnect };
  }

  const target = await resolveTargets(userId, text, intent, deps);
  if (target.kind === "reply") {
    return { handled: true, operation: "manage", reply: target.reply };
  }

  return await performMutation(userId, action, target.entities, intent.labelName ?? null, deps);
}

/** Resolve a user label NAME to a real Gmail label id. */
async function resolveLabelId(
  userId: string,
  action: GmailManageAction,
  labelName: string | null,
  deps: GmailCommandDeps,
): Promise<{ id: string; name: string } | { error: string } | null> {
  if (action !== "add_label" && action !== "remove_label") return null;
  const name = (labelName ?? "").trim();
  if (!name) return { error: GMAIL_CMD_REPLIES.needLabel };
  const listLabels = deps.listLabels ?? listGmailLabels;
  const found = findLabelByName(await listLabels(userId), name);
  // Never create a label the user doesn't have — a typo would litter their mailbox.
  if (!found) return { error: GMAIL_CMD_REPLIES.noSuchLabel(name) };
  return { id: found.id, name: found.name };
}

/**
 * Execute one conversation-level mutation: plan -> (confirm) -> execute -> VERIFY ->
 * remember. The entity is recorded ONLY from the executor's verified receipt.
 */
async function performMutation(
  userId: string,
  action: GmailManageAction,
  entities: GmailEntityRef[],
  labelName: string | null,
  deps: GmailCommandDeps,
): Promise<GmailCommandResult> {
  const label = await resolveLabelId(userId, action, labelName, deps);
  if (label && "error" in label) {
    return { handled: true, operation: "manage", reply: label.error };
  }
  const labelId = label?.id ?? null;

  const plan = planFor(action, labelId);
  if (!plan) return { handled: true, operation: "manage", reply: GMAIL_CMD_REPLIES.unavailable };

  const input = {
    threadIds: entities.map((e) => e.threadId),
    messageIds: entities.map((e) => e.messageId),
    op: action satisfies GmailMutationAction,
    mode: plan.mode,
    addLabelIds: plan.addLabelIds,
    removeLabelIds: plan.removeLabelIds,
    labelId,
    summary: plan.summary,
  };

  // Trash starts a deletion clock, and a bulk change is a different kind of mistake
  // from a single one — both are previewed and confirmed rather than run outright.
  const needsConfirm = action === "trash" || entities.length >= BULK_CONFIRM_THRESHOLD;
  if (needsConfirm) {
    const propose = deps.propose ?? createActionProposal;
    const preview =
      action === "trash"
        ? `I’ll move ${targetPhrase(entities)} to your Gmail trash. You can restore it from there for about 30 days — want me to go ahead?`
        : `I’ll ${plan.verb} ${targetPhrase(entities)}. Want me to go ahead?`;
    await propose(userId, {
      provider: GMAIL_PROVIDER,
      actionId: plan.actionId,
      riskLevel: action === "trash" ? "write" : "modify",
      confirmationRequired: true,
      input,
      previewText: preview,
    });
    return { handled: true, operation: "manage", reply: preview };
  }

  const execute = deps.execute ?? executeAction;
  const result = await execute(userId, plan.actionId, { input });

  // Remember ONLY what Gmail proved. An unverified change leaves the context alone,
  // so "undo that" can never reverse something that did not happen.
  const verifiedIds = result.receipt?.verifiedThreadIds ?? [];
  const verifiedEntity = entities.find((e) => verifiedIds.includes(e.threadId));
  if (result.ok && verifiedEntity) {
    const remember = deps.recordActed ?? recordActedEntity;
    try {
      await remember(userId, {
        entity: verifiedEntity,
        action: action satisfies GmailMutationAction,
        labelId,
        labelName: label && "name" in label ? label.name : null,
        at: new Date().toISOString(),
      });
    } catch (err) {
      logger.error("gmail.command acted-entity record failed", {
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return { handled: true, operation: "manage", reply: result.userMessage };
}

// --- UNDO ----------------------------------------------------------------

/**
 * Reverse the last VERIFIED action, and nothing else.
 *
 * "Undo" is never standing consent: it resolves against one recorded, proven action
 * and its documented inverse (`reverseOf`). With nothing recorded — or with an
 * action that cannot be reversed — it says so.
 */
async function runUndo(userId: string, deps: GmailCommandDeps): Promise<GmailCommandResult> {
  const loadContext = deps.loadContext ?? loadGmailEntityContext;
  const context = await loadContext(userId);
  const acted = context?.data.acted ?? null;
  if (!acted) return { handled: true, operation: "undo", reply: GMAIL_CMD_REPLIES.nothingToUndo };

  const reverse = reverseOf(acted.action);
  if (!reverse) {
    return {
      handled: true,
      operation: "undo",
      reply: GMAIL_CMD_REPLIES.cannotUndo(acted.action.replace(/_/g, " ")),
    };
  }

  const capability = deps.modifyCapability
    ? await deps.modifyCapability(userId)
    : await defaultModifyCapability(userId);
  if (capability === "not_connected") {
    return { handled: true, operation: "undo", reply: GMAIL_CMD_REPLIES.notConnected };
  }
  if (capability === "connected_no_modify") {
    return { handled: true, operation: "undo", reply: GMAIL_CMD_REPLIES.reconnect };
  }

  return await performMutation(
    userId,
    reverse as GmailManageAction,
    [acted.entity],
    acted.labelName,
    deps,
  );
}

// --- VERIFY STATE --------------------------------------------------------

/**
 * Answer "it's still starred" from Gmail's REAL state.
 *
 * This is the direct fix for the worst moment in the transcript: the generic model
 * replied "Let me take another look and remove that star for you", then "Unstarred
 * that email — the second one should now be clear", while the star sat there. It had
 * looked at nothing and done nothing.
 *
 * So the complaint is a Gmail operation. We re-read the conversation and answer from
 * what is actually there — and if the user is right, we say so plainly rather than
 * promising a fix we have not performed.
 */
async function runVerifyState(
  userId: string,
  text: string | undefined,
  intent: GmailIntent,
  deps: GmailCommandDeps,
): Promise<GmailCommandResult> {
  const loadContext = deps.loadContext ?? loadGmailEntityContext;
  const context = await loadContext(userId);
  const acted = context?.data.acted ?? null;

  // Nothing to check against -> resolve the target the normal way, or ask.
  if (!acted) {
    const target = await resolveTargets(userId, text, intent, deps);
    if (target.kind === "reply") return { handled: true, operation: "verify_state", reply: target.reply };
    return { handled: true, operation: "verify_state", reply: GMAIL_CMD_REPLIES.noTarget };
  }

  const expectation = expectationFor(acted.action, acted.labelId);
  if (!expectation) {
    return { handled: true, operation: "verify_state", reply: GMAIL_CMD_REPLIES.noTarget };
  }

  const fetchState = deps.fetchThreadState ?? fetchGmailThreadState;
  const state = await fetchState(userId, acted.entity.threadId);
  const holds = verifyThreadState(state, expectation);

  if (holds) {
    // Gmail really is in the state we claimed. Say what we can see, and don't argue
    // beyond it — the user may be looking at a different conversation.
    return {
      handled: true,
      operation: "verify_state",
      reply: `I’ve just checked ${targetPhrase([acted.entity])} in Gmail, and it shows as ${describeState(acted.action)}. If you’re seeing something different, it may be another conversation — want me to show you the list again?`,
    };
  }

  // The user is right and we were wrong. Offer to act; never claim we already have.
  const plan = planFor(acted.action as GmailManageAction, acted.labelId);
  return {
    handled: true,
    operation: "verify_state",
    reply: `You’re right — I’ve just checked and ${targetPhrase([acted.entity])} isn’t ${describeState(acted.action)} in Gmail. My earlier message was wrong. Want me to ${plan?.verb ?? "try that"} it again?`,
  };
}

/** PURE: how a completed action reads in a sentence. */
function describeState(action: GmailMutationAction): string {
  switch (action) {
    case "star":
      return "starred";
    case "unstar":
      return "unstarred";
    case "archive":
      return "archived";
    case "unarchive":
      return "back in your inbox";
    case "mark_read":
      return "read";
    case "mark_unread":
      return "unread";
    case "trash":
      return "in your trash";
    case "untrash":
      return "restored";
    case "add_label":
      return "labelled";
    case "remove_label":
      return "unlabelled";
    default:
      return "changed";
  }
}

/** Exported for the routing layer's honesty guard. */
export { DEFAULT_RESULT_CAP };
