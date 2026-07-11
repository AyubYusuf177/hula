Read AGENTS.md first and follow it strictly.

We are on the development branch.

This is Section 13B: production-quality Integrations UI, seamless Google Calendar return flow, integration-status request-loop repair, and real Google Calendar read-path diagnosis/fix.

Do not commit.
Do not push.
Do not use git add -A.
Do not add automations.
Do not add other integrations.
Do not add Google Calendar write scopes or write actions.
Do not add Gmail, Microsoft, Notion, Slack, Todoist, health providers, WhatsApp, billing, or unrelated features.
Do not change onboarding.
Do not replace Clerk authentication.
Do not break Expo Go compatibility.
Do not add native-only dependencies.
Do not open, print, cat, grep, or expose server/.env.
Do not print OAuth tokens, Clerk tokens, refresh tokens, access tokens, API keys, database URLs, encrypted credentials, or encryption keys.

CURRENT CONFIRMED STATE

- Latest committed foundation:
  12ef23d Add Hula agentic action runtime
- Section 13 changes are currently uncommitted.
- Google OAuth successfully completes.
- The backend callback displays:
  “Google Calendar connected”
- The Integrations screen eventually shows Connected.
- The connected Google Calendar appears in the hero.
- The user’s Google Calendar is empty.
- An iMessage request:
  “What’s on my calendar today?”
  currently returns:
  “I’m having trouble reaching your Google Calendar right now…”
- Empty event results must be treated as successful empty calendars, not provider failures.
- The browser callback leaves the user on the success webpage instead of returning seamlessly to Hula.
- Returning to the app can leave the details sheet showing stale connection copy/state.
- The frontend previously caused repeated GET /v1/me/integrations requests, sometimes several per second.
- The details sheet cannot scroll correctly.
- The details sheet cannot swipe down to dismiss.
- The primary actions can be cut off on smaller iPhones.
- The UI uses a generic calendar glyph rather than the real Google Calendar logo.
- The Hula logo appears inside a white square.
- Overall visual quality did not pass manual review.
- Miora reference screenshots are stored at:
  prompt_material/reference-images/miora-integrations/
- Inspect all 10 reference screenshots before editing.
- The exact source Hula logo is:
  assets/images/hula-logo.png

Before making changes:

1. Inspect all 10 visual-reference screenshots.
2. Inspect the entire current Section 13 implementation.
3. Inspect:
   - app/integrations/
   - components/integrations/
   - data/integrations.ts
   - lib/hulaApi.ts
   - lib/integrationStatus.ts
   - server Google Calendar provider files
   - server Google Calendar routes
   - webhook calendar routing
   - OAuth state implementation
4. Inspect existing Hula theme tokens and reusable components.
5. Do not assume the current implementation is correct.
6. Preserve working OAuth/token persistence code unless an actual defect is found.

==================================================
A. GOOGLE CALENDAR READ FAILURE
==================================================

OAuth succeeds and the integration is stored as Connected, but events.list fails.

Trace the exact failure through:

- credential lookup
- token decryption
- scope storage
- access-token expiry logic
- refresh-token flow
- Google HTTP request
- primary calendar lookup
- event normalization
- webhook calendar-question routing
- empty-event handling

Explicitly distinguish these safe internal error codes:

- google_calendar_api_disabled
- insufficient_scope
- token_refresh_failed
- invalid_grant
- credential_decrypt_failed
- calendar_not_found
- provider_rate_limited
- provider_unavailable
- malformed_provider_response
- network_failure

Requirements:

1. Google Calendar API enablement
- Detect Google 403 errors indicating the Calendar API is disabled.
- Map them to:
  google_calendar_api_disabled
- Provide a safe development log indicating that the Calendar API must be enabled in the same Google Cloud project.
- Do not expose the raw provider response to the user.

2. events.list request
Confirm it uses:
- calendarId=primary
- singleEvents=true
- orderBy=startTime
- bounded maxResults
- correct timeMin
- correct timeMax when applicable
- Bearer access token
- read-only scope only

