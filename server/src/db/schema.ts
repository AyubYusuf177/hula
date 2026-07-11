/**
 * Database schema DRAFT (types only) — for the not-yet-persisted feature areas.
 *
 * The core messaging models (users, messaging identities, link sessions,
 * conversations, messages, provider events) are now REAL and live in
 * `prisma/schema.prisma` as of Section 4. This file remains a typed design
 * artifact for the tables that are still unimplemented (media, integrations,
 * actions, billing, legal). Reminders are REAL as of Section 9 (see
 * `prisma/schema.prisma`). Nothing here reads or writes a
 * database — use the Prisma client (`db/prisma.ts`) for real persistence.
 */
import type { ActionApproval } from "../actions/types";
import type { Subscription } from "../billing/types";
import type { Conversation, Message } from "../conversations/types";
import type { UserIntegration } from "../integrations/types";
import type { LegalConsent } from "../legal/types";
import type { StoredMedia } from "../media/types";
import type { ReminderView } from "../reminders/types";
import type { LinkSession } from "../users/linkSessions";
import type { LinkedIdentity } from "../users/messagingIdentity";
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
  messaging_identities: LinkedIdentity;
  link_sessions: LinkSession;
  conversations: Conversation;
  messages: Message;
  media: StoredMedia;
  reminders: ReminderView;
  user_integrations: UserIntegration;
  action_approvals: ActionApproval;
  subscriptions: Subscription;
  legal_consents: LegalConsent;
}
