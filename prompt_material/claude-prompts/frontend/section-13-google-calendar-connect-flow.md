Read AGENTS.md first and follow it strictly.

We are on the development branch.

We are building Hula Section 13 only: the first production Integrations screen and Google Calendar backend-to-app connection flow.

IMPORTANT REFERENCE FILES
The Miora visual reference screenshots are already stored inside the repository at:

prompt_material/reference-images/miora-integrations/

Expected files:
- miora-integration-01.jpeg
- miora-integration-02.jpeg
- miora-integration-03.jpeg
- miora-integration-04.jpeg
- miora-integration-05.jpeg
- miora-integration-06.jpeg
- miora-integration-07.jpeg
- miora-integration-08.jpeg
- miora-integration-09.jpeg
- miora-integration-10.jpeg
- README.txt

Inspect those images before implementing anything.

These screenshots are visual and interaction references only.
Do not copy Miora branding, colours, wording, logo, or proprietary assets.
Use Hula’s existing design system and exact repository assets.

Do not build automation cards.
Do not build an Automations screen.
Do not add Gmail OAuth.
Do not add Microsoft OAuth.
Do not add Notion OAuth.
Do not add Slack OAuth.
Do not add Todoist OAuth.
Do not add health-provider OAuth.
Do not add WhatsApp.
Do not add billing.
Do not add Google Calendar write actions.
Do not add event editing or deletion.
Do not request Google Calendar write scopes.
Do not add broad tool execution.
Do not change onboarding.
Do not change auth.
Do not add native-only packages.
Do not break Expo Go compatibility.
Do not commit.
Do not push.
Do not use git add -A.
Do not open, print, cat, grep, or expose server/.env.
Do not print secrets, OAuth tokens, API keys, Clerk tokens, Sendblue credentials, database URLs, Anthropic keys or encryption keys.

Current confirmed state:
- Hula is an Expo/React Native/TypeScript app using Expo Router.
- Hula currently runs through Expo Go.
- Clerk handles user identity.
- Neon Postgres and Prisma handle persistence.
- Sendblue handles iMessage transport.
- Anthropic Claude is connected.
- Section 10 integrations foundation is complete.
- Section 11 Google Calendar read-only backend integration is complete.
- Section 12 agentic action runtime is complete.
- Latest commit:
  12ef23d Add Hula agentic action runtime
- Git status was clean before starting.
- Google OAuth environment variables are configured in server/.env.
- Do not inspect or display their values.

Important product distinction:
- Integrations = apps users connect and grant permissions to.
- Automations = outcomes powered by connected apps.
- Automations are not part of this section.

Section 13 product goal:
Build the reusable Hula Integrations screen foundation and connect Google Calendar through the existing backend OAuth flow.

This is the first real integration card. Every future integration should later use the same screen, card structure, connection state, details sheet and visual behaviour.

DESIGN REFERENCES
Study all images in:
prompt_material/reference-images/miora-integrations/

Reference behaviours to adapt:
- A large hero panel near the top.
- The assistant logo in the centre.
- Connected integration logos appearing around/orbiting the assistant logo.
- Integration cards arranged by category.
- Disconnected cards look muted/grey.
- Connected cards become more visually active.
- Tapping an integration opens a large bottom sheet.
- Bottom sheet explains the integration and contains a Connect button.
- A request-integration card appears near the bottom.

Apply those ideas using Hula’s own premium dark/glassy design system.

HULA DESIGN REQUIREMENTS
- Use Hula colours and existing theme tokens.
- Background base: #0B1020.
- Use violet, iris, sky and subtle mint accents from the existing theme.
- Maintain the premium dark, glassy and ambient visual style.
- Use Poppins where already configured.
- Do not introduce the orange Miora background.
- Do not copy Miora’s logo.
- Do not generate a substitute Hula logo.
- Use the real Hula logo asset exactly:
  assets/images/hula-logo.png
