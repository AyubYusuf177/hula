export const SLACK_PROVIDER = "slack";

export type SlackTokenType = "bot" | "user";

export interface SlackCredentials {
  botAccessToken: string;
  botRefreshToken: string | null;
  botExpiresAt: string | null;
  userAccessToken: string | null;
  userRefreshToken: string | null;
  userExpiresAt: string | null;
  teamId: string;
  teamName: string;
  enterpriseId: string | null;
  appId: string;
  botUserId: string;
  botScopes: string[];
  userScopes: string[];
}

export type SlackEntityType =
  | "workspace"
  | "channel"
  | "conversation"
  | "user"
  | "message"
  | "thread"
  | "file"
  | "scheduled_message"
  | "bookmark"
  | "user_group";

export interface SlackEntity {
  type: SlackEntityType;
  id: string;
  label: string;
  workspaceName: string;
  channelId?: string;
  channelName?: string;
  isPrivate?: boolean;
  isMember?: boolean;
  isIm?: boolean;
  isMpim?: boolean;
  ts?: string;
  threadTs?: string;
  userId?: string;
  mentionedUserIds?: string[];
  permalink?: string;
  authoredByHula?: boolean;
  expiresAt: string;
}

export interface SlackUserProfile {
  display_name?: string;
  real_name?: string;
  email?: string;
  status_text?: string;
  status_emoji?: string;
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  profile?: SlackUserProfile;
}

export interface SlackConversation {
  id: string;
  name?: string;
  user?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  topic?: { value?: string };
  purpose?: { value?: string };
}

export interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  files?: Array<{ id?: string; name?: string; title?: string; permalink?: string }>;
}

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  permalink?: string;
  url_private_download?: string;
  user?: string;
  timestamp?: number;
  channels?: string[];
  groups?: string[];
  ims?: string[];
}

export interface SlackScheduledMessage {
  id?: string | number;
  scheduled_message_id?: string;
  channel_id: string;
  post_at: number;
  text?: string;
}
