export type OutlookBodyType = "text" | "html";

export interface OutlookAddress {
  name: string | null;
  address: string;
}

export interface OutlookAttachment {
  id: string;
  name: string;
  contentType: string | null;
  size: number;
  isInline: boolean;
  kind: "file" | "item" | "reference" | "unknown";
}

export interface OutlookMessage {
  id: string;
  conversationId: string | null;
  internetMessageId: string | null;
  parentFolderId: string | null;
  subject: string;
  from: OutlookAddress | null;
  sender: OutlookAddress | null;
  replyTo: OutlookAddress[];
  to: OutlookAddress[];
  cc: OutlookAddress[];
  bcc: OutlookAddress[];
  receivedAt: string | null;
  sentAt: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  isRead: boolean;
  isDraft: boolean;
  importance: "low" | "normal" | "high";
  hasAttachments: boolean;
  preview: string;
  body: string | null;
  bodyType: OutlookBodyType | null;
  attachments: OutlookAttachment[];
}

export interface OutlookFolder {
  id: string;
  displayName: string;
  parentFolderId: string | null;
  childFolderCount: number;
  totalItemCount: number;
  unreadItemCount: number;
  isHidden: boolean;
}

export interface OutlookPage<T> {
  items: T[];
  nextLink: string | null;
  hasMore: boolean;
  fetchedCount: number;
}

export type OutlookWellKnownFolder =
  | "inbox"
  | "drafts"
  | "sentitems"
  | "deleteditems"
  | "archive"
  | "junkemail";

export interface OutlookMessageQuery {
  folder?: OutlookWellKnownFolder | string;
  query?: string;
  sender?: string;
  subject?: string;
  unread?: boolean;
  receivedAfter?: string;
  receivedBefore?: string;
  maxResults?: number;
  maxPages?: number;
}

export type OutlookMailMutation =
  | "create_draft"
  | "create_reply_draft"
  | "create_reply_all_draft"
  | "create_forward_draft"
  | "update_draft"
  | "delete_draft"
  | "mark_read"
  | "mark_unread"
  | "send"
  | "reply"
  | "reply_all"
  | "forward"
  | "send_draft";

export interface OutlookMutationReceipt {
  operation: OutlookMailMutation;
  messageId: string | null;
  draftId: string | null;
  conversationId: string | null;
  verification: "verified" | "accepted";
  isRead?: boolean;
}
