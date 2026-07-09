import type { Channel, Provider } from "../channels/types";

/**
 * A messaging identity ties a provider-specific sender handle (phone number,
 * email, or opaque provider id) to a Hula user. One user may have several
 * identities (e.g. iMessage + SMS fallback for the same number).
 *
 * Section 1: type only. No lookup/storage implemented.
 */
export interface MessagingIdentity {
  id: string;
  clerkUserId: string;
  provider: Provider;
  channel: Channel;
  /** The raw sender handle as seen by the provider. */
  handle: string;
  /** True once verified via the link-session flow. */
  verified: boolean;
  createdAt: string; // ISO 8601
}
