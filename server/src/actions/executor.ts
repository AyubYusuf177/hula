import { logger } from "../utils/logger";
import { getUserTimezone } from "../reminders/reminders";
import {
  GoogleCalendarError,
} from "../integrations/providers/googleCalendar/client";
import { fetchUpcomingGoogleCalendarEvents } from "../integrations/providers/googleCalendar/events";
import { formatCalendarAnswer } from "../integrations/providers/googleCalendar/calendarQuestion";
import type { CalendarRange } from "../integrations/providers/googleCalendar/types";
import { GmailError, isReconnectReason } from "../integrations/providers/gmail/client";
import {
  createGmailDraft,
  sendGmailMessage,
  type CreatedGmailDraft,
  type GmailRawPayload,
  type SentGmailMessage,
} from "../integrations/providers/gmail/drafts";
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
  receipt?: { draftId?: string; messageId?: string; threadId?: string };
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
} as const;

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
