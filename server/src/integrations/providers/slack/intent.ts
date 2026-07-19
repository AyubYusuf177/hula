import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";

export const SlackOperationSchema = z.enum([
  "capability_help", "list_conversations", "read_history", "summarize_history",
  "read_thread", "get_permalink", "search", "list_users", "lookup_user", "user_presence", "list_dms", "workspace_info", "send_message", "send_dm",
  "reply_thread", "edit_message", "delete_message", "list_reactions", "add_reaction",
  "remove_reaction", "list_pins", "add_pin", "remove_pin", "list_bookmarks",
  "create_bookmark", "edit_bookmark", "remove_bookmark", "list_files", "upload_file",
  "list_scheduled", "schedule_message", "delete_scheduled", "channel_info", "channel_members", "file_info",
  "channel_create", "channel_rename", "channel_topic", "channel_purpose",
  "channel_archive", "channel_unarchive", "channel_join", "channel_leave",
  "channel_invite", "channel_remove_member", "usergroup_list", "usergroup_create",
  "usergroup_update", "usergroup_enable", "usergroup_disable", "usergroup_membership", "emoji_list", "not_slack",
]);

const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

export const SlackIntentSchema = z.object({
  provider: z.enum(["slack", "gmail", "calendar", "todoist", "asana", "notion", "reminder", "memory", "unknown"]),
  operation: SlackOperationSchema,
  targetType: z.enum(["workspace", "channel", "dm", "mpim", "user", "message", "thread", "reply", "file", "bookmark", "user_group", "unknown"]).nullable().optional(),
  targetName: nullableText(200),
  personName: nullableText(200),
  people: z.array(z.string().trim().min(1).max(200)).max(50).nullable().optional(),
  messageReference: nullableText(120),
  fileReference: nullableText(120),
  requestedCount: z.number().int().min(1).max(50).nullable().optional(),
  query: nullableText(500),
  content: nullableText(3_000),
  emoji: nullableText(100),
  url: z.string().url().max(2_000).nullable().optional(),
  title: nullableText(200),
  scheduledFor: nullableText(120),
  summaryRequested: z.boolean().default(false),
  unresolvedReference: z.boolean().default(false),
  needsClarification: z.boolean().default(false),
  isPrivate: z.boolean().nullable().optional(),
});

export type SlackIntent = z.infer<typeof SlackIntentSchema>;
export const SlackPlanSchema = z.object({
  provider: z.literal("slack"),
  steps: z.array(SlackIntentSchema.omit({ provider: true })).min(1).max(5),
  responseMode: z.enum(["last_step", "summary", "people", "search_results"]).default("last_step"),
});
export type SlackPlan = z.infer<typeof SlackPlanSchema>;
export type SlackSemantic = SlackIntent | SlackPlan;

type Requirement = "channel" | "person" | "message" | "query" | "content" | "url" | "name" | "time";

export const SLACK_OPERATION_REQUIREMENTS: Record<SlackIntent["operation"], readonly Requirement[]> = {
  capability_help: [], workspace_info: [], list_conversations: [], list_dms: [], list_users: [],
  list_files: [], list_scheduled: [], usergroup_list: [], emoji_list: [], not_slack: [],
  search: ["query"], read_history: ["channel"], summarize_history: ["channel"],
  read_thread: ["message"], get_permalink: ["message"], lookup_user: ["person"], user_presence: ["person"], channel_info: ["channel"],
  channel_members: ["channel"], list_reactions: ["message"], list_pins: ["channel"],
  list_bookmarks: ["channel"], file_info: ["message"], upload_file: ["channel"],
  send_message: ["channel", "content"], send_dm: ["person", "content"],
  reply_thread: ["message", "content"], edit_message: ["message", "content"],
  delete_message: ["message"], schedule_message: ["channel", "content", "time"],
  delete_scheduled: ["message"], add_reaction: ["message"], remove_reaction: ["message"],
  add_pin: ["message"], remove_pin: ["message"], create_bookmark: ["channel", "url"],
  edit_bookmark: ["channel", "message"], remove_bookmark: ["channel", "message"],
  channel_create: ["name"], channel_rename: ["channel", "name"], channel_topic: ["channel", "content"],
  channel_purpose: ["channel", "content"], channel_archive: ["channel"], channel_unarchive: ["channel"],
  channel_join: ["channel"], channel_leave: ["channel"], channel_invite: ["channel", "person"],
  channel_remove_member: ["channel", "person"], usergroup_create: ["name"],
  usergroup_update: ["message"], usergroup_enable: ["message"], usergroup_disable: ["message"],
  usergroup_membership: ["message", "person"],
};

