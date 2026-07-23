import { logger } from "../utils/logger";
import { executeSlackMutation } from "../integrations/providers/slack/actions";
import { rememberVerifiedSlackMutation } from "../integrations/providers/slack/context";
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
  getCalendarEvent,
  updateCalendarEvent,
  verifyEventDeleted,
  type CalendarEventWriteFields,
  type SendUpdatesMode,
} from "../integrations/providers/googleCalendar/calendarWrites";
import {
  verifyEventState,
  type EventExpectation,
  type EventVerification,
} from "../integrations/providers/googleCalendar/calendarVerify";
import {
  recordActedCalendarEvent,
  toSelectionItem,
  type CalendarActedKind,
} from "../integrations/providers/googleCalendar/calendarContext";
import { formatEventWhen } from "../integrations/providers/googleCalendar/calendarDisplay";
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
import {
  TodoistError,
  isReconnectReason as isTodoistReconnectReason,
} from "../integrations/providers/todoist/client";
import {
  closeTask,
  createTask,
  deleteTask,
  fetchTask,
  moveTask,
  reopenTask,
  updateTask,
  type TodoistTaskWriteFields,
} from "../integrations/providers/todoist/tasks";
import {
  verifyCompletion,
  verifyDeletion,
  verifyReopen,
  verifyTaskState,
  type TaskExpectation,
} from "../integrations/providers/todoist/todoistVerify";
// Aliased: `calendarContext` exports a `toSelectionItem` too, and the two project
// different provider objects into different shapes.
import {
  recordActedTodoistTask,
  toSelectionItem as toTodoistSelectionItem,
} from "../integrations/providers/todoist/todoistContext";
import { dueLocalStamp } from "../integrations/providers/todoist/todoistFilters";
import {
  formatClockTime,
  formatLocalTime,
} from "../integrations/providers/todoist/todoistDisplay";
import type { NormalizedTodoistTask } from "../integrations/providers/todoist/types";
import { AsanaError } from "../integrations/providers/asana/client";
import { asanaRequest } from "../integrations/providers/asana/client";
import { createAsanaResource, createAsanaTask, deleteAsanaResource, getAsanaResource, listAsanaChildren, listAsanaTasks, mutateAsanaPortfolioItem, mutateAsanaRelationship, updateAsanaResource, updateAsanaTask, type AsanaReceipt } from "../integrations/providers/asana/operations";
import type { AsanaResource } from "../integrations/providers/asana/types";
import { recordAsanaEntity, toAsanaContextItem } from "../integrations/providers/asana/asanaContext";
import { asanaPlainText } from "../integrations/providers/asana/plainText";
import { buildActionPolicyContext } from "./context";
import { evaluateActionForUser, type ActionPolicyContext } from "./policy";
import { recordActionExecution, type ActionExecutionStatusValue } from "./executions";
import { getActionDefinition } from "./registry";
import type { NormalizedCalendarEvent } from "../integrations/providers/googleCalendar/types";
import { notionOps } from "../integrations/providers/notion/operations";
import { recordNotionEntity } from "../integrations/providers/notion/context";
import { DriveError } from "../integrations/providers/googleDrive/client";
import {
  createDriveFolder,
  createGoogleDoc,
} from "../integrations/providers/googleDrive/operations";
import {
  DRIVE_FOLDER_MIME,
  GOOGLE_DOC_MIME,
  type DriveCreationReceipt,
} from "../integrations/providers/googleDrive/types";
import {
  executeOutlookMailMutation,
  type OutlookMailDeps,
} from "../integrations/providers/microsoft/mailOperations";
import { MicrosoftGraphError } from "../integrations/providers/microsoft/graph";
import {
  executeOutlookCalendarMutation,
  type OutlookCalendarDeps,
} from "../integrations/providers/microsoft/calendarOperations";
import { recordOutlookCalendarEntity } from "../integrations/providers/microsoft/calendarContext";
import { invalidateOutlookDraftEntity } from "../integrations/providers/microsoft/mailContext";

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
    /**
     * The Todoist tasks whose expected end state was READ BACK and matched
     * (Section 19). Present only on a verified write, so a caller that remembers
     * "the task you just completed" can only ever remember something that
     * provably happened.
     */
    taskIds?: string[];
    /** Asana-issued ids backed by validated receipts/read-back state. */
    asanaResourceIds?: string[];
    /** Google Drive file id from a validated creation receipt. */
    driveFileId?: string;
    /** Safe provider link returned by Google, when present. */
    driveWebViewLink?: string;
    /** True only for an honestly reported multi-step Google Doc partial outcome. */
    partial?: boolean;
    /** Microsoft immutable message/draft identity and verification strength. */
    outlookConversationId?: string;
    /** Microsoft Graph event identity and Teams join URL after authoritative verification. */
    microsoftEventId?: string;
    teamsJoinUrl?: string;
    verification?: "verified" | "accepted";
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
  /**
   * The Section 18 POSTCONDITION reads. Separate from the write fns on purpose:
   * a write's own response is Google's echo of the request, while these ask what
   * is actually on the calendar now.
   */
  getCalendarEvent?: typeof getCalendarEvent;
  verifyEventDeleted?: typeof verifyEventDeleted;
  /** Records "the meeting you just created" — ONLY after verification. */
  recordActedCalendarEvent?: typeof recordActedCalendarEvent;
  /** Todoist provider fns — injected so tests never hit Todoist. */
  createTodoistTask?: typeof createTask;
  updateTodoistTask?: typeof updateTask;
  moveTodoistTask?: typeof moveTask;
  closeTodoistTask?: typeof closeTask;
  reopenTodoistTask?: typeof reopenTask;
  deleteTodoistTask?: typeof deleteTask;
  /**
   * The Todoist POSTCONDITION read. Separate from the write fns on purpose: a
   * write's own response is Todoist's echo of the request, while this asks what
   * the task actually looks like now.
   */
  fetchTodoistTask?: typeof fetchTask;
  /** Records "the task you just completed" — ONLY after verification. */
  recordActedTodoistTask?: typeof recordActedTodoistTask;
  createAsanaTask?: typeof createAsanaTask;
  updateAsanaTask?: typeof updateAsanaTask;
  deleteAsanaResource?: typeof deleteAsanaResource;
  mutateAsanaRelationship?: typeof mutateAsanaRelationship;
  mutateAsanaPortfolioItem?: typeof mutateAsanaPortfolioItem;
  getAsanaResource?: typeof getAsanaResource;
  listAsanaTasks?: typeof listAsanaTasks;
  listAsanaChildren?: typeof listAsanaChildren;
  createAsanaComment?: (userId:string,taskId:string,text:string)=>Promise<AsanaResource>;
  recordAsanaEntity?: typeof recordAsanaEntity;
  createAsanaResource?: typeof createAsanaResource;
  updateAsanaResource?: typeof updateAsanaResource;
  updateNotionPage?: typeof notionOps.updatePage;
  moveNotionPage?: typeof notionOps.movePage;
  createNotionComment?: typeof notionOps.createComment;
  updateNotionComment?: typeof notionOps.updateComment;
  deleteNotionComment?: typeof notionOps.deleteComment;
  updateNotionDataSource?: typeof notionOps.updateDataSource;
  archiveNotionBlock?: typeof notionOps.archiveBlock;
  appendNotionBlocks?: typeof notionOps.appendBlocks;
  recordNotionEntity?: typeof recordNotionEntity;
  executeSlackMutation?: typeof executeSlackMutation;
  rememberSlackMutation?: typeof rememberVerifiedSlackMutation;
  createDriveFolder?: typeof createDriveFolder;
  createGoogleDoc?: typeof createGoogleDoc;
  executeOutlookMailMutation?: (
    userId: string,
    input: Record<string, unknown>,
    deps?: OutlookMailDeps,
  ) => ReturnType<typeof executeOutlookMailMutation>;
  executeOutlookCalendarMutation?: (
    userId: string,
    input: Record<string, unknown>,
    deps?: OutlookCalendarDeps,
  ) => ReturnType<typeof executeOutlookCalendarMutation>;
  recordOutlookCalendarEntity?: typeof recordOutlookCalendarEntity;
  invalidateOutlookDraftEntity?: typeof invalidateOutlookDraftEntity;
  /**
   * Waits between bounded delete-absence re-reads. Injected so tests exercise the
   * real backoff logic without spending real time.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** The Todoist write actions the executor backs with a real adapter. */
type TodoistActionId =
  | "task.create"
  | "task.update"
  | "task.move"
  | "task.complete"
  | "task.reopen"
  | "task.delete";

const TODOIST_ACTION_IDS: ReadonlySet<string> = new Set<TodoistActionId>([
  "task.create",
  "task.update",
  "task.move",
  "task.complete",
  "task.reopen",
  "task.delete",
]);

/**
 * Process-local single flight complements the durable Drive appProperties key.
 * The inbound confirmation transition already admits only one confirmed proposal;
 * this closes the smaller concurrent direct-executor window without a schema
 * migration. Cross-process re-delivery remains provider-idempotent via the key.
 */
const DRIVE_CREATE_FLIGHTS = new Map<string, Promise<DriveCreationReceipt>>();

