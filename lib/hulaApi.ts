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

// --- Integrations (Section 10) --------------------------------------------
//
// Typed helpers only — there is NO integrations UI yet. Tokens are never
// exposed by the backend, so none of these ever return credential material.

/** One provider's static catalog metadata (`GET /v1/me/integrations/catalog`). */
export interface IntegrationCatalogEntry {
  provider: string;
  displayName: string;
  category: string;
  status: 'planned' | 'available_stub' | 'available_readonly';
  authType: 'oauth2' | 'api_key' | 'partner' | 'none';
  defaultScopes: string[];
  capabilities: string[];
  notes: string;
}

/** The signed-in user's status for one provider (`GET /v1/me/integrations`). */
export interface IntegrationStatus {
  provider: string;
  displayName: string;
  category: string;
  catalogStatus: 'planned' | 'available_stub' | 'available_readonly';
  authType: 'oauth2' | 'api_key' | 'partner' | 'none';
  connectionStatus: 'disconnected' | 'connected' | 'expired' | 'revoked' | 'error';
  connected: boolean;
  providerAccountEmail: string | null;
  connectedAccountName?: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  grantedCapabilities?: string[];
  missingCapabilities?: string[];
  partial?: boolean;
  configured?: boolean;
}

/** Fetch the provider catalog (static metadata, no user data). */
export async function fetchIntegrationCatalog(
  token: string,
): Promise<IntegrationCatalogEntry[]> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const res = await fetch(`${BASE_URL}/v1/me/integrations/catalog`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`me/integrations/catalog request failed (${res.status})`);
  }

  const data = (await res.json()) as { providers: IntegrationCatalogEntry[] };
  return data.providers;
}

/** Fetch the signed-in user's integration statuses (scoped to them). */
export async function fetchUserIntegrations(
  token: string,
): Promise<IntegrationStatus[]> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const res = await fetch(`${BASE_URL}/v1/me/integrations`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`me/integrations request failed (${res.status})`);
  }

  const data = (await res.json()) as { integrations: IntegrationStatus[] };
  return data.integrations;
}

