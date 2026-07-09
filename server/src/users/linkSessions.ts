import type { Provider } from "../channels/types";

/**
 * Link session placeholders for the "Text Hula" connect flow.
 *
 * Future flow (NOT implemented in Section 1):
 *   1. User taps "Text Hula" in the app.
 *   2. Backend creates a pending LinkSession with a one-time code.
 *   3. App opens iMessage to the Hula number prefilled with "Connect Hula ABC123".
 *   4. User sends the first inbound message.
 *   5. Sendblue webhook delivers the sender handle.
 *   6. Backend matches the code, links the handle to the Clerk user, and marks
 *      the session linked.
 */
export type LinkSessionStatus = "pending" | "linked" | "expired";

export interface LinkSession {
  id: string;
  clerkUserId: string;
  /** One-time code embedded in the prefilled first message (e.g. "ABC123"). */
  oneTimeCode: string;
  status: LinkSessionStatus;
  /** Provider the user is expected to message through first. */
  provider: Provider;
  /** Set once the inbound message arrives and the handle is captured. */
  linkedSenderHandle?: string;
  createdAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
}

/**
 * Typed placeholder for creating a pending link session. No persistence or code
 * generation yet — the real implementation arrives with the linking section.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createPendingLinkSession(
  _clerkUserId: string,
  _provider: Provider,
): LinkSession {
  throw new Error("createPendingLinkSession not implemented (Section 1)");
}
