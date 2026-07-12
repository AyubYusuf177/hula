import assert from 'node:assert/strict';

import { deriveIntegrationView } from './integrationStatus';
import type { IntegrationStatus } from './hulaApi';
import {
  clearMemoryStatuses,
  getIntegrationStatusCacheKey,
  getMemoryStatuses,
  markProviderDisconnected,
  sanitizeCachedStatuses,
  setMemoryStatuses,
} from './integrationStatusCache';

/**
 * Pure, offline tests for the user-scoped integration status cache (Integrations
 * V2). No React, no AsyncStorage, no network. Run with the server's tsx:
 *   ./server/node_modules/.bin/tsx lib/integrationStatusCache.test.ts
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  clearMemoryStatuses(); // isolate the shared in-memory singleton per test
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function status(
  provider: string,
  connectionStatus: IntegrationStatus['connectionStatus'],
  extra: Partial<IntegrationStatus> = {},
): IntegrationStatus {
  return {
    provider,
    displayName: provider,
    category: 'calendar',
    catalogStatus: 'available_readonly',
    authType: 'oauth2',
    connectionStatus,
    connected: connectionStatus === 'connected',
    providerAccountEmail: null,
    connectedAt: null,
    lastSyncedAt: null,
    ...extra,
  };
}

const USER_A = 'user_A';
const USER_B = 'user_B';

// --- cache key ------------------------------------------------------------

check('key: is versioned and user-scoped', () => {
  assert.equal(getIntegrationStatusCacheKey('abc'), 'integration_status_v1:abc');
});

// --- cache-first render ---------------------------------------------------

check('cache: a connected status renders connected immediately', () => {
  setMemoryStatuses(USER_A, [
    status('gmail', 'connected', { providerAccountEmail: 'me@example.com' }),
  ]);
  const cached = getMemoryStatuses(USER_A);
  assert.ok(cached, 'memory should be available synchronously');
  const view = deriveIntegrationView(cached![0]);
  assert.equal(view.connected, true);
  assert.equal(view.accountLabel, 'me@example.com');
});

check('cache: a disconnected status renders disconnected immediately', () => {
  setMemoryStatuses(USER_A, [status('gmail', 'disconnected')]);
  const cached = getMemoryStatuses(USER_A);
  const view = deriveIntegrationView(cached![0]);
  assert.equal(view.connected, false);
  assert.equal(view.state, 'disconnected');
});

// --- background refresh ---------------------------------------------------

check('refresh: a successful read replaces stale cache', () => {
  setMemoryStatuses(USER_A, [status('gmail', 'disconnected')]);
  // Simulate the background refresh landing with newer truth.
  setMemoryStatuses(USER_A, [status('gmail', 'connected')]);
  assert.equal(getMemoryStatuses(USER_A)![0].connected, true);
});

check('refresh: a failure preserves the cached state (no clobber)', () => {
  const cached = [status('gmail', 'connected')];
  setMemoryStatuses(USER_A, cached);
  // A failed refresh performs NO setMemoryStatuses — the cache is untouched.
  assert.deepEqual(getMemoryStatuses(USER_A), cached);
});

// --- per-user isolation ---------------------------------------------------

check('scope: one user never sees another user’s cached status', () => {
  setMemoryStatuses(USER_A, [status('gmail', 'connected')]);
  assert.equal(getMemoryStatuses(USER_B), null);
  assert.equal(getMemoryStatuses(null), null);
  assert.equal(getMemoryStatuses(undefined), null);
});

check('scope: setting for a missing user id is a no-op', () => {
  setMemoryStatuses(null, [status('gmail', 'connected')]);
  assert.equal(getMemoryStatuses(USER_A), null);
});

// --- first-ever load ------------------------------------------------------

check('first load: no memory + no valid cache → nothing to render (skeleton)', () => {
  assert.equal(getMemoryStatuses(USER_A), null);
  assert.equal(sanitizeCachedStatuses(null), null);
  assert.equal(sanitizeCachedStatuses(undefined), null);
});

// --- sanitize -------------------------------------------------------------

check('sanitize: malformed data is ignored safely', () => {
  assert.equal(sanitizeCachedStatuses('nonsense'), null);
  assert.equal(sanitizeCachedStatuses({}), null);
  assert.equal(sanitizeCachedStatuses([{ nope: true }]), null);
});

check('sanitize: a legit empty list stays empty; valid entries pass through', () => {
  assert.deepEqual(sanitizeCachedStatuses([]), []);
  const clean = sanitizeCachedStatuses([status('gmail', 'connected')]);
  assert.equal(clean?.length, 1);
  assert.equal(clean?.[0].provider, 'gmail');
});

// --- optimistic disconnect ------------------------------------------------

check('disconnect: flips only the selected provider', () => {
  const list = [
    status('gmail', 'connected', { providerAccountEmail: 'me@example.com' }),
    status('google_calendar', 'connected'),
  ];
  const next = markProviderDisconnected(list, 'gmail');

  const gmail = next.find((s) => s.provider === 'gmail')!;
  assert.equal(gmail.connected, false);
  assert.equal(gmail.connectionStatus, 'disconnected');
  assert.equal(gmail.providerAccountEmail, null);

  const cal = next.find((s) => s.provider === 'google_calendar')!;
  assert.equal(cal.connected, true, 'the other provider must be untouched');
  // The input list is not mutated.
  assert.equal(list[0].connected, true);
});

// --- reconnect ------------------------------------------------------------

check('reconnect: a refresh persists the new connected state', () => {
  // Post-disconnect cache…
  setMemoryStatuses(USER_A, [status('gmail', 'disconnected')]);
  // …then a reconnect + refresh lands connected truth.
  setMemoryStatuses(USER_A, [
    status('gmail', 'connected', { providerAccountEmail: 'me@example.com' }),
  ]);
  const view = deriveIntegrationView(getMemoryStatuses(USER_A)![0]);
  assert.equal(view.connected, true);
  assert.equal(view.accountLabel, 'me@example.com');
});

console.log(`\nAll ${passed} integration status cache (Integrations V2) tests passed.`);
