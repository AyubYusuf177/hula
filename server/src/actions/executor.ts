import { logger } from "../utils/logger";
import { getUserTimezone } from "../reminders/reminders";
import {
  GoogleCalendarError,
  isReconnectReason as isCalendarReconnectReason,
} from "../integrations/providers/googleCalendar/client";
import { fetchUpcomingGoogleCalendarEvents } from "../integrations/providers/googleCalendar/events";
import { formatCalendarAnswer } from "../integrations/providers/googleCalendar/calendarQuestion";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
  type CalendarEventWriteFields,
} from "../integrations/providers/googleCalendar/calendarWrites";
import {
  CALENDAR_WRITE_REPLIES,
  formatCreated,
  formatDeleted,
  formatUpdated,
} from "../integrations/providers/googleCalendar/calendarActions";
import type { CalendarRange } from "../integrations/providers/googleCalendar/types";
import { GmailError, isReconnectReason } from "../integrations/providers/gmail/client";
import {
  createGmailDraft,
  deleteGmailDraft,
  sendGmailMessage,
  updateGmailDraft,
  type CreatedGmailDraft,
  type GmailRawPayload,
  type SentGmailMessage,
} from "../integrations/providers/gmail/drafts";
import {
  MODIFY_BATCH_CAP,
  modifyGmailMessageLabels,
  trashGmailMessage,
  untrashGmailMessage,
} from "../integrations/providers/gmail/messageActions";
import {
  fetchGmailThreadState,
  modifyGmailThreadLabels,
  trashGmailThread,
  untrashGmailThread,
} from "../integrations/providers/gmail/gmailThreads";
import {
  expectationFor,
  verifyThreadState,
  type GmailMutationAction,
} from "../integrations/providers/gmail/gmailVerify";
import { MimeError, buildGmailRawPayload } from "../integrations/providers/gmail/mime";
import { buildActionPolicyContext } from "./context";
import { evaluateActionForUser, type ActionPolicyContext } from "./policy";
import { recordActionExecution, type ActionExecutionStatusValue } from "./executions";
import { getActionDefinition } from "./registry";
import type { NormalizedCalendarEvent } from "../integrations/providers/googleCalendar/types";

/**
 * Action executor (Section 12).
 *
 * The ONLY path an action ever runs through. It loads the action definition,
 * applies policy, executes through a provider adapter strictly when the action is
 * `implemented + enabled` AND policy allows it, appends an execution to the
 * ledger, and returns an honest user-facing message. It NEVER calls a provider
 * for a stubbed action and NEVER returns a token or raw provider payload.
 *
 * Today only the two Google Calendar READ actions are implemented; every write /
 * send / purchase action resolves to an honest "not enabled yet" message and a
 * `blocked` ledger entry.
 */

export interface ExecuteActionOptions {
  /** Redacted input for the action (values may include text — never logged raw). */
  input?: Record<string, unknown>;
  /** True when the user has explicitly confirmed this action (e.g. via a proposal). */
  userConfirmed?: boolean;
  /** Optional proposal this execution fulfils, for ledger linkage. */
  proposalId?: string | null;
}

export interface ActionExecutionResult {
  ok: boolean;
  status: ActionExecutionStatusValue;
  actionId: string;
  provider?: string;
  /** Honest, user-facing text to relay. Never contains tokens. */
  userMessage: string;
  executionId?: string;
  /**
   * SAFE provider receipt for a completed action — Gmail-issued ids only, never a
   * token or raw payload. Present ONLY on a validated success (e.g. a created
   * draft), so callers that persist a follow-up reference (see the Gmail
   * last-draft context) can do so strictly from a real provider result.
   */
  receipt?: {
    draftId?: string;
    messageId?: string;
    threadId?: string;
    /** Google-issued Calendar event id, present only on a validated event write. */
    eventId?: string;
    /**
     * The conversations whose expected end state was READ BACK from Gmail and
     * matched (Section 17 correction). Present only on a verified mutation, so a
     * caller that remembers "the email you just starred" can only ever remember
     * something that provably happened.
     */
    verifiedThreadIds?: string[];
  };
}

/**
 * Injectable dependencies. Defaults use the real DB/provider helpers; tests pass
 * fakes so the executor can be exercised with NO database and NO network.
 */
export interface ExecuteActionDeps {
  buildContext?: (
    userId: string,
    opts: { userConfirmed?: boolean },
  ) => Promise<ActionPolicyContext>;
  fetchEvents?: (
    userId: string,
    options: { range: CalendarRange; maxResults: number; timezone?: string },
  ) => Promise<NormalizedCalendarEvent[]>;
  getTimezone?: (userId: string) => Promise<string | undefined>;
  record?: typeof recordActionExecution;
  /** Gmail draft/send provider fns — injected so tests never hit Gmail. */
  createGmailDraft?: (
    userId: string,
    payload: GmailRawPayload,
  ) => Promise<CreatedGmailDraft>;
  sendGmailMessage?: (
    userId: string,
    payload: GmailRawPayload,
  ) => Promise<SentGmailMessage>;
  /** Gmail draft lifecycle provider fns — injected so tests never hit Gmail. */
  updateGmailDraft?: (
    userId: string,
    draftId: string,
    payload: GmailRawPayload,
  ) => Promise<CreatedGmailDraft>;
  deleteGmailDraft?: (userId: string, draftId: string) => Promise<void>;
  /** Gmail message-management provider fns — injected so tests never hit Gmail. */
  modifyGmailMessageLabels?: typeof modifyGmailMessageLabels;
  trashGmailMessage?: typeof trashGmailMessage;
  untrashGmailMessage?: typeof untrashGmailMessage;
  /** Gmail THREAD provider fns (Section 17 correction) — conversation-level state. */
  modifyGmailThreadLabels?: typeof modifyGmailThreadLabels;
  trashGmailThread?: typeof trashGmailThread;
  untrashGmailThread?: typeof untrashGmailThread;
  /** Reads back real state to VERIFY a mutation before it is reported as done. */
  fetchGmailThreadState?: typeof fetchGmailThreadState;
  /** Calendar write provider fns — injected so tests never hit Google. */
  createCalendarEvent?: typeof createCalendarEvent;
  updateCalendarEvent?: typeof updateCalendarEvent;
  deleteCalendarEvent?: typeof deleteCalendarEvent;
}

