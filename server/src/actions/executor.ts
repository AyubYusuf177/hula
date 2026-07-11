import { logger } from "../utils/logger";
import { getUserTimezone } from "../reminders/reminders";
import {
  GoogleCalendarError,
} from "../integrations/providers/googleCalendar/client";
import { fetchUpcomingGoogleCalendarEvents } from "../integrations/providers/googleCalendar/events";
import { formatCalendarAnswer } from "../integrations/providers/googleCalendar/calendarQuestion";
import type { CalendarRange } from "../integrations/providers/googleCalendar/types";
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