function hasGroundedReference(intent: SlackIntent): boolean {
  return Boolean(intent.unresolvedReference || intent.messageReference || intent.fileReference);
}

export function missingSlackIntentRequirements(intent: SlackIntent): Requirement[] {
  return SLACK_OPERATION_REQUIREMENTS[intent.operation].filter((requirement) => {
    if (requirement === "channel") return !intent.targetName && !hasGroundedReference(intent);
    if (requirement === "person") return !intent.personName && !intent.people?.length && !hasGroundedReference(intent);
    if (requirement === "message") return !hasGroundedReference(intent);
    if (requirement === "query") return !intent.query;
    if (requirement === "content") return !intent.content;
    if (requirement === "url") return !intent.url;
    if (requirement === "name") return !(intent.title || intent.targetName);
    return !intent.scheduledFor;
  });
}

export function normalizeSlackIntent(intent: SlackIntent): SlackIntent {
  return { ...intent, needsClarification: missingSlackIntentRequirements(intent).length > 0 };
}

/** Deterministic safety net for an explicit quoted channel post. It extracts
 * structure only; semantic interpretation remains the primary language path. */
export function explicitSlackWriteIntent(text: string): SlackIntent | null {
  const match = text.match(/^\s*(?:post|send)\s+["“]([^"”]{1,3000})["”]\s+(?:in|to)\s+#?([a-z0-9]+(?:-[a-z0-9-]+)*)\b(?:\s+on\s+slack)?[.!]?\s*$/i);
  if (!match) return null;
  return normalizeSlackIntent(SlackIntentSchema.parse({
    provider: "slack",
    operation: "send_message",
    targetType: "channel",
    targetName: match[2],
    content: match[1],
  }));
}

/**
 * Deterministic validation for clearly structured metadata questions about an
 * already-grounded Slack entity. This prevents a probabilistic extractor from
 * changing an attribute question into a content-reading operation while still
 * leaving general natural-language interpretation to the semantic path.
 */
export function explicitSlackEntityAttributeIntent(text: string): SlackIntent | null {
  const value = text.trim();
  const lower = value.toLowerCase();
  if (!value || /\bsearch\b/.test(lower)) return null;

  const hasGroundedReference = /\b(?:that|this|it|one|result|item)\b/.test(lower) ||
    /\b(?:first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th))\s+(?:message|thread|repl(?:y|ies)|result|item|one)\b/.test(lower);
  if (!hasGroundedReference) return null;

  const targetType: SlackIntent["targetType"] = /\brepl(?:y|ies)\b/.test(lower)
    ? "reply"
    : /\bthread\b/.test(lower)
      ? "thread"
      : "message";
  const channelAttribute = /\b(?:which|what)\s+(?:slack\s+)?channel\b/.test(lower) ||
    (/\bwhere\b/.test(lower) && /\b(?:message|thread|repl(?:y|ies)|result|item|one|it|that|this)\b/.test(lower)) ||
    /\b(?:which|what)\s+(?:slack\s+)?(?:source|origin)\b/.test(lower) ||
    /\b(?:message|thread|repl(?:y|ies)|result|item)\b.{0,100}\b(?:came|is|was)\s+from\b/.test(lower);
  const authorAttribute = /\bwho\b.{0,100}\b(?:wrote|authored|posted|sent)\b/.test(lower) ||
    /\b(?:who|which person|name|identify)\b.{0,100}\b(?:author|sender)\b/.test(lower);
  const permalinkAttribute = /\b(?:permalink|slack\s+link)\b/.test(lower) ||
    (/\blink\b/.test(lower) && /\b(?:give|show|get|copy|find|what|where)\b/.test(lower));
  const operation = channelAttribute
    ? "channel_info"
    : authorAttribute
      ? "lookup_user"
      : permalinkAttribute
        ? "get_permalink"
        : null;
  if (!operation) return null;

  return normalizeSlackIntent(SlackIntentSchema.parse({
    provider: "slack",
    operation,
    targetType,
    messageReference: value,
    unresolvedReference: true,
  }));
}
export type SlackTextGenerator = (params: {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  timeoutMs?: number;
}) => Promise<string>;