/** Generic stub reply for a defined-but-unimplemented action. */
const GENERIC_STUB =
  "I can’t do that action yet, but the backend contract is ready for it.";

/** Read `range` from input as a valid CalendarRange, defaulting to today. */
function readRange(input: Record<string, unknown> | undefined): CalendarRange {
  const raw = typeof input?.range === "string" ? input.range : "today";
  if (raw === "tomorrow" || raw === "week" || raw === "next") return raw;
  return "today";
}

/**
 * Execute a typed action for a user. Never throws — every failure resolves to a
 * safe result and a ledger entry.
 */
export async function executeAction(
  userId: string,
  actionId: string,
  options: ExecuteActionOptions = {},
  deps: ExecuteActionDeps = {},
): Promise<ActionExecutionResult> {
  const buildContext = deps.buildContext ?? buildActionPolicyContext;
  const fetchEvents = deps.fetchEvents ?? fetchUpcomingGoogleCalendarEvents;
  const getTz = deps.getTimezone ?? getUserTimezone;
  const record = deps.record ?? recordActionExecution;

  const input = options.input;
  const inputKeys = input ? Object.keys(input) : [];

  const action = getActionDefinition(actionId);
  if (!action) {
    const executionId = await record(userId, {
      actionId,
      status: "failed",
      errorMessage: "unknown_action",
    });
    return {
      ok: false,
      status: "failed",
      actionId,
      userMessage: GENERIC_STUB,
      executionId,
    };
  }

  // Gate everything through policy first.
  const ctx = await buildContext(userId, {
    userConfirmed: options.userConfirmed,
  });
  const policy = evaluateActionForUser(action, ctx);

  if (!policy.allowed) {
    const executionId = await record(userId, {
      proposalId: options.proposalId ?? null,
      provider: policy.provider ?? action.providerTypes[0] ?? null,
      actionId,
      status: "blocked",
      requestSummary: { inputKeys, blockedReason: policy.blockedReason },
    });
    return {
      ok: false,
      status: "blocked",
      actionId,
      provider: policy.provider,
      userMessage: policy.userMessage ?? action.userFacingDescription ?? GENERIC_STUB,
      executionId,
    };
  }

  // Allowed + implemented. Only the calendar reads have a real adapter today.
  try {
    if (actionId === "calendar.listEvents" || actionId === "calendar.findNextEvent") {
      const range: CalendarRange =
        actionId === "calendar.findNextEvent" ? "next" : readRange(input);
      const maxResults =
        range === "next"
          ? 1
          : typeof input?.maxResults === "number"
            ? input.maxResults
            : 10;
      const timezone = await getTz(userId);
      const events = await fetchEvents(userId, { range, maxResults, timezone });
      const userMessage = formatCalendarAnswer(range, events, timezone);
      const executionId = await record(userId, {
        proposalId: options.proposalId ?? null,
        provider: policy.provider ?? "google_calendar",
        actionId,
        status: "succeeded",
        requestSummary: { range, maxResults },
        // Ledger keeps only a COUNT — never event titles or raw payloads.
        resultSummary: { eventCount: events.length },
      });
      return {
        ok: true,
        status: "succeeded",
        actionId,
        provider: policy.provider ?? "google_calendar",
        userMessage,
        executionId,
      };
    }

    // Calendar event create / update / cancel (Section 17). The structured,
    // ALREADY-RESOLVED event id and times arrive in `input` from a CONFIRMED
    // proposal (see `calendarActions`). The executor performs the provider write and
    // confirms strictly from Google's validated response — it never resolves an
    // event itself, so an ambiguous or recurring target can never reach here.
    if (
      actionId === "calendar.createEvent" ||
      actionId === "calendar.updateEvent" ||
      actionId === "calendar.cancelEvent"
    ) {
      return await runCalendarWrite(
        userId,
        actionId,
        input,
        policy.provider ?? "google_calendar",
        {
          record,
          proposalId: options.proposalId ?? null,
          inputKeys,
          create: deps.createCalendarEvent ?? createCalendarEvent,
          update: deps.updateCalendarEvent ?? updateCalendarEvent,
          remove: deps.deleteCalendarEvent ?? deleteCalendarEvent,
        },
      );
    }

    // Gmail CONVERSATION management (Section 17 correction). Chosen by the presence
    // of `threadIds`: this is the UI-aligned path, where a change is applied at the
    // level the user perceives and then VERIFIED against Gmail's real state before
    // anything is reported. The message-level path below stays for callers that
    // genuinely mean one message.
    if (
      (actionId === "email.modifyLabels" ||
        actionId === "email.trash" ||
        actionId === "email.untrash") &&
      readStrArray(input, "threadIds").length > 0
    ) {
      return await runGmailThreadManagement(
        userId,
        actionId,
        input,
        policy.provider ?? "gmail",
        {
          record,
          proposalId: options.proposalId ?? null,
          inputKeys,
          modifyThread: deps.modifyGmailThreadLabels ?? modifyGmailThreadLabels,
          modifyMessage: deps.modifyGmailMessageLabels ?? modifyGmailMessageLabels,
          trashThread: deps.trashGmailThread ?? trashGmailThread,
          untrashThread: deps.untrashGmailThread ?? untrashGmailThread,
          fetchState: deps.fetchGmailThreadState ?? fetchGmailThreadState,
        },
      );
    }

    // Gmail MESSAGE MANAGEMENT (Section 17 / 3.5) — label changes, trash, untrash.
    // Message ids and label ids arrive ALREADY RESOLVED and validated; the executor
    // performs the provider calls and confirms only from Gmail's real responses.
    if (
      actionId === "email.modifyLabels" ||
      actionId === "email.trash" ||
      actionId === "email.untrash"
    ) {
      return await runGmailMessageManagement(
        userId,
        actionId,
        input,
        policy.provider ?? "gmail",
        {
          record,
          proposalId: options.proposalId ?? null,
          inputKeys,
          modify: deps.modifyGmailMessageLabels ?? modifyGmailMessageLabels,
          trash: deps.trashGmailMessage ?? trashGmailMessage,
          untrash: deps.untrashGmailMessage ?? untrashGmailMessage,
        },
      );
    }

    // Gmail draft EDIT / DELETE (Section 17). The draft id arrives ALREADY RESOLVED
    // from the lifecycle handler (which re-fetched it), and for an edit the complete
    // new MIME is already built. The executor performs the provider write and
    // confirms strictly from Gmail's validated response.
    if (actionId === "email.updateDraft" || actionId === "email.deleteDraft") {
      return await runGmailDraftLifecycle(
        userId,
        actionId,
        input,
        policy.provider ?? "gmail",
        {
          record,
          proposalId: options.proposalId ?? null,
          inputKeys,
          update: deps.updateGmailDraft ?? updateGmailDraft,
          remove: deps.deleteGmailDraft ?? deleteGmailDraft,
        },
      );
    }

    // Gmail draft creation / send (Section 16). The structured, ALREADY-RESOLVED
    // recipient/thread fields arrive in `input` (from the Gmail-write service or a
    // confirmed send proposal). The executor validates them, builds the MIME, and
    // performs the provider write — it never resolves a recipient itself.
    if (actionId === "email.createDraft" || actionId === "email.sendDraft") {
      return await runGmailWrite(userId, actionId, input, policy.provider ?? "gmail", {
        record,
        proposalId: options.proposalId ?? null,
        inputKeys,
        createDraft: deps.createGmailDraft ?? createGmailDraft,
        sendMessage: deps.sendGmailMessage ?? sendGmailMessage,
      });
    }

    // Allowed but no adapter wired (should not happen while only reads are
    // implemented) — stay honest and log it.
    const executionId = await record(userId, {
      proposalId: options.proposalId ?? null,
      provider: policy.provider ?? action.providerTypes[0] ?? null,
      actionId,
      status: "failed",
      requestSummary: { inputKeys },
      errorMessage: "no_adapter",
    });
    return {
      ok: false,
      status: "failed",
      actionId,
      provider: policy.provider,
      userMessage: action.userFacingDescription ?? GENERIC_STUB,
      executionId,
    };
  } catch (err) {
    // Provider/DB failure — never surface token/secret detail.
    const notConnected =
      err instanceof GoogleCalendarError && err.reason === "not_connected";
    logger.error("action.execute failed", {
      actionId,
      reason: err instanceof Error ? err.message : "unknown error",
    });
    const executionId = await record(userId, {
      proposalId: options.proposalId ?? null,
      provider: policy.provider ?? action.providerTypes[0] ?? null,
      actionId,
      status: "failed",
      requestSummary: { inputKeys },
      errorMessage: notConnected ? "not_connected" : "execution_failed",
    });
    return {
      ok: false,
      status: "failed",
      actionId,
      provider: policy.provider,
      userMessage: notConnected
        ? "I don’t have that app connected yet, so I can’t do that."
        : "I ran into a problem trying to do that — mind trying again in a bit?",
      executionId,
    };
  }
}

