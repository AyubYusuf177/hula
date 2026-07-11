Read AGENTS.md first and follow it strictly.

We are on the development branch.

Continue Section 13. Do not commit or push.

Do not change OAuth scopes.
Do not disconnect or reconnect Google Calendar.
Do not change the integration UI except where needed to expose safe diagnostics.
Do not add write actions.
Do not add other providers.
Do not open, print, cat, grep, or expose server/.env.
Do not print access tokens, refresh tokens, Authorization headers, Clerk tokens, client secrets, database URLs, encrypted credentials, or encryption keys.

Confirmed real-device state:

- Google OAuth completes successfully.
- Google Calendar connection is stored as Connected.
- Prisma migration for appReturnUrl was applied successfully.
- Database schema is current.
- Google Calendar API is enabled.
- Calendar scopes were granted.
- The real iMessage request “What’s on my calendar today?” fails.
- Safe backend logs show:

googleCalendar.provider error
provider: google_calendar
operation: GET /calendars/primary/events
httpStatus: null
errorCode: network_failure

- Because httpStatus is null, the failure occurs before Google returns an HTTP response.
- Existing fake tests pass, but the real provider request still fails.
- Do not claim the integration is fixed based only on mocked tests.

Goal:

Find and fix the exact runtime exception causing the real Google Calendar request to be classified as network_failure.

Inspect carefully:

- server/src/integrations/providers/googleCalendar/client.ts
- server/src/integrations/providers/googleCalendar/events.ts
- server/src/integrations/providers/googleCalendar/diagnostic.ts
- server/src/integrations/credentials.ts
- server/src/integrations/tokenVault.ts
- server/src/integrations/connections.ts
- server/src/routes/googleCalendar.ts
- server/src/routes/webhooks.ts
- any shared fetch/HTTP helpers
- Node/TypeScript runtime configuration

1. Add safe development exception diagnostics.

When fetch throws before an HTTP response, log only:

- provider
- operation
- errorName
- errorMessage
- safeCauseCode
- safeCauseMessage
- requestHost
- requestPath
- mappedErrorCode
- connectionId

Never log:

- query values containing sensitive data
- Authorization headers
- access token
- refresh token
- encrypted credential
- Google raw token response
- Clerk token
- client secret

The next real run must reveal the actual exception class and safe cause rather than only network_failure.

2. Inspect URL construction.

The Google Calendar request must use a valid absolute URL equivalent to:

https://www.googleapis.com/calendar/v3/calendars/primary/events

Required query parameters:

- singleEvents=true
- orderBy=startTime
- maxResults bounded
- timeMin valid RFC3339
- timeMax valid RFC3339 when supplied

Use URL and URLSearchParams rather than unsafe string concatenation.

Ensure:

- no undefined values are inserted
- no malformed double protocol
- no relative URL
- no invalid date string
- no accidental encoded full URL
- no invalid calendarId path
- calendarId is primary and correctly encoded

3. Inspect Node fetch usage.

Confirm:

- global fetch exists in the actual Node runtime
- fetch is not shadowed by a mock or incorrectly imported helper
- production code is not accidentally using a test fetch
- AbortController timeout is valid
- timeout cleanup cannot abort the request immediately
- signal is not already aborted before fetch starts
- request headers are valid strings
- Authorization header is exactly:
  Bearer <access token>
- no undefined/null header value is passed

4. Inspect timeout implementation.

A likely source of httpStatus:null is an AbortError caused by an incorrect timeout.

Check for:

- timeout value accidentally 0
- milliseconds/seconds confusion
- controller aborted before fetch
- timer reused across retry
- timer not cleared
- retry using an already-aborted signal

Use a reasonable provider timeout such as 10–15 seconds.

Each retry must receive a fresh AbortController and fresh timeout.

Map timeout separately to:

google_calendar_timeout

Do not map every thrown exception generically to network_failure.

5. Inspect credential/token values safely.

Without printing token content, verify:

- decrypted access token is a non-empty string
- token type is valid
- expiresAt is valid
- refresh token presence is a boolean
- the Authorization header can be constructed
- no object/JSON payload is accidentally passed as the token string

Add safe boolean/length metadata only if needed:

- accessTokenPresent
- accessTokenLength
- refreshTokenPresent

Do not log any token characters.

6. Add an internal direct provider diagnostic.

Expand the authenticated diagnostic endpoint so it runs each stage separately:

- credential_loaded
- credential_decrypted
- access_token_valid
- node_fetch_available
- google_dns_or_fetch_reachable
- primary_calendar_request_started
- primary_calendar_request_completed
- event_list_request_started
- event_list_request_completed

Safe response:

{
  "connected": true,
  "credentialPresent": true,
  "credentialDecryptable": true,
  "accessTokenPresent": true,
  "refreshTokenPresent": true,
  "nodeFetchAvailable": true,
  "googleReachable": true,
  "primaryCalendarAccessible": true,
  "eventReadAccessible": true,
  "eventCount": 0,
  "errorStage": null,
  "errorCode": null,
  "safeErrorName": null,
  "safeCauseCode": null
}

No tokens or raw provider bodies.

7. Add a server-side manual diagnostic command.

Add a script such as:

server/scripts/googleCalendarRealDiagnostic.ts

It must:

- accept a Clerk user ID or Hula user ID only through a command argument
- load that user’s current Google Calendar connection
- run the same safe diagnostic
- print only booleans, stages, status codes and safe error codes
- never print token values
- never print encrypted credentials
- never print raw Google provider responses

Document the exact command in README.

If identifying the user safely requires an authenticated app diagnostic instead, keep the app diagnostic path and explain why.

8. Empty calendar behaviour.

Once the request succeeds:

- items: [] must return success
- iMessage must answer that nothing is scheduled today
- no generic provider error

9. Error mapping.

Add precise thrown-exception mappings:

- AbortError or timeout → google_calendar_timeout
- ENOTFOUND → dns_failure
- ECONNRESET → connection_reset
- ECONNREFUSED → connection_refused
- UND_ERR_CONNECT_TIMEOUT → connect_timeout
- invalid URL → malformed_request_url
- invalid header → invalid_request_headers
- generic fetch TypeError → network_failure with safe cause details

Keep user-facing copy concise.

10. Tests.

Add tests for:

- absolute URL construction
- RFC3339 timeMin/timeMax
- no undefined query values
- a fresh AbortController for each attempt
- timeout does not fire immediately
- AbortError mapping
- ENOTFOUND mapping
- fetch TypeError safe-cause mapping
- invalid URL mapping
- empty items success
- retry uses a fresh request signal
- no token leakage in logs/results
- existing tests remain green

Tests must not call the real Google API.

11. Validation.

Run:

From repo root:
npm run lint
npx tsc --noEmit

Backend:
cd server
npm run typecheck
npm run build
npm test
npm run prisma:generate

Do not commit.

12. Final response format.

1. Exact code-level cause found
2. Why the real request threw before an HTTP response
3. Files changed
4. URL construction fix
5. timeout/AbortController fix
6. fetch/header/token fix
7. expanded safe diagnostics
8. test results
9. exact real-device retest steps
10. confirm no tokens/secrets were exposed
11. confirm no commit was made

Do not stop at mocked tests. The next real backend run must log the safe exception name/message/cause and identify the exact network_failure source.