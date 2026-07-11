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

/**
 * The action registry. Read actions backed by the Section 11 Google Calendar
 * read-only helper are `implemented + enabled`. Everything else is a STUB: the
 * contract is ready, but no write/send/purchase action executes in this section.
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
    description: "Create a new event on the user's calendar.",
    providerTypes: ["google_calendar"],
    requiredCapabilities: ["write_calendar_events"],
    requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
    riskLevel: "write",
    confirmationRequired: true,
    implemented: false,
    enabled: true,
    inputSchema: [
      { name: "title", type: "string", required: true, description: "Event title." },
      { name: "start", type: "datetime", required: true, description: "Start time (ISO 8601)." },
      { name: "end", type: "datetime", required: false, description: "End time (ISO 8601)." },
      { name: "location", type: "string", required: false, description: "Optional location." },
    ],
    examples: ["schedule gym tomorrow at 7pm", "book a call with Sam on Friday"],
    userFacingDescription:
      "I can prepare that, but creating calendar events isn't enabled yet — I can only read your calendar for now.",
  },
  {
    actionId: "calendar.updateEvent",
    category: "calendar",
    displayName: "Update calendar event",
    description: "Update an existing event on the user's calendar.",
    providerTypes: ["google_calendar"],
    requiredCapabilities: ["write_calendar_events"],
    requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
    riskLevel: "write",
    confirmationRequired: true,
    implemented: false,
    enabled: true,
    inputSchema: [
      { name: "eventId", type: "string", required: true, description: "Event to update." },
      { name: "title", type: "string", required: false, description: "New title." },
      { name: "start", type: "datetime", required: false, description: "New start (ISO 8601)." },
      { name: "end", type: "datetime", required: false, description: "New end (ISO 8601)." },
    ],
    examples: ["move my 3pm to 4pm", "rename tomorrow's meeting"],
    userFacingDescription: "Editing calendar events isn't enabled yet — I can only read your calendar for now.",
  },
  {
    actionId: "calendar.cancelEvent",
    category: "calendar",
    displayName: "Cancel calendar event",
    description: "Cancel/delete an existing event on the user's calendar.",
    providerTypes: ["google_calendar"],
    requiredCapabilities: ["write_calendar_events"],
    requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
    riskLevel: "write",
    confirmationRequired: true,
    implemented: false,
    enabled: true,
    inputSchema: [
      { name: "eventId", type: "string", required: true, description: "Event to cancel." },
    ],
    examples: ["cancel my 2pm", "delete tomorrow's dentist appointment"],
    userFacingDescription: "Cancelling calendar events isn't enabled yet — I can only read your calendar for now.",
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
    userFacingDescription: "I can't read your email yet — no email account is connected.",
  },
  {
    actionId: "email.createDraft",
    category: "email",
    displayName: "Create email draft",
    description: "Create a draft email (not sent).",
    providerTypes: ["gmail"],
    requiredCapabilities: ["email.draft"],
    requiredScopes: ["https://www.googleapis.com/auth/gmail.compose"],
    riskLevel: "draft",
    confirmationRequired: true,
    implemented: false,
    enabled: true,
    inputSchema: [
      { name: "to", type: "string", required: true, description: "Recipient." },
      { name: "subject", type: "string", required: false, description: "Subject line." },
      { name: "body", type: "string", required: true, description: "Email body." },
    ],
    examples: ["draft an email to Rob", "write an email to my accountant"],
    userFacingDescription:
      "I can't draft emails in your account yet — no email account is connected. I can write the text here for you to send.",
  },
  {
    actionId: "email.sendDraft",
    category: "email",
    displayName: "Send email",
    description: "Send an email on the user's behalf.",
    providerTypes: ["gmail"],
    requiredCapabilities: ["email.send"],
    requiredScopes: ["https://www.googleapis.com/auth/gmail.send"],
    riskLevel: "send",
    confirmationRequired: true,
    implemented: false,
    enabled: true,
    inputSchema: [
      { name: "to", type: "string", required: true, description: "Recipient." },
      { name: "subject", type: "string", required: false, description: "Subject line." },
      { name: "body", type: "string", required: true, description: "Email body." },
    ],
    examples: ["send an email to Rob", "email my accountant the figures"],
    userFacingDescription:
      "I can't send emails yet — no email account is connected. I can write the text here for you to send.",
  },
  // --- Tasks -------------------------------------------------------------
  {
    actionId: "task.create",
    category: "tasks",
    displayName: "Create task",
    description: "Create a task in the user's connected task app.",
    providerTypes: ["asana"],
    requiredCapabilities: ["tasks.write"],
    requiredScopes: ["tasks:write"],
    riskLevel: "write",
    confirmationRequired: true,
    implemented: false,
    enabled: true,
    inputSchema: [
      { name: "title", type: "string", required: true, description: "Task title." },
      { name: "due", type: "datetime", required: false, description: "Optional due date." },
    ],
    examples: ["create a task to call the bank", "add a to-do to renew my passport"],
    userFacingDescription:
      "I can't add tasks yet — no task app is connected. Want me to keep it in mind here instead?",
  },
  {
    actionId: "task.complete",
    category: "tasks",
    displayName: "Complete task",
    description: "Mark a task complete in the connected task app.",
    providerTypes: ["asana"],
    requiredCapabilities: ["tasks.write"],
    requiredScopes: ["tasks:write"],
    riskLevel: "write",
    confirmationRequired: true,
    implemented: false,
    enabled: true,
    inputSchema: [
      { name: "taskId", type: "string", required: true, description: "Task to complete." },
    ],
    examples: ["mark the passport task done", "complete my call-the-bank task"],
    userFacingDescription: "I can't update tasks yet — no task app is connected.",
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