/**
 * Execute a Calendar create/update/cancel from ALREADY-RESOLVED structured input
 * (Section 17).
 *
 * The proposal carries the exact Google event id and the exact ISO instants that
 * were previewed to the user, so this performs the write and nothing else — it
 * resolves no events, re-parses no dates, and re-checks no ambiguity. Success is
 * claimed ONLY from Google's validated response (`calendarWrites` enforces a real
 * event id); a thrown provider error is mapped to an honest reply. Never throws.
 */
async function runCalendarWrite(
  userId: string,
  actionId: "calendar.createEvent" | "calendar.updateEvent" | "calendar.cancelEvent",
  input: Record<string, unknown> | undefined,
  provider: string,
  ctx: {
    record: typeof recordActionExecution;
    proposalId: string | null;
    inputKeys: string[];
    create: typeof createCalendarEvent;
    update: typeof updateCalendarEvent;
    remove: typeof deleteCalendarEvent;
  },
): Promise<ActionExecutionResult> {
  const timezone = readStr(input, "timezone") || undefined;
  const eventId = readStr(input, "eventId");
  const title = readStr(input, "title");
  const startIso = readStr(input, "startIso");
  const endIso = readStr(input, "endIso");

  const fail = async (
    errorMessage: string,
    userMessage: string,
  ): Promise<ActionExecutionResult> => {
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "failed",
      requestSummary: { inputKeys: ctx.inputKeys },
      errorMessage,
    });
    return { ok: false, status: "failed", actionId, provider, userMessage, executionId };
  };

  try {
    if (actionId === "calendar.createEvent") {
      if (!title || !startIso || !endIso) {
        return await fail("invalid_input", CALENDAR_WRITE_REPLIES.unavailable);
      }
      // Re-check never-past HERE, not just at proposal time. Deferring the write
      // until confirmation opens a window (up to the proposal TTL) in which a
      // previewed start can slip into the past — the proposal-time check alone no
      // longer covers it.
      const startMs = new Date(startIso).getTime();
      if (!Number.isFinite(startMs) || startMs <= Date.now()) {
        return await fail("start_in_past", CALENDAR_WRITE_REPLIES.inPast);
      }
      const fields: CalendarEventWriteFields = {
        summary: title,
        start: { dateTime: startIso, timeZone: timezone },
        end: { dateTime: endIso, timeZone: timezone },
      };
      const location = readStr(input, "location");
      const description = readStr(input, "description");
      if (location) fields.location = location;
      if (description) fields.description = description;

      const event = await ctx.create(userId, fields);
      const executionId = await ctx.record(userId, {
        proposalId: ctx.proposalId,
        provider,
        actionId,
        status: "succeeded",
        requestSummary: { hasLocation: Boolean(location), hasDescription: Boolean(description) },
        // Ledger keeps only the Google-issued id — never the title or times.
        resultSummary: { eventId: event.id },
      });
      return {
        ok: true,
        status: "succeeded",
        actionId,
        provider,
        userMessage: formatCreated(event, timezone),
        executionId,
        receipt: { eventId: event.id },
      };
    }

    if (actionId === "calendar.updateEvent") {
      if (!eventId) return await fail("invalid_input", CALENDAR_WRITE_REPLIES.unavailable);
      const fields: CalendarEventWriteFields = {};
      const newTitle = readStr(input, "newTitle");
      const newLocation = readStr(input, "newLocation");
      if (newTitle) fields.summary = newTitle;
      if (newLocation) fields.location = newLocation;
      if (startIso && endIso) {
        // Same never-past re-check as create: a reschedule confirmed late must not
        // land the event in the past.
        const startMs = new Date(startIso).getTime();
        if (!Number.isFinite(startMs) || startMs <= Date.now()) {
          return await fail("start_in_past", CALENDAR_WRITE_REPLIES.inPast);
        }
        fields.start = { dateTime: startIso, timeZone: timezone };
        fields.end = { dateTime: endIso, timeZone: timezone };
      }
      if (Object.keys(fields).length === 0) {
        return await fail("invalid_input", CALENDAR_WRITE_REPLIES.needChange);
      }

      const event = await ctx.update(userId, eventId, fields);
      const executionId = await ctx.record(userId, {
        proposalId: ctx.proposalId,
        provider,
        actionId,
        status: "succeeded",
        requestSummary: { changedKeys: Object.keys(fields) },
        resultSummary: { eventId: event.id },
      });
      return {
        ok: true,
        status: "succeeded",
        actionId,
        provider,
        userMessage: formatUpdated(event, timezone, input?.renamedOnly === true),
        executionId,
        receipt: { eventId: event.id },
      };
    }

    // Cancel/delete. `deleteCalendarEvent` returns normally ONLY on a 2xx from
    // Google (204 No Content for a successful delete); any other status throws a
    // classified error. The confirmation uses the details captured at proposal
    // time because a deleted event has no response body to read them back from.
    if (!eventId) return await fail("invalid_input", CALENDAR_WRITE_REPLIES.unavailable);
    await ctx.remove(userId, eventId);
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "succeeded",
      requestSummary: {},
      resultSummary: { eventId },
    });
    return {
      ok: true,
      status: "succeeded",
      actionId,
      provider,
      userMessage: formatDeleted(
        {
          id: eventId,
          calendarId: "primary",
          summary: title || null,
          location: null,
          start: startIso || null,
          end: endIso || null,
          allDay: false,
          status: null,
          htmlLink: null,
          attendeeCount: null,
          organizerEmail: null,
          source: "google_calendar",
        },
        timezone,
      ),
      executionId,
      receipt: { eventId },
    };
  } catch (err) {
    const calErr = err instanceof GoogleCalendarError ? err : null;
    logger.error("action.calendarWrite failed", {
      actionId,
      errorCode: calErr?.reason ?? "unknown",
      httpStatus: calErr?.httpStatus ?? null,
    });
    let userMessage: string = CALENDAR_WRITE_REPLIES.unavailable;
    if (calErr?.reason === "not_connected") userMessage = CALENDAR_WRITE_REPLIES.notConnected;
    else if (
      calErr &&
      (calErr.reason === "insufficient_scope" || isCalendarReconnectReason(calErr.reason))
    ) {
      userMessage = CALENDAR_WRITE_REPLIES.reconnect;
    } else if (calErr?.reason === "calendar_not_found") {
      userMessage = CALENDAR_WRITE_REPLIES.notFound;
    }
    return await fail(calErr?.reason ?? "execution_failed", userMessage);
  }
}