/** Fetch the signed-in user's status for one provider. */
export async function fetchIntegrationStatus(
  token: string,
  provider: string,
): Promise<IntegrationStatus> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const res = await fetch(`${BASE_URL}/v1/me/integrations/${provider}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`me/integrations/${provider} request failed (${res.status})`);
  }

  const data = (await res.json()) as { integration: IntegrationStatus };
  return data.integration;
}

/**
 * Mark a provider disconnected for the signed-in user. Idempotent — the backend
 * returns `{ ok: true }` even if it was already disconnected.
 */
export async function disconnectIntegration(
  token: string,
  provider: string,
): Promise<{ ok: boolean; changed: boolean }> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const res = await fetch(
    `${BASE_URL}/v1/me/integrations/${provider}/disconnect`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!res.ok) {
    throw new Error(`me/integrations/${provider}/disconnect failed (${res.status})`);
  }

  return (await res.json()) as { ok: boolean; changed: boolean };
}

// --- Microsoft 365 (Section 24 Phase 1) ----------------------------------

export const MICROSOFT_PROVIDER = 'microsoft';

export class MicrosoftNotConfiguredError extends Error {
  constructor() {
    super('Microsoft 365 connect is not configured on the Hula backend yet.');
    this.name = 'MicrosoftNotConfiguredError';
  }
}

export interface MicrosoftConnectResponse {
  provider: string;
  authorizationUrl: string;
  expiresAt: string;
}

/** Start unified Microsoft OAuth. The mobile app never receives Graph tokens. */
export async function connectMicrosoft(
  token: string,
  params: { appReturnUrl?: string } = {},
): Promise<MicrosoftConnectResponse> {
  if (!BASE_URL) throw new MissingApiUrlError();
  const res = await fetch(
    `${BASE_URL}/v1/me/integrations/${MICROSOFT_PROVIDER}/connect`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(
        params.appReturnUrl ? { appReturnUrl: params.appReturnUrl } : {},
      ),
    },
  );
  if (res.status === 400) throw new MicrosoftNotConfiguredError();
  if (!res.ok) throw new Error(`microsoft/connect failed (${res.status})`);
  const data = (await res.json()) as Partial<MicrosoftConnectResponse>;
  if (typeof data.authorizationUrl !== 'string' || !data.authorizationUrl) {
    throw new Error('microsoft/connect returned no authorization URL');
  }
  return data as MicrosoftConnectResponse;
}

export const fetchMicrosoftStatus = (token: string) =>
  fetchIntegrationStatus(token, MICROSOFT_PROVIDER);

export const disconnectMicrosoft = (token: string) =>
  disconnectIntegration(token, MICROSOFT_PROVIDER);

// --- Google Calendar (Section 13) -----------------------------------------
//
// The first real, user-connectable integration. The app only ever handles the
// backend's SAFE status shape and an authorization URL — Google tokens stay
// encrypted server-side and never touch the app.

/** Stable provider slug for Google Calendar (matches the backend catalog). */
export const GOOGLE_CALENDAR_PROVIDER = 'google_calendar';

/**
 * Raised when the backend can't start the Google OAuth flow because its Google
 * OAuth env is not configured (a safe 400, not a crash). Lets the UI show a
 * clear "not available yet" message instead of a generic failure.
 */
export class GoogleCalendarNotConfiguredError extends Error {
  constructor() {
    super('Google Calendar connect is not configured on the Hula backend yet.');
    this.name = 'GoogleCalendarNotConfiguredError';
  }
}

/** Response of `POST /v1/me/integrations/google_calendar/connect`. */
export interface GoogleCalendarConnectResponse {
  provider: string;
  /** The Google consent URL to open in the system browser. */
  authorizationUrl: string;
  /** ISO timestamp after which the pending OAuth state expires. */
  expiresAt: string;
}

/**
 * Start the Google Calendar OAuth flow. Returns ONLY an authorization URL (plus
 * safe metadata) — never a token. The caller opens `authorizationUrl` in the
 * system browser; Google redirects back to the backend callback, which stores
 * the encrypted tokens. The app then re-reads status to learn the result.
 *
 * `appReturnUrl` (optional) is a validated app deep-link the backend uses to
 * bounce the user straight back into Hula after the callback. It's just a return
 * hint — the backend re-validates it and never trusts it for identity.
 */
export async function connectGoogleCalendar(
  token: string,
  params: { appReturnUrl?: string } = {},
): Promise<GoogleCalendarConnectResponse> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const res = await fetch(
    `${BASE_URL}/v1/me/integrations/${GOOGLE_CALENDAR_PROVIDER}/connect`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(
        params.appReturnUrl ? { appReturnUrl: params.appReturnUrl } : {},
      ),
    },
  );

  if (res.status === 400) {
    // Backend returns `{ error: "google_calendar_not_configured" }` here.
    throw new GoogleCalendarNotConfiguredError();
  }
  if (!res.ok) {
    throw new Error(`google_calendar/connect failed (${res.status})`);
  }

  const data = (await res.json()) as Partial<GoogleCalendarConnectResponse>;
  if (typeof data.authorizationUrl !== 'string' || data.authorizationUrl.length === 0) {
    // A malformed/empty response must fail clearly, never silently "succeed".
    throw new Error('google_calendar/connect returned no authorization URL');
  }
  return data as GoogleCalendarConnectResponse;
}

/** The safe Google Calendar read-path diagnostic (booleans + a coded reason). */
export interface GoogleCalendarDiagnostic {
  provider: string;
  connected: boolean;
  credentialPresent: boolean;
  credentialDecryptable: boolean;
  scopeGranted: boolean;
  accessTokenPresent: boolean;
  refreshTokenPresent: boolean;
  nodeFetchAvailable: boolean;
  googleReachable: boolean;
  calendarApiReachable: boolean;
  primaryCalendarAccessible: boolean;
  eventReadAccessible: boolean;
  eventCount: number | null;
  errorStage: string | null;
  errorCode: string | null;
  safeErrorName: string | null;
  safeCauseCode: string | null;
}

/**
 * Fetch the signed-in user's safe Google Calendar diagnostic. Never returns a
 * token or raw provider payload — just booleans and a single coded reason so the
 * connection can be triaged (e.g. `google_calendar_api_disabled`).
 */
export async function fetchGoogleCalendarDiagnostic(
  token: string,
): Promise<GoogleCalendarDiagnostic> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const res = await fetch(
    `${BASE_URL}/v1/me/integrations/${GOOGLE_CALENDAR_PROVIDER}/diagnostic`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    throw new Error(`google_calendar/diagnostic failed (${res.status})`);
  }

  return (await res.json()) as GoogleCalendarDiagnostic;
}

/**
 * Fetch the signed-in user's Google Calendar connection status. Thin wrapper
 * over the generic per-provider status endpoint — the backend is always the
 * source of truth for whether the calendar is actually connected.
 */
export async function fetchGoogleCalendarStatus(
  token: string,
): Promise<IntegrationStatus> {
  return fetchIntegrationStatus(token, GOOGLE_CALENDAR_PROVIDER);
}

/** Disconnect Google Calendar for the signed-in user (idempotent). */
export async function disconnectGoogleCalendar(
  token: string,
): Promise<{ ok: boolean; changed: boolean }> {
  return disconnectIntegration(token, GOOGLE_CALENDAR_PROVIDER);
}

// --- Google Drive (Section 23) -------------------------------------------
// A separate Hula connection that reuses the backend's Google OAuth primitives.
// Tokens remain encrypted server-side; the app receives only safe status and URL data.

export const GOOGLE_DRIVE_PROVIDER = 'google_drive';

export class GoogleDriveNotConfiguredError extends Error {
  constructor() {
    super('Google Drive connect is not configured on the Hula backend yet.');
    this.name = 'GoogleDriveNotConfiguredError';
  }
}

export async function connectGoogleDrive(
  token: string,
  params: { appReturnUrl?: string } = {},
): Promise<{ provider: string; authorizationUrl: string; expiresAt: string }> {
  if (!BASE_URL) throw new MissingApiUrlError();
  const res = await fetch(`${BASE_URL}/v1/me/integrations/${GOOGLE_DRIVE_PROVIDER}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(params.appReturnUrl ? { appReturnUrl: params.appReturnUrl } : {}),
  });
  if (res.status === 400) throw new GoogleDriveNotConfiguredError();
  if (!res.ok) throw new Error(`google_drive/connect failed (${res.status})`);
  const data = await res.json() as {
    provider: string;
    authorizationUrl?: string;
    expiresAt: string;
  };
  if (!data.authorizationUrl) throw new Error('google_drive/connect returned no authorization URL');
  return data as { provider: string; authorizationUrl: string; expiresAt: string };
}

