/**
 * Sendblue provider placeholder types.
 *
 * Section 1: shapes only, loosely mirroring Sendblue's documented webhook and
 * outbound payloads so we can normalize later. NO real API calls, SDK, or
 * webhook handling are implemented here yet. Refine against the real Sendblue
 * docs when the Sendblue section is built.
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

/** Placeholder shape of an inbound Sendblue webhook payload. */
export interface SendblueInboundWebhook {
  accountEmail?: string;
  content?: string;
  media_url?: string;
  is_outbound?: boolean;
  status?: SendblueStatus;
  error_code?: number | null;
  error_message?: string | null;
  message_handle?: string;
  date_sent?: string;
  date_updated?: string;
  /** The end-user's phone number/handle. */
  from_number?: string;
  /** The Hula-owned number that received the message. */
  number?: string;
  to_number?: string;
  was_downgraded?: boolean | null;
  service?: SendblueMessageService;
}

/** Placeholder shape of an outbound Sendblue send request. */
export interface SendblueOutboundRequest {
  number: string;
  content?: string;
  media_url?: string;
  send_style?: string;
  status_callback?: string;
}

/** Placeholder shape of a Sendblue outbound send response. */
export interface SendblueOutboundResponse {
  status?: SendblueStatus;
  message_handle?: string;
  error_code?: number | null;
  error_message?: string | null;
}