/** PURE: read a string field from redacted input, trimmed, or "". */
function readStr(input: Record<string, unknown> | undefined, key: string): string {
  const v = input?.[key];
  return typeof v === "string" ? v.trim() : "";
}

/** A recipient's display label: prefer the name, else the bare address. */
function recipientLabel(name: string, address: string): string {
  return name ? name : address;
}

/** Honest replies for the Gmail write executor (never leak provider detail). */
const GMAIL_EXEC_REPLIES = {
  missingInfo: "I don’t have enough to send that — I’m missing the recipient, subject, or message.",
  notConnected: "Your Gmail isn’t connected, so I can’t do that.",
  reconnect: "I don’t have permission to draft or send on your Gmail yet — reconnect it in Hula.",
  unavailable: "I couldn’t reach Gmail just now — mind trying again in a bit?",
  draftGone: "That draft isn’t in your Gmail anymore — it may have been sent or deleted already.",
  // Distinct from `reconnect`: this names the NEW Section 17 permission, so a user
  // who connected for drafting isn't told their draft access is broken.
  modifyReconnect:
    "I don’t have permission to manage your emails yet — reconnect Gmail in Hula to let me mark, star, archive, and trash.",
  /**
   * Gmail accepted the change, but reading the conversation back did NOT show the
   * state we promised. This is the reply that had to exist: the shipped bug said
   * "Unstarred 1 email" in exactly this situation, and the star was still there. We
   * do not retry automatically — a blind retry of a change that may have partly
   * landed is how one email gets acted on twice.
   */
  unverified:
    "I asked Gmail to make that change, but when I checked, it hadn’t taken effect. I haven’t tried again — mind taking a look, or asking me once more?",
} as const;

