import type { ActionRisk } from "../integrations/policy";
import type { ProviderId } from "../integrations/catalog";

/**
 * Typed action registry (Section 12) — the agentic integration runtime's single
 * source of truth for every action Hula can ever take on a connected provider.
 *
 * First-principles design: the model NEVER calls a provider API directly. It (or
 * a deterministic detector) names a typed Hula action from this registry; the
 * deterministic backend then validates it against policy, checks the connection
 * and scopes, asks for confirmation when needed, executes through a provider
 * adapter ONLY if the action is implemented + enabled, and logs the result.
 *
 * This file is pure metadata + lookups. It performs NO I/O, calls NO provider,
 * and touches NO token. Most actions are deliberately STUBS (`implemented:false`)
 * — the contract exists so future provider packs plug into one clear place.
 */

/** How an action groups (mirrors the provider catalog categories, loosely). */
export type ActionCategory =
  | "calendar"
  | "email"
  | "tasks"
  | "documents"
  | "messaging"
  | "shopping";

/** A lightweight typed field in an action's input/output schema. */
export interface ActionField {
  name: string;
  type: "string" | "number" | "boolean" | "datetime" | "string[]";
  required: boolean;
  description: string;
}

/** A single action definition. Pure metadata — no behaviour lives here. */
export interface ActionDefinition {
  /** Stable dotted id, e.g. "calendar.createEvent". */
  actionId: string;
  category: ActionCategory;
  displayName: string;
  /** Internal/dev description of what the action does. */
  description: string;
  /** Provider slugs that can satisfy this action (first = preferred). */
  providerTypes: ProviderId[];
  /** Capability slugs the connection must expose to run this. */
  requiredCapabilities: string[];
  /** OAuth scopes the connection must have granted to run this. */
  requiredScopes: string[];
  /** Risk ladder position — drives policy gating + confirmation. */
  riskLevel: ActionRisk;
  /** Whether an explicit per-action user confirmation is required. */
  confirmationRequired: boolean;
  /** True once a real deterministic adapter backs this action. */
  implemented: boolean;
  /** Master on/off switch, independent of `implemented`. */
  enabled: boolean;
  /** Lightweight input contract (metadata only; not validated at runtime yet). */
  inputSchema: ActionField[];
  /** Optional output contract, when useful. */
  outputSchema?: ActionField[];
  /** Example user phrasings that map to this action. */
  examples: string[];
  /**
   * The HONEST, user-facing one-liner Hula uses when this action can't run yet
   * (not implemented / not enabled). Written in Hula's voice so a detector or the
   * executor can surface it verbatim without pretending the action happened.
   */
  userFacingDescription: string;
}

const GCAL_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/**
 * The action registry. `implemented + enabled` means a real deterministic adapter
 * in the executor backs the action: the Google Calendar reads (Section 11), the
 * Gmail draft/send writes (Section 16), and the Google Calendar event
 * create/update/cancel writes (Section 17, confirmation-gated). Everything else is
 * a STUB — the contract is ready, but the executor never calls a provider for it.
 *
 * These flags are load-bearing, not documentation: `evaluateActionForUser` refuses
 * any action marked `implemented:false` and replies with `userFacingDescription`.
 * A declaration that disagrees with the executor makes Hula lie in one direction or
 * the other, so they must be changed together.
 */
