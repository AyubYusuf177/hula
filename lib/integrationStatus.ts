/**
 * Pure mapping between the backend's integration status and the small view model
 * the Integrations UI renders (Section 13).
 *
 * Kept free of React / network so it's trivially testable and reusable across
 * every future integration card. The backend is always the source of truth for
 * whether a provider is actually connected — nothing here infers "connected"
 * from a UI action like opening the browser.
 */

import type { IntegrationStatus } from './hulaApi';

/**
 * The states an integration card can show. `connecting` is a UI-only, transient
 * state the screen sets while the OAuth browser is open; it never comes from the
 * backend.
 */
export type IntegrationUiState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'expired'
  | 'error';

/** The safe, display-ready view of one integration. Never carries a token. */
export interface IntegrationView {
  state: IntegrationUiState;
  connected: boolean;
  /** Short status line, e.g. "Not connected" / "Connected". */
  statusLabel: string;
  /** Safe account label (e.g. the account email), or null. */
  accountLabel: string | null;
}

/** Map the backend connection status to a UI state. */
export function mapConnectionState(
  connectionStatus: IntegrationStatus['connectionStatus'],
): IntegrationUiState {
  switch (connectionStatus) {
    case 'connected':
      return 'connected';
    case 'expired':
      return 'expired';
    case 'error':
      return 'error';
    // `revoked` and anything else read as simply not connected.
    case 'revoked':
    case 'disconnected':
    default:
      return 'disconnected';
  }
}

/** Human-readable status line for a given UI state. */
export function statusLabelFor(state: IntegrationUiState): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'expired':
      return 'Reconnect needed';
    case 'error':
      return 'Connection error';
    case 'disconnected':
    default:
      return 'Not connected';
  }
}

/**
 * Build the view model for one integration. `status` is the backend truth (or
 * null before it loads). Optional overrides let the screen surface transient UI
 * states without lying about the backend:
 *  - `connecting`: OAuth browser is open (only meaningful while disconnected)
 *  - `errored`: the last connect/refresh call failed locally
 */
export function deriveIntegrationView(
  status: IntegrationStatus | null,
  overrides: { connecting?: boolean; errored?: boolean } = {},
): IntegrationView {
  const backendState = status ? mapConnectionState(status.connectionStatus) : 'disconnected';

  let state: IntegrationUiState = backendState;
  // A transient connect attempt only overrides a not-yet-connected card, and
  // never masks a real backend error/expired signal.
  if (overrides.connecting && backendState === 'disconnected') {
    state = 'connecting';
  } else if (overrides.errored && backendState !== 'connected') {
    state = 'error';
  }

  return {
    state,
    connected: backendState === 'connected',
    statusLabel: statusLabelFor(state),
    accountLabel: status?.providerAccountEmail ?? null,
  };
}

/**
 * The provider ids that should appear in the hero orbit: connected ones only.
 * Driven entirely by backend data so the hero keeps working as more
 * integrations connect, with no per-provider animation logic.
 */
export function deriveHeroProviderIds(statuses: IntegrationStatus[]): string[] {
  return statuses.filter((s) => s.connected).map((s) => s.provider);
}

// --- Details-sheet copy ---------------------------------------------------

/** The heading/body copy variants a provider supplies for both states. */
export interface SheetCopySource {
  sheetHeading: string;
  connectedHeading: string;
  sheetBody: string;
  connectedBody: string;
}

/**
 * PURE: pick the honest heading/body for the details sheet. A CONNECTED provider
 * shows "…connected" copy describing what's enabled; otherwise the connect copy.
 * Connected truth comes only from the backend-derived `view`, never a UI action.
 */
export function deriveSheetCopy(
  view: IntegrationView,
  copy: SheetCopySource,
): { heading: string; body: string } {
  if (view.connected) {
    return { heading: copy.connectedHeading, body: copy.connectedBody };
  }
  return { heading: copy.sheetHeading, body: copy.sheetBody };
}

// --- Status-request coordination (pure, testable) -------------------------
//
// These small helpers exist so the Integrations screen can fetch status exactly
// when it should — on focus, on a real background→active transition, after OAuth,
// and on manual refresh — WITHOUT a polling loop or duplicate/overlapping/stale
// requests. Kept pure so the decisions are unit-tested without React.

/** A React Native AppState-like value. */
export type AppStateValue = 'active' | 'background' | 'inactive' | (string & {});

/**
 * True only for a real transition INTO the foreground (background/inactive →
 * active). Returns false when the app is merely already active, so repeated
 * "active" change events never trigger repeated status fetches.
 */
export function shouldRefetchOnAppState(
  prev: AppStateValue,
  next: AppStateValue,
): boolean {
  return next === 'active' && prev !== 'active';
}

/** True when a newer request has since started — this response should be ignored. */
export function isStaleResponse(requestId: number, latestRequestId: number): boolean {
  return requestId !== latestRequestId;
}

/**
 * In-flight de-duplication: start a new request only when none is running and the
 * last one didn't start within `dedupeMs`. Returns whether to proceed; used with
 * a ref holding `{ inFlight, lastStartedAt }`.
 */
export function shouldStartRequest(
  state: { inFlight: boolean; lastStartedAt: number },
  now: number,
  dedupeMs = 400,
): boolean {
  if (state.inFlight) return false;
  return now - state.lastStartedAt >= dedupeMs;
}