/** PURE: read a bounded string[] from redacted input. */
function readStrArray(input: Record<string, unknown> | undefined, key: string): string[] {
  const v = input?.[key];
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
    .slice(0, MODIFY_BATCH_CAP);
}

/**
 * Execute Gmail message management from ALREADY-RESOLVED ids (Section 17 / 3.5).
 *
 * Gmail has no batch endpoint for these, so a multi-message request is N calls and
 * can PARTIALLY fail. That is the whole difficulty here: reporting "archived 5
 * emails" when two failed would be a straightforward lie, and silently dropping the
 * failures is worse. So each message is tracked individually and the reply states
 * exactly what happened — all, some, or none.
 *
 * Success per message is Gmail echoing back that message's own id (enforced in the
 * provider layer). Never throws.
 */
/**
 * Gmail CONVERSATION management with POSTCONDITION VERIFICATION (Section 17
 * correction).
 *
 * The rule this function exists to enforce: a 2xx from Gmail is NOT evidence the
 * user's inbox looks the way they asked. So every mutation here is followed by a
 * read-back of the conversation's real label state, checked against the state the
 * action declared it would produce (`expectationFor`). Only a conversation that
 * PROVES the expected state counts as succeeded.
 *
 * The two levels are a deliberate combination, not a blanket switch:
 *  - `mode: "latest_message"` (star) mirrors Gmail's own UI, which stars the newest
 *    message of a conversation rather than every message in it.
 *  - `mode: "thread"` (everything else) matches what the UI does at conversation
 *    level — and, for unstar, is the only thing that can clear a star the user can
 *    see, because any remaining starred message keeps the row starred.
 * Either way the VERIFICATION is always thread-level, because that is what the user
 * is looking at.
 */