export const fetchGoogleDriveStatus = (token: string) =>
  fetchIntegrationStatus(token, GOOGLE_DRIVE_PROVIDER);
export const disconnectGoogleDrive = (token: string) =>
  disconnectIntegration(token, GOOGLE_DRIVE_PROVIDER);

/** A single safe, normalized calendar event (no raw provider payload). */
export interface GoogleCalendarEvent {
  id: string;
  calendarId: string;
  summary: string | null;
  location: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  status: string | null;
  htmlLink: string | null;
  attendeeCount: number | null;
  organizerEmail: string | null;
  source: string;
}

/** Which window of upcoming events to read (read-only). */
export type GoogleCalendarRange = 'today' | 'tomorrow' | 'week' | 'next';

/** Response of `GET /v1/me/integrations/google_calendar/events`. */
export interface GoogleCalendarEventsResponse {
  provider: string;
  range: GoogleCalendarRange;
  events: GoogleCalendarEvent[];
}

/**
 * Read the user's upcoming Google Calendar events (READ-ONLY). Returns the
 * backend's already-normalized, credential-free events. Present so the app can
 * later preview the calendar; the primary calendar experience is via iMessage.
 */
export async function fetchGoogleCalendarEvents(
  token: string,
  params: { range?: GoogleCalendarRange; limit?: number } = {},
): Promise<GoogleCalendarEventsResponse> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const query = new URLSearchParams();
  if (params.range) query.set('range', params.range);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';

  const res = await fetch(
    `${BASE_URL}/v1/me/integrations/${GOOGLE_CALENDAR_PROVIDER}/events${suffix}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!res.ok) {
    throw new Error(`google_calendar/events request failed (${res.status})`);
  }

  return (await res.json()) as GoogleCalendarEventsResponse;
}

// --- Gmail (Section 14) ----------------------------------------------------
//
// A SEPARATE read-only integration from Google Calendar. The app only ever
// handles the backend's SAFE status shape, an authorization URL, and normalized
// message METADATA — Gmail tokens stay encrypted server-side and never touch the
// app, and there is no send/draft path anywhere.

/** Stable provider slug for Gmail (matches the backend catalog). */
export const GMAIL_PROVIDER = 'gmail';

/**
 * Raised when the backend can't start the Gmail OAuth flow because its Gmail
 * OAuth env is not configured (a safe 400, not a crash).
 */
export class GmailNotConfiguredError extends Error {
  constructor() {
    super('Gmail connect is not configured on the Hula backend yet.');
    this.name = 'GmailNotConfiguredError';
  }
}

/** Response of `POST /v1/me/integrations/gmail/connect`. */
export interface GmailConnectResponse {
  provider: string;
  /** The Google consent URL to open in the system browser. */
  authorizationUrl: string;
  /** ISO timestamp after which the pending OAuth state expires. */
  expiresAt: string;
}

/**
 * Start the Gmail OAuth flow. Returns ONLY an authorization URL (plus safe
 * metadata) — never a token. The caller opens `authorizationUrl` in the system
 * browser; Google redirects back to the backend Gmail callback, which stores the
 * encrypted tokens. The app then re-reads status to learn the result.
 */
export async function connectGmail(
  token: string,
  params: { appReturnUrl?: string } = {},
): Promise<GmailConnectResponse> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const res = await fetch(
    `${BASE_URL}/v1/me/integrations/${GMAIL_PROVIDER}/connect`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(
        params.appReturnUrl ? { appReturnUrl: params.appReturnUrl } : {},
      ),
    },
  );

  if (res.status === 400) {
    // Backend returns `{ error: "gmail_not_configured" }` here.
    throw new GmailNotConfiguredError();
  }
  if (!res.ok) {
    throw new Error(`gmail/connect failed (${res.status})`);
  }

  const data = (await res.json()) as Partial<GmailConnectResponse>;
  if (typeof data.authorizationUrl !== 'string' || data.authorizationUrl.length === 0) {
    throw new Error('gmail/connect returned no authorization URL');
  }
  return data as GmailConnectResponse;
}

/** Fetch the signed-in user's Gmail connection status (backend is the truth). */
export async function fetchGmailStatus(token: string): Promise<IntegrationStatus> {
  return fetchIntegrationStatus(token, GMAIL_PROVIDER);
}

/** Disconnect Gmail for the signed-in user (idempotent). */
export async function disconnectGmail(
  token: string,
): Promise<{ ok: boolean; changed: boolean }> {
  return disconnectIntegration(token, GMAIL_PROVIDER);
}

// --- Todoist (Section 19) ------------------------------------------------
// Same shape as the Google flows: the app only ever receives an authorization
// URL and safe status metadata. Tokens live on the backend and never reach here.

/** The backend Todoist provider slug. */
export const TODOIST_PROVIDER = 'todoist';

/**
 * Raised when the backend can't start the Todoist OAuth flow because its Todoist
 * OAuth env is not configured (a safe 400, not a crash).
 */
export class TodoistNotConfiguredError extends Error {
  constructor() {
    super('Todoist connect is not configured on the Hula backend yet.');
    this.name = 'TodoistNotConfiguredError';
  }
}

/** Response of `POST /v1/me/integrations/todoist/connect`. */
export interface TodoistConnectResponse {
  provider: string;
  /** The Todoist consent URL to open in the system browser. */
  authorizationUrl: string;
  /** ISO timestamp after which the pending OAuth state expires. */
  expiresAt: string;
}

/**
 * Start the Todoist OAuth flow. Returns ONLY an authorization URL (plus safe
 * metadata) — never a token. The caller opens `authorizationUrl` in the system
 * browser; Todoist redirects back to the backend callback, which stores the
 * encrypted tokens. The app then re-reads status to learn the result.
 */
export async function connectTodoist(
  token: string,
  params: { appReturnUrl?: string } = {},
): Promise<TodoistConnectResponse> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const res = await fetch(
    `${BASE_URL}/v1/me/integrations/${TODOIST_PROVIDER}/connect`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(
        params.appReturnUrl ? { appReturnUrl: params.appReturnUrl } : {},
      ),
    },
  );

  if (res.status === 400) {
    // Backend returns `{ error: "todoist_not_configured" }` here.
    throw new TodoistNotConfiguredError();
  }
  if (!res.ok) {
    throw new Error(`todoist/connect failed (${res.status})`);
  }

  const data = (await res.json()) as Partial<TodoistConnectResponse>;
  if (typeof data.authorizationUrl !== 'string' || data.authorizationUrl.length === 0) {
    throw new Error('todoist/connect returned no authorization URL');
  }
  return data as TodoistConnectResponse;
}

/** Fetch the signed-in user's Todoist connection status (backend is the truth). */
export async function fetchTodoistStatus(token: string): Promise<IntegrationStatus> {
  return fetchIntegrationStatus(token, TODOIST_PROVIDER);
}

/** Disconnect Todoist for the signed-in user (idempotent). */
export async function disconnectTodoist(
  token: string,
): Promise<{ ok: boolean; changed: boolean }> {
  return disconnectIntegration(token, TODOIST_PROVIDER);
}

// --- Asana (Section 20) --------------------------------------------------
export const ASANA_PROVIDER = 'asana';
export class AsanaNotConfiguredError extends Error {
  constructor() { super('Asana connect is not configured on the Hula backend yet.'); this.name = 'AsanaNotConfiguredError'; }
}
export async function connectAsana(token:string,params:{appReturnUrl?:string}={}):Promise<{provider:string;authorizationUrl:string;expiresAt:string}>{
  if(!BASE_URL) throw new MissingApiUrlError();
  const res=await fetch(`${BASE_URL}/v1/me/integrations/${ASANA_PROVIDER}/connect`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(params.appReturnUrl?{appReturnUrl:params.appReturnUrl}:{})});
  if(res.status===400)throw new AsanaNotConfiguredError();
  if(!res.ok)throw new Error(`asana/connect failed (${res.status})`);
  const data=await res.json() as {provider:string;authorizationUrl?:string;expiresAt:string};
  if(!data.authorizationUrl)throw new Error('asana/connect returned no authorization URL');
  return data as {provider:string;authorizationUrl:string;expiresAt:string};
}
export const fetchAsanaStatus=(token:string)=>fetchIntegrationStatus(token,ASANA_PROVIDER);
export const disconnectAsana=(token:string)=>disconnectIntegration(token,ASANA_PROVIDER);

// --- Notion (Section 21) ------------------------------------------------
export const NOTION_PROVIDER='notion';
export class NotionNotConfiguredError extends Error {constructor(){super('Notion connect is not configured on the Hula backend yet.');this.name='NotionNotConfiguredError';}}
export async function connectNotion(token:string,params:{appReturnUrl?:string}={}):Promise<{provider:string;authorizationUrl:string;expiresAt:string}>{
  if(!BASE_URL)throw new MissingApiUrlError();const res=await fetch(`${BASE_URL}/v1/me/integrations/${NOTION_PROVIDER}/connect`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(params.appReturnUrl?{appReturnUrl:params.appReturnUrl}:{})});
  if(res.status===400)throw new NotionNotConfiguredError();if(!res.ok)throw new Error(`notion/connect failed (${res.status})`);const data=await res.json() as {provider:string;authorizationUrl?:string;expiresAt:string};if(!data.authorizationUrl)throw new Error('notion/connect returned no authorization URL');return data as {provider:string;authorizationUrl:string;expiresAt:string};
}
export const fetchNotionStatus=(token:string)=>fetchIntegrationStatus(token,NOTION_PROVIDER);
export const disconnectNotion=(token:string)=>disconnectIntegration(token,NOTION_PROVIDER);

// --- Slack (Section 22) -------------------------------------------------
export const SLACK_PROVIDER = 'slack';
export class SlackNotConfiguredError extends Error {
  constructor() {
    super('Slack connect is not configured on the Hula backend yet.');
    this.name = 'SlackNotConfiguredError';
  }
}
export class SlackConnectError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SlackConnectError';
  }
}
export async function connectSlack(
  token: string,
  params: { appReturnUrl?: string } = {},
): Promise<{ provider: string; authorizationUrl: string; expiresAt: string }> {
  if (!BASE_URL) throw new MissingApiUrlError();
  const res = await fetch(`${BASE_URL}/v1/me/integrations/${SLACK_PROVIDER}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(params.appReturnUrl ? { appReturnUrl: params.appReturnUrl } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: unknown };
    const code = typeof body.error === 'string' ? body.error : `http_${res.status}`;
    if (code === 'slack_not_configured') throw new SlackNotConfiguredError();
    throw new SlackConnectError(code);
  }
  const data = await res.json() as {
    provider: string;
    authorizationUrl?: string;
    expiresAt: string;
  };
  if (!data.authorizationUrl) throw new Error('slack/connect returned no authorization URL');
  return data as { provider: string; authorizationUrl: string; expiresAt: string };
}
export const fetchSlackStatus = (token: string) => fetchIntegrationStatus(token, SLACK_PROVIDER);
export const disconnectSlack = (token: string) => disconnectIntegration(token, SLACK_PROVIDER);

/** A single safe, normalized Gmail message (metadata + snippet only, no body). */
export interface GmailMessage {
  id: string;
  threadId: string;
  fromName: string | null;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: string | null;
  unread: boolean;
  important: boolean;
  labels: string[];
  snippet: string | null;
  source: string;
}

/** Response of `GET /v1/me/integrations/gmail/messages`. */
export interface GmailMessagesResponse {
  provider: string;
  messages: GmailMessage[];
}

/**
 * Read the user's recent Gmail inbox messages (READ-ONLY). Returns the backend's
 * already-normalized, credential-free metadata + snippets. The primary Gmail
 * experience is via iMessage; this exists so the app can preview safely.
 */
export async function fetchGmailMessages(
  token: string,
  params: { limit?: number } = {},
): Promise<GmailMessagesResponse> {
  if (!BASE_URL) throw new MissingApiUrlError();

  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';

  const res = await fetch(
    `${BASE_URL}/v1/me/integrations/${GMAIL_PROVIDER}/messages${suffix}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!res.ok) {
    throw new Error(`gmail/messages request failed (${res.status})`);
  }

  return (await res.json()) as GmailMessagesResponse;
}
