/**
 * Database schema DRAFT (types only).
 *
 * Section 1: NO real database is connected. This file documents the intended
 * persistence model as a typed draft so we agree on shapes before choosing an
 * ORM/driver later (Prisma/Drizzle/etc.). Each entity type already lives in its
 * feature folder; here we collect them into one schema view plus a table-name
 * registry.
 */
import type { ActionApproval } from "../actions/types";
import type { Subscription } from "../billing/types";
import type { Conversation, Message } from "../conversations/types";
import type { UserIntegration } from "../integrations/types";
import type { LegalConsent } from "../legal/types";
import type { StoredMedia } from "../media/types";
import type { Reminder } from "../reminders/types";
import type { LinkSession } from "../users/linkSessions";
import type { MessagingIdentity } from "../users/messagingIdentity";
import type { UserProfile } from "../users/types";

/** Logical tables the backend will eventually persist. */
export const TABLES = {
  users: "users",
  messagingIdentities: "messaging_identities",
  linkSessions: "link_sessions",
  conversations: "conversations",
  messages: "messages",
  media: "media",
  reminders: "reminders",
  userIntegrations: "user_integrations",
  actionApprovals: "action_approvals",
  subscriptions: "subscriptions",
  legalConsents: "legal_consents",
} as const;

export type TableName = (typeof TABLES)[keyof typeof TABLES];

/**
 * The full schema draft as a type map. This is a design artifact only — nothing
 * reads or writes these tables in Section 1.
 */
export interface DatabaseSchema {
  users: UserProfile;
  messaging_identities: MessagingIdentity;
  link_sessions: LinkSession;
  conversations: Conversation;
  messages: Message;
  media: StoredMedia;
  reminders: Reminder;
  user_integrations: UserIntegration;
  action_approvals: ActionApproval;
  subscriptions: Subscription;
  legal_consents: LegalConsent;
}