async function runGmailThreadManagement(
  userId: string,
  actionId: "email.modifyLabels" | "email.trash" | "email.untrash",
  input: Record<string, unknown> | undefined,
  provider: string,
  ctx: {
    record: typeof recordActionExecution;
    proposalId: string | null;
    inputKeys: string[];
    modifyThread: typeof modifyGmailThreadLabels;
    modifyMessage: typeof modifyGmailMessageLabels;
    trashThread: typeof trashGmailThread;
    untrashThread: typeof untrashGmailThread;
    fetchState: typeof fetchGmailThreadState;
  },
): Promise<ActionExecutionResult> {
  const threadIds = readStrArray(input, "threadIds").slice(0, MODIFY_BATCH_CAP);
  const messageIds = readStrArray(input, "messageIds");
  const addLabelIds = readStrArray(input, "addLabelIds");
  const removeLabelIds = readStrArray(input, "removeLabelIds");
  const op = readStr(input, "op") as GmailMutationAction;
  const labelId = readStr(input, "labelId") || null;
  const mode = readStr(input, "mode") === "latest_message" ? "latest_message" : "thread";
  const summary = readStr(input, "summary") || "updated";

  const fail = async (
    errorMessage: string,
    userMessage: string,
  ): Promise<ActionExecutionResult> => {
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "failed",
      requestSummary: { inputKeys: ctx.inputKeys, threadCount: threadIds.length },
      errorMessage,
    });
    return { ok: false, status: "failed", actionId, provider, userMessage, executionId };
  };

  if (threadIds.length === 0) return await fail("invalid_input", GMAIL_EXEC_REPLIES.unavailable);

  // The expectation IS the contract. Without one we cannot prove anything, so we
  // refuse to run rather than perform an unverifiable change.
  const expectation = expectationFor(op, labelId);
  if (!expectation) return await fail("invalid_input", GMAIL_EXEC_REPLIES.unavailable);

  const verified: string[] = [];
  const unverified: string[] = [];
  let firstError: GmailError | null = null;

  for (const [index, threadId] of threadIds.entries()) {
    try {
      // 1. Mutate at the level that matches what the user sees.
      if (actionId === "email.trash") {
        await ctx.trashThread(userId, threadId);
      } else if (actionId === "email.untrash") {
        await ctx.untrashThread(userId, threadId);
      } else if (mode === "latest_message") {
        const messageId = messageIds[index];
        if (!messageId) throw new GmailError("malformed_provider_response", "No message to change");
        await ctx.modifyMessage(userId, messageId, { addLabelIds, removeLabelIds });
      } else {
        await ctx.modifyThread(userId, threadId, { addLabelIds, removeLabelIds });
      }

      // 2. PROVE it. Gmail's acceptance is not the outcome; the conversation's real
      //    state is. This read-back is the whole point of this function.
      const state = await ctx.fetchState(userId, threadId);
      if (verifyThreadState(state, expectation)) verified.push(threadId);
      else unverified.push(threadId);
    } catch (err) {
      const gmailErr = err instanceof GmailError ? err : null;
      if (!firstError && gmailErr) firstError = gmailErr;
      unverified.push(threadId);
      logger.error("action.gmailThreadManagement failed", {
        actionId,
        op,
        errorCode: gmailErr?.reason ?? "unknown",
        httpStatus: gmailErr?.httpStatus ?? null,
      });
      // A dead grant / missing scope applies to EVERY thread — stop rather than
      // hammer Gmail with calls that will all fail identically.
      if (
        gmailErr &&
        (gmailErr.reason === "not_connected" ||
          gmailErr.reason === "insufficient_scope" ||
          isReconnectReason(gmailErr.reason))
      ) {
        break;
      }
    }
  }

  if (verified.length === 0) {
    let userMessage: string = GMAIL_EXEC_REPLIES.unavailable;
    if (firstError?.reason === "not_connected") userMessage = GMAIL_EXEC_REPLIES.notConnected;
    else if (
      firstError &&
      (firstError.reason === "insufficient_scope" || isReconnectReason(firstError.reason))
    ) {
      userMessage = GMAIL_EXEC_REPLIES.modifyReconnect;
    } else if (!firstError) {
      // Gmail took the change and simply did not end up in the promised state.
      userMessage = GMAIL_EXEC_REPLIES.unverified;
    }
    return await fail(firstError?.reason ?? "postcondition_unverified", userMessage);
  }

  const failedCount = threadIds.length - verified.length;
  const executionId = await ctx.record(userId, {
    proposalId: ctx.proposalId,
    provider,
    actionId,
    status: failedCount > 0 ? "failed" : "succeeded",
    requestSummary: { threadCount: threadIds.length, op, addLabelIds, removeLabelIds },
    // Ledger keeps counts + Gmail ids only — never senders or subjects.
    resultSummary: { verified: verified.length, unverified: failedCount },
    errorMessage: failedCount > 0 ? "postcondition_unverified" : null,
  });

  const noun = verified.length === 1 ? "conversation" : "conversations";
  // Partial success is reported as partial — never rounded up to "done".
  const userMessage =
    failedCount > 0
      ? `I ${summary} ${verified.length} of ${threadIds.length} ${noun}, but couldn’t confirm the rest changed.`
      : `${capitalise(summary)} ${verified.length} ${noun}.`;

  return {
    ok: failedCount === 0,
    status: failedCount > 0 ? "failed" : "succeeded",
    actionId,
    provider,
    userMessage,
    executionId,
    // The caller records the acted-on entity ONLY from this verified set, so "undo
    // that" can never reverse something that did not happen.
    receipt: { verifiedThreadIds: verified },
  };
}

/** PURE: sentence-case a summary phrase for the start of a reply. */
function capitalise(text: string): string {
  return text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

async function runGmailMessageManagement(
  userId: string,
  actionId: "email.modifyLabels" | "email.trash" | "email.untrash",
  input: Record<string, unknown> | undefined,
  provider: string,
  ctx: {
    record: typeof recordActionExecution;
    proposalId: string | null;
    inputKeys: string[];
    modify: typeof modifyGmailMessageLabels;
    trash: typeof trashGmailMessage;
    untrash: typeof untrashGmailMessage;
  },
): Promise<ActionExecutionResult> {
  const messageIds = readStrArray(input, "messageIds");
  const addLabelIds = readStrArray(input, "addLabelIds");
  const removeLabelIds = readStrArray(input, "removeLabelIds");
  // A human phrase for the reply ("marked as read"), built by the routing layer.
  const summary = readStr(input, "summary") || "updated";

  const fail = async (
    errorMessage: string,
    userMessage: string,
  ): Promise<ActionExecutionResult> => {
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "failed",
      requestSummary: { inputKeys: ctx.inputKeys, messageCount: messageIds.length },
      errorMessage,
    });
    return { ok: false, status: "failed", actionId, provider, userMessage, executionId };
  };

  if (messageIds.length === 0) return await fail("invalid_input", GMAIL_EXEC_REPLIES.unavailable);
  if (
    actionId === "email.modifyLabels" &&
    addLabelIds.length === 0 &&
    removeLabelIds.length === 0
  ) {
    return await fail("invalid_input", GMAIL_EXEC_REPLIES.unavailable);
  }

  const succeeded: string[] = [];
  let firstError: GmailError | null = null;

  for (const id of messageIds) {
    try {
      if (actionId === "email.modifyLabels") {
        await ctx.modify(userId, id, { addLabelIds, removeLabelIds });
      } else if (actionId === "email.trash") {
        await ctx.trash(userId, id);
      } else {
        await ctx.untrash(userId, id);
      }
      succeeded.push(id);
    } catch (err) {
      const gmailErr = err instanceof GmailError ? err : null;
      if (!firstError && gmailErr) firstError = gmailErr;
      logger.error("action.gmailMessageManagement failed", {
        actionId,
        errorCode: gmailErr?.reason ?? "unknown",
        httpStatus: gmailErr?.httpStatus ?? null,
      });
      // A dead grant / missing scope applies to EVERY message — stop rather than
      // hammer Gmail with N calls that will all fail the same way.
      if (
        gmailErr &&
        (gmailErr.reason === "not_connected" ||
          gmailErr.reason === "insufficient_scope" ||
          isReconnectReason(gmailErr.reason))
      ) {
        break;
      }
    }
  }

  const failedCount = messageIds.length - succeeded.length;

  if (succeeded.length === 0) {
    let userMessage: string = GMAIL_EXEC_REPLIES.unavailable;
    if (firstError?.reason === "not_connected") userMessage = GMAIL_EXEC_REPLIES.notConnected;
    else if (
      firstError &&
      (firstError.reason === "insufficient_scope" || isReconnectReason(firstError.reason))
    ) {
      userMessage = GMAIL_EXEC_REPLIES.modifyReconnect;
    }
    return await fail(firstError?.reason ?? "execution_failed", userMessage);
  }

  const executionId = await ctx.record(userId, {
    proposalId: ctx.proposalId,
    provider,
    actionId,
    status: failedCount > 0 ? "failed" : "succeeded",
    requestSummary: { messageCount: messageIds.length, addLabelIds, removeLabelIds },
    // Ledger keeps counts + Gmail ids only — never senders or subjects.
    resultSummary: { succeeded: succeeded.length, failed: failedCount },
    errorMessage: failedCount > 0 ? (firstError?.reason ?? "partial_failure") : null,
  });

  const noun = succeeded.length === 1 ? "email" : "emails";
  // Partial success is reported as partial — never rounded up to "done".
  const userMessage =
    failedCount > 0
      ? `${summary} ${succeeded.length} of ${messageIds.length} ${noun} — the rest didn’t go through.`
      : `${summary} ${succeeded.length} ${noun}.`;

  return {
    ok: failedCount === 0,
    status: failedCount > 0 ? "failed" : "succeeded",
    actionId,
    provider,
    userMessage: userMessage.charAt(0).toUpperCase() + userMessage.slice(1),
    executionId,
  };
}