3. Empty calendar
- HTTP success with items: [] is success.
- It must produce an honest empty-calendar response.
- It must never fall into the generic provider-error response.

4. Token refresh
- If access token is expired or receives one valid authentication failure:
  - refresh once
  - store the updated encrypted token
  - retry the original request exactly once
- Never create an infinite retry.
- Invalid refresh token must mark the connection expired/error safely.

5. Encryption
- Confirm credentials written during callback can be decrypted using the current integration token-vault implementation.
- Never log encrypted or plaintext credentials.

6. Scopes
Confirm the stored granted scopes include:
https://www.googleapis.com/auth/calendar.readonly

Do not add write scopes.

7. Safe structured logs
Add safe development logs containing only:
- provider
- operation
- HTTP status
- safe provider error reason/code
- safe connection identifier if useful
- internal mapped error code

Never log:
- Authorization header
- access token
- refresh token
- code verifier
- client secret
- full Google response payload

8. Diagnostic endpoint
Add an authenticated, current-user-only safe diagnostic endpoint if useful:

GET /v1/me/integrations/google_calendar/diagnostic

Safe response shape:

{
  "provider": "google_calendar",
  "connected": true,
  "credentialPresent": true,
  "scopeGranted": true,
  "accessTokenPresent": true,
  "refreshTokenPresent": true,
  "calendarApiReachable": true,
  "primaryCalendarAccessible": true,
  "eventReadAccessible": true,
  "eventCount": 0,
  "errorCode": null
}

Rules:
- Clerk authentication required.
- Current user only.
- No token strings.
- No encrypted values.
- No raw Google payload.
- No OAuth secret.
- No account-sensitive provider payload.
- Keep it development-only or safe and removable.

9. Tests
Add fake-provider tests for:
- successful empty event list
- populated event list
- Calendar API disabled 403
- insufficient scope 403
- expired token → refresh → successful retry
- invalid refresh token
- malformed provider response
- no token leakage

Normal tests must not call real Google.

==================================================
B. INTEGRATION STATUS REQUEST LOOP
==================================================

Live server logs showed GET /v1/me/integrations repeatedly, including several requests per second.

Find and remove the effect/render loop.

Requirements:

- Fetch once when the screen initially focuses.
- Fetch once when AppState actually transitions from background/inactive to active.
- Fetch once after OAuth browser/auth session completes.
- Fetch once when the user manually taps Refresh.
- No polling timer.
- Do not fetch repeatedly merely because AppState is currently active.
- Use stable callbacks.
- Fix effect dependencies.
- Add an in-flight guard.
- Prevent overlapping requests.
- Deduplicate refreshes occurring very close together.
- Ignore stale responses if a newer request has already completed.
- Clean up listeners correctly.
- Repeated renders must not trigger repeated status requests.

Add tests or pure helper tests for:
- active transition decision
- in-flight deduplication
- stale-response handling where practical

==================================================
C. SEAMLESS OAUTH RETURN
==================================================

Current behaviour:
- Google OAuth succeeds.
- Backend renders “Google Calendar connected”.
- User remains in the browser page.
- Returning to Hula can show stale connection UI.

Build the cleanest Expo Go-compatible return flow.

Google’s OAuth redirect URI must remain the backend callback:

/v1/integrations/google_calendar/callback

Preferred implementation:

1. Frontend creates an app return URL using Expo Linking/createURL for the Integrations route.

2. Frontend passes that return URL to the authenticated connect endpoint.

3. Backend stores the return URL only in the short-lived OAuth transaction.

4. Validate return URL strictly:
- permit expected Expo development schemes/hosts
- permit future Hula app scheme if already configured
- reject arbitrary http/https redirects
- do not create an open redirect

5. Backend callback:
- exchanges code
- persists encrypted tokens
- marks OAuth state consumed
- only then returns success
- renders a polished Hula success page
- includes a visible “Return to Hula” button
- attempts a redirect to the validated app return URL

