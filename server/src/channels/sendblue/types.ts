/**
 * Sendblue provider types.
 *
 * Loosely mirrors Sendblue's documented webhook and outbound payloads. Inbound
 * payloads are treated defensively (most fields optional) because provider
 * shapes drift; the normalizer must never assume a field is present.
 */

/** Whether Sendblue delivered/received over blue iMessage or green SMS. */
export type SendblueMessageService = "iMessage" | "SMS";

/** Delivery status strings Sendblue reports (placeholder subset). */
export type SendblueStatus =
  | "QUEUED"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "ERROR";

/**
 * Shape of an inbound Sendblue webhook payload. Every field is optional: real
 * webhooks vary by event type (inbound message vs. outbound status callback)
 * and by media presence, so the normalizer guards each access.
 */
export interface SendblueInboundWebhook {
  accountEmail?: string;
  content?: string;
  /** Single media URL (Sendblue's common inbound shape). */
  media_url?: string;
  /** Some payloads use a plural/array or nested shapes — accept them loosely. */
  media_urls?: string[];
  media?: unknown;
  attachments?: unknown;
  is_outbound?: boolean;
  status?: SendblueStatus;
  error_code?: number | null;
  error_message?: string | null;
  message_handle?: string;
  /** Sendblue's numeric row id, present on some events. */
  row_id?: number;
  date_sent?: string;
  date_updated?: string;
  /** The end-user's phone number/handle. */
  from_number?: string;
  /** The Hula-owned number that received the message. */
  number?: string;
  to_number?: string;
  was_downgraded?: boolean | null;
  service?: SendblueMessageService;

  // --- Alternative sender/recipient shapes (defensive) ---
  // Provider payloads drift; we accept several field names / nestings so the
  // sender is extracted robustly and never silently defaults to the Hula line.
  from?: string;
  sender?: string;
  phone_number?: string;
  to?: string;
  recipient?: string;
  line?: string;
  contact?: { phone_number?: string } & Record<string, unknown>;
  message?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/** Shape of an outbound Sendblue send request. */
export interface SendblueOutboundRequest {
  /** Recipient handle/number. */
  number: string;
  content?: string;
  media_url?: string;
  send_style?: string;
  status_callback?: string;
  /** Which of our Sendblue numbers to send from (Hula's dedicated line). */
  from_number?: string;
}

/** Shape of a Sendblue outbound send response. */
export interface SendblueOutboundResponse {
  status?: SendblueStatus;
  message_handle?: string;
  error_code?: number | null;
  error_message?: string | null;
}