- If the asset path differs, locate the existing Hula logo in the repository and use that real asset.
- Do not redraw, recreate or approximate it.
- Do not use random placeholder branding for Hula.

SCREEN ROUTE
Create or update the route used by Home → Integrations.

Use the existing Expo Router structure.
Do not redesign Home.
The Home Integrations row should navigate to the new screen.

SCREEN STRUCTURE

1. Header
- Back button.
- Centred title: “Integrations”.
- Respect safe areas.

2. Animated hero panel
- Large rounded glass panel.
- Real Hula logo centred.
- Small connected-provider icons animate around the Hula logo.
- When Google Calendar is disconnected, its icon can appear muted or remain outside the active orbit.
- When connected, the Google Calendar icon becomes active and joins the orbit.
- Animation should be subtle and premium:
  - gentle orbit
  - fade/scale in and out
  - slow movement
- Avoid distracting constant spinning.
- Use React Native Animated or Reanimated only if already available.
- Keep Expo Go compatibility.
- The hero must continue working when more connected integrations are added later.
- Drive it from connected-provider data rather than hardcoded animation logic.

3. Category section
For this section only, use:
- ORGANIZATION

Under it show:
- Google Calendar

Do not add the complete marketplace yet.
The card system must be reusable for future apps.

4. Google Calendar card
Disconnected state:
- muted glass appearance
- Google Calendar icon
- “Google Calendar”
- status: “Not connected”
- short capability description

Connected state:
- brighter Hula accent border/glow
- status: “Connected”
- optionally show safe account label
- never show tokens
- subtle connection indicator
- hero animation includes Google Calendar icon

Do not claim write capability.

Current capabilities text:
- Read your upcoming events
- Answer calendar questions from iMessage
- Find your next meeting

Coming later text:
- Create events after confirmation
- Reschedule meetings
- Meeting preparation

5. Google Calendar details sheet
Tapping the Google Calendar card opens a polished bottom sheet or modal.

It should resemble the interaction structure from the reference screenshots but use Hula styling.

Sheet content:
- Close button
- title: Google Calendar
- Google Calendar icon
- heading:
  Connect Google Calendar
- body:
  Connect your Google Calendar so Hula can read your schedule and answer calendar questions directly from iMessage.
- privacy note:
  Your Google tokens stay encrypted on Hula’s server and are never stored in the mobile app.
- capability list:
  Read upcoming events
  Answer schedule questions
  Find your next meeting
- limitation:
  Calendar creation and editing are not enabled yet.
- primary button:
  Connect Google
- connected state button:
  Disconnect Google Calendar
- secondary action:
  Refresh connection status

Do not say Hula can create or manage events yet.

6. Request Integration card
Add a reusable card near the bottom:
- title: Request an Integration
- status: Coming soon
- disabled for now
- do not navigate to chat yet
- visually communicate that it is not active
- build it so it can later open the Hula chat

7. Backend-to-app OAuth flow
Use the existing backend Google Calendar endpoints.

Expected backend endpoints likely include:
POST /v1/me/integrations/google_calendar/connect
GET /v1/integrations/google_calendar/callback
GET integration status endpoint
POST disconnect endpoint if already supported

Review existing routes before changing anything.
Do not rewrite working OAuth code.

Connect flow:
- silently obtain Clerk bearer token
- call backend connect endpoint
- receive authorizationUrl
- open it using Linking.openURL or an existing system-browser helper
- never use an embedded WebView
- never expose Google tokens to the app
- Google redirects to the existing backend callback
- callback page tells user to return to Hula
- when the app becomes active again, refetch connection status
- also offer a manual Refresh status action

Use AppState or screen focus only if clean and reliable.
Avoid repeated polling.

8. Backend status endpoint
If existing integration status is insufficient, add:

GET /v1/me/integrations/google_calendar/status