async function runDriveCreateOnce(
  key: string,
  create: () => Promise<DriveCreationReceipt>,
): Promise<DriveCreationReceipt> {
  const active = DRIVE_CREATE_FLIGHTS.get(key);
  if (active) return active;
  const pending = create();
  DRIVE_CREATE_FLIGHTS.set(key, pending);
  try {
    return await pending;
  } finally {
    if (DRIVE_CREATE_FLIGHTS.get(key) === pending) DRIVE_CREATE_FLIGHTS.delete(key);
  }
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
          getEvent: deps.getCalendarEvent ?? getCalendarEvent,
          verifyDeleted: deps.verifyEventDeleted ?? verifyEventDeleted,
          recordActed: deps.recordActedCalendarEvent ?? recordActedCalendarEvent,
        },
      );
    }

    if (actionId === "microsoft.calendar.mutate") {
      return await runOutlookCalendarAction(
        userId,
        input,
        policy.provider ?? "microsoft",
        {
          record,
          proposalId: options.proposalId ?? null,
          execute: deps.executeOutlookCalendarMutation ?? executeOutlookCalendarMutation,
          remember: deps.recordOutlookCalendarEntity ?? recordOutlookCalendarEntity,
        },
      );
    }

    // Todoist task lifecycle (Section 19). The structured, ALREADY-RESOLVED task
    // ids and values arrive in `input` from the Todoist handler (which resolved
    // and re-fetched the targets) or from a CONFIRMED proposal. The executor
    // performs the provider write, VERIFIES the postcondition by re-reading, and
    // confirms strictly from what Todoist actually shows — it never resolves a
    // task itself, so an ambiguous target can never reach here.
    if (TODOIST_ACTION_IDS.has(actionId)) {
      return await runTodoistWrite(
        userId,
        actionId as TodoistActionId,
        input,
        policy.provider ?? "todoist",
        {
          record,
          proposalId: options.proposalId ?? null,
          inputKeys,
          create: deps.createTodoistTask ?? createTask,
          update: deps.updateTodoistTask ?? updateTask,
          move: deps.moveTodoistTask ?? moveTask,
          close: deps.closeTodoistTask ?? closeTask,
          reopen: deps.reopenTodoistTask ?? reopenTask,
          remove: deps.deleteTodoistTask ?? deleteTask,
          getTask: deps.fetchTodoistTask ?? fetchTask,
          recordActed: deps.recordActedTodoistTask ?? recordActedTodoistTask,
          sleep: deps.sleep,
        },
      );
    }

    if (actionId === "drive.createFolder" || actionId === "drive.createDocument") {
      return await runDriveCreation(
        userId,
        actionId,
        input,
        policy.provider ?? "google_drive",
        {
          record,
          proposalId: options.proposalId ?? null,
          createFolder: deps.createDriveFolder ?? createDriveFolder,
          createDocument: deps.createGoogleDoc ?? createGoogleDoc,
        },
      );
    }

    if (actionId.startsWith("asana.task.")) {
      return await runAsanaAction(userId, actionId, input, policy.provider ?? "asana", {
        record, proposalId: options.proposalId ?? null,
        create: deps.createAsanaTask ?? createAsanaTask,
        update: deps.updateAsanaTask ?? updateAsanaTask,
        remove: deps.deleteAsanaResource ?? deleteAsanaResource,
        relationship: deps.mutateAsanaRelationship ?? mutateAsanaRelationship,
        get: deps.getAsanaResource ?? getAsanaResource,
        listTasks: deps.listAsanaTasks ?? listAsanaTasks,
        comment: deps.createAsanaComment ?? (async (u,t,text) => asanaRequest<AsanaResource>(u,"POST",`/tasks/${t}/stories`,{data:{text}})),
        remember: deps.recordAsanaEntity ?? recordAsanaEntity,
      });
    }
    if(actionId==="notion.mutate"){
      const operation=readStr(input,"operation"),targetId=readStr(input,"targetId"),targetTitle=readStr(input,"targetTitle")??"Notion content",body=input?.body&&typeof input.body==="object"?input.body as Record<string,unknown>:{};
      if(["comment","update_comment","delete_comment"].includes(operation)&&!ctx.capabilitiesByProvider.notion?.includes("comments.write")){const executionId=await record(userId,{proposalId:options.proposalId??null,provider:"notion",actionId,status:"blocked",requestSummary:{operation},errorMessage:"missing_comment_capability"});return{ok:false,status:"blocked",actionId,provider:"notion",userMessage:"Reconnect Notion and grant comment access before I post or change comments.",executionId};}
      try{let result:Record<string,unknown>;
        if(operation==="archive_page"||operation==="restore_page"){if(!targetId)throw new Error("missing target");result=await(deps.updateNotionPage??notionOps.updatePage)(userId,targetId,{in_trash:operation==="archive_page"});}
        else if(operation==="update_page"){if(!targetId)throw new Error("missing target");result=await(deps.updateNotionPage??notionOps.updatePage)(userId,targetId,body);}
        else if(operation==="comment"){if(!targetId)throw new Error("missing target");result=await(deps.createNotionComment??notionOps.createComment)(userId,body);}
        else if(operation==="update_comment"){if(!targetId)throw new Error("missing target");result=await(deps.updateNotionComment??notionOps.updateComment)(userId,targetId,body);}
        else if(operation==="delete_comment"){if(!targetId)throw new Error("missing target");result=await(deps.deleteNotionComment??notionOps.deleteComment)(userId,targetId);}
        else if(operation==="move_page"){if(!targetId||!body.parent||typeof body.parent!=="object")throw new Error("missing target");result=await(deps.moveNotionPage??notionOps.movePage)(userId,targetId,body.parent as Record<string,unknown>);}
        else if(operation==="schema"){if(!targetId)throw new Error("missing target");result=await(deps.updateNotionDataSource??notionOps.updateDataSource)(userId,targetId,body);}
        else if(operation==="archive_block"){if(!targetId)throw new Error("missing target");result=await(deps.archiveNotionBlock??notionOps.archiveBlock)(userId,targetId);}
        else if(operation==="append"){if(!targetId)throw new Error("missing target");result=await(deps.appendNotionBlocks??notionOps.appendBlocks)(userId,targetId,Array.isArray(body.children)?body.children:[]);}
        else throw new Error("unsupported operation");
        if(!result||typeof result!=="object")throw new Error("malformed receipt");
        const targetMutation=new Set(["archive_page","restore_page","update_page","update_comment","delete_comment","move_page","schema","archive_block"]);
        if(targetMutation.has(operation)&&result.id!==targetId)throw new Error("receipt target mismatch");
        if(operation==="archive_page"&&result.in_trash!==true)throw new Error("archive postcondition mismatch");
        if(operation==="restore_page"&&result.in_trash!==false)throw new Error("restore postcondition mismatch");
        if(operation==="move_page"){
          const expected=body.parent as Record<string,unknown>,actual=result.parent&&typeof result.parent==="object"?result.parent as Record<string,unknown>:null;
          const type=readStr(expected,"type"),key=type==="data_source_id"?"data_source_id":"page_id";
          if(!actual||actual.type!==type||actual[key]!==expected[key])throw new Error("move postcondition mismatch");
        }
        if(operation==="append"&&(result.object!=="list"||!Array.isArray(result.results)))throw new Error("append receipt malformed");
        if(typeof result.id==="string"&&result.object!=="list")await(deps.recordNotionEntity??recordNotionEntity)(userId,result);
        const executionId=await record(userId,{proposalId:options.proposalId??null,provider:"notion",actionId,status:"succeeded",requestSummary:{operation},resultSummary:{receiptValidated:true}});
        return{ok:true,status:"succeeded",actionId,provider:"notion",userMessage:operation==="archive_page"?`Archived the Notion page “${targetTitle}”.`:operation==="restore_page"?`Restored the Notion page “${targetTitle}”.`:operation==="update_page"?`Updated the Notion page or record “${targetTitle}”.`:operation==="comment"?`Posted the comment on “${targetTitle}”.`:operation==="update_comment"?`Updated the Notion comment “${targetTitle}”.`:operation==="delete_comment"?`Deleted the Notion comment “${targetTitle}”.`:operation==="move_page"?`Moved the Notion page “${targetTitle}”.`:operation==="append"?`Added the content to “${targetTitle}”.`:`Updated the Notion data source “${targetTitle}”.`,executionId};
      }catch(error){const executionId=await record(userId,{proposalId:options.proposalId??null,provider:"notion",actionId,status:"failed",requestSummary:{operation},errorMessage:error instanceof Error?error.name:"execution_failed"});return{ok:false,status:"failed",actionId,provider:"notion",userMessage:"I couldn’t verify that Notion change, so I won’t say it succeeded.",executionId};}
    }
    if(actionId==="asana.portfolio.membership"){
      const portfolioId=readStr(input,"portfolioId"),itemId=readStr(input,"itemId"),operation=readStr(input,"operation");
      if(!portfolioId||!itemId||!new Set(["addItem","removeItem"]).has(operation)){const executionId=await record(userId,{proposalId:options.proposalId??null,provider:policy.provider??"asana",actionId,status:"failed",requestSummary:{operation},errorMessage:"invalid_input"});return{ok:false,status:"failed",actionId,provider:policy.provider??"asana",userMessage:"I’m missing the exact Asana portfolio or project.",executionId};}
      try{const receipt=await(deps.mutateAsanaPortfolioItem??mutateAsanaPortfolioItem)(userId,portfolioId,operation as "addItem"|"removeItem",itemId);if(receipt.accepted!==true||receipt.portfolioGid!==portfolioId||receipt.itemGid!==itemId)throw new AsanaError("malformed_response",200);const items=await(deps.listAsanaChildren??listAsanaChildren)(userId,"portfolios",portfolioId,"items",100),present=items.some(item=>item.gid===itemId);if(present!==(operation==="addItem"))throw new Error("postcondition mismatch");const portfolio=await(deps.getAsanaResource??getAsanaResource)(userId,"portfolios",portfolioId);await(deps.recordAsanaEntity??recordAsanaEntity)(userId,toAsanaContextItem(portfolio),operation);const executionId=await record(userId,{proposalId:options.proposalId??null,provider:policy.provider??"asana",actionId,status:"succeeded",requestSummary:{operation},resultSummary:{portfolioId,itemId,receiptValidated:true,postcondition:"confirmed"}});return{ok:true,status:"succeeded",actionId,provider:policy.provider??"asana",userMessage:operation==="addItem"?"Added that project to the Asana portfolio.":"Removed that project from the Asana portfolio.",executionId,receipt:{asanaResourceIds:[portfolioId,itemId]}};}catch(error){const providerError=error instanceof AsanaError?error:null;const executionId=await record(userId,{proposalId:options.proposalId??null,provider:policy.provider??"asana",actionId,status:"failed",requestSummary:{operation},errorMessage:providerError?.reason??"execution_failed"});return{ok:false,status:"failed",actionId,provider:policy.provider??"asana",userMessage:"I couldn’t verify that Asana portfolio change.",executionId};}
    }
    if (/^asana\.(?:project|section|portfolio|goal|time_entry)\.(?:write|delete)$/.test(actionId)) {
      return await runAsanaResourceAction(userId,actionId,input,policy.provider??"asana",{
        record,proposalId:options.proposalId??null,
        create:deps.createAsanaResource??createAsanaResource,
        update:deps.updateAsanaResource??updateAsanaResource,
        remove:deps.deleteAsanaResource??deleteAsanaResource,
        get:deps.getAsanaResource??getAsanaResource,
        remember:deps.recordAsanaEntity??recordAsanaEntity,
      });
    }

    if (
      actionId === "microsoft.mail.createDraft" ||
      actionId === "microsoft.mail.updateDraft" ||
      actionId === "microsoft.mail.deleteDraft" ||
      actionId === "microsoft.mail.setReadState" ||
      actionId === "microsoft.mail.send"
    ) {
      return await runOutlookMailAction(
        userId,
        actionId,
        input,
        policy.provider ?? "microsoft",
        {
          record,
          proposalId: options.proposalId ?? null,
          execute: deps.executeOutlookMailMutation ?? executeOutlookMailMutation,
          invalidateDraft: deps.invalidateOutlookDraftEntity ?? invalidateOutlookDraftEntity,
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

    if (actionId === "slack.postMessage" || actionId === "slack.mutate") {
      const method = actionId === "slack.postMessage"
        ? "chat.postMessage"
        : readStr(input, "method");
      const params = actionId === "slack.postMessage"
        ? { channel: readStr(input, "channel"), text: readStr(input, "text") }
        : input?.params && typeof input.params === "object"
          ? input.params as Record<string, unknown>
          : {};
      if (!method) throw new Error("missing_slack_method");
      const receipt = await (deps.executeSlackMutation ?? executeSlackMutation)(userId, method, params);
      try {
        await (deps.rememberSlackMutation ?? rememberVerifiedSlackMutation)(userId, receipt, params);
      } catch (error) {
        // Context is helpful but not part of Slack's authoritative mutation receipt.
        // A local context-store failure must not turn a confirmed provider success
        // into a false failure or cause the mutation to be retried.
        logger.error("slack.context record failed", {
          actionId,
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
      const executionId = await record(userId, {
        proposalId: options.proposalId ?? null,
        provider: "slack",
        actionId,
        status: "succeeded",
        requestSummary: { method, inputKeys },
        resultSummary: {
          receiptValidated: true,
          hasChannelReceipt: Boolean(receipt.channelId),
          hasTimestampReceipt: Boolean(receipt.timestamp),
          hasScheduledReceipt: Boolean(receipt.scheduledMessageId),
        },
      });
      const success = readStr(input, "successText") ??
        (method === "chat.postMessage" ? "Sent the Slack message." : "Updated Slack.");
      return {
        ok: true,
        status: "succeeded",
        actionId,
        provider: "slack",
        userMessage: success,
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
    const slackMissingScope = actionId.startsWith("slack.") &&
      err instanceof Error && err.message === "slack_missing_scope";
    const slackNotConnected = actionId.startsWith("slack.") &&
      err instanceof Error && err.message === "slack_not_connected";
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
      errorMessage: notConnected || slackNotConnected
        ? "not_connected"
        : slackMissingScope
          ? "missing_scope"
          : "execution_failed",
    });
    return {
      ok: false,
      status: "failed",
      actionId,
      provider: policy.provider,
      userMessage: slackMissingScope
        ? "Slack didn’t grant the permission needed for that change. Reinstall Slack from Integrations to update permissions."
        : notConnected || slackNotConnected
        ? "I don’t have that app connected yet, so I can’t do that."
        : "I ran into a problem trying to do that — mind trying again in a bit?",
      executionId,
    };
  }
}

async function runDriveCreation(
  userId: string,
  actionId: "drive.createFolder" | "drive.createDocument",
  input: Record<string, unknown> | undefined,
  provider: string,
  deps: {
    record: typeof recordActionExecution;
    proposalId: string | null;
    createFolder: typeof createDriveFolder;
    createDocument: typeof createGoogleDoc;
  },
): Promise<ActionExecutionResult> {
  const name = readStr(input, "name").trim();
  const idempotencyKey = readStr(input, "idempotencyKey").trim();
  const content = readStr(input, "content");
  const expectedMime = actionId === "drive.createFolder" ? DRIVE_FOLDER_MIME : GOOGLE_DOC_MIME;
  const inputValid = name.length > 0 && name.length <= 300 &&
    idempotencyKey.length >= 16 && idempotencyKey.length <= 200 &&
    content.length <= 12_000;
  if (!inputValid) {
    const executionId = await deps.record(userId, {
      proposalId: deps.proposalId,
      provider,
      actionId,
      status: "failed",
      requestSummary: { operation: actionId, inputKeys: Object.keys(input ?? {}) },
      errorMessage: "invalid_input",
    });
    return {
      ok: false,
      status: "failed",
      actionId,
      provider,
      userMessage: "I couldn’t validate that Drive request, so I didn’t create anything.",
      executionId,
    };
  }

  try {
    const flightKey = `${userId}:${actionId}:${idempotencyKey}`;
    const receipt = await runDriveCreateOnce(flightKey, () =>
      actionId === "drive.createFolder"
        ? deps.createFolder({ userId, name, idempotencyKey })
        : deps.createDocument({ userId, name, content, idempotencyKey }),
    );
    const receiptValid = Boolean(receipt.fileId) && receipt.name === name &&
      receipt.mimeType === expectedMime && receipt.idempotencyKey === idempotencyKey;
    if (!receiptValid) throw new DriveError("malformed_provider_response");

    if (actionId === "drive.createDocument" && receipt.contentApplied !== true) {
      const executionId = await deps.record(userId, {
        proposalId: deps.proposalId,
        provider,
        actionId,
        status: "failed",
        requestSummary: { operation: actionId, inputKeys: Object.keys(input ?? {}) },
        resultSummary: {
          driveFileId: receipt.fileId,
          receiptValidated: true,
          contentApplied: false,
          partial: true,
        },
        errorMessage: "partial_document_creation",
      });
      const link = receipt.webViewLink ? ` ${receipt.webViewLink}` : "";
      return {
        ok: false,
        status: "failed",
        actionId,
        provider,
        userMessage: `Google created the Doc “${receipt.name}”, but I couldn’t verify that its initial content was added. I’m not reporting this as complete.${link}`,
        executionId,
        receipt: {
          driveFileId: receipt.fileId,
          driveWebViewLink: receipt.webViewLink ?? undefined,
          partial: true,
        },
      };
    }

    const executionId = await deps.record(userId, {
      proposalId: deps.proposalId,
      provider,
      actionId,
      status: "succeeded",
      requestSummary: { operation: actionId, inputKeys: Object.keys(input ?? {}) },
      resultSummary: {
        driveFileId: receipt.fileId,
        receiptValidated: true,
        ...(actionId === "drive.createDocument" ? { contentApplied: true } : {}),
      },
    });
    const link = receipt.webViewLink ? ` ${receipt.webViewLink}` : "";
    return {
      ok: true,
      status: "succeeded",
      actionId,
      provider,
      userMessage: actionId === "drive.createFolder"
        ? `Created the Google Drive folder “${receipt.name}”.${link}`
        : `Created the Google Doc “${receipt.name}” and verified its initial content.${link}`,
      executionId,
      receipt: {
        driveFileId: receipt.fileId,
        driveWebViewLink: receipt.webViewLink ?? undefined,
      },
    };
  } catch (error) {
    const code = error instanceof DriveError ? error.reason : "execution_failed";
    const executionId = await deps.record(userId, {
      proposalId: deps.proposalId,
      provider,
      actionId,
      status: "failed",
      requestSummary: { operation: actionId, inputKeys: Object.keys(input ?? {}) },
      errorMessage: code,
    });
    return {
      ok: false,
      status: "failed",
      actionId,
      provider,
      userMessage: "I couldn’t verify that Google Drive creation, so I won’t say it succeeded.",
      executionId,
    };
  }
}

/**
 * Execute a Calendar create/update/cancel from ALREADY-RESOLVED structured input
 * (Sections 17 + 18).
 *
 * The proposal carries the exact Google event id, the exact ISO instants, the
 * exact attendee list, and — when a Google Meet was asked for — the exact
 * conference `requestId` that were previewed to the user. So this performs the
 * write and nothing else: it resolves no events, re-parses no dates, invents no
 * addresses, and re-checks no ambiguity.
 *
 * Success is claimed ONLY from Google's validated response (`calendarWrites`
 * enforces a real event id) and then CHECKED against a fresh read of the
 * calendar (Section 18). A thrown provider error is mapped to an honest reply.
 * Never throws.
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
    getEvent: typeof getCalendarEvent;
    verifyDeleted: typeof verifyEventDeleted;
    recordActed: typeof recordActedCalendarEvent;
  },
): Promise<ActionExecutionResult> {
  const timezone = readStr(input, "timezone") || undefined;
  const eventId = readStr(input, "eventId");
  const title = readStr(input, "title");
  const startIso = readStr(input, "startIso");
  const endIso = readStr(input, "endIso");
  const attendees = readStrArray(input, "attendees");
  const conferenceRequestId = readStr(input, "conferenceRequestId");

  /**
   * Whether Google emails the guests. `none` is the default everywhere; `all` is
   * used ONLY when the proposal recorded that guests exist AND the preview the
   * user confirmed told them invitations would go out. An invitation is
   * unrecallable, so it may never be a side effect of a default.
   */
  const sendUpdates: SendUpdatesMode =
    input?.notifyGuests === true || attendees.length > 0 ? "all" : "none";

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
      const allDay = input?.allDay === true;
      const startDate = readStr(input, "startDate");
      const endDate = readStr(input, "endDate");

      const fields: CalendarEventWriteFields = {};
      const expectation: EventExpectation = {};

      if (!title) return await fail("invalid_input", CALENDAR_WRITE_REPLIES.unavailable);
      fields.summary = title;
      expectation.title = title;

      if (allDay) {
        if (!startDate || !endDate) {
          return await fail("invalid_input", CALENDAR_WRITE_REPLIES.unavailable);
        }
        // All-day uses a bare date on BOTH ends; `end.date` is exclusive.
        fields.start = { date: startDate };
        fields.end = { date: endDate };
        expectation.startDate = startDate;
      } else {
        if (!startIso || !endIso) {
          return await fail("invalid_input", CALENDAR_WRITE_REPLIES.unavailable);
        }
        // Re-check never-past HERE, not just at proposal time. Deferring the
        // write until confirmation opens a window (up to the proposal TTL) in
        // which a previewed start can slip into the past — the proposal-time
        // check alone no longer covers it.
        const startMs = new Date(startIso).getTime();
        if (!Number.isFinite(startMs) || startMs <= Date.now()) {
          return await fail("start_in_past", CALENDAR_WRITE_REPLIES.inPast);
        }
        fields.start = { dateTime: startIso, timeZone: timezone };
        fields.end = { dateTime: endIso, timeZone: timezone };
        expectation.startIso = startIso;
        expectation.endIso = endIso;
      }

      const location = readStr(input, "location");
      const description = readStr(input, "description");
      if (location) {
        fields.location = location;
        expectation.location = location;
      }
      if (description) {
        fields.description = description;
        expectation.description = description;
      }
      if (attendees.length > 0) {
        fields.attendees = attendees.map((email) => ({ email }));
        expectation.attendees = attendees;
      }
      const reminderMinutes = readNum(input, "reminderMinutes");
      if (reminderMinutes !== null) {
        fields.reminders = [{ method: "popup", minutes: reminderMinutes }];
      }
      if (conferenceRequestId) {
        // Replaying the SAME id on a duplicate confirmation makes Google return
        // the SAME conference rather than allocating a second Meet.
        fields.addConferenceRequestId = conferenceRequestId;
        expectation.expectMeet = true;
      }

      const event = await ctx.create(userId, fields, { sendUpdates });
      const { observed, verification } = await verifyWrite(
        userId,
        event,
        expectation,
        ctx.getEvent,
      );

      // A verified MISMATCH means the calendar does not say what we were about
      // to claim. Report what is actually true instead of the intent.
      if (verification && !verification.ok) {
        return await reportPartial(
          userId,
          actionId,
          provider,
          observed,
          verification,
          timezone,
          ctx,
          "created",
        );
      }

      const executionId = await ctx.record(userId, {
        proposalId: ctx.proposalId,
        provider,
        actionId,
        status: "succeeded",
        requestSummary: {
          hasLocation: Boolean(location),
          hasDescription: Boolean(description),
          attendeeCount: attendees.length,
          requestedMeet: Boolean(conferenceRequestId),
          allDay,
        },
        // Ledger keeps only the Google-issued id — never the title or times.
        resultSummary: { eventId: event.id, verified: verification?.ok ?? false },
      });

      await rememberActed(userId, observed, "created", ctx);

      return {
        ok: true,
        status: "succeeded",
        actionId,
        provider,
        userMessage: formatCreated(observed, timezone),
        executionId,
        receipt: { eventId: event.id },
      };
    }

    if (actionId === "calendar.updateEvent") {
      if (!eventId) return await fail("invalid_input", CALENDAR_WRITE_REPLIES.unavailable);
      const fields: CalendarEventWriteFields = {};
      const expectation: EventExpectation = {};

      const newTitle = readStr(input, "newTitle");
      const newLocation = readStr(input, "newLocation");
      const newDescription = readStr(input, "newDescription");
      if (newTitle) {
        fields.summary = newTitle;
        expectation.title = newTitle;
      }
      if (newLocation) {
        fields.location = newLocation;
        expectation.location = newLocation;
      }
      if (newDescription) {
        fields.description = newDescription;
        expectation.description = newDescription;
      }
      if (startIso && endIso) {
        // Same never-past re-check as create: a reschedule confirmed late must
        // not land the event in the past.
        const startMs = new Date(startIso).getTime();
        if (!Number.isFinite(startMs) || startMs <= Date.now()) {
          return await fail("start_in_past", CALENDAR_WRITE_REPLIES.inPast);
        }
        fields.start = { dateTime: startIso, timeZone: timezone };
        fields.end = { dateTime: endIso, timeZone: timezone };
        expectation.startIso = startIso;
        expectation.endIso = endIso;
      }
      if (attendees.length > 0) {
        // The proposal already merged this into the COMPLETE list — Google's
        // PATCH replaces the array wholesale rather than merging.
        fields.attendees = attendees.map((email) => ({ email }));
        expectation.attendees = attendees;
      }
      const reminderMinutes = readNum(input, "reminderMinutes");
      if (reminderMinutes !== null) {
        fields.reminders = [{ method: "popup", minutes: reminderMinutes }];
      }
      if (conferenceRequestId) {
        fields.addConferenceRequestId = conferenceRequestId;
        expectation.expectMeet = true;
      }

      if (Object.keys(fields).length === 0) {
        return await fail("invalid_input", CALENDAR_WRITE_REPLIES.needChange);
      }

      const event = await ctx.update(userId, eventId, fields, { sendUpdates });
      const { observed, verification } = await verifyWrite(
        userId,
        event,
        expectation,
        ctx.getEvent,
      );

      if (verification && !verification.ok) {
        return await reportPartial(
          userId,
          actionId,
          provider,
          observed,
          verification,
          timezone,
          ctx,
          "updated",
        );
      }

      const executionId = await ctx.record(userId, {
        proposalId: ctx.proposalId,
        provider,
        actionId,
        status: "succeeded",
        requestSummary: { changedKeys: Object.keys(fields) },
        resultSummary: { eventId: event.id, verified: verification?.ok ?? false },
      });

      await rememberActed(userId, observed, "updated", ctx);

      return {
        ok: true,
        status: "succeeded",
        actionId,
        provider,
        userMessage: formatUpdated(observed, timezone, input?.renamedOnly === true),
        executionId,
        receipt: { eventId: event.id },
      };
    }

    // Cancel/delete. `deleteCalendarEvent` returns normally ONLY on a 2xx from
    // Google (204 No Content for a successful delete); any other status throws a
    // classified error. The confirmation uses the details captured at proposal
    // time because a deleted event has no response body to read them back from.
    if (!eventId) return await fail("invalid_input", CALENDAR_WRITE_REPLIES.unavailable);
    await ctx.remove(userId, eventId, { sendUpdates });

    // Postcondition: ask whether it is actually gone. A `false` here means
    // Google accepted the DELETE but the event is still on the calendar — which
    // must never be reported as a deletion.
    let deletionVerified: boolean | null = null;
    try {
      deletionVerified = await ctx.verifyDeleted(userId, eventId);
    } catch {
      // Couldn't check (transport). The 2xx stands as Google's own confirmation.
      deletionVerified = null;
    }
    if (deletionVerified === false) {
      return await fail("delete_not_verified", CALENDAR_WRITE_REPLIES.unavailable);
    }

    const deletedEvent: NormalizedCalendarEvent = {
      id: eventId,
      calendarId: "primary",
      summary: title || null,
      location: null,
      description: null,
      start: startIso || null,
      end: endIso || null,
      allDay: false,
      status: "cancelled",
      htmlLink: null,
      attendeeCount: null,
      attendees: [],
      organizerEmail: null,
      timeZone: null,
      conference: null,
      recurringEventId: null,
      isRecurringMaster: false,
      source: "google_calendar",
    };

    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "succeeded",
      requestSummary: { recurrenceScope: readStr(input, "recurrenceScope") || "this_event" },
      resultSummary: { eventId, verified: deletionVerified === true },
    });

    await rememberActed(userId, deletedEvent, "cancelled", ctx);

    return {
      ok: true,
      status: "succeeded",
      actionId,
      provider,
      userMessage: formatDeleted(deletedEvent, timezone),
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

async function runAsanaResourceAction(userId:string,actionId:string,input:Record<string,unknown>|undefined,provider:string,deps:{record:typeof recordActionExecution;proposalId:string|null;create:typeof createAsanaResource;update:typeof updateAsanaResource;remove:typeof deleteAsanaResource;get:typeof getAsanaResource;remember:typeof recordAsanaEntity}):Promise<ActionExecutionResult>{
  const entity=actionId.split(".")[1] as "project"|"section"|"portfolio"|"goal"|"time_entry";const plural={project:"projects",section:"sections",portfolio:"portfolios",goal:"goals",time_entry:"time_tracking_entries"} as const;const kind=plural[entity];const resourceId=readStr(input,"resourceId");const data=input?.data&&typeof input.data==="object"?input.data as Record<string,unknown>:{};const operation=readStr(input,"operation");
  const fail=async(code:string,message:string)=>{const executionId=await deps.record(userId,{proposalId:deps.proposalId,provider,actionId,status:"failed",requestSummary:{entity,operation},errorMessage:code});return{ok:false,status:"failed" as const,actionId,provider,userMessage:message,executionId};};
  try{if(actionId.endsWith(".delete")){if(!resourceId)return fail("invalid_input",`I’m missing the exact Asana ${entity.replace("_"," ")} to delete.`);await deps.remove(userId,kind,resourceId);await deps.remember(userId,{id:resourceId,type:"deleted",title:`Deleted Asana ${entity.replace("_"," ")}`,completed:null,project:null,section:null,due:null,permalink:null},"deleted");const executionId=await deps.record(userId,{proposalId:deps.proposalId,provider,actionId,status:"succeeded",requestSummary:{entity},resultSummary:{resourceId}});return{ok:true,status:"succeeded",actionId,provider,userMessage:`Deleted that Asana ${entity.replace("_"," ")}.`,executionId,receipt:{asanaResourceIds:[resourceId]}};}
    let receipt:AsanaReceipt;if(operation==="create")receipt=await deps.create(userId,kind,data,{parentPath:readStr(input,"parentPath")||undefined});else{if(!resourceId)return fail("invalid_input",`I’m missing the exact Asana ${entity.replace("_"," ")} to update.`);receipt=await deps.update(userId,kind,resourceId,data);}if(operation!=="create"&&receipt.gid!==resourceId)throw new AsanaError("malformed_response",200);const observed=await deps.get(userId,kind,receipt.gid);if(observed.gid!==receipt.gid)throw new Error("postcondition mismatch");for(const key of ["name","notes","archived"] as const)if(key in data&&(observed[key]??null)!==(data[key]??null))throw new Error("postcondition mismatch");await deps.remember(userId,toAsanaContextItem(observed),operation);const executionId=await deps.record(userId,{proposalId:deps.proposalId,provider,actionId,status:"succeeded",requestSummary:{entity,operation},resultSummary:{resourceId:receipt.gid,verified:true}});return{ok:true,status:"succeeded",actionId,provider,userMessage:`${operation==="create"?"Created":"Updated"} “${asanaPlainText(receipt.name) || entity.replace("_"," ")}” in Asana.`,executionId,receipt:{asanaResourceIds:[receipt.gid]}};
  }catch(error){const e=error instanceof AsanaError?error:null;return fail(e?.reason??"execution_failed",e?.reason==="plan_restricted"?"Asana says that feature isn’t included in your current plan.":e?.reason==="forbidden"?"I don’t have permission to change that Asana resource.":actionId.endsWith(".delete")&&(e?.reason==="timeout"||e?.reason==="network_failure")?"I asked Asana to delete that, but the outcome is unknown. I haven’t tried again.":"I couldn’t make that Asana change.");}}

async function runAsanaAction(
  userId:string, actionId:string, input:Record<string,unknown>|undefined, provider:string,
  deps:{record:typeof recordActionExecution;proposalId:string|null;create:typeof createAsanaTask;update:typeof updateAsanaTask;remove:typeof deleteAsanaResource;relationship:typeof mutateAsanaRelationship;get:typeof getAsanaResource;listTasks:typeof listAsanaTasks;comment:(u:string,t:string,text:string)=>Promise<AsanaResource>;remember:typeof recordAsanaEntity},
):Promise<ActionExecutionResult>{
  const relationIds=(value:unknown)=>Array.isArray(value)?value.map(item=>item&&typeof item==="object"?(item as Record<string,unknown>).gid:null).filter((id):id is string=>typeof id==="string"):[];
  const relationVerified=(action:string,relationshipInput:Record<string,unknown>,observed:AsanaResource)=>{const check=(collection:unknown,ids:string[],present:boolean)=>ids.every(id=>relationIds(collection).includes(id)===present);if(action==="addFollowers"||action==="removeFollowers")return check(observed.followers,readStrArray(relationshipInput,"followers"),action==="addFollowers");if(action==="addDependencies"||action==="removeDependencies")return check(observed.dependencies,readStrArray(relationshipInput,"dependencies"),action==="addDependencies");if(action==="addTag"||action==="removeTag")return check(observed.tags,[readStr(relationshipInput,"tag")].filter(Boolean),action==="addTag");if(action==="addProject"||action==="removeProject")return check(observed.projects,[readStr(relationshipInput,"project")].filter(Boolean),action==="addProject");return true;};
  const ids=readStrArray(input,"taskIds");
  const fail=async(code:string,message:string,status:ActionExecutionStatusValue="failed")=>{const executionId=await deps.record(userId,{proposalId:deps.proposalId,provider,actionId,status,requestSummary:{taskCount:ids.length,inputKeys:Object.keys(input??{})},errorMessage:code});return{ok:false,status,actionId,provider,userMessage:message,executionId};};
  const successIds:string[]=[];const failures:string[]=[];
  try{
    if(actionId==="asana.task.create"){
      const receipt=await deps.create(userId,input??{});const observed=await deps.get(userId,"tasks",receipt.gid);const expectedProjects=Array.isArray(input?.projects)?input.projects.filter((value):value is string=>typeof value==="string"):[];const observedProjects=[...(Array.isArray(observed.projects)?observed.projects:[]),...(Array.isArray(observed.memberships)?observed.memberships.map(value=>value&&typeof value==="object"?(value as Record<string,unknown>).project:null):[])].map(value=>value&&typeof value==="object"?(value as Record<string,unknown>).gid:null).filter((value):value is string=>typeof value==="string");const mismatched=typeof observed.gid!=="string"||observed.gid!==receipt.gid||(typeof input?.name==="string"&&observed.name!==input.name)||(typeof input?.notes==="string"&&observed.notes!==input.notes)||(typeof input?.due_at==="string"&&observed.due_at!==input.due_at)||(typeof input?.due_on==="string"&&observed.due_on!==input.due_on)||expectedProjects.some(project=>!observedProjects.includes(project));if(mismatched)return fail("unverified_receipt","Asana accepted the task, but I couldn’t verify every requested field. I haven’t tried again.");
      await deps.remember(userId,toAsanaContextItem(observed),"created");const executionId=await deps.record(userId,{proposalId:deps.proposalId,provider,actionId,status:"succeeded",requestSummary:{inputKeys:Object.keys(input??{})},resultSummary:{resourceId:receipt.gid,verified:true}});return{ok:true,status:"succeeded",actionId,provider,userMessage:`Added “${asanaPlainText(receipt.name)||"Untitled"}” to Asana.`,executionId,receipt:{asanaResourceIds:[receipt.gid]}};
    }
    if(!ids.length)return fail("invalid_input","I’m missing the exact Asana task to change.");
    if(actionId==="asana.task.relationship"&&readStr(input,"relationshipAction")==="moveToSection"){
      const taskId=ids[0]!,relationshipInput=input?.relationshipInput&&typeof input.relationshipInput==="object"?input.relationshipInput as Record<string,unknown>:{};const section=readStr(relationshipInput,"section"),project=readStr(relationshipInput,"project"),sectionName=asanaPlainText(readStr(relationshipInput,"sectionName"))||"that section";if(ids.length!==1||!section||!project)return fail("invalid_input","I’m missing the exact Asana task, project, or section for that move.");
      try{const before=await deps.get(userId,"tasks",taskId);const memberships=Array.isArray(before.memberships)?before.memberships as Record<string,unknown>[]:[];const alreadyThere=memberships.some(m=>m.section&&typeof m.section==="object"&&(m.section as Record<string,unknown>).gid===section);if(alreadyThere){await deps.remember(userId,toAsanaContextItem(before),"moved");const executionId=await deps.record(userId,{proposalId:deps.proposalId,provider,actionId,status:"succeeded",requestSummary:{taskCount:1,operation:"move_to_section"},resultSummary:{resourceId:taskId,sectionId:section,alreadyApplied:true}});return{ok:true,status:"succeeded",actionId,provider,userMessage:`That Asana task is already in ${sectionName}.`,executionId,receipt:{asanaResourceIds:[taskId]}};}
        const relationshipReceipt=await deps.relationship(userId,taskId,"moveToSection",{section,project});if(!("accepted" in relationshipReceipt)||relationshipReceipt.accepted!==true||relationshipReceipt.taskGid!==taskId||relationshipReceipt.sectionGid!==section)throw new AsanaError("malformed_response",200);
        let postcondition:"confirmed"|"stale"|"unavailable"="unavailable";try{const sectionTasks=await deps.listTasks(userId,{section,count:500});postcondition=sectionTasks.some(task=>task.gid===taskId)?"confirmed":"stale";}catch{}
        const updatedMemberships=memberships.filter(m=>!(m.project&&typeof m.project==="object"&&(m.project as Record<string,unknown>).gid===project));updatedMemberships.push({project:{gid:project},section:{gid:section,name:sectionName}});await deps.remember(userId,toAsanaContextItem({...before,memberships:updatedMemberships}),"moved");const executionId=await deps.record(userId,{proposalId:deps.proposalId,provider,actionId,status:"succeeded",requestSummary:{taskCount:1,operation:"move_to_section"},resultSummary:{resourceId:taskId,sectionId:section,receiptValidated:true,postcondition}});return{ok:true,status:"succeeded",actionId,provider,userMessage:`Moved that Asana task to ${sectionName}.`,executionId,receipt:{asanaResourceIds:[taskId]}};
      }catch(error){const asanaError=error instanceof AsanaError?error:null;const code=asanaError?.reason??"execution_failed";logger.error("asana.operation failed",{operation:"move_to_section",errorCode:code,httpStatus:asanaError?.status??null,endpoint:"sections/{section_gid}/addTask",category:asanaError?"provider":"validation"});const message=code==="invalid_request"?"Asana rejected that section move as invalid. Nothing was reported as moved.":code==="auth_failed"||code==="reconnect_required"?"Asana needs to be reconnected before I can move that task.":code==="forbidden"?"I don’t have permission to move that task into the requested Asana section.":code==="not_found"?"That Asana task or section is no longer accessible.":code==="rate_limited"?"Asana is rate-limiting requests right now, so I didn’t report the task as moved.":code==="timeout"||code==="network_failure"?"I asked Asana to move that task, but the connection dropped before it confirmed. I haven’t tried again.":code==="malformed_response"?"Asana returned an invalid move receipt, so I didn’t report success.":"Asana couldn’t complete that section move.";return fail(code,message,code==="timeout"||code==="network_failure"?"failed":"failed");}
    }
    const updateFields=input?.fields&&typeof input.fields==="object"?input.fields as Record<string,unknown>:{};
    if(actionId==="asana.task.update"&&typeof updateFields.assignee==="string"){
      if(ids.length!==1)return fail("invalid_input","Assign one Asana task at a time so I can verify the assignee.");
      const taskId=ids[0]!,assignee=updateFields.assignee;
      try{
        const receipt=await deps.update(userId,taskId,{assignee});
        if(receipt.gid!==taskId)throw new AsanaError("malformed_response",200);
        const observed=await deps.get(userId,"tasks",taskId);
        const observedAssignee=observed.assignee&&typeof observed.assignee==="object"?(observed.assignee as Record<string,unknown>).gid:null;
        if(observed.gid!==taskId||observedAssignee!==assignee)throw new Error("assignment_postcondition_mismatch");
        await deps.remember(userId,toAsanaContextItem(observed),"assigned");
        const executionId=await deps.record(userId,{proposalId:deps.proposalId,provider,actionId,status:"succeeded",requestSummary:{taskCount:1,operation:"assign_task"},resultSummary:{resourceId:taskId,receiptValidated:true,postcondition:"confirmed"}});
        return{ok:true,status:"succeeded",actionId,provider,userMessage:"Assigned that Asana task.",executionId,receipt:{asanaResourceIds:[taskId]}};
      }catch(error){
        const providerError=error instanceof AsanaError?error:null;const postcondition=error instanceof Error&&error.message==="assignment_postcondition_mismatch";const code=providerError?.reason??(postcondition?"postcondition_mismatch":"execution_failed");
        logger.error("asana.operation failed",{operation:"assign_task",errorCode:code,httpStatus:providerError?.status??null,endpoint:"tasks/{task_gid}",category:providerError?"provider":postcondition?"verification":"validation"});
        const message=code==="invalid_request"?"Asana rejected that assignment as invalid. Nothing was reported as assigned.":code==="auth_failed"||code==="reconnect_required"?"Asana needs to be reconnected before I can assign that task.":code==="forbidden"?"I don’t have permission to assign that Asana task.":code==="not_found"?"That Asana task or assignee is no longer accessible.":code==="rate_limited"?"Asana is rate-limiting requests right now, so I didn’t report the task as assigned.":code==="timeout"||code==="network_failure"?"I asked Asana to assign that task, but the connection dropped before it confirmed. I haven’t tried again.":code==="malformed_response"?"Asana returned an invalid assignment receipt, so I didn’t report success.":code==="postcondition_mismatch"?"Asana accepted the assignment, but I couldn’t verify the assignee, so I didn’t report success.":"Asana couldn’t complete that assignment.";
        return fail(code,message);
      }
    }
    for(const id of ids.slice(0,20)){
      try{
        if(actionId==="asana.task.delete"){await deps.remove(userId,"tasks",id);await deps.remember(userId,{id,type:"deleted",title:"Deleted Asana task",completed:null,project:null,section:null,due:null,permalink:null},"deleted");successIds.push(id);continue;}
        if(actionId==="asana.task.comment"){const body=readStr(input,"text");if(!body)throw new Error("missing comment");const story=await deps.comment(userId,id,body);if(typeof story.gid!=="string"||!story.gid)throw new Error("malformed receipt");const observed=await deps.get(userId,"tasks",id);if(observed.gid!==id)throw new Error("postcondition mismatch");await deps.remember(userId,toAsanaContextItem(observed),"commented");successIds.push(id);continue;}
        if(actionId==="asana.task.relationship"||actionId==="asana.task.attachUrl"){const action=(actionId==="asana.task.attachUrl"?"attachUrl":readStr(input,"relationshipAction")) as Parameters<typeof mutateAsanaRelationship>[2];const allowed=new Set(["addProject","removeProject","addFollowers","removeFollowers","addDependencies","removeDependencies","addTag","removeTag","attachUrl"]);if(!allowed.has(action))throw new Error("invalid relationship");const relationshipInput=input?.relationshipInput&&typeof input.relationshipInput==="object"?input.relationshipInput as Record<string,unknown>:{};const relationshipReceipt=await deps.relationship(userId,id,action,relationshipInput);if("taskGid" in relationshipReceipt?(relationshipReceipt.taskGid!==id||relationshipReceipt.accepted!==true):action==="attachUrl"?!relationshipReceipt.gid:relationshipReceipt.gid!==id)throw new AsanaError("malformed_response",200);const observed=await deps.get(userId,"tasks",id);if(observed.gid!==id||!relationVerified(action,relationshipInput,observed))throw new Error("postcondition mismatch");await deps.remember(userId,toAsanaContextItem(observed),action);successIds.push(id);continue;}
        const fields=input?.fields&&typeof input.fields==="object"?input.fields as Record<string,unknown>:{};const receipt=await deps.update(userId,id,fields);const observed=await deps.get(userId,"tasks",id);if(observed.gid!==receipt.gid||receipt.gid!==id)throw new Error("unverified");for(const key of ["name","notes","due_on","due_at","start_on","start_at","completed"] as const){if(!(key in fields))continue;const expected=fields[key]??null,actual=observed[key]??null;if(actual!==expected)throw new Error("postcondition mismatch");}await deps.remember(userId,toAsanaContextItem(observed),"updated");successIds.push(id);
      }catch{failures.push(id);}
    }
    if(!successIds.length)return fail("provider_failure","I couldn’t make that Asana change. Nothing was reported as completed.");
    const partial=failures.length>0;const executionId=await deps.record(userId,{proposalId:deps.proposalId,provider,actionId,status:partial?"failed":"succeeded",requestSummary:{taskCount:ids.length},resultSummary:{succeeded:successIds.length,failed:failures.length}});
    const verb=actionId.endsWith("delete")?"Deleted":actionId.endsWith("comment")?"Commented on":"Updated";
    return{ok:!partial,status:partial?"failed":"succeeded",actionId,provider,userMessage:partial?`${verb} ${successIds.length} of ${ids.length} Asana tasks. ${failures.length} failed.`:`${verb} ${successIds.length===1?"that Asana task":`${successIds.length} Asana tasks`}.`,executionId,receipt:{asanaResourceIds:successIds}};
  }catch(error){const e=error instanceof AsanaError?error:null;const message=e?.reason==="not_connected"?"Your Asana isn’t connected.":e?.reason==="plan_restricted"?"Asana says that feature isn’t included in your current plan.":e?.reason==="forbidden"?"I don’t have permission to make that Asana change.":e&&(e.reason==="timeout"||e.reason==="network_failure")&&actionId.endsWith("delete")?"I asked Asana to delete that, but the connection dropped before it confirmed. I haven’t tried again.":"I couldn’t reach Asana to make that change.";return fail(e?.reason??"execution_failed",message);}
}

/** Honest replies for the Todoist executor (never leak provider detail). */
export const TODOIST_EXEC_REPLIES = {
  notConnected: "Your Todoist isn’t connected, so I can’t do that.",
  reconnect: "I don’t have permission to change your Todoist yet — reconnect it in Hula.",
  deleteReconnect:
    "I don’t have permission to delete Todoist tasks yet — reconnect Todoist in Hula and allow deletion.",
  unavailable: "I couldn’t reach Todoist just now — mind trying again in a bit?",
  taskGone: "That task isn’t in your Todoist anymore — it may have been deleted already.",
  missingInfo: "I don’t have enough to do that — I’m missing the task or what to change.",
  noDueTime: "That task doesn’t have a due date, so there’s no time to take off it.",
  /**
   * The DELETE never returned a validated response — a timeout or a dropped
   * connection. Genuinely uncertain: it may or may not have landed. We do NOT
   * retry (a destructive write of unknown outcome must never be repeated) and we
   * do NOT claim either result.
   */
  deleteUncertain:
    "I asked Todoist to delete that, but the connection dropped before it confirmed — so I can’t tell you whether it went through. I haven’t tried again. Mind checking Todoist?",
  /**
   * Todoist accepted the change, but reading the task back did NOT show the state
   * we promised. We do NOT retry: a blind retry of a write that may have partly
   * landed is how one task becomes two.
   */
  unverified:
    "I asked Todoist to make that change, but when I checked, it hadn’t taken effect. I haven’t tried again — mind taking a look, or asking me once more?",
} as const;

/** PURE: map a Todoist provider failure to an honest reply. */
export function todoistReplyForError(
  err: TodoistError | null,
  actionId: TodoistActionId,
): string {
  if (!err) return TODOIST_EXEC_REPLIES.unavailable;
  if (err.reason === "not_connected") return TODOIST_EXEC_REPLIES.notConnected;
  if (err.reason === "insufficient_scope" || isTodoistReconnectReason(err.reason)) {
    // Name the DELETE permission specifically: a user who connected for read/write
    // must not be told their whole Todoist access is broken because they declined
    // the optional delete scope.
    return actionId === "task.delete"
      ? TODOIST_EXEC_REPLIES.deleteReconnect
      : TODOIST_EXEC_REPLIES.reconnect;
  }
  if (err.reason === "task_not_found") return TODOIST_EXEC_REPLIES.taskGone;
  // A DELETE that never got a validated response is genuinely uncertain — it may
  // have landed. Saying "try again in a bit" would invite a repeat of a
  // destructive write whose outcome we do not know.
  if (actionId === "task.delete" && isUncertainOutcome(err.reason)) {
    return TODOIST_EXEC_REPLIES.deleteUncertain;
  }
  return TODOIST_EXEC_REPLIES.unavailable;
}

/**
 * PURE: did the request fail WITHOUT a validated provider response?
 *
 * These are pre-response transport failures plus a 2xx we could not validate. For
 * a destructive write they mean "unknown outcome", which is a different thing from
 * a definitive provider rejection (404/403/429/5xx), where nothing happened.
 */
function isUncertainOutcome(reason: TodoistError["reason"]): boolean {
  return (
    reason === "todoist_timeout" ||
    reason === "network_failure" ||
    reason === "connection_reset" ||
    reason === "connect_timeout" ||
    reason === "malformed_provider_response"
  );
}

/** PURE: the past-tense verb for a Todoist action, used in replies. */
function todoistVerb(actionId: TodoistActionId): string {
  switch (actionId) {
    case "task.create":
      return "Added";
    case "task.update":
      return "Updated";
    case "task.move":
      return "Moved";
    case "task.complete":
      return "Completed";
    case "task.reopen":
      return "Reopened";
    case "task.delete":
      return "Deleted";
    default:
      return "Updated";
  }
}

/** PURE: read the write fields for a Todoist create/update out of redacted input. */
function readTodoistFields(input: Record<string, unknown> | undefined): TodoistTaskWriteFields {
  const fields: TodoistTaskWriteFields = {};
  const content = readStr(input, "content");
  const description = readStr(input, "description");
  const dueDate = readStr(input, "dueDate");
  const dueDatetime = readStr(input, "dueDatetime");
  const dueString = readStr(input, "dueString");
  const priority = readNum(input, "priority");
  const labels = readStrArray(input, "labels");

  if (content) fields.content = content;
  if (description) fields.description = description;
  if (dueDate) fields.dueDate = dueDate;
  if (dueDatetime) fields.dueDatetime = dueDatetime;
  if (dueString) fields.dueString = dueString;
  if (input?.removeDue === true) fields.removeDue = true;
  if (priority !== null) fields.priority = priority;
  // An explicitly-supplied EMPTY array means "remove every label" — a real
  // request. `readStrArray` cannot distinguish that from absent, so the presence
  // of the key is what decides.
  if (input && "labels" in input && Array.isArray(input.labels)) fields.labels = labels;
  return fields;
}

/** PURE: build the expectation a Todoist write must prove after the fact. */
export function todoistExpectationFor(
  actionId: TodoistActionId,
  input: Record<string, unknown> | undefined,
): TaskExpectation {
  const expectation: TaskExpectation = {};
  if (actionId === "task.complete") return { completed: true };
  if (actionId === "task.reopen") return { completed: false };
  if (actionId === "task.move") {
    const projectId = readStr(input, "projectId");
    const sectionId = readStr(input, "sectionId");
    if (projectId) expectation.projectId = projectId;
    if (sectionId) expectation.sectionId = sectionId;
    return expectation;
  }

  const fields = readTodoistFields(input);
  if (fields.content !== undefined) expectation.content = fields.content;
  if (fields.description !== undefined) expectation.description = fields.description;

  // The due expectation is stated in the USER'S LOCAL TERMS ("2026-07-17" at
  // "17:00" in Europe/London), not as the UTC instant we happen to send. Todoist
  // may store the due as a floating wall time OR as an absolute instant, and the
  // only thing stable across both — and the only thing the user cares about — is
  // whether it says 5pm on Friday.
  const timezone = readStr(input, "timezone") || undefined;
  const dueLocalDate = readStr(input, "dueLocalDate");
  const dueLocalTime = readStr(input, "dueLocalTime");
  if (fields.removeDue) {
    expectation.dueRemoved = true;
  } else if (input?.removeDueTime === true) {
    // The date is asserted by the executor from the task's own current date.
    expectation.dueTimeRemoved = true;
    if (dueLocalDate) expectation.dueDate = dueLocalDate;
    expectation.dueTimezone = timezone;
  } else if (dueLocalDate) {
    expectation.dueDate = dueLocalDate;
    if (dueLocalTime) expectation.dueTime = dueLocalTime;
    expectation.dueTimezone = timezone;
  }
  if (fields.priority !== undefined) expectation.priority = fields.priority;
  if (fields.labels !== undefined) expectation.labels = fields.labels;
  // A recurring `dueString` is deliberately NOT asserted: Todoist parses it
  // server-side into a date we did not compute, so we cannot state in advance what
  // it will become. Claiming an expectation we cannot derive would produce a false
  // mismatch on a perfectly good write.
  if (actionId === "task.create" && expectation.completed === undefined) {
    expectation.completed = false;
  }
  return expectation;
}

/**
 * Execute a Todoist task write from ALREADY-RESOLVED structured input (Section 19).
 *
 * ONE function for the whole lifecycle because every Todoist write shares the same
 * shape: resolve → write → RE-READ → verify → report. The uniformity is the point;
 * a per-action copy of this loop is where partial-failure honesty rots.
 *
 * The rules it enforces, all of which the section names explicitly:
 *  - Success is claimed ONLY from a verified re-read, never from a 2xx. Todoist
 *    answers 204 to close/reopen/delete with NO body, so the provider's acceptance
 *    carries no information about the outcome at all.
 *  - PARTIAL bulk failure is reported as partial. "Completed 2 of 3" is the truth;
 *    rounding it to "Completed 3" is the exact lie Phase 9 forbids.
 *  - Nothing is retried. An ambiguous write retried is how duplicates happen.
 *  - `recordActed` runs ONLY over the VERIFIED set, so "undo that" can never
 *    reverse something that did not happen.
 *
 * Never throws.
 */
async function runTodoistWrite(
  userId: string,
  actionId: TodoistActionId,
  input: Record<string, unknown> | undefined,
  provider: string,
  ctx: {
    record: typeof recordActionExecution;
    proposalId: string | null;
    inputKeys: string[];
    create: typeof createTask;
    update: typeof updateTask;
    move: typeof moveTask;
    close: typeof closeTask;
    reopen: typeof reopenTask;
    remove: typeof deleteTask;
    getTask: typeof fetchTask;
    recordActed: typeof recordActedTodoistTask;
    /** Waits between bounded delete-absence re-reads (injected in tests). */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<ActionExecutionResult> {
  const taskIds = readStrArray(input, "taskIds");

  const fail = async (
    errorMessage: string,
    userMessage: string,
  ): Promise<ActionExecutionResult> => {
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "failed",
      requestSummary: { inputKeys: ctx.inputKeys, taskCount: taskIds.length },
      errorMessage,
    });
    return { ok: false, status: "failed", actionId, provider, userMessage, executionId };
  };

  // --- CREATE: a single task, verified into existence --------------------
  if (actionId === "task.create") {
    const fields = readTodoistFields(input);
    if (!fields.content) return await fail("invalid_input", TODOIST_EXEC_REPLIES.missingInfo);
    const projectId = readStr(input, "projectId");
    const sectionId = readStr(input, "sectionId");
    if (projectId) fields.projectId = projectId;
    if (sectionId) fields.sectionId = sectionId;

    try {
      // The requestId is generated at proposal time and REPLAYED, so a duplicate
      // delivery reuses Todoist's de-duplication rather than creating a twin.
      const created = await ctx.create(userId, fields, {
        requestId: readStr(input, "requestId") || undefined,
      });

      const createExpectation = todoistExpectationFor(actionId, input);
      const { observed, verification } = await verifyTodoistWrite(
        userId,
        created,
        createExpectation,
        ctx.getTask,
      );
      if (verification && !verification.ok) {
        return await reportTodoistPartial(
          userId,
          actionId,
          provider,
          observed,
          verification,
          ctx,
          createExpectation,
        );
      }

      const executionId = await ctx.record(userId, {
        proposalId: ctx.proposalId,
        provider,
        actionId,
        status: "succeeded",
        requestSummary: {
          hasDue: Boolean(fields.dueDate || fields.dueDatetime || fields.dueString),
          hasProject: Boolean(projectId),
          labelCount: fields.labels?.length ?? 0,
        },
        // Ledger keeps only the Todoist-issued id — never the title.
        resultSummary: { taskId: created.id, verified: verification?.ok ?? false },
      });

      await rememberTodoistActed(userId, observed, "created", ctx);
      return {
        ok: true,
        status: "succeeded",
        actionId,
        provider,
        userMessage: `Added “${observed.content}”.`,
        executionId,
        receipt: { taskIds: [created.id] },
      };
    } catch (err) {
      const todoistErr = err instanceof TodoistError ? err : null;
      logger.error("action.todoistWrite failed", {
        actionId,
        errorCode: todoistErr?.reason ?? "unknown",
        httpStatus: todoistErr?.httpStatus ?? null,
      });
      return await fail(
        todoistErr?.reason ?? "execution_failed",
        todoistReplyForError(todoistErr, actionId),
      );
    }
  }

  // --- EVERYTHING ELSE: 1..N tasks, each verified individually -----------
  if (taskIds.length === 0) return await fail("invalid_input", TODOIST_EXEC_REPLIES.missingInfo);

  const expectation = todoistExpectationFor(actionId, input);
  const verified: string[] = [];
  const verifiedTasks: NormalizedTodoistTask[] = [];
  let rolledForward = 0;
  let firstError: TodoistError | null = null;

  for (const taskId of taskIds) {
    try {
      // Re-fetch BEFORE the write. The context may be up to 30 minutes old, and
      // this is also what tells us whether the task is recurring — which changes
      // what a successful completion even looks like.
      let before: NormalizedTodoistTask | null = null;
      try {
        before = await ctx.getTask(userId, taskId);
      } catch (err) {
        if (err instanceof TodoistError && err.reason === "task_not_found") {
          // Already gone. For a delete that IS the requested end state.
          if (actionId === "task.delete") {
            verified.push(taskId);
            continue;
          }
        }
        throw err;
      }

      if (actionId === "task.update") {
        const fields = readTodoistFields(input);
        if (input?.removeDueTime === true) {
          // "Take the time off that, keep the day." Todoist has no 'clear the
          // time' flag — sending a date-only `due_date` IS how the time is
          // dropped. The date comes from the task's OWN freshly-read due date, so
          // a stale context can never silently move the day while removing a time.
          const currentKey = dueLocalStamp(
            before?.due ?? null,
            readStr(input, "timezone") || undefined,
          )?.dateKey;
          if (!currentKey) {
            return await fail("invalid_input", TODOIST_EXEC_REPLIES.noDueTime);
          }
          fields.dueDate = currentKey;
          delete fields.dueDatetime;
          delete fields.dueString;
        }
        await ctx.update(userId, taskId, fields);
      } else if (actionId === "task.move") {
        await ctx.move(userId, taskId, {
          projectId: readStr(input, "projectId") || undefined,
          sectionId: readStr(input, "sectionId") || undefined,
        });
      } else if (actionId === "task.complete") {
        await ctx.close(userId, taskId);
      } else if (actionId === "task.reopen") {
        await ctx.reopen(userId, taskId);
      } else {
        // DELETE. Executed EXACTLY ONCE and never retried — a destructive write
        // whose outcome is unknown must never be repeated.
        //
        // `ctx.remove` returns only on a DOCUMENTED success status (see
        // `deleteTask`); anything else throws and is handled by the catch below.
        // That validated receipt is AUTHORITATIVE: Todoist has told us the task is
        // gone, and no subsequent read can make that untrue.
        const receipt = await ctx.remove(userId, taskId);
        // The read-back can only ever CONFIRM — never falsify. See
        // `confirmTodoistDeletion`.
        const confirmation = await confirmTodoistDeletion(userId, taskId, ctx.getTask, ctx.sleep);
        logger.info("action.todoistDelete", {
          httpStatus: receipt.httpStatus,
          confirmation,
        });
        verified.push(taskId);
        verifiedTasks.push(before);
        continue;
      }

      // PROVE it. Todoist's acceptance is not the outcome; the task's real state
      // is. This read-back is the whole point of the loop.
      let after: NormalizedTodoistTask | null = null;
      let found = true;
      try {
        after = await ctx.getTask(userId, taskId);
      } catch (err) {
        if (err instanceof TodoistError && err.reason === "task_not_found") found = false;
        else throw err;
      }

      let ok: boolean;
      if (actionId === "task.complete") {
        const result = verifyCompletion({
          found,
          task: after,
          wasRecurring: before?.due?.isRecurring ?? false,
        });
        ok = result.ok;
        if (result.rolledForward) rolledForward += 1;
      } else if (actionId === "task.reopen") {
        ok = verifyReopen(after);
      } else {
        ok = verifyTaskState(after, expectation).ok;
      }

      if (ok) {
        verified.push(taskId);
        verifiedTasks.push(after ?? before);
      }
    } catch (err) {
      const todoistErr = err instanceof TodoistError ? err : null;
      if (!firstError && todoistErr) firstError = todoistErr;
      logger.error("action.todoistWrite failed", {
        actionId,
        errorCode: todoistErr?.reason ?? "unknown",
        httpStatus: todoistErr?.httpStatus ?? null,
      });
      // A dead grant / missing scope applies to EVERY task — stop rather than
      // hammer Todoist with calls that will all fail identically.
      if (
        todoistErr &&
        (todoistErr.reason === "not_connected" ||
          todoistErr.reason === "insufficient_scope" ||
          isTodoistReconnectReason(todoistErr.reason))
      ) {
        break;
      }
    }
  }

  if (verified.length === 0) {
    const userMessage = firstError
      ? todoistReplyForError(firstError, actionId)
      : TODOIST_EXEC_REPLIES.unverified;
    return await fail(firstError?.reason ?? "postcondition_unverified", userMessage);
  }

  const failedCount = taskIds.length - verified.length;
  const executionId = await ctx.record(userId, {
    proposalId: ctx.proposalId,
    provider,
    actionId,
    status: failedCount > 0 ? "failed" : "succeeded",
    requestSummary: { taskCount: taskIds.length, changedKeys: ctx.inputKeys },
    // Ledger keeps counts + Todoist ids only — never task titles.
    resultSummary: { verified: verified.length, unverified: failedCount },
    errorMessage: failedCount > 0 ? "postcondition_unverified" : null,
  });

  // Remember ONLY the verified set, so "undo that" can never reverse a task the
  // write did not actually change.
  const actedKind =
    actionId === "task.complete"
      ? "completed"
      : actionId === "task.reopen"
        ? "reopened"
        : actionId === "task.delete"
          ? "deleted"
          : actionId === "task.move"
            ? "moved"
            : "updated";
  if (verifiedTasks[0]) {
    await rememberTodoistActed(userId, verifiedTasks[0], actedKind, ctx, verified);
  }

  return {
    ok: failedCount === 0,
    status: failedCount > 0 ? "failed" : "succeeded",
    actionId,
    provider,
    userMessage: formatTodoistOutcome({
      actionId,
      verified: verified.length,
      total: taskIds.length,
      label: verifiedTasks[0]?.content ?? readStr(input, "label"),
      rolledForward,
    }),
    executionId,
    receipt: { taskIds: verified },
  };
}

/**
 * PURE: the user-facing outcome line.
 *
 * Partial success is reported as partial — never rounded up to "done". The
 * singular case names the task, because "Completed “Call Rob”" is far more useful
 * as a confirmation than "Completed 1 task".
 */
export function formatTodoistOutcome(input: {
  actionId: TodoistActionId;
  verified: number;
  total: number;
  label?: string | null;
  rolledForward?: number;
}): string {
  const verb = todoistVerb(input.actionId);
  const failed = input.total - input.verified;

  if (failed > 0) {
    const noun = input.total === 2 ? "task" : "tasks";
    const tail =
      failed === 1 ? "one didn’t go through." : `${failed} didn’t go through.`;
    return `${verb} ${input.verified} of ${input.total} ${noun} — ${tail}`;
  }

  if (input.verified === 1) {
    const base = input.label ? `${verb} “${input.label}”.` : `${verb} the task.`;
    // A recurring task that rolled forward is a genuinely different outcome and
    // saying so prevents the "why is it still there?" confusion.
    if (input.rolledForward && input.actionId === "task.complete") {
      return `${base} It repeats, so it’s already back for its next date.`;
    }
    return base;
  }

  const base = `${verb} ${input.verified} tasks.`;
  if (input.rolledForward && input.actionId === "task.complete") {
    const n = input.rolledForward;
    return `${base} ${n === 1 ? "One repeats, so it’s" : `${n} repeat, so they’re`} already back for the next date.`;
  }
  return base;
}

/**
 * How many times a delete's absence check may be re-read, and how long to wait
 * between attempts.
 *
 * Small and bounded on purpose: this runs inside an iMessage round-trip, so it
 * must not add perceptible latency. Two short waits are enough to ride out the
 * read-after-write lag that produced the live false failure, and the whole thing
 * is best-effort anyway — the receipt already settled the outcome.
 */
export const DELETE_CONFIRM_ATTEMPTS = 3;
export const DELETE_CONFIRM_BACKOFF_MS = [0, 250, 750];

/** What a bounded absence check managed to observe. Never changes the outcome. */
export type DeleteConfirmation = "absent" | "still_visible" | "unknown";

/** Default sleep. Injected in tests so no suite ever actually waits. */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask whether a deleted task is actually gone — WITHOUT the power to contradict a
 * validated delete receipt.
 *
 * THE BUG THIS REPLACES. The old code did ONE immediate read and treated a task
 * still being visible as proof the delete had failed. On a real device Todoist
 * accepted the DELETE, answered a documented success, and then — 6 seconds later,
 * within the same reply — still returned the task from `GET /tasks/{id}`. Hula
 * told the user the change "hadn't taken effect". Four minutes later the task was
 * demonstrably gone. The deletion had worked all along; the verifier was reading
 * a stale replica and calling it a failure.
 *
 * A distributed store is allowed to lag a write. A validated DELETE receipt is
 * Todoist telling us the task is gone; a stale read is Todoist not having caught
 * up with itself yet. Between those two, the receipt is the authority — so this
 * function returns an OBSERVATION for the log, never a verdict:
 *
 *   - `absent`        the read confirms it (the common case, usually first try);
 *   - `still_visible` every bounded read was stale — the receipt still stands;
 *   - `unknown`       the check itself failed (transport). Proves nothing either way.
 *
 * It re-reads ONLY. The DELETE is never repeated, whatever this observes.
 */
export async function confirmTodoistDeletion(
  userId: string,
  taskId: string,
  getTask: typeof fetchTask,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<DeleteConfirmation> {
  for (let attempt = 0; attempt < DELETE_CONFIRM_ATTEMPTS; attempt += 1) {
    const wait = DELETE_CONFIRM_BACKOFF_MS[attempt] ?? 0;
    if (wait > 0) await sleep(wait);
    try {
      await getTask(userId, taskId);
      // Still visible — a stale replica. Try again within the bound.
    } catch (err) {
      // A definitive not-found is the confirmation we were hoping for.
      if (err instanceof TodoistError && err.reason === "task_not_found") return "absent";
      // The CHECK failed (network). That says nothing about the delete, which
      // already succeeded. Stop — retrying a broken read helps no one.
      return "unknown";
    }
  }
  return "still_visible";
}

/**
 * Re-read the task and check it against what the write promised (Section 19).
 *
 * The re-fetch is BEST-EFFORT on transport failure but AUTHORITATIVE on mismatch —
 * the same asymmetry the Calendar path uses, for the same reason. A failed
 * re-read (network) leaves the write's own validated receipt — a real
 * Todoist-issued id — as genuine evidence; refusing to report a real success
 * because a second call flaked would lie in the other direction. A re-read that
 * SUCCEEDS and disagrees wins unconditionally.
 */
async function verifyTodoistWrite(
  userId: string,
  written: NormalizedTodoistTask,
  expectation: TaskExpectation,
  getTask: typeof fetchTask,
): Promise<{
  observed: NormalizedTodoistTask;
  verification: ReturnType<typeof verifyTaskState> | null;
}> {
  try {
    const fresh = await getTask(userId, written.id);
    return { observed: fresh, verification: verifyTaskState(fresh, expectation) };
  } catch {
    return { observed: written, verification: null };
  }
}

/**
 * Remember a task a write VERIFIABLY landed on. Best-effort: losing this costs the
 * pronoun shortcut, never the action.
 */
async function rememberTodoistActed(
  userId: string,
  task: NormalizedTodoistTask,
  kind: "created" | "updated" | "completed" | "reopened" | "deleted" | "moved",
  ctx: { recordActed: typeof recordActedTodoistTask },
  bulkIds?: string[],
): Promise<void> {
  try {
    await ctx.recordActed(userId, {
      task: toTodoistSelectionItem(task),
      kind,
      at: new Date().toISOString(),
      ...(bulkIds && bulkIds.length > 1 ? { bulkIds } : {}),
    });
  } catch {
    // Non-fatal by design.
  }
}

/**
 * Report a Todoist write whose postcondition did NOT match (Section 19).
 *
 * The anti-fabrication path: the write reached Todoist and Todoist answered 2xx,
 * but the task does not say what we were about to claim. Hula reports what it
 * OBSERVED, names the gap, and records the execution as `failed` so the ledger
 * does not show a success that isn't one. It does NOT retry.
 */
async function reportTodoistPartial(
  userId: string,
  actionId: TodoistActionId,
  provider: string,
  observed: NormalizedTodoistTask,
  verification: ReturnType<typeof verifyTaskState>,
  ctx: { record: typeof recordActionExecution; proposalId: string | null; inputKeys: string[] },
  expectation: TaskExpectation = {},
): Promise<ActionExecutionResult> {
  const timezone = expectation.dueTimezone;
  const executionId = await ctx.record(userId, {
    proposalId: ctx.proposalId,
    provider,
    actionId,
    status: "failed",
    requestSummary: { inputKeys: ctx.inputKeys },
    resultSummary: { taskId: observed.id, mismatches: verification.mismatches },
    errorMessage: "postcondition_mismatch",
  });

  const notes: string[] = [];
  // Name the field that ACTUALLY failed. Reporting "the due date didn't stick" for
  // a task whose date saved perfectly and only lost its TIME told a real user their
  // date was wrong when it was right — and sent them looking for the wrong problem.
  const observedStamp = dueLocalStamp(observed.due, timezone);
  const onlyTimeFailed =
    verification.mismatches.length === 1 && verification.mismatches[0] === "due_time";

  if (verification.mismatches.includes("due")) notes.push("The due date didn’t stick.");
  // Skipped when it is the whole story — the headline below already says it.
  if (verification.mismatches.includes("due_time") && !onlyTimeFailed) {
    notes.push(
      observedStamp?.time
        ? `It saved as ${formatLocalTime(observedStamp.time)} rather than the time I described.`
        : "The due time didn’t save — it’s showing as an all-day task.",
    );
  }
  if (verification.mismatches.includes("priority")) notes.push("The priority didn’t stick.");
  if (verification.mismatches.includes("project")) notes.push("It didn’t move project.");
  if (verification.mismatches.includes("section")) notes.push("It didn’t move section.");
  if (verification.mismatches.includes("labels")) notes.push("The labels didn’t stick.");
  if (verification.mismatches.includes("content")) notes.push("The title didn’t stick.");
  if (verification.mismatches.includes("description")) notes.push("The description didn’t stick.");
  notes.push("Have a look in Todoist and I can fix it from there.");

  // When the ONLY thing that failed is the due TIME, say precisely that. The
  // generic "it didn't come out exactly as I described" is accurate but useless
  // here — the user needs to know the task and its date are fine and only the time
  // is wrong, which is a much smaller thing to fix.
  //
  // MISSING and WRONG are separated because they are different facts: a time that
  // saved as 7pm WAS saved, so "wasn't saved" would be its own small lie.
  const verb = actionId === "task.create" ? "created" : "updated";
  let headline = `I saved “${observed.content}”, but it didn’t come out exactly as I described.`;
  if (onlyTimeFailed && expectation.dueTime) {
    headline = observedStamp?.time
      ? `I ${verb} the task, but it saved as ${formatLocalTime(observedStamp.time)} rather than the ${formatClockTime(expectation.dueTime)} I asked for.`
      : `I ${verb} the task, but its ${formatClockTime(expectation.dueTime)} due time wasn’t saved.`;
  }

  return {
    ok: false,
    status: "failed",
    actionId,
    provider,
    userMessage: [headline, ...notes].join(" "),
    executionId,
    receipt: { taskIds: [observed.id] },
  };
}

/**
 * Re-read the event and check it against what the write promised (Section 18).
 *
 * The re-fetch is BEST-EFFORT on transport failure but AUTHORITATIVE on
 * mismatch. Those are different situations and collapsing them would be wrong in
 * both directions:
 *  - If the re-read fails (network), the write's own validated receipt — a real
 *    Google-issued event id — is still genuine evidence the event exists. Refusing
 *    to report a real success because a second call flaked would make Hula lie in
 *    the other direction. `verification` is null and the caller reports from the
 *    receipt.
 *  - If the re-read SUCCEEDS and disagrees, reality wins, unconditionally.
 */
async function verifyWrite(
  userId: string,
  written: NormalizedCalendarEvent,
  expectation: EventExpectation,
  getEvent: typeof getCalendarEvent,
): Promise<{ observed: NormalizedCalendarEvent; verification: EventVerification | null }> {
  try {
    const fresh = await getEvent(userId, written.id);
    return { observed: fresh, verification: verifyEventState(fresh, expectation) };
  } catch {
    return { observed: written, verification: null };
  }
}

/**
 * Remember an event a write VERIFIABLY landed on, so "move it to Friday" and
 * "the meeting you just created" resolve. Best-effort: losing this costs the
 * pronoun shortcut, never the action.
 */
async function rememberActed(
  userId: string,
  event: NormalizedCalendarEvent,
  kind: CalendarActedKind,
  ctx: { recordActed: typeof recordActedCalendarEvent },
): Promise<void> {
  try {
    await ctx.recordActed(userId, {
      event: toSelectionItem(event),
      kind,
      at: new Date().toISOString(),
    });
  } catch {
    // Non-fatal by design.
  }
}

/**
 * Report a write whose postcondition did NOT match (Section 18).
 *
 * This is the anti-fabrication path. The write reached Google and Google
 * answered 2xx, but the calendar does not say what we were about to claim — the
 * commonest real case being a Meet that was silently not created. Hula reports
 * what it OBSERVED, names the gap, and records the execution as `failed` so the
 * ledger doesn't show a success that isn't one. Crucially it does NOT retry: the
 * write is ambiguous, and retrying an ambiguous write is how duplicates happen.
 */
async function reportPartial(
  userId: string,
  actionId: string,
  provider: string,
  observed: NormalizedCalendarEvent,
  verification: EventVerification,
  timezone: string | undefined,
  ctx: { record: typeof recordActionExecution; proposalId: string | null; inputKeys: string[] },
  kind: "created" | "updated",
): Promise<ActionExecutionResult> {
  const executionId = await ctx.record(userId, {
    proposalId: ctx.proposalId,
    provider,
    actionId,
    status: "failed",
    requestSummary: { inputKeys: ctx.inputKeys },
    resultSummary: { eventId: observed.id, mismatches: verification.mismatches },
    errorMessage: "postcondition_mismatch",
  });

  const base =
    kind === "created"
      ? `I created “${(observed.summary ?? "").trim() || "the event"}”, but it didn’t save exactly as I described.`
      : `I changed “${(observed.summary ?? "").trim() || "the event"}”, but it didn’t save exactly as I described.`;

  // Name the gap concretely. A vague "something went wrong" would leave the user
  // unable to tell whether their meeting exists.
  const notes: string[] = [];
  if (verification.mismatches.includes("conference")) {
    notes.push("Google didn’t attach a Meet link.");
  }
  if (verification.mismatches.includes("attendees")) {
    notes.push("Not everyone I listed was added as a guest.");
  }
  if (verification.mismatches.includes("start") || verification.mismatches.includes("end")) {
    notes.push(`It’s showing as ${formatEventWhen(observed, timezone, { includeDay: true })}.`);
  }
  if (verification.mismatches.includes("location")) notes.push("The location didn’t stick.");
  if (verification.mismatches.includes("title")) notes.push("The title didn’t stick.");
  if (verification.mismatches.includes("description")) notes.push("The description didn’t stick.");
  notes.push("Have a look at the event and I can fix it from there.");

  return {
    ok: false,
    status: "failed",
    actionId,
    provider,
    userMessage: [base, ...notes].join(" "),
    executionId,
    receipt: { eventId: observed.id },
  };
}

/** PURE: read a string field from redacted input, trimmed, or "". */
function readStr(input: Record<string, unknown> | undefined, key: string): string {
  const v = input?.[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * PURE: read a finite number field from redacted input, or null.
 *
 * Distinguishes "absent" from 0 — a `reminderMinutes: 0` means "at the moment it
 * starts", which is a real, different request from no reminder at all.
 */
function readNum(input: Record<string, unknown> | undefined, key: string): number | null {
  const v = input?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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

async function runOutlookMailAction(
  userId: string,
  actionId:
    | "microsoft.mail.createDraft"
    | "microsoft.mail.updateDraft"
    | "microsoft.mail.deleteDraft"
    | "microsoft.mail.setReadState"
    | "microsoft.mail.send",
  input: Record<string, unknown> | undefined,
  provider: string,
  ctx: {
    record: typeof recordActionExecution;
    proposalId: string | null;
    execute: typeof executeOutlookMailMutation;
    invalidateDraft: typeof invalidateOutlookDraftEntity;
  },
): Promise<ActionExecutionResult> {
  const operation = readStr(input, "operation");
  const fail = async (reason: string, userMessage: string): Promise<ActionExecutionResult> => {
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "failed",
      requestSummary: { operation, inputKeys: Object.keys(input ?? {}) },
      errorMessage: reason,
    });
    return { ok: false, status: "failed", actionId, provider, userMessage, executionId };
  };
  if (!input || !operation) {
    return fail("invalid_input", "I’m missing the exact Outlook message details, so I didn’t change anything.");
  }
  try {
    const receipt = await ctx.execute(userId, input);
    if ((operation === "delete_draft" || operation === "send_draft") && receipt.draftId) {
      await ctx.invalidateDraft(userId, receipt.draftId);
    }
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "succeeded",
      requestSummary: { operation },
      resultSummary: {
        operation: receipt.operation,
        verification: receipt.verification,
        hasMessageReceipt: Boolean(receipt.messageId),
        hasDraftReceipt: Boolean(receipt.draftId),
      },
    });
    let userMessage: string;
    if (actionId === "microsoft.mail.createDraft") {
      userMessage = "Draft created in Outlook.";
    } else if (actionId === "microsoft.mail.updateDraft") {
      userMessage = "Updated the Outlook draft.";
    } else if (actionId === "microsoft.mail.deleteDraft") {
      userMessage = "Deleted the Outlook draft.";
    } else if (actionId === "microsoft.mail.setReadState") {
      userMessage = receipt.isRead ? "Marked the Outlook message as read." : "Marked the Outlook message as unread.";
    } else if (receipt.verification === "verified") {
      userMessage = operation === "reply" || operation === "reply_all"
        ? "Sent the reply from your Outlook account."
        : operation === "forward"
          ? "Forwarded it from your Outlook account."
          : "Sent it from your Outlook account.";
    } else {
      userMessage = "Microsoft accepted the message for sending. I couldn’t yet confirm it in Sent Items, so I won’t claim delivery.";
    }
    return {
      ok: true,
      status: "succeeded",
      actionId,
      provider,
      userMessage,
      executionId,
      receipt: {
        ...(receipt.draftId ? { draftId: receipt.draftId } : {}),
        ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
        ...(receipt.conversationId ? { outlookConversationId: receipt.conversationId } : {}),
        verification: receipt.verification,
      },
    };
  } catch (error) {
    const graph = error instanceof MicrosoftGraphError ? error : null;
    logger.error("action.outlookMail failed", {
      actionId,
      operation,
      errorCode: graph?.reason ?? "unknown",
      httpStatus: graph?.httpStatus ?? null,
    });
    let userMessage = "I couldn’t verify that Outlook change, so I won’t say it succeeded.";
    if (graph?.reason === "not_connected") userMessage = "Connect Microsoft 365 in Hula first, then I can do that.";
    else if (graph?.reason === "reconnect_required" || graph?.reason === "insufficient_capability" || graph?.reason === "permission_denied") {
      userMessage = "Reconnect Microsoft 365 in Hula and grant Outlook Mail access before I can do that.";
    } else if (graph?.reason === "rate_limited") {
      userMessage = "Outlook is rate-limiting requests right now. I didn’t retry the write; please check your mailbox before trying again.";
    } else if (actionId === "microsoft.mail.send" && (graph?.reason === "timeout" || graph?.reason === "network_failure")) {
      userMessage = "The Outlook send result is uncertain. I haven’t tried again because that could send twice—please check Sent Items first.";
    }
    return fail(graph?.reason ?? "execution_failed", userMessage);
  }
}

async function runOutlookCalendarAction(
  userId: string,
  input: Record<string, unknown> | undefined,
  provider: string,
  ctx: {
    record: typeof recordActionExecution;
    proposalId: string | null;
    execute: typeof executeOutlookCalendarMutation;
    remember: typeof recordOutlookCalendarEntity;
  },
): Promise<ActionExecutionResult> {
  const actionId = "microsoft.calendar.mutate";
  const operation = readStr(input, "operation");
  const fail = async (reason: string, userMessage: string): Promise<ActionExecutionResult> => {
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "failed",
      requestSummary: { operation, inputKeys: Object.keys(input ?? {}) },
      errorMessage: reason,
    });
    return { ok: false, status: "failed", actionId, provider, userMessage, executionId };
  };
  if (!input || !operation) return fail("invalid_input", "I’m missing the exact Outlook event details, so I didn’t change anything.");
  try {
    const receipt = await ctx.execute(userId, input);
    if (receipt.event) await ctx.remember(userId, receipt.event);
    const executionId = await ctx.record(userId, {
      proposalId: ctx.proposalId,
      provider,
      actionId,
      status: "succeeded",
      requestSummary: { operation },
      resultSummary: {
        operation,
        verification: receipt.verification,
        hasEventReceipt: true,
        hasTeamsJoinUrl: Boolean(receipt.event?.teamsJoinUrl),
      },
    });
    const userMessage = operation === "delete"
      ? "Cancelled the Outlook calendar event and verified it is gone."
      : operation === "create"
        ? receipt.event?.teamsJoinUrl
          ? `Created the Outlook event with a verified Teams link: ${receipt.event.teamsJoinUrl}`
          : input.teamsMeeting === true
            ? "Microsoft created the event but did not return a Teams join URL, so I won’t claim one exists."
            : "Created the Outlook calendar event and verified it."
        : receipt.event?.teamsJoinUrl && input.teamsMeeting === true
          ? `Updated the Outlook event with a verified Teams link: ${receipt.event.teamsJoinUrl}`
          : input.teamsMeeting === true
            ? "Microsoft kept the Outlook event but did not return a Teams join URL, so I won’t claim one exists."
            : "Updated the Outlook calendar event and verified the change.";
    return {
      ok: true,
      status: "succeeded",
      actionId,
      provider,
      userMessage,
      executionId,
      receipt: {
        microsoftEventId: receipt.eventId,
        ...(receipt.event?.teamsJoinUrl ? { teamsJoinUrl: receipt.event.teamsJoinUrl } : {}),
        verification: "verified",
      },
    };
  } catch (error) {
    const graph = error instanceof MicrosoftGraphError ? error : null;
    logger.error("action.outlookCalendar failed", {
      operation,
      errorCode: graph?.reason ?? "unknown",
      httpStatus: graph?.httpStatus ?? null,
    });
    let message = "I couldn’t verify that Outlook Calendar change, so I won’t say it succeeded.";
    if (graph?.reason === "not_connected") message = "Connect Microsoft 365 in Hula first, then I can do that.";
    else if (graph?.reason === "reconnect_required" || graph?.reason === "insufficient_capability" || graph?.reason === "permission_denied") {
      message = "Reconnect Microsoft 365 in Hula and grant Outlook Calendar access before I can do that.";
    } else if (input.teamsMeeting === true && (graph?.reason === "invalid_request" || graph?.reason === "unsupported_account")) {
      message = "This Microsoft account or tenant did not allow Teams meeting creation. I didn’t fabricate a join link.";
    } else if (graph?.reason === "timeout" || graph?.reason === "network_failure" || graph?.reason === "rate_limited") {
      message = "The Outlook Calendar result is uncertain. I didn’t retry the write because that could create or change it twice—please check the calendar first.";
    }
    return fail(graph?.reason ?? "execution_failed", message);
  }
}
