Read AGENTS.md first and follow it strictly.

We are on the development branch.

We are building Hula Section 11 only: Google Calendar read-only MVP.

Do not add Gmail.
Do not add Zoom.
Do not add Notion.
Do not add Asana.
Do not add Slack.
Do not add WhatsApp.
Do not add billing.
Do not add frontend integration UI screens yet.
Do not add calendar event creation.
Do not add calendar event editing.
Do not add calendar event deleting.
Do not add sending emails.
Do not add tool/action execution by Claude.
Do not add automatic calendar reminder creation yet unless explicitly scoped as read-only candidate data.
Do not add Google Calendar push webhooks yet.
Do not add Google Calendar write scopes.
Do not add broad proactive follow-up logic.
Do not change onboarding screens.
Do not add onboarding questions.
Do not add frontend popups.
Do not add visible loading states.
Do not add new user-facing buttons unless absolutely necessary for a non-invasive manual test helper.
Do not change auth.
Do not break Expo Go compatibility.
Do not commit.
Do not push.
Do not use git add -A.
Do not expose env values.
Do not open, print, cat, grep, or display server/.env.
Only inspect .env.example if needed.
Do not print API keys, Clerk secrets, Sendblue secrets, database URLs, Anthropic keys, OAuth secrets, integration tokens, refresh tokens, access tokens, or Google tokens.

Current confirmed state:
- Hula app is on Expo Go.
- Backend lives in server/.
- Clerk is the auth system.
- Neon Postgres is the database.
- Prisma is set up and migrated.
- Sendblue is connected.
- Dedicated Hula iMessage number is +1 646 548 0761.
- Anthropic Claude is connected.
- ANTHROPIC_MODEL is claude-opus-4-8.
- ngrok forwards to local backend.
- Sendblue webhook reaches /webhooks/sendblue.
- Section 4 persistence is complete and tested.
- Section 5 message persistence inspection is complete and committed.
- Section 6 Claude brain/router is complete and committed.
- Section 7 silent profile/onboarding context sync is complete and committed.
- Section 7.1 Text hula connected-state UX fix is complete and committed.
- Section 8 explicit long-term memory is complete and committed.
- Section 9 explicit reminders/follow-ups foundation is complete and committed.
- Section 10 integrations foundation is complete and committed.
- Latest commit before this section:
  f65ee30 Add Hula integrations foundation
- git status was clean before starting Section 11.

Current architecture:
- Clerk = user identity/auth.
- Neon Postgres = persistence.
- Prisma = database access.
- Sendblue = iMessage transport.
- Anthropic Claude = Hula brain provider.
- Hula backend = router/orchestrator.
- Integration foundation now exists:
  - IntegrationConnection
  - IntegrationCredential
  - IntegrationSyncState
  - IntegrationEvent
  - IntegrationActionLog
  - provider catalog
  - token vault
  - integration policy
  - integration status endpoints

Product direction:
Hula is an AGI-style personal assistant that primarily lives inside iMessage and WhatsApp.
The mobile app is the control panel for auth, onboarding, settings, integrations, permissions, subscription, and setup.
Long-term, users will selectively enable integrations they want Hula to access.
For Google Calendar, start read-only.

Section 11 first-principles purpose:
Build the first real app integration: Google Calendar read-only access.
Hula should be able to connect a user’s Google Calendar, store OAuth credentials securely server-side, fetch upcoming events, expose them through authenticated endpoints, and use them in Hula’s iMessage answers.

Important:
This section should prove the full integration path without adding event write capabilities.

Target user value:
After connecting Google Calendar, user can text Hula:
- “What’s on my calendar today?”
- “Do I have anything tomorrow?”
- “When’s my next meeting?”
- “What meetings do I have this week?”

Hula should answer from real Google Calendar data if connected.
If not connected, Hula should honestly say it does not have calendar access yet.

OAuth/security principles:
- Use least-privilege Google Calendar read-only scopes.
- Do not request write scopes.
- Store Google tokens server-side only.
- Encrypt tokens using the Section 10 token vault.
- Never send tokens to the mobile app.
- Never log tokens.
- Track granted scopes.
- Track provider account email if available safely.
- Support refresh tokens.
- If access token expires, refresh it server-side.
- If refresh fails, mark connection expired/error.
- Use state for CSRF protection.
- Prefer PKCE if clean.
- Use the existing integration foundation instead of creating one-off Google tables unless provider-specific event cache is needed.

