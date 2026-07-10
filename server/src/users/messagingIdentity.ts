import { digitsOf } from "../channels/sendblue/normalize";
import type { Channel, Provider } from "../channels/types";

/**
 * A messaging identity ties a provider-specific sender handle (phone number or
 * email) to a Clerk user. Once linked via the connect-code flow, future inbound
 * messages from that handle are recognized as belonging to the user.
 *
 * Section 3: IN-MEMORY ONLY. Survives only for the process lifetime. Moves to
 * Postgres in Section 4. Do not add a database here.
 */
export interface MessagingIdentity {
  clerkUserId: string;
  /** The raw sender handle as first seen from the provider. */
  handle: string;
  provider: Provider;
  channel: Channel;
  linkedAt: number; // epoch ms
}

/** In-memory store keyed by a normalized form of the handle. */
const identitiesByKey = new Map<string, MessagingIdentity>();

/**
 * Normalize a handle into a stable lookup key: bare digits for phone numbers,
 * lowercased for emails / opaque handles. Keeps "+1 (646) 548-0761" and
 * "+16465480761" pointing at the same identity.
 */
export function normalizeHandleKey(handle: string): string {
  const trimmed = handle.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = digitsOf(trimmed);
  return digits.length > 0 ? digits : trimmed.toLowerCase();
}

/** Look up the identity linked to a sender handle, if any. */
export function getLinkedIdentity(
  handle: string,
): MessagingIdentity | undefined {
  return identitiesByKey.get(normalizeHandleKey(handle));
}

/**
 * Link a sender handle to a Clerk user. Overwrites any existing entry for the
 * same handle key — callers are responsible for the "already linked to a
 * different user" guard before calling this.
 */
export function linkIdentity(params: {
  handle: string;
  clerkUserId: string;
  provider: Provider;
  channel: Channel;
}): MessagingIdentity {
  const identity: MessagingIdentity = {
    clerkUserId: params.clerkUserId,
    handle: params.handle,
    provider: params.provider,
    channel: params.channel,
    linkedAt: Date.now(),
  };
  identitiesByKey.set(normalizeHandleKey(params.handle), identity);
  return identity;
}

/** Test/util only: clear all linked identities. */
export function _resetIdentities(): void {
  identitiesByKey.clear();
}
