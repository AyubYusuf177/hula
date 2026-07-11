Read AGENTS.md first and follow it strictly.

We are on the development branch.

We are building Hula Section 10 only: integrations architecture foundation.

Do not add Google Calendar OAuth yet.
Do not add Gmail OAuth yet.
Do not add Zoom OAuth yet.
Do not add Notion OAuth yet.
Do not add Asana OAuth yet.
Do not add WhatsApp.
Do not add billing.
Do not add frontend integration UI yet.
Do not add new mobile screens.
Do not add frontend popups.
Do not add visible loading states.
Do not add new user-facing buttons.
Do not add new permissions.
Do not add automatic integration syncing yet.
Do not fetch real provider data yet.
Do not execute real provider actions yet.
Do not add tool/action execution by Claude yet.
Do not change onboarding screens.
Do not add onboarding questions.
Do not change auth.
Do not break Expo Go compatibility.
Do not commit.
Do not push.
Do not use git add -A.
Do not expose env values.
Do not open, print, cat, grep, or display server/.env.
Only inspect .env.example if needed.
Do not print API keys, Clerk secrets, Sendblue secrets, database URLs, Anthropic keys, OAuth secrets, integration tokens, or refresh tokens.

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
- Latest commit before this section:
  f960f6d Add explicit Hula reminders
- git status was clean before starting Section 10.

Current architecture:
- Clerk = user identity/auth.
- Neon Postgres = persistence.
- Prisma = database access.
- Sendblue = iMessage transport.
- Anthropic Claude = Hula brain provider.
- Hula backend = router/orchestrator.
- Expo app = user control panel.

Product direction:
Hula is an AGI-style personal assistant that primarily lives inside iMessage and WhatsApp.
The mobile app is the control panel for auth, onboarding, integrations, permissions, subscription, settings, and setup.
The long-term product needs many app integrations:
- Google Calendar
- Gmail
- Zoom
- Notion
- Asana
- Slack
- travel providers
- food/order providers
- health providers
- future aggregator providers such as Nylas if useful

Section 10 first-principles purpose:
Before adding real provider OAuth, we need a clean integration foundation.
The foundation should let future providers plug in without creating messy one-off code.

Research-driven principles:
- OAuth integrations should be based on Authorization Code + PKCE for app/user flows.
- Use external/system browser flows later for native/mobile OAuth.
- Use least-privilege scopes.
- Track exact granted scopes.
- Store tokens only server-side.
- Never expose tokens to the mobile app.
- Keep access tokens short-lived and refresh tokens protected.
- Design for direct provider APIs and aggregator APIs.
- Design for incremental permissions later: users should enable only what they want Hula to access.
- Hula should not be able to perform high-impact actions unless the user explicitly granted that provider/scope and the backend policy allows it.

Section 10 goal:
Create the backend integration registry, database models, safe token abstraction, status endpoints, and test coverage.

Do not connect any real provider yet.

Implementation requirements:

1. Add Prisma integration models.

Add a safe additive migration.

Suggested models:

IntegrationConnection
- id
- userId
- provider
- providerAccountId nullable
- providerAccountEmail nullable
- displayName nullable
- status: disconnected | connected | expired | revoked | error
- grantedScopes Json nullable
- requestedScopes Json nullable
- capabilities Json nullable
- connectedAt nullable
- disconnectedAt nullable
- lastSyncedAt nullable
- createdAt
- updatedAt

IntegrationCredential
- id
- connectionId
- tokenType: oauth
- encryptedAccessToken nullable
- encryptedRefreshToken nullable
- accessTokenExpiresAt nullable
- refreshTokenExpiresAt nullable
- scopeHash nullable
- createdAt
- updatedAt

IntegrationSyncState
- id
- connectionId
- resourceType
- cursor nullable
- syncToken nullable
- lastSyncedAt nullable
- status nullable
- errorMessage nullable
- createdAt
- updatedAt

IntegrationEvent
- id
- userId
- connectionId nullable
- provider
- eventType
- resourceType nullable
- providerEventId nullable
- safeSummaryJson nullable
- createdAt

IntegrationActionLog
- id
- userId
- connectionId nullable
- provider
- actionType
- status
- requestSummaryJson nullable
- resultSummaryJson nullable
- errorMessage nullable
- createdAt

Relations:
- Connection belongs to User.
- Credential belongs to Connection.
- SyncState belongs to Connection.
- Event belongs to User and optionally Connection.
- ActionLog belongs to User and optionally Connection.

Indexes:
- IntegrationConnection userId/provider
- IntegrationConnection userId/status
- IntegrationCredential connectionId
- IntegrationSyncState connectionId/resourceType
- IntegrationEvent userId/provider/createdAt
- IntegrationActionLog userId/provider/createdAt

Do not reset DB.
Do not delete existing real user/profile/message/link/memory/reminder data.
No destructive migration.

2. Provider registry.

Add a provider registry file, likely:
server/src/integrations/registry.ts

It should define supported/planned providers with metadata only:
- google_calendar
- gmail
- zoom
- notion
- asana
- slack
- nylas
- generic

Each provider entry should include:
- provider id
- displayName
- category: calendar | email | meetings | productivity | communication | aggregator | generic
- status: planned | available_stub
- authType: oauth2 | api_key | partner | none
- defaultScopes
- capabilities
- notes