export function buildSlackIntentPrompt(context: boolean): string {
  return [
    "Interpret one user request for provider routing. Return strict JSON only. Never answer or execute the request.",
    "Choose provider slack only when Slack is explicit, the user refers to a channel/DM/message/thread in Slack terms, or verified Slack context was supplied.",
    "Email is Gmail; events and meetings are Calendar; tasks are Todoist/Asana; Notion pages stay Notion; reminders and memory stay Hula. An ordinary ambiguous question is unknown.",
    context
      ? "Verified durable arbitration says the unresolved pronoun/ordinal refers to Slack. Preserve unresolvedReference and infer the Slack operation."
      : "No verified Slack context exists. Do not assume Slack for vague requests such as 'what happened?'. A plausible named channel may be Slack, but deterministic code will verify the name and decline if it does not resolve.",
    "Understand meaning, not trigger words: history includes catching up, activity, chatter, updates, missed discussion and recent posts. summarize_history means a digest; read_history means a requested raw list. A vague few/couple uses requestedCount null; exact written or numeric counts become an integer.",
    "capability_help is only a broad question about what Hula can do with Slack, never an actionable request.",
    "Workspace-wide operations need no target: list_users means people in the workspace; list_conversations means channels/conversations; workspace_info means installation identity.",
    "Use channel_info for details about one channel and channel_members for who belongs to it. Use lookup_user for one named person or a grounded message author.",
    "A Slack thread or reply is message-backed. Preserve targetType thread or reply for attribute questions so deterministic grounding can derive its parent channel without inventing a channel name.",
    "Use get_permalink for a link to a grounded message. Use user_presence for active/away presence; profile status text alone is not presence.",
    "For a compound read, return a bounded plan. Example semantics: recent messages plus their people is read_history then list_users with targetType message and unresolvedReference true. Search plus authors is search then list_users similarly.",
    "responseMode describes the requested final presentation. Use people only when the user asks who authored or was represented in results. Use search_results when the user asks where search results came from or wants matching messages/files with source attribution; a supporting list_users step must not replace the search results.",
    "Never invent IDs. Output names/references only as the user expressed them. Deterministic code, not this model, makes the final clarification decision.",
    `Operations: ${SlackOperationSchema.options.join(", ")}.`,
    `Single shape: ${JSON.stringify({ provider: "slack", operation: "read_history", targetType: "channel", targetName: null, personName: null, messageReference: null, fileReference: null, requestedCount: null, query: null, content: null, emoji: null, url: null, title: null, scheduledFor: null, summaryRequested: false, unresolvedReference: false, needsClarification: false })}`,
    `Plan shape: ${JSON.stringify({ provider: "slack", steps: [{ operation: "read_history", targetType: "channel", targetName: "channel-name", requestedCount: 20, summaryRequested: false, unresolvedReference: false, needsClarification: false }, { operation: "list_users", targetType: "message", summaryRequested: false, unresolvedReference: true, needsClarification: false }], responseMode: "people" })}`,
  ].join("\n");
}

export function parseSlackSemantic(raw: string): SlackSemantic | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    const plan = SlackPlanSchema.safeParse(value);
    if (plan.success) return { ...plan.data, steps: plan.data.steps.map((step) => normalizeSlackIntent({ provider: "slack", ...step })) };
    const parsed = SlackIntentSchema.safeParse(value);
    return parsed.success ? normalizeSlackIntent(parsed.data) : null;
  } catch {
    return null;
  }
}

export function parseSlackIntent(raw: string): SlackIntent | null {
  const parsed = parseSlackSemantic(raw);
  return parsed && "operation" in parsed ? parsed : null;
}

export async function extractSlackIntent(input: {
  text: string;
  context?: boolean;
  generate?: SlackTextGenerator;
}): Promise<SlackIntent | null> {
  try {
    const raw = await (input.generate ?? generateAnthropicText)({
      system: buildSlackIntentPrompt(Boolean(input.context)),
      messages: [{ role: "user", content: input.text }],
      maxTokens: 650,
    });
    return parseSlackIntent(raw);
  } catch {
    return null;
  }
}

export async function extractSlackSemantic(input: {
  text: string;
  context?: boolean;
  generate?: SlackTextGenerator;
}): Promise<SlackSemantic | null> {
  try {
    const raw = await (input.generate ?? generateAnthropicText)({
      system: buildSlackIntentPrompt(Boolean(input.context)),
      messages: [{ role: "user", content: input.text }],
      maxTokens: 900,
    });
    return parseSlackSemantic(raw);
  } catch {
    return null;
  }
}

function target(intent: SlackIntent): string {
  return intent.targetName ? ` #${intent.targetName.replace(/^#/, "")}` : "";
}

