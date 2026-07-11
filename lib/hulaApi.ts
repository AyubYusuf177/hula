/**
 * Thin client for the Hula backend.
 *
 * The base URL comes from `EXPO_PUBLIC_HULA_API_URL` (public, non-secret — it is
 * just where the backend is reachable). No secrets ever live in the app; the
 * per-request Clerk session token is passed in by the caller.
 */

import type { ProfileSyncPayload } from './hulaProfileSync';

/** Backend base URL, e.g. an ngrok tunnel during local development. */
const BASE_URL = process.env.EXPO_PUBLIC_HULA_API_URL;

/** Raised when the backend URL isn't configured, so callers can fail clearly. */
export class MissingApiUrlError extends Error {
  constructor() {
    super(
      'EXPO_PUBLIC_HULA_API_URL is not set. Add it to .env and restart Expo with `npx expo start -c`.',
    );
    this.name = 'MissingApiUrlError';
  }
}

export interface LinkSessionResponse {
  /** One-time connect code, e.g. "HULA-8K2Q". */
  code: string;
  /** Hula's iMessage line, e.g. "+16465480761". */
  hulaNumber: string;
  /** Prefilled first message the app opens in Messages. */
  messageBody: string;
}

/**
 * Create a pending link session for the signed-in user. `token` is a Clerk
 * session token from `getToken()`. `firstName` is an optional display hint only
 * — the backend never trusts it for identity.
 */
export async function createLinkSession(
  token: string,
  params: { firstName?: string } = {},
): Promise<LinkSessionResponse> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const res = await fetch(`${BASE_URL}/v1/link-sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(
      params.firstName ? { firstName: params.firstName } : {},
    ),
  });

  if (!res.ok) {
    throw new Error(`link-session request failed (${res.status})`);
  }

  return (await res.json()) as LinkSessionResponse;
}

/** The masked iMessage connection status from `GET /v1/me/messaging-status`. */
export interface ImessageStatus {
  connected: boolean;
  provider: string;
  linkedAt: string | null;
  /** Masked handle (e.g. "+*******0761"), or null when not connected. */
  handleDisplay: string | null;
}

/** Response shape of `GET /v1/me/messaging-status`. */
export interface MessagingStatusResponse {
  imessage: ImessageStatus;
  /** Hula's own line, so a connected user can open the existing thread. */
  hulaNumber: string;
}

/**
 * Fetch whether the signed-in user is already connected to a Hula messaging
 * sender. `token` is a Clerk session token from `getToken()`. Used by "Text
 * hula" to decide between opening the existing thread and starting the one-time
 * connect flow. The backend scopes the result to the authenticated user and
 * masks the handle.
 */
export async function fetchMessagingStatus(
  token: string,
): Promise<MessagingStatusResponse> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const res = await fetch(`${BASE_URL}/v1/me/messaging-status`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`me/messaging-status request failed (${res.status})`);
  }

  return (await res.json()) as MessagingStatusResponse;
}

/** A single stored message as returned by `GET /v1/me/messages`. */
export interface MyMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  channel: string;
  provider: string;
  text: string | null;
  status: string | null;
  conversationId: string | null;
  createdAt: string; // ISO 8601
}

/** Response shape of `GET /v1/me/messages`. */
export interface MyMessagesResponse {
  messages: MyMessage[];
  limit: number;
  order: 'asc' | 'desc';
  defaultLimit: number;
  maxLimit: number;
}

/**
 * Fetch the signed-in user's own recent Hula messages (newest first by default).
 * `token` is a Clerk session token from `getToken()`. Used for inspection/debug;
 * there is no chat UI yet. The backend scopes results to the authenticated user.
 */
export async function fetchMyMessages(
  token: string,
  params: { limit?: number; order?: 'asc' | 'desc' } = {},
): Promise<MyMessagesResponse> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.order) query.set('order', params.order);
  const suffix = query.toString() ? `?${query.toString()}` : '';

  const res = await fetch(`${BASE_URL}/v1/me/messages${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`me/messages request failed (${res.status})`);
  }

  return (await res.json()) as MyMessagesResponse;
}

/** The safe profile the backend stores/returns (all fields optional). */
export interface MyProfile extends ProfileSyncPayload {
  /** ISO timestamp of the last update, or null when no profile exists yet. */
  updatedAt: string | null;
}

/**
 * Silently mirror the signed-in user's safe profile fields to the backend
 * (`PUT /v1/me/profile`). `token` is a Clerk session token from `getToken()`.
 * Best-effort by design: the caller treats any rejection as a no-op. Returns the
 * stored profile so callers can confirm what was persisted.
 */
export async function syncMyProfile(
  token: string,
  payload: ProfileSyncPayload,
): Promise<MyProfile> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const res = await fetch(`${BASE_URL}/v1/me/profile`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`me/profile sync failed (${res.status})`);
  }

  const data = (await res.json()) as { profile: MyProfile };
  return data.profile;
}
