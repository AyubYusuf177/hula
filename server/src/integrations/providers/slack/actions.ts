import { slackOps } from "./operations";
import { getConnectionForUserProvider } from "../../connections";

export const SLACK_MUTATION_METHODS = new Set([
  "hula.openAndPost",
  "bookmarks.add",
  "bookmarks.edit",
  "bookmarks.remove",
  "chat.delete",
  "chat.deleteScheduledMessage",
  "chat.postMessage",
  "chat.scheduleMessage",
  "chat.update",
  "conversations.archive",
  "conversations.create",
  "conversations.close",
  "conversations.invite",
  "conversations.join",
  "conversations.kick",
  "conversations.leave",
  "conversations.rename",
  "conversations.setPurpose",
  "conversations.setTopic",
  "conversations.unarchive",
  "pins.add",
  "pins.remove",
  "reactions.add",
  "reactions.remove",
  "usergroups.create",
  "usergroups.disable",
  "usergroups.enable",
  "usergroups.update",
  "usergroups.users.update",
]);

export interface SlackMutationReceipt {
  method: string;
  channelId?: string;
  timestamp?: string;
  scheduledMessageId?: string;
  entityId?: string;
}

const METHOD_SCOPES: Array<{ prefix: string; anyOf: string[] }> = [
  { prefix: "hula.openAndPost", anyOf: ["im:write"] },
  { prefix: "chat.", anyOf: ["chat:write"] },
  { prefix: "reactions.", anyOf: ["reactions:write"] },
  { prefix: "pins.", anyOf: ["pins:write"] },
  { prefix: "bookmarks.", anyOf: ["bookmarks:write"] },
  { prefix: "files.", anyOf: ["files:write"] },
  { prefix: "usergroups.", anyOf: ["usergroups:write"] },
  { prefix: "conversations.join", anyOf: ["channels:join"] },
  { prefix: "conversations.close", anyOf: ["im:write"] },
  { prefix: "conversations.", anyOf: ["channels:manage", "groups:write", "im:write"] },
];

export async function assertSlackMethodScope(userId: string, method: string): Promise<void> {
  const required = METHOD_SCOPES.find((entry) => method.startsWith(entry.prefix));
  if (!required) throw new Error("unsupported_slack_mutation");
  const connection = await getConnectionForUserProvider(userId, "slack");
  if (!connection || connection.status !== "connected") throw new Error("slack_not_connected");
  if (!required.anyOf.some((scope) => connection.grantedScopes.includes(scope))) {
    throw new Error("slack_missing_scope");
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function validateSlackMutationReceipt(
  method: string,
  envelope: Record<string, unknown>,
  params: Record<string, unknown>,
): SlackMutationReceipt {
  if (envelope.ok !== true) throw new Error("invalid_slack_receipt");
  const channel = stringField(envelope.channel) ?? stringField(params.channel);
  const ts = stringField(envelope.ts) ?? stringField(params.ts) ?? stringField(params.timestamp);
  if (method === "chat.postMessage" && (!channel || !stringField(envelope.ts))) {
    throw new Error("invalid_slack_message_receipt");
  }
  if (method === "chat.update" && (!channel || !stringField(envelope.ts))) {
    throw new Error("invalid_slack_update_receipt");
  }
  const scheduledMessageId = stringField(envelope.scheduled_message_id);
  if (method === "chat.scheduleMessage" && !scheduledMessageId) {
    throw new Error("invalid_slack_schedule_receipt");
  }
  const channelObject = envelope.channel && typeof envelope.channel === "object"
    ? envelope.channel as Record<string, unknown>
    : null;
  const userGroup = envelope.usergroup && typeof envelope.usergroup === "object"
    ? envelope.usergroup as Record<string, unknown>
    : null;
  const bookmark = envelope.bookmark && typeof envelope.bookmark === "object"
    ? envelope.bookmark as Record<string, unknown>
    : null;
  if (method === "conversations.create" && !stringField(channelObject?.id)) {
    throw new Error("invalid_slack_channel_receipt");
  }
  if (method === "usergroups.create" && !stringField(userGroup?.id)) {
    throw new Error("invalid_slack_usergroup_receipt");
  }
  if (method === "bookmarks.add" && !stringField(bookmark?.id)) {
    throw new Error("invalid_slack_bookmark_receipt");
  }
  return {
    method,
    channelId: channel,
    timestamp: ts,
    scheduledMessageId,
    entityId: stringField(channelObject?.id) ?? stringField(userGroup?.id) ?? stringField(bookmark?.id),
  };
}

export async function executeSlackMutation(
  userId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<SlackMutationReceipt> {
  if (!SLACK_MUTATION_METHODS.has(method)) throw new Error("unsupported_slack_mutation");
  await assertSlackMethodScope(userId, method);
  if (method === "hula.openAndPost") {
    const users = typeof params.users === "string" ? params.users.split(",").filter(Boolean) : [];
    const text = typeof params.text === "string" ? params.text : "";
    if (users.length === 0 || !text) throw new Error("invalid_slack_dm_input");
    const opened = await slackOps.open(userId, users);
    const channel = opened.channel && typeof opened.channel === "object"
      ? opened.channel as Record<string, unknown>
      : null;
    if (!channel || typeof channel.id !== "string") throw new Error("invalid_slack_open_receipt");
    const sent = await slackOps.write(userId, "chat.postMessage", { channel: channel.id, text });
    return validateSlackMutationReceipt("chat.postMessage", sent, { channel: channel.id });
  }
  const envelope = await slackOps.write(userId, method, params);
  return validateSlackMutationReceipt(method, envelope, params);
}
