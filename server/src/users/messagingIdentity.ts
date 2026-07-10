import { digitsOf } from "../channels/sendblue/normalize";
import type { Channel, Provider } from "../channels/types";
import { getPrisma } from "../db/prisma";

/**
 * A messaging identity ties a provider-specific sender handle (phone number or
 * email) to a Hula user. Once linked via the connect-code flow, future inbound
 * messages from that handle are recognized as belonging to the user.
 *
 * Section 4: DATABASE-BACKED via Prisma. Links now survive a backend restart.
 * `normalizeHandleKey` stays pure (no database) so callers and tests can key on
 * a handle without a live connection.
 */
export interface LinkedIdentity {
  /** Internal Hula user id the handle is linked to. */
  userId: string;
  /** The raw sender handle as first seen from the provider. */
  handle: string;
  provider: Provider;
  channel: Channel;
  linkedAt: Date;
}

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

/** Look up the active identity linked to a sender handle, if any. */
export async function getLinkedIdentity(
  handle: string,
): Promise<LinkedIdentity | undefined> {
  const identity = await getPrisma().messagingIdentity.findUnique({
    where: { handleNormalized: normalizeHandleKey(handle) },
    select: {
      userId: true,
      handleDisplay: true,
      handleNormalized: true,
      provider: true,
      channel: true,
      status: true,
      linkedAt: true,
    },
  });
  if (!identity) return undefined;
  if (identity.status !== "active") return undefined;
  return {
    userId: identity.userId,
    handle: identity.handleDisplay ?? identity.handleNormalized,
    provider: identity.provider as Provider,
    channel: identity.channel as Channel,
    linkedAt: identity.linkedAt,
  };
}

/**
 * Link a sender handle to a Hula user. Uses an upsert keyed on the normalized
 * handle — callers are responsible for the "already linked to a different user"
 * guard before calling this.
 */
export async function linkIdentity(params: {
  handle: string;
  userId: string;
  provider: Provider;
  channel: Channel;
}): Promise<LinkedIdentity> {
  const handleNormalized = normalizeHandleKey(params.handle);
  const now = new Date();

  const identity = await getPrisma().messagingIdentity.upsert({
    where: { handleNormalized },
    create: {
      userId: params.userId,
      channel: params.channel,
      provider: params.provider,
      handleNormalized,
      handleDisplay: params.handle,
      status: "active",
      linkedAt: now,
    },
    update: {
      userId: params.userId,
      channel: params.channel,
      provider: params.provider,
      handleDisplay: params.handle,
      status: "active",
      linkedAt: now,
    },
    select: { userId: true, handleDisplay: true, linkedAt: true },
  });

  return {
    userId: identity.userId,
    handle: identity.handleDisplay ?? params.handle,
    provider: params.provider,
    channel: params.channel,
    linkedAt: identity.linkedAt,
  };
}