/**
 * Execute a Gmail draft EDIT or DELETE from an ALREADY-RESOLVED draft id
 * (Section 17).
 *
 * The lifecycle handler resolved the draft, re-fetched its current state, and (for
 * an edit) built the complete replacement MIME — so this performs the provider call
 * and nothing else. Success is claimed ONLY from Gmail's validated response
 * (`updateGmailDraft` enforces a returned id matching the one targeted; a delete
 * returns normally only on a 2xx). Never throws.
 */
async function runGmailDraftLifecycle(
  userId: string,
  actionId: "email.updateDraft" | "email.deleteDraft",
  input: Record<string, unknown> | undefined,
  provider: string,
  ctx: {
    record: typeof recordActionExecution;
    proposalId: string | null;
    inputKeys: string[];
    update: (
      userId: string,
      draftId: string,
      payload: GmailRawPayload,
    ) => Promise<CreatedGmailDraft>;
    remove: (userId: string, draftId: string) => Promise<void>;
  },
): Promise<ActionExecutionResult> {
  const draftId = readStr(input, "draftId");
  const label = readStr(input, "label") || readStr(input, "to");

  const fail = async (
    errorMessage: string,
    userMessage: string,
  ): Promise<ActionExecutionResult> => {
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "failed",
      requestSummary: { inputKeys: ctx.inputKeys },
      errorMessage,
    });
    return { ok: false, status: "failed", actionId, provider, userMessage, executionId };
  };

  if (!draftId) return await fail("invalid_input", GMAIL_EXEC_REPLIES.unavailable);

  try {
    if (actionId === "email.updateDraft") {
      const raw = readStr(input, "raw");
      if (!raw) return await fail("invalid_input", GMAIL_EXEC_REPLIES.unavailable);
      const threadId = readStr(input, "threadId") || undefined;
      const updated = await ctx.update(userId, draftId, { raw, threadId });
      const executionId = await ctx.record(userId, {
        proposalId: ctx.proposalId,
        provider,
        actionId,
        status: "succeeded",
        requestSummary: { isReply: Boolean(threadId) },
        // Ledger keeps Gmail-issued ids only — never the body or recipient.
        resultSummary: { draftId: updated.draftId, threadId: updated.threadId },
      });
      return {
        ok: true,
        status: "succeeded",
        actionId,
        provider,
        userMessage: `Updated the draft${label ? ` to ${label}` : ""}.`,
        executionId,
        receipt: {
          draftId: updated.draftId,
          messageId: updated.messageId,
          threadId: updated.threadId,
        },
      };
    }

    // Delete. Returns normally only on a real 2xx from Gmail; anything else throws
    // a classified error, so a deletion is never assumed.
    await ctx.remove(userId, draftId);
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "succeeded",
      requestSummary: {},
      resultSummary: { draftId },
    });
    return {
      ok: true,
      status: "succeeded",
      actionId,
      provider,
      userMessage: `Deleted the draft${label ? ` to ${label}` : ""}.`,
      executionId,
      receipt: { draftId },
    };
  } catch (err) {
    const gmailErr = err instanceof GmailError ? err : null;
    logger.error("action.gmailDraftLifecycle failed", {
      actionId,
      errorCode: gmailErr?.reason ?? "unknown",
      httpStatus: gmailErr?.httpStatus ?? null,
    });
    let userMessage: string = GMAIL_EXEC_REPLIES.unavailable;
    if (gmailErr?.reason === "not_connected") userMessage = GMAIL_EXEC_REPLIES.notConnected;
    else if (
      gmailErr &&
      (gmailErr.reason === "insufficient_scope" || isReconnectReason(gmailErr.reason))
    ) {
      userMessage = GMAIL_EXEC_REPLIES.reconnect;
    } else if (gmailErr?.reason === "mailbox_not_found") {
      userMessage = GMAIL_EXEC_REPLIES.draftGone;
    }
    return await fail(gmailErr?.reason ?? "execution_failed", userMessage);
  }
}