Environment variables:
Add placeholders only to server/.env.example:
- GOOGLE_OAUTH_CLIENT_ID=
- GOOGLE_OAUTH_CLIENT_SECRET=
- GOOGLE_OAUTH_REDIRECT_URI=
- GOOGLE_CALENDAR_SCOPES=

Expected local redirect URI for ngrok/dev:
https://YOUR-NGROK-URL/v1/integrations/google_calendar/callback

Do not require these env vars at server startup unless Google OAuth is being used.
If missing and connect is attempted, return a safe configuration error.

Implementation requirements:

1. Provider registry update.

Update google_calendar in the provider catalog:
- status should become available_stub or available_readonly
- category: calendar
- authType: oauth2
- capabilities:
  - read_calendar_events
  - list_calendars
  - read_free_busy_candidate later if applicable
- defaultScopes should be read-only only.
Suggested scopes:
- https://www.googleapis.com/auth/calendar.readonly
or more limited read scopes if clean.

Do not add write scopes.

2. OAuth state model if needed.

If current integration models do not support OAuth state, add a safe additive Prisma model.

Suggested:
IntegrationOAuthState
- id
- userId
- provider
- state unique
- codeVerifier nullable
- redirectUri
- scopes Json
- status: pending | consumed | expired
- expiresAt
- consumedAt nullable
- createdAt

Indexes:
- state
- userId/provider/status

Do not reset DB.
Do not delete existing data.
No destructive migration.

3. Google Calendar integration files.

Suggested files:
- server/src/integrations/providers/googleCalendar/oauth.ts
- server/src/integrations/providers/googleCalendar/client.ts
- server/src/integrations/providers/googleCalendar/events.ts
- server/src/integrations/providers/googleCalendar/types.ts

Keep provider-specific code isolated.

4. OAuth connect endpoint.

Add an authenticated endpoint to start OAuth:

POST /v1/me/integrations/google_calendar/connect

or reuse existing connect endpoint for provider-specific behaviour.

Auth:
- Clerk bearer token required.
- Resolve current User.
- Generate state.
- Generate PKCE code_verifier/challenge if implemented.
- Store OAuth state server-side.
- Build Google OAuth authorization URL.
- Include:
  - client_id
  - redirect_uri
  - response_type=code
  - scope
  - access_type=offline
  - prompt=consent only if needed to obtain refresh token in dev
  - state
  - code_challenge / code_challenge_method if PKCE implemented
- Return:
{
  "provider": "google_calendar",
  "authorizationUrl": "...",
  "expiresAt": "..."
}

No tokens returned.

5. OAuth callback endpoint.

Add public callback endpoint:

GET /v1/integrations/google_calendar/callback

This endpoint receives:
- code
- state
- error if user denied

Flow:
- Validate state exists, pending, not expired.
- Exchange code for tokens with Google.
- Fetch safe Google account/calendar identity if possible.
- Store/update IntegrationConnection for user/provider.
- Store encrypted access/refresh tokens in IntegrationCredential.
- Store granted scopes.
- Mark OAuth state consumed.
- Record IntegrationEvent.
- Return a simple HTML success page:
  “Google Calendar connected. You can return to Hula.”

If failure:
- mark state expired/error if appropriate.
- return simple safe HTML error page.
- Do not print tokens or sensitive data.

6. Google token refresh.

Implement helper:
- getValidGoogleCalendarAccessToken(connectionId)
- If access token is valid, decrypt and return server-side only.
- If expired and refresh token exists, refresh with Google.
- Store new encrypted access token and expiry.
- If refresh fails, mark connection expired/error and throw safe error.

Do not expose token outside server provider helpers.

7. Calendar event fetch.

Add helper:
fetchUpcomingGoogleCalendarEvents(userId, options)

Options:
- timeMin
- timeMax
- maxResults default 10/20
- calendarId default primary

Uses Google Calendar API events.list.
Read-only.
Return safe normalized events:
- id
- calendarId
- summary
- description maybe truncated or omitted by default
- location
- start
- end
- htmlLink maybe
- attendees count maybe
- organizer email maybe if safe
- status
- source provider

Do not store raw Google event payloads.
Do not expose tokens.
Do not over-fetch.

8. Authenticated calendar endpoints.

Add under /v1/me/integrations/google_calendar:

GET /v1/me/integrations/google_calendar/events?range=today|tomorrow|week&limit=10

or:
GET /v1/me/calendar/events

Requirements:
- Clerk bearer token.
- User only sees their own connected Google Calendar events.
- If not connected, return clear 409/400 style response:
  { "error": "google_calendar_not_connected" }
- If token expired and refresh works, request succeeds.
- If refresh fails, mark integration expired and return safe error.
- Return normalized events only.

