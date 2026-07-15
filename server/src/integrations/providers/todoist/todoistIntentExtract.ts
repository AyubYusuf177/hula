import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";
import { isReferencePhrase } from "./todoistContext";

/**
 * Structured Todoist intent extraction (Section 19).
 *
 * WHAT THE MODEL IS AND IS NOT ALLOWED TO DO. It fills TYPED SLOTS from one
 * message. It does not read Todoist, does not decide what is on the list, does not
 * choose provider ids, and — critically — never authors a filter expression. The
 * backend queries Todoist deterministically from these validated slots and answers
 * strictly from what comes back. The output is untrusted: it is re-validated here
 * by Zod and again downstream when names are resolved against real projects.
 *
 * WHY EXTRACTION RATHER THAN KEYWORDS. The section explicitly forbids literal
 * keyword rules ("when text contains work, return X"), and rightly: "what do I
 * need to do today", "what's on my plate", "anything overdue?", "what's left for
 * the week" are the same intent with no shared keyword. Slot-filling covers that
 * open set; a regex ladder would not, and would sprawl.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

const nullableDate = z.string().regex(DATE_RE).nullable().optional();
const nullableTime = z.string().regex(TIME_RE).nullable().optional();
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

/** The date scopes the model may choose. Mirrors `TodoistScope` exactly. */
const ScopeEnum = z.enum(["today", "overdue", "upcoming", "week", "no_date", "all"]);

/**
 * The READ intents Hula supports.
 *  - `list`      : "what do I need to do today", "what's overdue", "show my Hula tasks"
 *  - `completed` : "what did I just complete", "what did I finish today"
 *  - `inspect`   : "tell me about that task", "what's the detail on the second one"
 */
export const TodoistReadIntentSchema = z.object({
  intent: z.enum(["list", "completed", "inspect", "not_todoist_read"]),
  scope: ScopeEnum.nullable().optional(),
  /** A project named in the message ("my work project"). NAME only, never an id. */
  projectName: nullableText(120),
  /** A section named in the message. */
  sectionName: nullableText(120),
  /** A label named in the message ("tasks labelled work"). */
  label: nullableText(120),
  /** UI priority: 1 = urgent … 4 = normal. "high priority" -> 1. */
  uiPriority: z.number().int().min(1).max(4).nullable().optional(),
  /** Free-text topic to match against task titles. */
  query: nullableText(120),
  /** An explicit count the user asked for ("show me 5"). */
  count: z.number().int().min(1).max(50).nullable().optional(),
});

export type TodoistReadIntent = z.infer<typeof TodoistReadIntentSchema>;

/**
 * The WRITE intents Hula supports. One schema for the whole lifecycle, because
 * these arrive as one message and share most slots.
 */
export const TodoistWriteIntentSchema = z.object({
  intent: z.enum([
    "create",
    "update",
    "complete",
    "reopen",
    "delete",
    "move",
    "undo",
    "not_todoist_write",
  ]),
  /** The task title, for a create. */
  content: nullableText(500),
  /** A new title, for a rename. */
  newContent: nullableText(500),
  description: nullableText(2000),
  /** Which task the user means, described in their words ("the pitch deck one"). */
  targetPhrase: nullableText(200),
  /** A 1-based position when they said "the second one". */
  targetPosition: z.number().int().min(1).max(20).nullable().optional(),
  /** True when they addressed a whole shown list ("complete all of those"). */
  targetAll: z.boolean().nullable().optional(),
  dueDate: nullableDate,
  dueTime: nullableTime,
  /** A recurring expression Todoist parses natively ("every Monday"). */
  dueString: nullableText(120),
  /** True for "take the due date off that" — the whole date goes. */
  removeDue: z.boolean().nullable().optional(),
  /**
   * True for "keep it Friday but drop the time" — the DATE stays, the time goes.
   * Distinct from `removeDue`: confusing the two either strands a task with no date
   * at all or leaves the time the user asked to remove.
   */
  removeDueTime: z.boolean().nullable().optional(),
  projectName: nullableText(120),
  sectionName: nullableText(120),
  /** Labels to ADD. */
  addLabels: z.array(z.string().trim().min(1).max(60)).max(10).nullable().optional(),
  /** Labels to REMOVE. */
  removeLabels: z.array(z.string().trim().min(1).max(60)).max(10).nullable().optional(),
  /** UI priority: 1 = urgent … 4 = normal. */
  uiPriority: z.number().int().min(1).max(4).nullable().optional(),
});

