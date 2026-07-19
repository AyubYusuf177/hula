import { getPrisma } from "../../../db/prisma";
import { readCredentialSecrets, storeCredentialSecrets } from "../../credentials";
import { SlackApiError, SlackClient, type SlackClientOptions } from "./client";
import { getSlackOAuthConfig, refreshSlackToken, type SlackOAuthConfig } from "./oauth";
import {
  SLACK_PROVIDER,
  type SlackConversation,
  type SlackCredentials,
  type SlackFile,
  type SlackMessage,
  type SlackScheduledMessage,
  type SlackTokenType,
  type SlackUser,
} from "./types";

export interface SlackRuntimeDeps {
  load?: (userId: string) => Promise<{ connectionId: string; credentials: SlackCredentials }>;
  persist?: (connectionId: string, credentials: SlackCredentials) => Promise<void>;
  refresh?: typeof refreshSlackToken;
  config?: () => SlackOAuthConfig;
  clientOptions?: SlackClientOptions;
  now?: () => Date;
}

function parseCredentials(raw: string | null): SlackCredentials | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SlackCredentials>;
    return typeof parsed.botAccessToken === "string" && typeof parsed.teamId === "string"
      ? parsed as SlackCredentials
      : null;
  } catch {
    return null;
  }
}

export async function loadSlackCredentials(
  userId: string,
): Promise<{ connectionId: string; credentials: SlackCredentials }> {
  const connection = await getPrisma().integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: SLACK_PROVIDER } },
    select: { id: true, status: true },
  });
  if (!connection || connection.status !== "connected") throw new Error("slack_not_connected");
  const encrypted = await readCredentialSecrets(connection.id);
  const credentials = parseCredentials(encrypted?.accessToken ?? null);
  if (!credentials) throw new Error("slack_not_connected");
  return { connectionId: connection.id, credentials };
}

export async function getSlackInstallation(
  userId: string,
): Promise<{ name: string; botUserId: string; botScopes: string[]; userScopes: string[] }> {
  const { credentials } = await loadSlackCredentials(userId);
  return {
    name: credentials.teamName,
    botUserId: credentials.botUserId,
    botScopes: credentials.botScopes,
    userScopes: credentials.userScopes,
  };
}

export async function persistSlackCredentials(
  connectionId: string,
  credentials: SlackCredentials,
): Promise<void> {
  await storeCredentialSecrets(connectionId, {
    accessToken: JSON.stringify(credentials),
    refreshToken: credentials.botRefreshToken,
    accessTokenExpiresAt: credentials.botExpiresAt ? new Date(credentials.botExpiresAt) : null,
    scopes: [...credentials.botScopes, ...credentials.userScopes.map((scope) => `user:${scope}`)],
  });
}

function tokenExpired(expiresAt: string | null, now: Date): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry <= now.getTime() + 30_000;
}

function refreshableError(error: unknown): boolean {
  return error instanceof SlackApiError &&
    new Set(["invalid_auth", "token_expired", "token_revoked"]).has(error.code);
}

export class SlackRuntime {
  private readonly load: NonNullable<SlackRuntimeDeps["load"]>;
  private readonly persist: NonNullable<SlackRuntimeDeps["persist"]>;
  private readonly refresh: NonNullable<SlackRuntimeDeps["refresh"]>;
  private readonly now: () => Date;
  private readonly config: () => SlackOAuthConfig;

  constructor(private readonly deps: SlackRuntimeDeps = {}) {
    this.load = deps.load ?? loadSlackCredentials;
    this.persist = deps.persist ?? persistSlackCredentials;
    this.refresh = deps.refresh ?? refreshSlackToken;
    this.config = deps.config ?? getSlackOAuthConfig;
    this.now = deps.now ?? (() => new Date());
  }

  async request<T extends Record<string, unknown>>(
    userId: string,
    tokenType: SlackTokenType,
    method: string,
    params: Record<string, unknown> = {},
    mutation = false,
    form = false,
  ): Promise<T> {
    const loaded = await this.load(userId);
    let credentials = loaded.credentials;
    if (this.shouldRefresh(credentials, tokenType)) {
      credentials = await this.rotate(loaded.connectionId, credentials, tokenType);
    }
    const token = this.accessToken(credentials, tokenType);
    if (!token) throw new Error(tokenType === "user" ? "slack_search_requires_user_token" : "slack_not_connected");
    const client = new SlackClient(token, this.deps.clientOptions);

    try {
      return await client.call<T>(method, params, {
        mutation,
        retryRateLimit: !mutation,
        form,
      });
    } catch (error) {
      // A mutation may have reached Slack. Never refresh-and-repeat it.
      if (mutation || !refreshableError(error) || !this.refreshToken(credentials, tokenType)) throw error;
      credentials = await this.rotate(loaded.connectionId, credentials, tokenType);
      const retryToken = this.accessToken(credentials, tokenType);
      if (!retryToken) throw error;
      return new SlackClient(retryToken, this.deps.clientOptions).call<T>(method, params, {
        retryRateLimit: true,
        form,
      });
    }
  }

