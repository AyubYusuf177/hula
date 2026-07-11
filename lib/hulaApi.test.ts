import assert from 'node:assert/strict';

/**
 * Offline tests for the Hula API client's Google Calendar connect call
 * (Section 13). No network: `global.fetch` is stubbed and asserted against. Run
 * with the server's tsx from the repo root:
 *   ./server/node_modules/.bin/tsx lib/hulaApi.test.ts
 *
 * The backend base URL is read from env at import time, so we set it first and
 * import the module dynamically.
 */

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

interface CapturedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Install a fake fetch that records the request and returns a fixed response. */
function stubFetch(response: {
  ok: boolean;
  status: number;
  json: unknown;
}): () => CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  (global as { fetch: unknown }).fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json,
    };
  };
  return () => calls;
}

async function main(): Promise<void> {
  process.env.EXPO_PUBLIC_HULA_API_URL = 'https://hula.test';
  const {
    connectGoogleCalendar,
    GoogleCalendarNotConfiguredError,
    GOOGLE_CALENDAR_PROVIDER,
  } = await import('./hulaApi');

  await check('connect: POSTs to the provider connect endpoint with a Clerk bearer', async () => {
    const getCalls = stubFetch({
      ok: true,
      status: 200,
      json: { provider: GOOGLE_CALENDAR_PROVIDER, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', expiresAt: '2026-07-11T00:10:00Z' },
    });
    const res = await connectGoogleCalendar('clerk-token-abc', { appReturnUrl: 'hulaai://integrations' });
    const [call] = getCalls();
    assert.equal(call.method, 'POST');
    assert.equal(call.url, `https://hula.test/v1/me/integrations/${GOOGLE_CALENDAR_PROVIDER}/connect`);
    assert.equal(call.headers.Authorization, 'Bearer clerk-token-abc');
    assert.deepEqual(call.body, { appReturnUrl: 'hulaai://integrations' });
    assert.equal(res.authorizationUrl, 'https://accounts.google.com/o/oauth2/v2/auth?x=1');
  });

  await check('connect: omits the return URL from the body when not provided', async () => {
    const getCalls = stubFetch({
      ok: true,
      status: 200,
      json: { provider: GOOGLE_CALENDAR_PROVIDER, authorizationUrl: 'https://x', expiresAt: 'z' },
    });
    await connectGoogleCalendar('t');
    assert.deepEqual(getCalls()[0].body, {});
  });

  await check('connect: a 400 maps to GoogleCalendarNotConfiguredError', async () => {
    stubFetch({ ok: false, status: 400, json: { error: 'google_calendar_not_configured' } });
    await assert.rejects(connectGoogleCalendar('t'), GoogleCalendarNotConfiguredError);
  });

  await check('connect: a malformed 200 (no authorizationUrl) throws, never "succeeds"', async () => {
    stubFetch({ ok: true, status: 200, json: { provider: GOOGLE_CALENDAR_PROVIDER } });
    await assert.rejects(connectGoogleCalendar('t'), /no authorization URL/i);
  });

  console.log(`\nAll ${passed} Hula API (Section 13) tests passed.`);
}

main().catch((err) => {
  console.error('Hula API tests failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
