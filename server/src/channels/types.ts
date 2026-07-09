/**
 * Channel-agnostic messaging types.
 *
 * The Hula "brain" must not care whether a message arrived over Sendblue,
 * WhatsApp, Apple Messages for Business, or SMS fallback. Everything below is
 * the provider-neutral shape the rest of the backend works with. Provider
 * adapters (e.g. `channels/sendblue`) are responsible for normalizing their
 * payloads into these types and back.
 */

/** The logical channel a message travels over. */
export type Channel =
  | "imessage"
  | "sms"
  | "rcs"
  | "whatsapp"
  | "apple_business";

/** The concrete provider/vendor that delivered or will deliver the message. */
export type Provider =
  | "sendblue"
  | "whatsapp"
  | "apple_business"
  | "sms_fallback";

/** Kinds of content Hula can receive or send. */
export type MessageContentType =
  | "text"
  | "audio"
  | "image"
  | "file"
  | "location";

/** A single media attachment reference (details live in `media/types`). */
export interface MediaAttachment {
  type: Exclude<MessageContentType, "text" | "location">;
  /** Provider-hosted or Hula-hosted URL. Placeholder for Section 1. */
  url: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Duration in seconds for audio/voice notes. */
  durationSeconds?: number;
  fileName?: string;
}

/** Placeholder location payload (not implemented in Section 1). */
export interface LocationContent {
  latitude: number;
  longitude: number;
  label?: string;
}

/**
 * Internal, provider-neutral message content. A message can carry text and/or
 * attachments and/or a location; consumers should check what is present.
 */
export interface MessageContent {
  type: MessageContentType;
  text?: string;
  attachments?: MediaAttachment[];
  location?: LocationContent;
}

/** Delivery lifecycle of an outbound message. */
export type DeliveryStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "undelivered";

/** Read lifecycle of a message. */
export type ReadStatus = "unread" | "read";

/**
 * A message coming INTO Hula from a user, already normalized from a provider
 * payload into the channel-agnostic shape.
 */
export interface InboundMessage {
  /** Provider-assigned message id (when available). */
  providerMessageId?: string;
  channel: Channel;
  provider: Provider;
  /** Raw provider handle for the sender (phone/email/opaque id). */
  senderHandle: string;
  /** The Hula-side handle/number that received this message. */
  recipientHandle: string;
  content: MessageContent;
  /** Whether the sender appears to be on iMessage (blue) vs SMS/RCS (green). */
  isIMessage?: boolean;
  receivedAt: string; // ISO 8601
}

/**
 * A message going OUT from Hula to a user, in channel-agnostic form. A provider
 * adapter serializes this into the vendor's outbound API shape.
 */
export interface OutboundMessage {
  channel: Channel;
  provider: Provider;
  recipientHandle: string;
  content: MessageContent;
  /** Optional: request typing indicator / mark-as-read behaviors. */
  sendTypingIndicator?: boolean;
  markThreadRead?: boolean;
}

/** Categories of asynchronous events providers push to Hula via webhooks. */
export type ProviderEventType =
  | "inbound_message"
  | "delivery_status"
  | "read_status"
  | "typing_indicator"
  | "unknown";

/**
 * A normalized event emitted by a provider webhook. The `payload` shape depends
 * on `type`; adapters narrow it before handing it to the brain.
 */
export interface ProviderEvent {
  type: ProviderEventType;
  provider: Provider;
  channel: Channel;
  receivedAt: string; // ISO 8601
  inbound?: InboundMessage;
  delivery?: {
    providerMessageId: string;
    status: DeliveryStatus;
  };
  read?: {
    providerMessageId: string;
    status: ReadStatus;
  };
}