  async paginate<T extends object>(
    userId: string,
    tokenType: SlackTokenType,
    method: string,
    params: Record<string, unknown>,
    limit: number,
    form = false,
  ): Promise<T[]> {
    const loaded = await this.load(userId);
    let credentials = loaded.credentials;
    if (this.shouldRefresh(credentials, tokenType)) {
      credentials = await this.rotate(loaded.connectionId, credentials, tokenType);
    }
    const token = this.accessToken(credentials, tokenType);
    if (!token) throw new Error(tokenType === "user" ? "slack_search_requires_user_token" : "slack_not_connected");
    try {
      return await new SlackClient(token, this.deps.clientOptions).paginate<T>(method, params, limit, 10, { form });
    } catch (error) {
      if (!refreshableError(error) || !this.refreshToken(credentials, tokenType)) throw error;
      credentials = await this.rotate(loaded.connectionId, credentials, tokenType);
      const retryToken = this.accessToken(credentials, tokenType);
      if (!retryToken) throw error;
      return new SlackClient(retryToken, this.deps.clientOptions).paginate<T>(method, params, limit, 10, { form });
    }
  }

  private shouldRefresh(credentials: SlackCredentials, type: SlackTokenType): boolean {
    return Boolean(this.refreshToken(credentials, type)) &&
      tokenExpired(type === "bot" ? credentials.botExpiresAt : credentials.userExpiresAt, this.now());
  }

  private accessToken(credentials: SlackCredentials, type: SlackTokenType): string | null {
    return type === "bot" ? credentials.botAccessToken : credentials.userAccessToken;
  }

  private refreshToken(credentials: SlackCredentials, type: SlackTokenType): string | null {
    return type === "bot" ? credentials.botRefreshToken : credentials.userRefreshToken;
  }

  private async rotate(
    connectionId: string,
    credentials: SlackCredentials,
    type: SlackTokenType,
  ): Promise<SlackCredentials> {
    const currentRefreshToken = this.refreshToken(credentials, type);
    if (!currentRefreshToken) return credentials;
    const rotated = await this.refresh(this.config(), currentRefreshToken, type);
    const next: SlackCredentials = type === "bot"
      ? {
          ...credentials,
          botAccessToken: rotated.accessToken,
          botRefreshToken: rotated.refreshToken,
          botExpiresAt: rotated.expiresAt,
          botScopes: rotated.scopes.length > 0 ? rotated.scopes : credentials.botScopes,
        }
      : {
          ...credentials,
          userAccessToken: rotated.accessToken,
          userRefreshToken: rotated.refreshToken,
          userExpiresAt: rotated.expiresAt,
          userScopes: rotated.scopes.length > 0 ? rotated.scopes : credentials.userScopes,
        };
    // Persist the newly rotated refresh token before any provider retry.
    await this.persist(connectionId, next);
    return next;
  }
}

const runtime = new SlackRuntime();

export interface SlackConversationAccess {
  isPrivate?: boolean;
  isMember?: boolean;
  isIm?: boolean;
  isMpim?: boolean;
}

export async function readSlackConversation<T extends object>(
  activeRuntime: SlackRuntime,
  userId: string,
  method: "conversations.history" | "conversations.replies",
  params: Record<string, unknown>,
  limit: number,
  access: SlackConversationAccess = {},
): Promise<T[]> {
  // Reading must never mutate membership. Public joins are explicit, confirmed
  // operations; private/DM/MPIM boundaries are never crossed automatically.
  if (access.isMember === false) {
    throw new SlackApiError("Slack conversation membership required", "not_in_channel", 200);
  }
  const tokenType: SlackTokenType = method === "conversations.replies" && !access.isIm && !access.isMpim
    ? "user"
    : "bot";
  return activeRuntime.paginate<T>(userId, tokenType, method, params, limit, method === "conversations.replies");
}

export function slackHistoryParams(
  channel: string,
  oldest?: string,
  latest?: string,
): Record<string, unknown> {
  const hasBoundary = Boolean(oldest || latest);
  return {
    channel,
    ...(oldest ? { oldest } : {}),
    ...(latest ? { latest } : {}),
    ...(hasBoundary ? { inclusive: true } : {}),
  };
}

