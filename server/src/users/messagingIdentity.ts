import { digitsOf } from "../channels/sendblue/normalize";
import type { Channel, Provider } from "../channels/types";
import { getPrisma } from "../db/prisma";
import { getOrCreateUserByClerkId } from "./store";

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

/** Provider assumed for the messaging status when nothing is linked yet. */
const DEFAULT_STATUS_PROVIDER: Provider = "sendblue";

/**
 * A user's active identity in a form the reminder worker can actually send to.
 * Unlike `getImessageStatusForUser`, this returns the UNMASKED handle because it
 * is used internally to deliver a proactive message — it is never exposed to the
 * app or logged in full.
 */
export interface SendableIdentity {
  /** Raw handle to send to (e.g. "+16465480761"). */
  handle: string;
  channel: Channel;
  provider: Provider;
}

/**
 * Resolve the most recently linked ACTIVE identity for an internal user id in a
 * sendable form, or `null` when none exists. Used by the reminder worker to
 * deliver proactive iMessages.
 */
export async function getSendableIdentityForUser(
  userId: string,
): Promise<SendableIdentity | null> {
  const identity = await getPrisma().messagingIdentity.findFirst({
    where: { userId, status: "active" },
    orderBy: { linkedAt: "desc" },
    select: {
      channel: true,
      provider: true,
      handleDisplay: true,
      handleNormalized: true,
    },
  });
  if (!identity) return null;
  const handle = identity.handleDisplay ?? identity.handleNormalized;
  if (!handle) return null;
  return {
    handle,
    channel: (identity.channel as Channel) || "imessage",
    provider: (identity.provider as Provider) || DEFAULT_STATUS_PROVIDER,
  };
}

/**
 * Pure: mask a sender handle for display so the app never receives the full
 * phone number or email. Phones keep only their last four digits (e.g.
 * "+16465480761" → "+*******0761"); emails keep only the first character of the
 * local part (e.g. "me@example.com" → "m***@example.com"). No I/O — unit-testable.
 */
export function maskHandle(handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) return "";
  if (trimmed.includes("@")) {
    const atIndex = trimmed.indexOf("@");
    const local = trimmed.slice(0, atIndex);
    const domain = trimmed.slice(atIndex + 1);
    const head = local.slice(0, 1);
    return `${head}***@${domain}`;
  }
  const digits = digitsOf(trimmed);
  if (digits.length === 0) return "***";
  const visible = digits.slice(-4);
  const stars = "*".repeat(Math.max(0, digits.length - visible.length));
  const prefix = trimmed.startsWith("+") ? "+" : "";
  return `${prefix}${stars}${visible}`;
}

/**
 * The safe, masked connection status the app reads to decide the "Text hula"
 * behaviour. Never exposes the full handle, other users' identities, or secrets.
 */
export interface ImessageStatusView {
  connected: boolean;
  provider: string;
  linkedAt: string | null;
  /** Masked handle (e.g. "+*******0761"), or null when not connected. */
  handleDisplay: string | null;
}

/**
 * Read the connection status for an internal Hula user id. Returns the most
 * recently linked ACTIVE identity (masked), or a not-connected view when none
 * exists. Scoped to the given user only.
 */
export async function getImessageStatusForUser(
  userId: string,
): Promise<ImessageStatusView> {
  const identity = await getPrisma().messagingIdentity.findFirst({
    where: { userId, status: "active" },
    orderBy: { linkedAt: "desc" },
    select: {
      provider: true,
      handleDisplay: true,
      handleNormalized: true,
      linkedAt: true,
    },
  });

  if (!identity) {
    return {
      connected: false,
      provider: DEFAULT_STATUS_PROVIDER,
      linkedAt: null,
      handleDisplay: null,
    };
  }

  const raw = identity.handleDisplay ?? identity.handleNormalized;
  return {
    connected: true,
    provider: identity.provider || DEFAULT_STATUS_PROVIDER,
    linkedAt: identity.linkedAt.toISOString(),
    handleDisplay: raw ? maskHandle(raw) : null,
  };
}

/**
 * Resolve (or create) the Hula user for a Clerk id, then read their masked
 * messaging status. Used by `GET /v1/me/messaging-status`.
 */
export async function getMessagingStatus(
  clerkUserId: string,
): Promise<ImessageStatusView> {
  const user = await getOrCreateUserByClerkId(clerkUserId);
  return getImessageStatusForUser(user.id);
}