export type TodoistWriteIntent = z.infer<typeof TodoistWriteIntentSchema>;

/** PURE: shared JSON-extraction + validation for either schema. */
function parseWith<T extends z.ZodTypeAny>(schema: T, raw: string): z.infer<T> | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** PURE: build the READ-extraction system prompt. */
export function buildReadIntentPrompt(nowLocalIso: string, timezone: string | undefined): string {
  const tz = timezone ?? "UTC";
  return [
    "You extract a single TASK-LIST question from one message. You never answer it.",
    `The user's current local date and time is ${nowLocalIso} (timezone: ${tz}).`,
    "",
    "Respond with ONE JSON object and nothing else. No markdown, no prose. Shape:",
    "{",
    '  "intent": "list" | "completed" | "inspect" | "not_todoist_read",',
    '  "scope": "today" | "overdue" | "upcoming" | "week" | "no_date" | "all" | null,',
    '  "projectName": string | null,',
    '  "sectionName": string | null,',
    '  "label": string | null,',
    '  "uiPriority": 1 | 2 | 3 | 4 | null,',
    '  "query": string | null,',
    '  "count": number | null',
    "}",
    "",
    "Rules:",
    '- "list" = asking what tasks they have. "completed" = asking what they finished.',
    '- "inspect" = asking for the detail of ONE specific task.',
    '- Priority uses Todoist numbering: "high"/"urgent"/"top" priority -> 1. "low" -> 4.',
    '- "what do I need to do" / "what\'s on my plate" with no timeframe -> scope "today".',
    '- "this week" / "the rest of the week" -> "week". "coming up" / "later" -> "upcoming".',
    '- "no due date" / "unscheduled" -> "no_date". "everything" -> "all".',
    '- Set "count" ONLY if they named a number ("show me 5"). Otherwise null.',
    '- Put a project name in "projectName" WITHOUT the # (e.g. "Show my tasks for Hula" -> "Hula").',
    '- Put a label in "label" WITHOUT the @.',
    '- If the message is not about reading their tasks, return {"intent":"not_todoist_read"}.',
    "- A request to CREATE, COMPLETE, MOVE, or DELETE a task is NOT a read.",
    "- Never invent a project, label, or date the message does not imply. Leave it null.",
  ].join("\n");
}

/** PURE: build the WRITE-extraction system prompt. */
export function buildWriteIntentPrompt(nowLocalIso: string, timezone: string | undefined): string {
  const tz = timezone ?? "UTC";
  return [
    "You extract a single TASK command from one message. You never perform it.",
    `The user's current local date and time is ${nowLocalIso} (timezone: ${tz}).`,
    'Resolve relative dates ("tomorrow", "Friday", "next Monday") to concrete dates using that current date.',
    "",
    "Respond with ONE JSON object and nothing else. No markdown, no prose. Shape:",
    "{",
    '  "intent": "create" | "update" | "complete" | "reopen" | "delete" | "move" | "undo" | "not_todoist_write",',
    '  "content": string | null,        // the task title, for a create',
    '  "newContent": string | null,     // a new title, for a rename',
    '  "description": string | null,',
    '  "targetPhrase": string | null,   // how they NAMED an existing task. NEVER a pronoun.',
    '  "targetPosition": number | null, // "the second one" -> 2',
    '  "targetAll": boolean | null,     // "complete all of those" -> true',
    '  "dueDate": "YYYY-MM-DD" | null,',
    '  "dueTime": "HH:MM" | null,',
    '  "dueString": string | null,      // ONLY for repeats, e.g. "every Monday"',
    '  "removeDue": boolean | null,     // drop the due date entirely',
    '  "removeDueTime": boolean | null, // keep the DAY, drop only the time',
    '  "projectName": string | null,',
    '  "sectionName": string | null,',
    '  "addLabels": string[] | null,',
    '  "removeLabels": string[] | null,',
    '  "uiPriority": 1 | 2 | 3 | 4 | null',
    "}",
    "",
    "Rules:",
    '- "create" = adding a NEW task. Put the task text in "content", not "targetPhrase".',
    '- "update" = changing an existing task (rename, due date, priority, labels, description).',
    '- "move" = changing which project or section a task is in.',
    '- "complete" = marking done. "reopen" = undoing a completion. "delete" = removing entirely.',
    '- "undo" = reversing the action Hula just performed ("undo that").',
    '- targetPhrase is for a task the user NAMED ("the pitch deck one"). If they only pointed at it ("it", "that", "that task", "the one I just reopened"), leave targetPhrase NULL — the backend resolves references from context. Never put a pronoun in targetPhrase.',
    "- Use 24-hour HH:MM (5pm -> 17:00).",
    '- Priority uses Todoist numbering: "high"/"urgent" -> 1, "low" -> 4.',
    '- Put project/label names WITHOUT the # or @ prefix.',
    '- Set "dueString" ONLY for a repeating task, and only in the form "every …"/"each …". A one-off date/time ALWAYS goes in "dueDate"/"dueTime", never in "dueString".',
    '- "remove the due date" / "unschedule it" -> removeDue. "make it any time that day" / "drop the time" -> removeDueTime.',
    '- If the message is not a task command, return {"intent":"not_todoist_write"}.',
    "- Never invent a title, project, label, or date the message does not imply. Leave it null.",
  ].join("\n");
}