/**
 * Execute a Gmail draft-create or send from ALREADY-RESOLVED structured input.
 * Builds the MIME (pure), performs the provider write, and confirms ONLY from the
 * real Gmail response — a thrown provider/MIME error never reports success. Never
 * throws; returns a safe result + ledger entry.
 */
async function runGmailWrite(
  userId: string,
  actionId: "email.createDraft" | "email.sendDraft",
  input: Record<string, unknown> | undefined,
  provider: string,
  ctx: {
    record: typeof recordActionExecution;
    proposalId: string | null;
    inputKeys: string[];
    createDraft: (userId: string, payload: GmailRawPayload) => Promise<CreatedGmailDraft>;
    sendMessage: (userId: string, payload: GmailRawPayload) => Promise<SentGmailMessage>;
  },
): Promise<ActionExecutionResult> {
  const to = readStr(input, "to");
  const toName = readStr(input, "toName");
  const subject = readStr(input, "subject");
  const body = typeof input?.body === "string" ? input.body : "";
  const isReply = input?.isReply === true;
  const threadId = readStr(input, "threadId") || undefined;
  const inReplyTo = readStr(input, "inReplyTo") || undefined;
  const references = readStr(input, "references") || undefined;
  const isSend = actionId === "email.sendDraft";

  // A reply may keep the thread subject; a NEW message needs its own subject.
  const missing = !to || body.trim().length === 0 || (!isReply && !subject);

  let payload: GmailRawPayload;
  try {
    if (missing) throw new MimeError("empty_body", "missing required fields");
    payload = buildGmailRawPayload(
      { to, subject, body, inReplyTo, references },
      threadId,
    );
  } catch (err) {
    // Validation/MIME failure — never a false success.
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "failed",
      requestSummary: { inputKeys: ctx.inputKeys, isReply, isSend },
      errorMessage: err instanceof MimeError ? `mime_${err.reason}` : "invalid_input",
    });
    return {
      ok: false,
      status: "failed",
      actionId,
      provider,
      userMessage: GMAIL_EXEC_REPLIES.missingInfo,
      executionId,
    };
  }

  const label = recipientLabel(toName, to);
  try {
    if (isSend) {
      const sent = await ctx.sendMessage(userId, payload);
      // Validate the provider result before ANY success claim (Fix 1): a send with
      // no Gmail-issued message id is not a confirmed send — treat it as a failure
      // so Hula never says "sent" without a validated provider identifier.
      if (!sent.messageId) {
        throw new GmailError(
          "malformed_provider_response",
          "Gmail did not confirm the sent message",
        );
      }
      const executionId = await ctx.record(userId, {
        proposalId: ctx.proposalId,
        provider,
        actionId,
        status: "succeeded",
        requestSummary: { isReply, isSend },
        // Ledger keeps only Gmail-issued ids — never recipient/subject/body.
        resultSummary: { messageId: sent.messageId, threadId: sent.threadId },
      });
      return {
        ok: true,
        status: "succeeded",
        actionId,
        provider,
        userMessage: isReply ? `Reply sent to ${label}.` : `Email sent to ${label}.`,
        executionId,
        receipt: { messageId: sent.messageId, threadId: sent.threadId },
      };
    }

    const draft = await ctx.createDraft(userId, payload);
    // Same validation for a draft: no Gmail-issued draft id means it isn't a
    // confirmed draft — fail honestly rather than claim one was created.
    if (!draft.draftId) {
      throw new GmailError(
        "malformed_provider_response",
        "Gmail did not return a draft id",
      );
    }
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "succeeded",
      requestSummary: { isReply, isSend },
      resultSummary: { draftId: draft.draftId, threadId: draft.threadId },
    });
    const header = isReply ? "Reply draft created in Gmail." : "Draft created in Gmail.";
    const subjectLine = isReply && subject.length === 0 ? "" : `\nSubject: ${subject}`;
    return {
      ok: true,
      status: "succeeded",
      actionId,
      provider,
      userMessage: `${header}\nTo: ${label}${subjectLine}`,
      executionId,
      receipt: {
        draftId: draft.draftId,
        messageId: draft.messageId,
        threadId: draft.threadId,
      },
    };
  } catch (err) {
    const gmailErr = err instanceof GmailError ? err : null;
    logger.error("action.gmailWrite failed", {
      actionId,
      errorCode: gmailErr?.reason ?? "unknown",
      httpStatus: gmailErr?.httpStatus ?? null,
    });
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "failed",
      requestSummary: { isReply, isSend },
      errorMessage: gmailErr?.reason ?? "execution_failed",
    });
    let userMessage: string = GMAIL_EXEC_REPLIES.unavailable;
    if (gmailErr?.reason === "not_connected") userMessage = GMAIL_EXEC_REPLIES.notConnected;
    else if (gmailErr && (gmailErr.reason === "insufficient_scope" || isReconnectReason(gmailErr.reason)))
      userMessage = GMAIL_EXEC_REPLIES.reconnect;
    return { ok: false, status: "failed", actionId, provider, userMessage, executionId };
  }
}