function reference(intent: SlackIntent): string {
  return intent.messageReference ?? "that Slack message";
}

/** Compatibility adapter: structured meaning selects the existing deterministic executor branch. */
export function slackIntentCommand(intent: SlackIntent): string | null {
  const count = intent.requestedCount ? ` ${intent.requestedCount}` : "";
  const content = intent.content ? ` saying ${intent.content}` : "";
  const person = intent.personName ? ` ${intent.personName}` : "";
  switch (intent.operation) {
    case "capability_help": return "what can you do with Slack";
    case "list_conversations": return "show Slack channels";
    case "list_dms": return "show Slack DMs";
    case "read_history": return `show${count} latest Slack messages in${target(intent)}`;
    case "summarize_history": return `summarize Slack history in${target(intent)}`;
    case "read_thread": return `show Slack thread replies to ${reference(intent)}`;
    case "get_permalink": return `show Slack permalink for ${reference(intent)}`;
    case "search": return `search Slack for ${intent.query ?? ""}`;
    case "list_users": return "show Slack users";
    case "lookup_user": return `show Slack profile${person}`;
    case "user_presence": return `show Slack presence${person}`;
    case "workspace_info": return "show Slack workspace identity";
    case "send_message": return `send Slack message to${target(intent)}${content}`;
    case "send_dm": return `message${person}${content} on Slack`;
    case "reply_thread": return `reply to ${reference(intent)}${content}`;
    case "edit_message": return `edit ${reference(intent)} to say ${intent.content ?? ""}`;
    case "delete_message": return `delete ${reference(intent)}`;
    case "list_reactions": return "show Slack reactions";
    case "add_reaction": return `react to ${reference(intent)} with ${intent.emoji ?? "thumbsup"}`;
    case "remove_reaction": return `remove reaction ${intent.emoji ?? "thumbsup"} from ${reference(intent)}`;
    case "list_pins": return `show Slack pins in${target(intent)}`;
    case "add_pin": return `pin ${reference(intent)}`;
    case "remove_pin": return `unpin ${reference(intent)}`;
    case "list_bookmarks": return `show Slack bookmarks in${target(intent)}`;
    case "list_files": return `show Slack files in${target(intent)}`;
    case "list_scheduled": return "show scheduled Slack messages";
    case "delete_scheduled": return "delete scheduled Slack message";
    case "emoji_list": return "show Slack emoji";
    case "channel_info": return `show Slack channel information for${target(intent)}`;
    case "channel_members": return `show Slack channel members for${target(intent)}`;
    case "file_info": return `show Slack file information ${intent.fileReference ?? ""}`;
    case "channel_create": return `create Slack channel called ${intent.targetName ?? ""}`;
    case "channel_rename": return `rename${target(intent)} to ${intent.title ?? ""}`;
    case "channel_topic": return `change${target(intent)} topic to ${intent.content ?? ""}`;
    case "channel_purpose": return `change${target(intent)} purpose to ${intent.content ?? ""}`;
    case "channel_archive": return `archive${target(intent)} Slack channel`;
    case "channel_unarchive": return `unarchive${target(intent)} Slack channel`;
    case "channel_join": return `join${target(intent)} Slack channel`;
    case "channel_leave": return `leave${target(intent)} Slack channel`;
    case "channel_invite": return `invite${person} to${target(intent)} Slack channel`;
    case "channel_remove_member": return `remove member${person} from${target(intent)} Slack channel`;
    case "usergroup_list": return "show Slack user groups";
    case "usergroup_create": return `create Slack user group called ${intent.targetName ?? ""}`;
    case "upload_file": return `upload Slack file ${intent.fileReference ?? ""} to${target(intent)}`;
    case "schedule_message": return `schedule Slack message${content} in${target(intent)} for ${intent.scheduledFor ?? ""}`;
    case "create_bookmark": return `add Slack bookmark ${intent.url ?? ""} called ${intent.title ?? ""} to${target(intent)}`;
    case "edit_bookmark": return `edit Slack bookmark ${intent.messageReference ?? ""}`;
    case "remove_bookmark": return `remove Slack bookmark ${intent.messageReference ?? ""}`;
    case "usergroup_update": return `update Slack user group ${intent.targetName ?? ""}`;
    case "usergroup_enable": return `enable Slack user group ${intent.targetName ?? ""}`;
    case "usergroup_disable": return `disable Slack user group ${intent.targetName ?? ""}`;
    case "usergroup_membership": return `update Slack user group ${intent.targetName ?? ""}`;
    case "not_slack": return null;
  }
}