/** PURE: parse a raw model reply into a validated read intent, or null. */
export function parseTodoistReadIntent(raw: string): TodoistReadIntent | null {
  return parseWith(TodoistReadIntentSchema, raw);
}

/** PURE: parse a raw model reply into a validated write intent, or null. */
export function parseTodoistWriteIntent(raw: string): TodoistWriteIntent | null {
  const parsed = parseWith(TodoistWriteIntentSchema, raw);
  if (!parsed) return null;

  // A create with no title is not a create. Downgrading here rather than
  // downstream keeps the "never invent a title" rule in one place.
  if (parsed.intent === "create" && !parsed.content) {
    return { ...parsed, intent: "not_todoist_write" };
  }

  // A PRONOUN IS NOT A TITLE. The model naturally answers `targetPhrase: "it"` for
  // "Delete it" — it is describing the target faithfully. But downstream that
  // string is used to SEARCH task titles, so "it" would either match a task by
  // coincidence or match nothing and refuse (which is what happened live). Nulling
  // it here means the typed intent can never carry a reference where a name
  // belongs; the resolver then resolves it against context, which is the only
  // thing that actually knows what "it" is.
  if (isReferencePhrase(parsed.targetPhrase)) {
    return { ...parsed, targetPhrase: null };
  }
  return parsed;
}

/** The model call, injectable so every test runs with no network. */
export type TextGenerator = (params: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}) => Promise<string>;

/**
 * Extract a structured Todoist READ intent. Returns null when the model is
 * unavailable, errors, or returns something invalid — the caller treats null as
 * "couldn't extract" and falls through unchanged.
 */
export async function extractTodoistReadIntent(params: {
  text: string;
  nowLocalIso: string;
  timezone: string | undefined;
  generate?: TextGenerator;
}): Promise<TodoistReadIntent | null> {
  const generate = params.generate ?? generateAnthropicText;
  try {
    const reply = await generate({
      system: buildReadIntentPrompt(params.nowLocalIso, params.timezone),
      messages: [{ role: "user", content: params.text }],
      maxTokens: 400,
    });
    return parseTodoistReadIntent(reply);
  } catch {
    return null;
  }
}

/** Extract a structured Todoist WRITE intent. Null on any failure. */
export async function extractTodoistWriteIntent(params: {
  text: string;
  nowLocalIso: string;
  timezone: string | undefined;
  generate?: TextGenerator;
}): Promise<TodoistWriteIntent | null> {
  const generate = params.generate ?? generateAnthropicText;
  try {
    const reply = await generate({
      system: buildWriteIntentPrompt(params.nowLocalIso, params.timezone),
      messages: [{ role: "user", content: params.text }],
      maxTokens: 500,
    });
    return parseTodoistWriteIntent(reply);
  } catch {
    return null;
  }
}