export function slackMembersParams(channel: string): { channel: string } {
  return { channel };
}

export function slackSearchParams(query: string, limit = 20): {
  query: string; count: number; sort: "timestamp"; sort_dir: "desc";
} {
  return {
    query,
    count: Math.min(Math.max(limit, 1), 100),
    sort: "timestamp",
    sort_dir: "desc",
  };
}

export const slackOps = {
  installation: getSlackInstallation,
  identity: (userId: string) => runtime.request(userId, "bot", "auth.test"),
  team: (userId: string) => runtime.request(userId, "bot", "team.info"),
  users: (userId: string, limit = 100) =>
    runtime.paginate<SlackUser>(userId, "bot", "users.list", {}, limit),
  presence: (userId: string, slackUserId: string) =>
    runtime.request(userId, "bot", "users.getPresence", { user: slackUserId }),
  profile: (userId: string, slackUserId: string) =>
    runtime.request(userId, "bot", "users.profile.get", { user: slackUserId }),
  channels: (userId: string, limit = 100) =>
    runtime.paginate<SlackConversation>(userId, "bot", "conversations.list", {
      types: "public_channel,private_channel,im,mpim",
      exclude_archived: false,
    }, limit),
  channelInfo: (userId: string, channel: string) =>
    runtime.request(userId, "bot", "conversations.info", { channel, include_num_members: true }),
  members: (userId: string, channel: string, limit = 100) =>
    runtime.paginate<{ id: string }>(userId, "bot", "conversations.members", slackMembersParams(channel), Math.min(Math.max(limit, 1), 200), true),
  open: (userId: string, users: string[]) =>
    runtime.request(userId, "bot", "conversations.open", { users: users.join(",") }, true),
  history: (userId: string, channel: string, limit = 10, oldest?: string, latest?: string, access?: SlackConversationAccess) =>
    readSlackConversation<SlackMessage>(
      runtime,
      userId,
      "conversations.history",
      slackHistoryParams(channel, oldest, latest),
      limit,
      access,
    ),
  replies: (userId: string, channel: string, ts: string, limit = 30, access?: SlackConversationAccess) =>
    readSlackConversation<SlackMessage>(runtime, userId, "conversations.replies", { channel, ts }, limit, access),
  permalink: (userId: string, channel: string, ts: string) =>
    runtime.request(userId, "bot", "chat.getPermalink", { channel, message_ts: ts }),
  search: (userId: string, query: string, limit = 20) =>
    runtime.request(userId, "user", "search.all", slackSearchParams(query, limit), false, true),
  files: (userId: string, limit = 20, channel?: string, user?: string) =>
    runtime.request<{ ok: true; files: SlackFile[] }>(userId, "bot", "files.list", {
      count: Math.min(Math.max(limit, 1), 100),
      ...(channel ? { channel } : {}),
      ...(user ? { user } : {}),
    }),
  fileInfo: (userId: string, file: string) =>
    runtime.request(userId, "bot", "files.info", { file }),
  reactions: (userId: string, channel: string, ts: string) =>
    runtime.request(userId, "bot", "reactions.get", { channel, timestamp: ts }),
  pins: (userId: string, channel: string) =>
    runtime.request(userId, "bot", "pins.list", { channel }),
  bookmarks: (userId: string, channel: string) =>
    runtime.request(userId, "bot", "bookmarks.list", { channel_id: channel }),
  userGroups: (userId: string) =>
    runtime.request(userId, "bot", "usergroups.list", { include_users: true }),
  emoji: (userId: string) => runtime.request(userId, "bot", "emoji.list"),
  scheduled: (userId: string, channel?: string) =>
    runtime.request<{ ok: true; scheduled_messages: SlackScheduledMessage[] }>(
      userId,
      "bot",
      "chat.scheduledMessages.list",
      channel ? { channel } : {},
    ),
  write: (userId: string, method: string, input: Record<string, unknown>) =>
    runtime.request(userId, "bot", method, input, true),
  upload: async (
    userId: string,
    file: Uint8Array,
    filename: string,
    channel?: string,
    threadTs?: string,
  ) => {
    const upload = await runtime.request<{ ok: true; upload_url: string; file_id: string }>(
      userId,
      "bot",
      "files.getUploadURLExternal",
      { filename, length: file.byteLength },
    );
    const response = await fetch(upload.upload_url, {
      method: "POST",
      body: Buffer.from(file),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new SlackApiError("Slack file transfer failed", "upload_failed", response.status, undefined, true);
    return runtime.request(userId, "bot", "files.completeUploadExternal", {
      files: [{ id: upload.file_id, title: filename }],
      ...(channel ? { channel_id: channel } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }, true);
  },
};