export const ACTION_DEFINITIONS: readonly ActionDefinition[] = [
  // --- Calendar ----------------------------------------------------------
  {
    actionId: "calendar.listEvents",
    category: "calendar",
    displayName: "List calendar events",
    description: "Read upcoming events from the user's connected calendar.",
    providerTypes: ["google_calendar"],
    requiredCapabilities: ["read_calendar_events"],
    requiredScopes: [GCAL_READONLY_SCOPE],
    riskLevel: "read",
    confirmationRequired: false,
    implemented: true,
    enabled: true,
    inputSchema: [
      { name: "range", type: "string", required: false, description: "today | tomorrow | week" },
      { name: "maxResults", type: "number", required: false, description: "Cap on events returned." },
    ],
    examples: ["what's on my calendar today", "what do I have tomorrow"],
    userFacingDescription: "I can read your connected Google Calendar (read-only).",
  },
  {
    actionId: "calendar.findNextEvent",
    category: "calendar",
    displayName: "Find next calendar event",
    description: "Read the single next upcoming event from the connected calendar.",
    providerTypes: ["google_calendar"],
    requiredCapabilities: ["read_calendar_events"],
    requiredScopes: [GCAL_READONLY_SCOPE],
    riskLevel: "read",
    confirmationRequired: false,
    implemented: true,
    enabled: true,
    inputSchema: [],
    examples: ["when's my next meeting", "what's my next event"],
    userFacingDescription: "I can tell you your next event from your connected Google Calendar.",
  },
  {
    actionId: "calendar.createEvent",
    category: "calendar",
    displayName: "Create calendar event",
    description:
      "Create a new event on the user's calendar (Section 18: timed or all-day, with " +
      "optional location, description, attendees, reminders, and a genuine Google Meet " +
      "conference). Every field arrives ALREADY RESOLVED from a confirmed proposal.",
    providerTypes: ["google_calendar"],
    requiredCapabilities: ["write_calendar_events"],
    // Google Meet conferences are created through `events.insert` itself, so the
    // SAME calendar.events scope authorises them. There is no separate Meet scope.
    requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
    riskLevel: "write",
    confirmationRequired: true,
    implemented: true,
    enabled: true,
    inputSchema: [
      { name: "title", type: "string", required: true, description: "Event title." },
      { name: "startIso", type: "datetime", required: false, description: "Start instant (ISO 8601). Required unless allDay." },
      { name: "endIso", type: "datetime", required: false, description: "End instant (ISO 8601). Required unless allDay." },
      { name: "allDay", type: "boolean", required: false, description: "True for an all-day event." },
      { name: "startDate", type: "string", required: false, description: "All-day start (YYYY-MM-DD)." },
      { name: "endDate", type: "string", required: false, description: "All-day end (YYYY-MM-DD, EXCLUSIVE per Google)." },
      { name: "location", type: "string", required: false, description: "Optional location." },
      { name: "description", type: "string", required: false, description: "Optional description." },
      {
        name: "attendees",
        type: "string[]",
        required: false,
        description:
          "Verified attendee addresses. Only ever addresses the user typed — never inferred from a name.",
      },
      { name: "reminderMinutes", type: "number", required: false, description: "Popup reminder, minutes before start." },
      {
        name: "conferenceRequestId",
        type: "string",
        required: false,
        description:
          "Present when a Google Meet was requested. Generated ONCE at proposal time and replayed, so a duplicate confirmation reuses the same conference instead of allocating a second one.",
      },
      {
        name: "notifyGuests",
        type: "boolean",
        required: false,
        description: "Whether Google emails the guests. Only true after a preview that said so.",
      },
    ],
    examples: [
      "schedule gym tomorrow at 7pm",
      "book a call with Sam on Friday",
      "book an hour with rob@x.com Monday as a Google Meet",
    ],
    userFacingDescription:
      "I couldn’t set that event up just now — mind trying again in a moment?",
  },
  {
    actionId: "calendar.updateEvent",
    category: "calendar",
    displayName: "Update calendar event",
    description:
      "Update an existing event (Section 18: reschedule, change duration, rename, " +
      "location, description, add/remove attendees, reminders, add a Google Meet). " +
      "The target id and every value arrive ALREADY RESOLVED from a confirmed proposal.",
    providerTypes: ["google_calendar"],
    requiredCapabilities: ["write_calendar_events"],
    requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
    riskLevel: "write",
    confirmationRequired: true,
    implemented: true,
    enabled: true,
    inputSchema: [
      {
        name: "eventId",
        type: "string",
        required: true,
        description:
          "Event to update. For a recurring series this is the INSTANCE id (`this_event`) or the MASTER id (`entire_series`), chosen at proposal time from an explicit user answer.",
      },
      { name: "newTitle", type: "string", required: false, description: "New title." },
      { name: "startIso", type: "datetime", required: false, description: "New start (ISO 8601)." },
      { name: "endIso", type: "datetime", required: false, description: "New end (ISO 8601)." },
      { name: "newLocation", type: "string", required: false, description: "New location." },
      { name: "newDescription", type: "string", required: false, description: "New description." },
      {
        name: "attendees",
        type: "string[]",
        required: false,
        description:
          "The COMPLETE attendee list. Google's PATCH replaces the array rather than merging, so the proposal merges add/remove against the event's real guests first.",
      },
      { name: "reminderMinutes", type: "number", required: false, description: "Popup reminder, minutes before start." },
      { name: "conferenceRequestId", type: "string", required: false, description: "Present when adding a Google Meet." },
      { name: "recurrenceScope", type: "string", required: false, description: "`this_event` or `entire_series` — never guessed." },
      { name: "notifyGuests", type: "boolean", required: false, description: "Whether Google emails the guests about the change." },
    ],
    examples: [
      "move my 3pm to 4pm",
      "rename tomorrow's meeting",
      "make it a Google Meet",
      "move it back thirty minutes",
    ],
    userFacingDescription:
      "I couldn’t change that event just now — mind trying again in a moment?",
  },
  {
    actionId: "calendar.cancelEvent",
    category: "calendar",
    displayName: "Cancel calendar event",
    description:
      "Cancel/delete an existing event, including a Google Meet event, through the " +
      "normal confirmation + receipt path. Deletion is VERIFIED by re-reading the " +
      "event (Section 18) — a 2xx alone is not reported as gone.",
    providerTypes: ["google_calendar"],
    requiredCapabilities: ["write_calendar_events"],
    requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
    riskLevel: "write",
    confirmationRequired: true,
    implemented: true,
    enabled: true,
    inputSchema: [
      {
        name: "eventId",
        type: "string",
        required: true,
        description:
          "Event to cancel. The INSTANCE id deletes one occurrence; the MASTER id deletes the whole series — chosen at proposal time from an explicit user answer, never guessed.",
      },
      { name: "recurrenceScope", type: "string", required: false, description: "`this_event` or `entire_series`." },
      { name: "notifyGuests", type: "boolean", required: false, description: "Whether Google emails the guests a cancellation." },
    ],
    examples: ["cancel my 2pm", "delete tomorrow's dentist appointment", "only cancel this occurrence"],
    userFacingDescription:
      "I couldn’t cancel that event just now — mind trying again in a moment?",
  },
  // --- Email -------------------------------------------------------------
  {
    actionId: "email.search",
    category: "email",
    displayName: "Search email",
    description: "Search the user's connected inbox.",
    providerTypes: ["gmail"],
    requiredCapabilities: ["email.read"],
    requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    riskLevel: "read",
    confirmationRequired: false,
    implemented: false,
    enabled: true,
    inputSchema: [
      { name: "query", type: "string", required: true, description: "Search query." },
    ],
    examples: ["find the email from my landlord", "search my inbox for the invoice"],
    userFacingDescription:
      "I can’t search your inbox that way yet — but I can pull up your recent, unread, or important emails if that helps.",
  },
  {
    actionId: "email.createDraft",
    category: "email",
    displayName: "Create email draft",
    description:
      "Create a real Gmail draft (never sent). Section 16 — executes immediately once " +
      "the recipient/thread is safely resolved; no confirmation required.",
    providerTypes: ["gmail"],
    requiredCapabilities: ["email.draft"],
    requiredScopes: ["https://www.googleapis.com/auth/gmail.compose"],
    riskLevel: "draft",
    // A draft never leaves Hula's control (it stays in the user's Drafts), so it
    // does NOT require explicit confirmation — matching the risk ladder.
    confirmationRequired: false,
    implemented: true,
    enabled: true,
    inputSchema: [
      { name: "to", type: "string", required: true, description: "Recipient address." },
      { name: "subject", type: "string", required: false, description: "Subject line." },
      { name: "body", type: "string", required: true, description: "Email body." },
    ],
    examples: ["draft an email to Rob", "draft a reply to my accountant's email"],
    userFacingDescription:
      "I couldn’t set up that draft just now — mind trying again in a moment?",
  },
  {
    actionId: "email.sendDraft",
    category: "email",
    displayName: "Send email",
    description:
      "Send a new email or a reply on the user's behalf (Section 16). Requires an " +
      "explicit confirmation via the Section 12 proposal runtime before it ever sends.",
    providerTypes: ["gmail"],
    requiredCapabilities: ["email.send"],
    // `gmail.compose` grants both draft creation AND sending, so it is the single
    // scope Section 16 requests — no separate gmail.send.
    requiredScopes: ["https://www.googleapis.com/auth/gmail.compose"],
    riskLevel: "send",
    confirmationRequired: true,
    implemented: true,
    enabled: true,
    inputSchema: [
      { name: "to", type: "string", required: true, description: "Recipient address." },
      { name: "subject", type: "string", required: false, description: "Subject line." },
      { name: "body", type: "string", required: true, description: "Email body." },
    ],
    examples: ["send an email to Rob", "email my accountant the figures"],
    userFacingDescription:
      "I couldn’t set that email up just now — mind trying again in a moment?",
  },
  {
    actionId: "email.updateDraft",
    category: "email",
    displayName: "Edit email draft",
    description:
      "Replace the body of an existing Gmail draft (Section 17). Executes immediately " +
      "once the draft is resolved and re-fetched; a draft never leaves the user's control.",
    providerTypes: ["gmail"],
    requiredCapabilities: ["email.draft"],
    // `gmail.compose` authorises drafts.update — verified against Google's
    // per-method reference. No broader scope is needed.
    requiredScopes: ["https://www.googleapis.com/auth/gmail.compose"],
    riskLevel: "draft",
    // Editing a draft is not externally visible (it stays in Drafts), so it needs
    // no confirmation — matching `email.createDraft` on the same risk rung.
    confirmationRequired: false,
    implemented: true,
    enabled: true,
    inputSchema: [
      { name: "draftId", type: "string", required: true, description: "Draft to edit." },
      { name: "body", type: "string", required: true, description: "The complete new body." },
    ],
    examples: ["make it shorter", "change Friday to Monday", "make that more professional"],
    userFacingDescription:
      "I couldn’t update that draft just now — mind trying again in a moment?",
  },
  {
    actionId: "email.deleteDraft",
    category: "email",
    displayName: "Delete email draft",
    description:
      "Permanently delete a Gmail draft (Section 17). Gmail does NOT trash a deleted " +
      "draft — it is irreversible — so this always requires explicit confirmation.",
    providerTypes: ["gmail"],
    requiredCapabilities: ["email.draft"],
    requiredScopes: ["https://www.googleapis.com/auth/gmail.compose"],
    // Deliberately "write", not "destructive": the risk ladder HARD-BLOCKS
    // `destructive`, which would make this unrunnable. The irreversibility is
    // handled where it belongs — an explicit confirmation plus a preview that says
    // so — rather than by a rung that forbids the action outright.
    riskLevel: "write",
    confirmationRequired: true,
    implemented: true,
    enabled: true,
    inputSchema: [
      { name: "draftId", type: "string", required: true, description: "Draft to delete." },
    ],
    examples: ["delete that draft", "get rid of the draft to Rob"],
    userFacingDescription:
      "I couldn’t delete that draft just now — mind trying again in a moment?",
  },
  {
    actionId: "email.modifyLabels",
    category: "email",
    displayName: "Change email labels",
    description:
      "Add/remove Gmail labels on messages (Section 17): mark read/unread, star/unstar, " +
      "archive, and apply/remove an existing user label. One action because these are " +
      "all the same Gmail operation with a different label set.",
    providerTypes: ["gmail"],
    requiredCapabilities: ["email.modify"],
    // `messages.modify` does NOT accept gmail.compose — verified against Google's
    // per-method reference. gmail.modify is the narrowest scope that works.
    requiredScopes: [GMAIL_MODIFY_SCOPE],
    // Reversible, non-external, destroys nothing — see the `modify` rung.
    riskLevel: "modify",
    confirmationRequired: false,
    implemented: true,
    enabled: true,
    inputSchema: [
      {
        name: "threadIds",
        type: "string[]",
        required: false,
        description:
          "Conversations to change (Section 17 correction). Present for the UI-aligned path: " +
          "the change is applied at conversation level and then VERIFIED against Gmail's real " +
          "state before success is reported.",
      },
      {
        name: "messageIds",
        type: "string[]",
        required: false,
        description:
          "Messages to change. Required when no threadIds are given; alongside threadIds it " +
          "names each conversation's newest message, for `mode: latest_message` (star).",
      },
      {
        name: "op",
        type: "string",
        required: false,
        description:
          "The semantic action (star/unstar/archive/…). Required with threadIds — it selects " +
          "the postcondition the change must prove.",
      },
      {
        name: "mode",
        type: "string",
        required: false,
        description: "`thread` (default) or `latest_message` — how the change is applied.",
      },
      { name: "addLabelIds", type: "string[]", required: false, description: "Label ids to add." },
      { name: "removeLabelIds", type: "string[]", required: false, description: "Label ids to remove." },
      { name: "labelId", type: "string", required: false, description: "Resolved user label id, for add/remove_label." },
    ],
    examples: ["mark Rob's email as read", "star the second email", "archive those newsletters"],
    userFacingDescription:
      "I couldn’t change that email just now — mind trying again in a moment?",
  },
  {
    actionId: "email.trash",
    category: "email",
    displayName: "Move email to trash",
    description:
      "Move messages to the Gmail trash (Section 17). RECOVERABLE — Gmail keeps trashed " +
      "mail ~30 days and `email.untrash` restores it. Permanent deletion is NOT implemented.",
    providerTypes: ["gmail"],
    requiredCapabilities: ["email.modify"],
    requiredScopes: [GMAIL_MODIFY_SCOPE],
    // Consequential enough to confirm (mail leaves the inbox and starts a deletion
    // clock), but recoverable — so `write`, not `destructive`.
    riskLevel: "write",
    confirmationRequired: true,
    implemented: true,
    enabled: true,
    inputSchema: [
      {
        name: "threadIds",
        type: "string[]",
        required: false,
        description: "Conversations to trash (the UI-aligned path). Verified after the change.",
      },
      { name: "messageIds", type: "string[]", required: false, description: "Messages to trash." },
      { name: "op", type: "string", required: false, description: "`trash` — selects the postcondition." },
    ],
    examples: ["move that email to trash", "bin those emails"],
    userFacingDescription:
      "I couldn’t move that email to trash just now — mind trying again in a moment?",
  },
  {
    actionId: "email.untrash",
    category: "email",
    displayName: "Restore email from trash",
    description: "Restore messages from the Gmail trash (Section 17).",
    providerTypes: ["gmail"],
    requiredCapabilities: ["email.modify"],
    requiredScopes: [GMAIL_MODIFY_SCOPE],
    // Restorative: it puts mail BACK. Nothing is lost, so no confirmation.
    riskLevel: "modify",
    confirmationRequired: false,
    implemented: true,
    enabled: true,
    inputSchema: [
      {
        name: "threadIds",
        type: "string[]",
        required: false,
        description: "Conversations to restore (the UI-aligned path). Verified after the change.",
      },
      { name: "messageIds", type: "string[]", required: false, description: "Messages to restore." },
      { name: "op", type: "string", required: false, description: "`untrash` — selects the postcondition." },
    ],
    examples: ["restore the email I just trashed", "undo that trash"],
    userFacingDescription:
      "I couldn’t restore that email just now — mind trying again in a moment?",
  },
  // --- Tasks (Todoist, Section 19) ---------------------------------------
  //
  // WHY THESE SIT ON THE `modify` RUNG. The risk ladder forces a confirmation for
  // anything marked `write`. Creating, editing, completing, reopening, or moving a
  // SINGLE task is reversible, invisible outside the user's own account, and
  // destroys nothing — the exact definition of the `modify` rung (see
  // `integrations/policy.ts`). The section requires these to execute immediately
  // once the target is unambiguous, and prompting for each one would train users
  // to reflex-approve, eroding the confirmation on the rungs that matter
  // (deletion, bulk). `email.modifyLabels` set the same precedent.
  //
  // BULK is NOT expressed here. Confirmation for "complete all of those" is
  // enforced by the HANDLER (`todoistActions`), which is the only layer that knows
  // how many tasks a request resolved to. A registry flag cannot express "one is
  // fine, five needs asking".
  {
    actionId: "task.create",
    category: "tasks",
    displayName: "Create task",
    description:
      "Create a task in Todoist (Section 19). Title, description, due date/time, recurring " +
      "expression, project, section, labels, and priority all arrive ALREADY RESOLVED.",
    providerTypes: ["todoist"],
    requiredCapabilities: ["tasks.write"],
    requiredScopes: ["data:read_write"],
    riskLevel: "modify",
    confirmationRequired: false,
    implemented: true,
    enabled: true,
    inputSchema: [
      { name: "content", type: "string", required: true, description: "Task title." },
      { name: "description", type: "string", required: false, description: "Optional detail." },
      { name: "dueDate", type: "string", required: false, description: "All-day due (YYYY-MM-DD)." },
      { name: "dueDatetime", type: "datetime", required: false, description: "Timed due (ISO 8601)." },
      { name: "dueString", type: "string", required: false, description: "Recurring expression, e.g. 'every Monday'." },
      { name: "projectId", type: "string", required: false, description: "Resolved project id." },
      { name: "sectionId", type: "string", required: false, description: "Resolved section id." },
      { name: "labels", type: "string[]", required: false, description: "Resolved label names." },
      { name: "priority", type: "number", required: false, description: "RAW API priority (1..4; 4 = urgent)." },
      {
        name: "requestId",
        type: "string",
        required: false,
        description:
          "Generated ONCE at proposal time and replayed, so a duplicate delivery reuses Todoist's de-duplication instead of creating a second task.",
      },
    ],
    examples: [
      "add finish the pitch deck to my work project for Friday at 5",
      "add a task to call the bank",
    ],
    userFacingDescription:
      "I couldn’t add that task just now — mind trying again in a moment?",
  },
  {
    actionId: "task.update",
    category: "tasks",
    displayName: "Update task",
    description:
      "Update an existing Todoist task: rename, edit description, change or remove the due " +
      "date/time, reschedule, change priority, add/remove labels. The task id and every value " +
      "arrive ALREADY RESOLVED and the task is re-fetched before the write.",
    providerTypes: ["todoist"],
    requiredCapabilities: ["tasks.write"],
    requiredScopes: ["data:read_write"],
    riskLevel: "modify",
    confirmationRequired: false,
    implemented: true,
    enabled: true,
    inputSchema: [
      { name: "taskIds", type: "string[]", required: true, description: "Tasks to update." },
      { name: "content", type: "string", required: false, description: "New title." },
      { name: "description", type: "string", required: false, description: "New description." },
      { name: "dueDate", type: "string", required: false, description: "New all-day due." },
      { name: "dueDatetime", type: "datetime", required: false, description: "New timed due." },
      { name: "dueString", type: "string", required: false, description: "New recurring expression." },
      { name: "removeDue", type: "boolean", required: false, description: "Clear the due date." },
      { name: "labels", type: "string[]", required: false, description: "The COMPLETE new label set (merged at proposal time)." },
      { name: "priority", type: "number", required: false, description: "RAW API priority (1..4)." },
    ],
    examples: ["move the second task to Monday", "change its priority to high", "add the label work"],
    userFacingDescription:
      "I couldn’t change that task just now — mind trying again in a moment?",
  },
  {
    actionId: "task.move",
    category: "tasks",
    displayName: "Move task",
    description:
      "Move a Todoist task to a different project or section. A SEPARATE action because " +
      "Todoist's update endpoint cannot move a task — it silently ignores project_id and " +
      "answers 200, so a move must go through /tasks/{id}/move.",
    providerTypes: ["todoist"],
    requiredCapabilities: ["tasks.write"],
    requiredScopes: ["data:read_write"],
    riskLevel: "modify",
    confirmationRequired: false,
    implemented: true,
    enabled: true,
    inputSchema: [
      { name: "taskIds", type: "string[]", required: true, description: "Tasks to move." },
      { name: "projectId", type: "string", required: false, description: "Resolved destination project id." },
      { name: "sectionId", type: "string", required: false, description: "Resolved destination section id." },
    ],
    examples: ["put that in my Hula project", "move it to the Later section"],
    userFacingDescription:
      "I couldn’t move that task just now — mind trying again in a moment?",
  },
  {
    actionId: "task.complete",
    category: "tasks",
    displayName: "Complete task",
    description:
      "Mark Todoist tasks complete. Reversible via task.reopen, which is why it needs no " +
      "confirmation for a single unambiguous task. Completion is VERIFIED by re-reading — a " +
      "204 alone is not reported as done.",
    providerTypes: ["todoist"],
    requiredCapabilities: ["tasks.write"],
    requiredScopes: ["data:read_write"],
    riskLevel: "modify",
    confirmationRequired: false,
    implemented: true,
    enabled: true,
    inputSchema: [
      { name: "taskIds", type: "string[]", required: true, description: "Tasks to complete." },
    ],
    examples: ["mark the first one complete", "complete all of those", "tick that off"],
    userFacingDescription:
      "I couldn’t complete that task just now — mind trying again in a moment?",
  },
  {
    actionId: "task.reopen",
    category: "tasks",
    displayName: "Reopen task",
    description:
      "Reopen completed Todoist tasks. Restorative — it puts a task BACK — so nothing is lost " +
      "and no confirmation is required.",
    providerTypes: ["todoist"],
    requiredCapabilities: ["tasks.write"],
    requiredScopes: ["data:read_write"],
    riskLevel: "modify",
    confirmationRequired: false,
    implemented: true,
    enabled: true,
    inputSchema: [
      { name: "taskIds", type: "string[]", required: true, description: "Tasks to reopen." },
    ],
    examples: ["reopen the task I just completed", "undo that", "put that back on my list"],
    userFacingDescription:
      "I couldn’t reopen that task just now — mind trying again in a moment?",
  },
  {
    actionId: "task.delete",
    category: "tasks",
    displayName: "Delete task",
    description:
      "Permanently delete Todoist tasks (Section 19). Todoist does NOT trash a deleted task — " +
      "it is irreversible — so this ALWAYS requires explicit confirmation and a preview that " +
      "says it is permanent. Deletion is VERIFIED by absence, never assumed from a 204.",
    providerTypes: ["todoist"],
    requiredCapabilities: ["tasks.delete"],
    // The one action needing data:delete. A user who declined it keeps every
    // other capability and only this refuses — never a 'disconnected' claim.
    requiredScopes: ["data:delete"],
    // Deliberately "write", not "destructive": the ladder HARD-BLOCKS
    // `destructive`, which would make this unrunnable. The irreversibility is
    // handled where it belongs — an explicit confirmation plus a preview that
    // says so. `email.deleteDraft` set this precedent.
    riskLevel: "write",
    confirmationRequired: true,
    implemented: true,
    enabled: true,
    inputSchema: [
      { name: "taskIds", type: "string[]", required: true, description: "Tasks to delete." },
    ],
    examples: ["delete that task", "get rid of the pitch deck task"],
    userFacingDescription:
      "I couldn’t delete that task just now — mind trying again in a moment?",
  },
  // --- Documents ---------------------------------------------------------
  {
    actionId: "document.search",
    category: "documents",
    displayName: "Search documents",
    description: "Search the user's connected document workspace.",
    providerTypes: ["notion"],
    requiredCapabilities: ["docs.read"],
    requiredScopes: ["read_content"],
    riskLevel: "read",
    confirmationRequired: false,
    implemented: false,
    enabled: true,
    inputSchema: [
      { name: "query", type: "string", required: true, description: "Search query." },
    ],
    examples: ["find my notes on the project", "search my docs for the contract"],
    userFacingDescription: "I can't search your documents yet — no document workspace is connected.",
  },
  {
    actionId: "document.appendText",
    category: "documents",
    displayName: "Append to document",
    description: "Append text to a document in the connected workspace.",
    providerTypes: ["notion"],
    requiredCapabilities: ["docs.write"],
    requiredScopes: ["write_content"],
    riskLevel: "write",
    confirmationRequired: true,
    implemented: false,
    enabled: true,
    inputSchema: [
      { name: "documentId", type: "string", required: true, description: "Target document." },
      { name: "text", type: "string", required: true, description: "Text to append." },
    ],
    examples: ["add this to my project notes", "append a line to my journal doc"],
    userFacingDescription: "I can't write to your documents yet — no document workspace is connected.",
  },
  // --- Messaging ---------------------------------------------------------
  {
    actionId: "slack.postMessage",
    category: "messaging",
    displayName: "Post Slack message",
    description: "Post a message to a Slack channel or person.",
    providerTypes: ["slack"],
    requiredCapabilities: ["messages.send"],
    requiredScopes: ["chat:write"],
    riskLevel: "send",
    confirmationRequired: true,
    implemented: false,
    enabled: true,
    inputSchema: [
      { name: "channel", type: "string", required: true, description: "Channel or user." },
      { name: "text", type: "string", required: true, description: "Message text." },
    ],
    examples: ["post in the team channel", "message my manager on Slack"],
    userFacingDescription: "I can't post to Slack yet — Slack isn't connected.",
  },
  // --- Shopping ----------------------------------------------------------
  {
    actionId: "shopping.createList",
    category: "shopping",
    displayName: "Create shopping list",
    description: "Create a shopping list in a connected app.",
    providerTypes: [],
    requiredCapabilities: ["shopping.write"],
    requiredScopes: [],
    riskLevel: "write",
    confirmationRequired: true,
    implemented: false,
    enabled: true,
    inputSchema: [
      { name: "name", type: "string", required: false, description: "List name." },
      { name: "items", type: "string[]", required: false, description: "Items to add." },
    ],
    examples: ["make a shopping list", "start a grocery list"],
    userFacingDescription: "I can't create shopping lists in an app yet — no shopping app is connected.",
  },
] as const;

/** Fast lookup by action id. */
const BY_ID = new Map<string, ActionDefinition>(
  ACTION_DEFINITIONS.map((a) => [a.actionId, a]),
);

/** Return every action definition (safe metadata only). */
export function listActionDefinitions(): readonly ActionDefinition[] {
  return ACTION_DEFINITIONS;
}

/** Look up one action definition, or undefined if the id is unknown. */
export function getActionDefinition(actionId: string): ActionDefinition | undefined {
  return BY_ID.get(actionId);
}

/** Whether an action id exists in the registry. */
export function isKnownAction(actionId: string): boolean {
  return BY_ID.has(actionId);
}