Safe response:
{
  "provider": "google_calendar",
  "connected": true,
  "status": "connected",
  "accountLabel": "safe optional account label",
  "grantedScopes": ["safe scope strings"],
  "lastConnectedAt": "safe optional timestamp"
}

Never return:
- access tokens
- refresh tokens
- encrypted credentials
- raw provider payloads
- OAuth secrets

9. Frontend API helpers
Update lib/hulaApi.ts.

Add or reuse typed helpers:
- connectGoogleCalendar(token)
- fetchGoogleCalendarStatus(token)
- disconnectGoogleCalendar(token)
- fetchGoogleCalendarEvents(token, range) if already present

Use existing Hula API error conventions.

10. Connected-state accuracy
The UI must always use backend state as source of truth.

Do not mark connected just because the browser opened.
Only mark connected after backend status confirms it.

Handle:
- disconnected
- connecting
- connected
- expired
- error
- backend unavailable

Use inline status text.
Avoid intrusive alerts unless existing project conventions require them.

11. Reusable architecture
Do not hardcode the entire screen around Google Calendar.

Create reusable concepts where appropriate:
- IntegrationCard
- IntegrationDetailsSheet
- IntegrationCategory
- connected provider hero data

Keep the implementation proportionate.
Do not overengineer a full marketplace.

Future integrations should be addable by supplying:
- provider id
- display name
- category
- icon
- connection status
- capability description
- connect handler
- disconnect handler

12. Tests
Add/update tests where practical:
- status mapping
- connected/disconnected/error states
- connect helper request
- status helper request
- backend status response contains no credential fields
- connect returns authorizationUrl only
- hero provider list uses only connected integrations
- future provider configuration can use reusable card structure
- existing backend tests pass
- no tests call real Google APIs

13. README
Document:
- Section 13 Integrations screen
- Google Calendar app connect flow
- system-browser OAuth
- backend status as source of truth
- testing-mode Google users
- production verification requirement
- read-only limitation
- no automations yet
- no full marketplace yet

14. Save this prompt
Save a copy at:
prompt_material/claude-prompts/frontend/section-13-google-calendar-connect-flow.md

15. Validation
Run:

From repository root:
git branch --show-current
git status --short
npm run lint
npx tsc --noEmit

Backend:
cd server
npm run typecheck
npm run build
npm test
npm run prisma:generate

No Prisma migration should be needed unless strictly necessary.

16. Manual test
Claude must not claim it completed manual testing.

User manual test after Claude finishes:
1. Start backend.
2. Start ngrok.
3. Confirm redirect URI matches Google Cloud.
4. Start Expo with cache cleared.
5. Open Home.
6. Tap Integrations.
7. Confirm the Hula logo is the exact real repository asset.
8. Confirm hero animation works.
9. Confirm Google Calendar card is initially disconnected if not connected.
10. Tap Google Calendar.
11. Confirm details sheet opens.
12. Tap Connect Google.
13. Confirm system browser opens Google OAuth.
14. Complete read-only consent.
15. Return to Hula.
16. Confirm status refreshes to Connected.
17. Confirm card visual state changes.
18. Confirm Google Calendar icon enters the connected hero animation.
19. Text Hula:
    What’s on my calendar today?
20. Confirm Hula answers using the connected calendar.
21. Confirm Request Integration says Coming soon.
22. Confirm no tokens or secrets appear anywhere.

FINAL RESPONSE FORMAT
1. Files changed
2. New Integrations route
3. Reusable integration UI components
4. Hero animation behaviour
5. Google Calendar card states
6. Details sheet behaviour
7. OAuth connect flow
8. Status/refocus behaviour
9. Disconnect behaviour
10. Tests
11. Manual testing not completed by Claude
12. Confirm exact assets/images/hula-logo.png was used
13. Confirm no automations UI, full marketplace, write scope, Gmail, Microsoft, Notion, Slack, billing or WhatsApp was added
14. Confirm no commit was made