No real OAuth URL generation yet unless implemented as a stub that throws “not implemented”.

3. Token vault abstraction.

Add a server-only token vault abstraction, likely:
server/src/integrations/tokenVault.ts

Requirements:
- Mobile app never sees provider tokens.
- Tokens are encrypted before storage.
- Use Node crypto AES-256-GCM if straightforward.
- Add env placeholder to server/.env.example:
  INTEGRATION_TOKEN_ENCRYPTION_KEY=
- Do not require this env for current server startup unless token encryption is actually used.
- If encryption key is missing and token storage is attempted, throw a safe configuration error.
- Do not print token values.
- Do not log encrypted token values.
- Add tests using a test key.

If implementing real encryption is too much for this section, create the interface and a clearly failing stub for token storage. But prefer implementing AES-256-GCM if clean.

4. Backend integration helpers.

Add helpers, likely:
server/src/integrations/connections.ts

Functions:
- listIntegrationCatalog()
- listUserIntegrationConnections(userId)
- getUserIntegrationStatus(userId)
- upsertIntegrationConnection(...)
- disconnectIntegrationConnection(userId, provider)
- getConnectionForUserProvider(userId, provider)
- recordIntegrationEvent(...)
- recordIntegrationAction(...)

Disconnect should:
- mark connection disconnected
- clear or deactivate credentials if implemented
- not delete audit logs

5. Authenticated endpoints.

Add endpoints under existing /v1/me namespace:

GET /v1/me/integrations/catalog
Returns provider catalog metadata.

GET /v1/me/integrations
Returns current user integration statuses.

GET /v1/me/integrations/:provider
Returns one provider status.

POST /v1/me/integrations/:provider/disconnect
Marks provider disconnected for current user.

Do not add real connect endpoint unless it only returns a safe “not implemented yet” response.
If adding:
POST /v1/me/integrations/:provider/connect
It should return 501 or { status: "not_implemented" } for now.

Security:
- Clerk bearer token required.
- User only sees their own integration records.
- Do not expose tokens.
- Do not expose encrypted token values.
- Do not expose raw provider payloads.
- Unknown provider should return a safe 404/400.

6. Frontend API helper only.

Update lib/hulaApi.ts to add typed helpers:
- fetchIntegrationCatalog
- fetchUserIntegrations
- fetchIntegrationStatus
- disconnectIntegration

Do not add UI.
Do not add screens.
Do not wire to settings rows yet unless there is already a non-invasive placeholder and no UX change.
No user-facing changes in Section 10.

7. Brain context.

Do not let Claude execute integrations yet.

Optionally pass a lightweight integration-status summary into the Hula brain:
- connected provider names only
- not tokens
- not scopes unless needed
- no provider data

But do not change Hula replies to claim it can access apps yet if no real providers are connected.

Hula should still be honest:
“I can help plan that, but I don’t have your calendar connected yet.”

8. Future action policy foundation.

Add a policy file if useful:
server/src/integrations/policy.ts

Define action risk levels:
- read
- draft
- write
- send
- purchase
- destructive

Define future rule:
- reads can run only if provider connected and scope granted
- writes/actions require explicit user confirmation unless later configured otherwise
- purchases/high-impact actions are not allowed yet

Do not implement real actions yet.

9. Tests.

Add tests for:
- provider registry contains expected providers
- catalog endpoint shape if testable
- unknown provider rejected
- user integration statuses scoped to user
- disconnect marks only that user’s connection disconnected
- token vault encrypt/decrypt roundtrip with test key
- token vault refuses to store/decrypt without key
- no token values returned from helpers/endpoints
- action policy risk levels
- existing normalization/linking/query/brain/profile/messaging-status/memory/reminders tests still pass

Normal tests must not call real provider APIs.
No Google/Zoom/Notion/Gmail network calls.

10. Optional manual script.

Add:
server/scripts/integrations.manual.ts

It should:
- create throwaway user
- create stub connection
- store encrypted fake token if token vault implemented
- list statuses
- disconnect
- ensure tokens are not returned
- clean up
- print no secrets

11. README update.

Add Section 10:
- integration foundation purpose
- provider registry
- connection model
- credential/token vault
- status endpoints
- disconnect endpoint
- future OAuth flow
- future Google Calendar plan
- future app UI plan
- security model
- limitations:
  no real OAuth yet
  no provider data sync yet
  no actions/tools yet
  no frontend UI yet

12. Save this prompt.

If prompt_material/claude-prompts/backend exists, save a copy as:
prompt_material/claude-prompts/backend/section-10-integrations-foundation.md

13. Validation commands.

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

If integration manual script added:
npm run test:integrations
or whatever script name was added

Manual/local test:
1. Do not connect any real provider.
2. Run integration manual script.
3. Confirm it creates a throwaway connection.
4. Confirm fake tokens are encrypted/decrypted only inside server helper.
5. Confirm API/helper never returns token values.
6. Confirm disconnect marks the connection disconnected.
7. Confirm cleanup completed.

Final response:
1. Files changed
2. Prisma schema/migration changes
3. Integration models added
4. Provider registry added
5. Token vault behaviour
6. Endpoints added
7. Frontend helper changes
8. Future action policy foundation
9. Test results
10. Manual test results
11. Confirm no real Google/Zoom/Gmail/Notion OAuth was added
12. Confirm no integrations data sync/actions/frontend UI were added
13. Confirm no commit was made