9. Hula brain/calendar routing.

When already-linked user sends a normal iMessage:
- Before generic Claude response, detect simple calendar questions:
  - “what’s on my calendar today”
  - “what do I have tomorrow”
  - “when’s my next meeting”
  - “what meetings do I have this week”
  - “do I have anything today”
- If calendar question and Google Calendar connected:
  - fetch events
  - build concise answer deterministically or with Claude using event context
  - save outbound message
  - send via Sendblue
- If calendar question and not connected:
  - reply:
    “I don’t have your Google Calendar connected yet. Once you connect it in Hula, I’ll be able to answer that.”
- Do not pretend to have access.
- Do not create/edit/delete events.
- Do not set reminders automatically from calendar yet.

If not a calendar question:
- normal Hula brain path continues.
- Optional: pass connected provider names into brain as Section 10 did, but do not pass calendar event data unless user asked a calendar question.

10. Tests.

Add/update tests for:
- Google Calendar provider registry is read-only
- connect endpoint returns authorization URL and stores OAuth state
- missing env returns safe config error
- callback rejects missing/invalid/expired state
- token vault stores tokens encrypted
- token refresh helper updates stored access token
- normalized event mapping strips raw payload
- events endpoint rejects not connected
- events endpoint scopes data to current user
- calendar intent detection
- connected calendar question uses calendar path
- not-connected calendar question returns honest not-connected message
- normal non-calendar messages still use brain
- existing normalization/linking/query/brain/profile/messaging-status/memory/reminders/integrations tests still pass

Normal tests must not call real Google APIs.
Mock/fake Google HTTP calls.

11. Optional manual script.

Add:
server/scripts/googleCalendar.manual.ts

It should support safe local checks:
- print the local connect URL instructions without printing secrets
- verify provider catalog
- optionally test event normalization with fake payloads
- do not require real Google API unless env and a real OAuth flow are completed

Do not print tokens.

12. README update.

Add Section 11:
- Google Cloud setup steps:
  - create/select project
  - enable Google Calendar API
  - configure OAuth consent screen
  - create OAuth client
  - add redirect URI:
    https://YOUR-NGROK-URL/v1/integrations/google_calendar/callback
  - set server env:
    GOOGLE_OAUTH_CLIENT_ID
    GOOGLE_OAUTH_CLIENT_SECRET
    GOOGLE_OAUTH_REDIRECT_URI
    GOOGLE_CALENDAR_SCOPES
    INTEGRATION_TOKEN_ENCRYPTION_KEY
- local connect flow
- how to fetch events endpoint
- how to ask Hula calendar questions via iMessage
- limitations:
  read-only calendar access
  no event creation/edit/delete
  no Google push webhooks yet
  no automatic calendar reminders yet
  no frontend integration UI yet

13. Save this prompt.

If prompt_material/claude-prompts/backend exists, save a copy as:
prompt_material/claude-prompts/backend/section-11-google-calendar-mvp.md

14. Validation commands.

Run from repo root:
git branch --show-current
git status --short

Frontend:
npm run lint
npx tsc --noEmit

Backend:
cd server
npm run typecheck
npm run build
npm test
npm run prisma:generate

If schema changed:
npm run prisma:migrate

If Google Calendar manual script added:
npm run test:google-calendar
or whatever script name was added

Manual test without real OAuth:
- Run tests/manual fake script.
- Confirm no Google network needed.

Manual test with real OAuth, after env setup:
1. Start backend.
2. Start ngrok.
3. Confirm Google OAuth redirect URI matches current ngrok URL:
   https://YOUR-NGROK-URL/v1/integrations/google_calendar/callback
4. Start Expo only if needed.
5. Use authenticated connect endpoint to get authorizationUrl.
6. Open authorizationUrl in browser.
7. Approve Google Calendar read-only consent.
8. Callback returns success page.
9. Query events endpoint.
10. From linked iMessage thread, ask:
    What’s on my calendar today?
11. Expected:
    Hula answers from real Google Calendar data.
12. Ask:
    Can you create a calendar event?
13. Expected:
    Hula says it can’t create/edit events yet.

Final response:
1. Files changed
2. Prisma schema/migration changes
3. Google Calendar OAuth flow added
4. Env variables added
5. Token storage/refresh behaviour
6. Event fetch/normalization behaviour
7. Calendar endpoints added
8. iMessage calendar question routing
9. Test results
10. Manual test results
11. Confirm no Gmail/Zoom/Notion/WhatsApp/event write/frontend UI/actions were added
12. Confirm no commit was made