6. Frontend:
- prefer WebBrowser.openAuthSessionAsync when compatible
- use openBrowserAsync only as a safe fallback
- call WebBrowser.maybeCompleteAuthSession() where appropriate
- never use WebView
- on auth-session return, refetch status exactly once
- on app reactivation, refetch status exactly once
- never mark Connected merely because the browser opened or closed
- backend status remains the only source of truth

7. Expo Go fallback
If Expo Go cannot automatically close the auth browser in the current environment:
- success page must still have a functioning Return to Hula button
- after returning, Hula refreshes status immediately
- no repeated status loop

If an additive nullable appReturnUrl field is required on the OAuth-state model:
- add a safe migration
- no reset
- no destructive migration

==================================================
D. CONNECTED-STATE ACCURACY
==================================================

Separate states clearly:

- initial_loading
- disconnected
- connecting
- connected
- expired
- backend_unavailable
- transient_connect_error
- provider_read_error

Rules:

- A connect failure must not overwrite persisted provider status.
- A Calendar API read failure must not visually mark OAuth as disconnected.
- Transient errors clear on retry/navigation.
- Connected comes only from backend status.
- Returning from successful OAuth must update the sheet/card immediately after backend confirmation.
- Connected sheet heading must say:
  “Google Calendar connected”
  not:
  “Connect Google Calendar”
- Connected body copy must describe what is currently enabled.
- Disconnect and Refresh actions must remain accessible.

==================================================
E. HULA LOGO FIX
==================================================

The hero currently shows the Hula icon inside a white square.

Requirements:

- Inspect assets/images/hula-logo.png.
- Preserve the exact Hula mark.
- If the source contains a surrounding background, create a derived transparent PNG from that exact source.
- Remove only the surrounding background.
- Do not redraw, regenerate, approximate, reinterpret, or replace the Hula mark.
- Save a clear derived asset, for example:
  assets/images/hula-logo-transparent.png
- Use contain sizing.
- No white Image wrapper.
- No visible square boundary.
- The final hero must show the mark naturally on the glass background.

==================================================
F. GOOGLE CALENDAR PRODUCT ICON
==================================================

The current generic blue calendar glyph is unacceptable.

Requirements:

- Use an accurate multicolour Google Calendar product icon.
- Store one high-resolution local asset:
  assets/images/integrations/google-calendar.png
- Use it consistently in:
  - card
  - details sheet
  - connected hero animation
- Do not extract a low-resolution icon from the Miora screenshots.
- Remove the generic glyph fallback from Google Calendar UI.

==================================================
G. HERO REDESIGN
==================================================

Use the reference only for interaction/layout inspiration.

Requirements:

- Hula branding only.
- Dark premium glass panel.
- Real transparent Hula mark centred.
- Controlled orbital dots/rings.
- Connected-provider icons softly appear, move, and fade.
- Restrained, premium animation.
- Provider icons come only from backend-connected provider data.
- No huge loading spinner between hero and category.
- Loading must not shift the page layout.
- Remove or reduce oversized decorative circles that obscure content.
- Decorative elements must be clipped and subtle.
- Hero must scale for multiple future integrations.

==================================================
H. GOOGLE CALENDAR CARD REDESIGN
==================================================

Requirements:

- More compact and refined.
- Accurate Google Calendar logo.
- Better typography hierarchy.
- Reduced empty space.
- Reusable component structure.

Disconnected:
- muted glass
- “Not connected”

Connected:
- active logo
- restrained Hula sky/violet border/glow
- “Connected”
- optional safe account label

Error:
- transient inline retry message
- never replace backend-connected truth with a permanent “Connection error”

==================================================
I. DETAILS SHEET SCROLLING
==================================================

The entire sheet content must be scrollable.

Requirements:

- Animated.ScrollView or ScrollView.
- Every field and button reachable on small iPhones.
- Respect safe-area insets.
- Add home-indicator bottom padding.
- No fixed content height that clips actions.
- A sticky action footer is acceptable if clean.
- Connect/Disconnect and Refresh must always be reachable.

==================================================
J. SWIPE-DOWN DISMISSAL
==================================================

Requirements:

- Visible drag handle.
- Swipe down to dismiss.
- X button dismisses.
- Backdrop tap dismisses.
- Smooth opening and closing.
- Use installed libraries or Animated + PanResponder.
- Do not add native-only dependencies.
- Inner scrolling and sheet drag must cooperate.
- When inner scroll is at top and the user pulls down, the sheet follows.
- Dismiss past a reasonable distance/velocity threshold.
- Maximum height roughly 88–92% of available screen.

==================================================
K. SHEET VISUAL COMPOSITION
==================================================

Requirements:

- Rounded top corners.
- Dimmed/blurred backdrop using Expo-compatible tools.
- Drag handle.
- Close button.
- Centred title.
- Accurate Google Calendar icon.
- Correct backend status.
- Strong but concise heading.
- Current capability list.
- Coming-later list.
- Honest read-only limitation.
- Privacy note.
- Inline transient errors.
- Connect/Disconnect button.
- Refresh action.
- No cut-off content.
- No excessive vertical spacing.

==================================================
L. REQUEST INTEGRATION CARD
==================================================

- Keep disabled.
- Label Coming soon.
- Improve density and visual quality.
- No navigation yet.

==================================================
M. CLEANUP
==================================================

Remove:
- hardcoded screen-height hacks
- duplicate status refresh effects
- persistent transient errors
- generic Calendar glyph usage
- unused components/imports
- random logo containers
- oversized spacing
- layout hacks causing clipping
- excessive decorative backgrounds
- unnecessary spinners

Do not overengineer a complete marketplace.

==================================================
N. TESTS
==================================================

Add/update tests for:

- correct POST connect endpoint
- Clerk bearer header
- malformed connect response
- safe return-URL validation
- arbitrary redirect rejection
- callback persists connection before redirect
- backend status contains no credential/token fields
- Connected only comes from backend
- transient connect error does not become provider status
- provider read error does not mark connection disconnected
- repeated renders do not refetch status
- AppState transition triggers only one refresh
- request deduplication
- connected sheet copy mapping
- empty Google event list returns successful empty response
- Calendar API disabled error mapping
- insufficient scope mapping
- token refresh and one retry
- no secrets in logs/API/test snapshots
- all existing tests remain green

==================================================
O. README
==================================================

Document:

- Google Calendar API must be enabled in the same Cloud project.
- OAuth backend callback.
- safe app-return URL flow.
- Expo Go fallback behaviour.
- backend status as source of truth.
- safe diagnostic endpoint.
- read-only limitation.
- test-user/production publishing note.
- no Calendar writes or automations yet.

==================================================
P. VALIDATION
==================================================

Run from repo root:

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

If schema changed:

npm run prisma:migrate

Run any new frontend pure tests and Google Calendar fake/manual diagnostic tests.

Do not claim real-device testing.

==================================================
FINAL RESPONSE FORMAT
==================================================

1. Exact root cause of Calendar read failure
2. Exact Calendar read fix
3. Cause and fix of repeated status requests
4. OAuth return-flow implementation
5. Files changed
6. Prisma migration, if any
7. Hula transparent-logo fix
8. Google Calendar icon fix
9. Hero redesign
10. Card redesign
11. Scrollable sheet implementation
12. Swipe/backdrop/X dismissal
13. Safe-area/action visibility fix
14. Connected-state copy/state fix
15. Diagnostic endpoint/script
16. Test and validation results
17. Exact remaining manual test steps
18. Confirm no unrelated integration/provider, automation UI, write scope/action, billing, or WhatsApp work was added
19. Confirm no commit was made

Do not stop after making visual changes.

The section is incomplete until:

- empty calendars return a correct empty response through iMessage
- Google provider errors are safely diagnosable
- the status request loop is removed
- OAuth return is improved
- the sheet scrolls
- the sheet swipes down
- X and backdrop dismissal work
- buttons are reachable on compact iPhones
- the real Hula mark has no white square
- the accurate Google Calendar logo appears everywhere
- connected-state copy is correct
- all validation passes
- no commit is made.