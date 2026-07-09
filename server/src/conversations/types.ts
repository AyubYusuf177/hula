import type {
  Channel,
  DeliveryStatus,
  MessageContent,
  Provider,
  ReadStatus,
} from "../channels/types";

/**
 * A Conversation is the durable thread between a Hula user and the agent over a
 * given channel/provider. Messages are the individual turns within it.
 */
export type MessageDirection = "inbound" | "outbound";

export interface Message {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  content: MessageContent;
  /** Provider-assigned id, when known. */
  providerMessageId?: string;
  deliveryStatus?: DeliveryStatus;
  readStatus?: ReadStatus;
  createdAt: string; // ISO 8601
}

export interface Conversation {
  id: string;
  clerkUserId: string;
  channel: Channel;
  provider: Provider;
  /** The user's messaging handle for this conversation. */
  userHandle: string;
  lastMessageAt?: string; // ISO 8601
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
