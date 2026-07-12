import assert from 'node:assert/strict';

import type { IntegrationStatus } from './hulaApi';
import {
  deriveHeroProviderIds,
  deriveIntegrationView,
  deriveSheetCopy,
  isStaleResponse,
  mapConnectionState,
  shouldRefetchOnAppState,
  shouldStartRequest,
  statusLabelFor,
} from './integrationStatus';

/**
 * Pure, offline tests for the integration status mapping (Section 13). No React,
 * no network. Run with the server's tsx, e.g. from the repo root:
 *   ./server/node_modules/.bin/tsx lib/integrationStatus.test.ts
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

/** Build a minimal IntegrationStatus for a provider. */
function status(
  provider: string,
  connectionStatus: IntegrationStatus['connectionStatus'],
  extra: Partial<IntegrationStatus> = {},
): IntegrationStatus {
  return {
    provider,
    displayName: provider,
    category: 'calendar',
    catalogStatus: 'available_stub',
    authType: 'oauth2',
    connectionStatus,
    connected: connectionStatus === 'connected',
    providerAccountEmail: null,
    connectedAt: null,
    lastSyncedAt: null,
    ...extra,
  };
}

// --- mapConnectionState --------------------------------------------------

check('map: connected/expired/error pass through; revoked→disconnected', () => {
  assert.equal(mapConnectionState('connected'), 'connected');
  assert.equal(mapConnectionState('expired'), 'expired');
  assert.equal(mapConnectionState('error'), 'error');
  assert.equal(mapConnectionState('revoked'), 'disconnected');
  assert.equal(mapConnectionState('disconnected'), 'disconnected');
});

check('label: every state has an honest human label', () => {
  assert.equal(statusLabelFor('connected'), 'Connected');
  assert.equal(statusLabelFor('disconnected'), 'Not connected');
  assert.equal(statusLabelFor('connecting'), 'Connecting…');
  assert.equal(statusLabelFor('expired'), 'Reconnect needed');
  assert.equal(statusLabelFor('error'), 'Connection error');
});

// --- deriveIntegrationView -----------------------------------------------

check('view: null status is disconnected, not connected', () => {
  const v = deriveIntegrationView(null);
  assert.equal(v.state, 'disconnected');
  assert.equal(v.connected, false);
  assert.equal(v.statusLabel, 'Not connected');
});

check('view: backend connected wins over any transient override', () => {
  const v = deriveIntegrationView(status('google_calendar', 'connected'), {
    connecting: true,
    errored: true,
  });
  assert.equal(v.state, 'connected');
  assert.equal(v.connected, true);
});

check('view: connecting only overrides a disconnected card', () => {
  const v = deriveIntegrationView(status('google_calendar', 'disconnected'), {
    connecting: true,
  });
  assert.equal(v.state, 'connecting');
  // It must NOT claim the backend is connected.
  assert.equal(v.connected, false);
});

check('view: a local error surfaces when not connected', () => {
  const v = deriveIntegrationView(status('google_calendar', 'disconnected'), {
    errored: true,
  });
  assert.equal(v.state, 'error');
  assert.equal(v.connected, false);
});

check('view: exposes a safe account label only', () => {
  const v = deriveIntegrationView(
    status('google_calendar', 'connected', { providerAccountEmail: 'me@example.com' }),
  );
  assert.equal(v.accountLabel, 'me@example.com');
});

check('view: an explicitly disconnected backend status reports disconnected', () => {
  // After a real backend disconnect, GET status returns connectionStatus
  // "disconnected"; the card must reflect that (no lingering connected UI).
  const v = deriveIntegrationView(status('gmail', 'disconnected'));
  assert.equal(v.state, 'disconnected');
  assert.equal(v.connected, false);
  assert.equal(v.statusLabel, 'Not connected');
  assert.equal(v.accountLabel, null);
});

check('view: refreshing from connected → disconnected flips the card back', () => {
  // Models the UI re-reading backend truth after a disconnect: same provider,
  // two successive backend reads, the second wins.
  const before = deriveIntegrationView(
    status('gmail', 'connected', { providerAccountEmail: 'me@example.com' }),
  );
  assert.equal(before.connected, true);
  const after = deriveIntegrationView(status('gmail', 'disconnected'));
  assert.equal(after.connected, false);
  assert.equal(after.state, 'disconnected');
});

// --- deriveHeroProviderIds -----------------------------------------------

check('hero: lists connected providers only', () => {
  const list = [
    status('google_calendar', 'connected'),
    status('gmail', 'disconnected'),
    status('notion', 'expired'),
  ];
  assert.deepEqual(deriveHeroProviderIds(list), ['google_calendar']);
});

check('hero: empty when nothing is connected', () => {
  assert.deepEqual(deriveHeroProviderIds([status('google_calendar', 'disconnected')]), []);
});

// --- deriveSheetCopy ------------------------------------------------------

const COPY = {
  sheetHeading: 'Connect Google Calendar',
  connectedHeading: 'Google Calendar connected',
  sheetBody: 'Connect your Google Calendar…',
  connectedBody: 'Hula can now read your upcoming events…',
};

check('copy: connected sheet says "…connected" and describes what is enabled', () => {
  const v = deriveIntegrationView(status('google_calendar', 'connected'));
  const c = deriveSheetCopy(v, COPY);
  assert.equal(c.heading, 'Google Calendar connected');
  assert.equal(c.body, COPY.connectedBody);
});

check('copy: disconnected sheet says "Connect …"', () => {
  const v = deriveIntegrationView(status('google_calendar', 'disconnected'));
  const c = deriveSheetCopy(v, COPY);
  assert.equal(c.heading, 'Connect Google Calendar');
  assert.equal(c.body, COPY.sheetBody);
});

check('copy: a transient connect error keeps the connect copy (not connected)', () => {
  const v = deriveIntegrationView(status('google_calendar', 'disconnected'), { errored: true });
  const c = deriveSheetCopy(v, COPY);
  assert.equal(c.heading, 'Connect Google Calendar');
});

// --- Status-request coordination -----------------------------------------

check('appstate: only a background/inactive → active transition refetches', () => {
  assert.equal(shouldRefetchOnAppState('background', 'active'), true);
  assert.equal(shouldRefetchOnAppState('inactive', 'active'), true);
  // Already active, or leaving the foreground, must NOT refetch.
  assert.equal(shouldRefetchOnAppState('active', 'active'), false);
  assert.equal(shouldRefetchOnAppState('active', 'background'), false);
  assert.equal(shouldRefetchOnAppState('active', 'inactive'), false);
});

check('stale: a response is stale once a newer request has started', () => {
  assert.equal(isStaleResponse(1, 1), false); // newest
  assert.equal(isStaleResponse(1, 2), true); // superseded
});

check('dedupe: no overlap and no rapid duplicate starts', () => {
  // In-flight → never start another.
  assert.equal(shouldStartRequest({ inFlight: true, lastStartedAt: 0 }, 10_000), false);
  // Idle but within the dedupe window → skip.
  assert.equal(shouldStartRequest({ inFlight: false, lastStartedAt: 9_800 }, 10_000, 400), false);
  // Idle and past the window → proceed.
  assert.equal(shouldStartRequest({ inFlight: false, lastStartedAt: 9_000 }, 10_000, 400), true);
});

console.log(`\nAll ${passed} integration status (Section 13) tests passed.`);
