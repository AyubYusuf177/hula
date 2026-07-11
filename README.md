# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Configure environment

   Copy `.env.example` to `.env` and fill in the values (see the table below).
   These are read at build time, so restart Expo with `npx expo start -c` after
   any change.

   | Variable                            | Purpose                                                        |
   | ----------------------------------- | -------------------------------------------------------------- |
   | `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (public).                                |
   | `EXPO_PUBLIC_HULA_API_URL`          | Base URL of the Hula backend (e.g. ngrok) for "Text hula".     |

   No secret keys ever live in the app — only `EXPO_PUBLIC_*` values, which are
   safe to ship in the client bundle.

3. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.

## Integrations (Section 13)

The Integrations screen (`app/integrations/index.tsx`, reached from **Home →
Integrations**) is Hula's first production integrations surface and the first
real app connection: **Google Calendar (read-only)**.

### What's on the screen

- **Ambient hero** — the real Hula mark on the dark glass with a soft glow and a
  gently drifting dot field. The mark is a **derived transparent PNG**
  (`assets/images/hula-logo-transparent.png`) generated from the exact source
  `assets/images/hula-logo.png` by removing only the surrounding white
  background — the mark itself is never redrawn, and there is **no white square
  wrapper**. Each **connected** provider's real product icon fades in and slowly
  orbits the mark, driven entirely by backend connection data
  (`components/integrations/IntegrationHero.tsx`). Animation uses the React
  Native `Animated` API only, so it stays **Expo Go compatible** and the fixed
  panel height means loading never shifts the layout.
- **Category cards** — reusable `IntegrationCard`s grouped by
  `IntegrationCategory` (currently just **Organization → Google Calendar**).
  Disconnected cards read muted; connected cards gain a restrained sky/violet
  border + glow. A transient error shows inline and never overwrites
  backend-connected truth.
- **Details sheet** — tapping a card opens `IntegrationDetailsSheet`: a fully
  **scrollable**, **swipe-to-dismiss** bottom sheet (drag handle, X button, and
  backdrop tap all dismiss it) with a blurred backdrop, the accurate Google
  Calendar icon, honest read-only capabilities, a privacy note, and a **sticky
  footer** that keeps Connect / Disconnect / Refresh reachable above the home
  indicator on compact iPhones. Connected copy reads **"Google Calendar
  connected"** and describes what's enabled.
- **Request an Integration** — a disabled "Coming soon" card, built so a later
  section can wire it to the Hula chat.

Product icons are accurate, local, high-resolution assets
(`assets/images/integrations/google-calendar.png`) — never a generic glyph and
never extracted from reference screenshots. New integrations are added by
supplying one entry in `data/integrations.ts` (id, display name, category, icon
image, accent, copy) plus a backend connect flow — no screen changes required.

### Google Calendar connect flow (system-browser OAuth)

1. The app builds an app return URL with `Linking.createURL('/integrations')`,
   gets the Clerk bearer token, and calls
   `POST /v1/me/integrations/google_calendar/connect` with that return URL in the
   body. The response contains **only** an `authorizationUrl` (never a token).
   The backend **strictly validates** the return URL (Hula's own `hulaai://`
   scheme or the Expo dev schemes only — arbitrary `http(s)` is rejected so it
   can never become an open redirect) and stores it on the short-lived OAuth
   state.
2. The app opens that URL with `WebBrowser.openAuthSessionAsync(url, returnUrl)`
   (SFAuthenticationSession / Chrome Custom Tabs, **never an embedded WebView**),
   falling back to `openBrowserAsync` where the auth session isn't available.
3. Google's redirect URI stays the backend callback
   (`GET /v1/integrations/google_calendar/callback`). It exchanges the code,
   stores the **encrypted** tokens, marks the connection connected — and **only
   then** renders a polished Hula success page that (a) auto-redirects to the
   validated app return URL and (b) shows a visible **Return to Hula** button as
   a reliable fallback for environments where the auth browser can't auto-close.
4. On the auth session returning (once) and on the next background→active
   transition or screen focus, plus the manual **Refresh connection status**
   action, the app re-reads `GET /v1/me/integrations` and updates the UI.

**Backend status is the source of truth.** A card is only shown as connected
after the backend confirms it — never because the browser opened or closed. The
app never sees Google access/refresh tokens; the status shape carries only safe
fields (connection status, optional account email, timestamps).

**Status is fetched exactly when it should be.** The screen guards against the
old request loop with an in-flight guard + short dedupe window and only refetches
on focus, a real background→active transition, after the OAuth session returns,
or a manual refresh — never on a timer and never merely because `AppState` is
already active. The decisions are pure and unit-tested
(`shouldRefetchOnAppState`, `isStaleResponse`, `shouldStartRequest` in
`lib/integrationStatus.ts`).

Frontend helpers live in `lib/hulaApi.ts`
(`connectGoogleCalendar`, `fetchGoogleCalendarStatus`,
`disconnectGoogleCalendar`, `fetchGoogleCalendarEvents`,
`fetchGoogleCalendarDiagnostic`) and the pure status mapping in
`lib/integrationStatus.ts`.

### ⚠️ Enable the Google Calendar API (required to read events)

OAuth consent uses `accounts.google.com` / `oauth2.googleapis.com`, which work
**without** the Calendar API being enabled — so a user can finish consent and the
connection is stored `connected`, yet every `calendar/v3` read still fails with
**HTTP 403** until the **Google Calendar API is enabled in the same Google Cloud
project** as the OAuth client. Enable it at
**APIs & Services → Library → "Google Calendar API" → Enable** for that project.
Until then, the diagnostic reports `errorCode: "google_calendar_api_disabled"`
and iMessage calendar questions honestly reply that the calendar is unavailable
(they never pretend). An **empty** calendar (HTTP 200 with `items: []`) is a
success and returns an honest "nothing on your calendar" reply — it is never
treated as a provider error.

### Safe diagnostic endpoint

`GET /v1/me/integrations/google_calendar/diagnostic` (Clerk-authed, current user
only) runs the read path **one stage at a time** and returns booleans + the
failing stage + a single coded reason so the read path can be triaged **without
exposing any secret** — no token, encrypted value, raw Google payload, or OAuth
secret:

```json
{ "provider": "google_calendar", "connected": true, "credentialPresent": true,
  "credentialDecryptable": true, "scopeGranted": true, "accessTokenPresent": true,
  "refreshTokenPresent": true, "nodeFetchAvailable": true, "googleReachable": true,
  "calendarApiReachable": true, "primaryCalendarAccessible": true,
  "eventReadAccessible": true, "eventCount": 0, "errorStage": null,
  "errorCode": null, "safeErrorName": null, "safeCauseCode": null }
```

When a request throws **before** an HTTP response (so `errorCode` would otherwise
be an opaque `network_failure`), the diagnostic reports `errorStage`
(`"primary_calendar_request"` / `"event_list_request"`) plus the SAFE exception
name (`safeErrorName`, e.g. `"TypeError"`) and cause code (`safeCauseCode`, e.g.
`"ENOTFOUND"`). The same safe fields are logged server-side under
`googleCalendar.fetch exception` — never a token, header, body, or query value.

Provider errors are classified into safe codes (never the raw body). HTTP-response
errors: `google_calendar_api_disabled`, `insufficient_scope`, `token_refresh_failed`,
`invalid_grant`, `credential_decrypt_failed`, `calendar_not_found`,
`provider_rate_limited`, `provider_unavailable`, `malformed_provider_response`.
Pre-response transport errors (fetch threw, no status): `google_calendar_timeout`,
`dns_failure`, `connection_reset`, `connection_refused`, `connect_timeout`,
`malformed_request_url`, `invalid_request_headers`, and a generic `network_failure`.
A single valid auth failure (401) triggers exactly **one** token refresh + retry —
never an infinite loop. Each attempt gets a **fresh** `AbortController` with a
12s timeout, and GET requests carry **no body** (undici rejects a GET+body
synchronously, which previously surfaced as an unexplained `network_failure`).

**Manual real diagnostic (server-side, one connected user):**

```bash
cd server
# <id> is a Clerk user id OR a Hula user id; runs the REAL read path for that
# user and prints ONLY booleans, the failing stage, and safe error/cause codes.
npm run test:google-calendar-real -- <clerkUserId | hulaUserId>
```

Requires the server env (`DATABASE_URL`, `INTEGRATION_TOKEN_ENCRYPTION_KEY`,
`GOOGLE_OAUTH_*`). It never prints a token, encrypted credential, or raw Google
response body.

### Scope & limitations

- **Read-only.** Requested scope is `calendar.readonly`. Hula can read upcoming
  events, answer schedule questions from iMessage, and find your next meeting.
  It **cannot** create, edit, delete, or reschedule events yet — the UI says so.
- **No automations** and **no full marketplace** here — just the reusable screen
  foundation and Google Calendar. No Calendar write scopes or write actions.

### Google testing vs production

While the Google OAuth app is in **testing** mode, only Google accounts added as
**test users** in the Google Cloud console can complete consent. Moving to
general availability requires Google's **verification** (read-only sensitive
scopes still need review). The backend redirect URI must exactly match the one
registered in Google Cloud (e.g. your ngrok callback URL).

### Tests

- Frontend (pure, offline): run with the server's tsx from the repo root:
  - `./server/node_modules/.bin/tsx lib/integrationStatus.test.ts` — status
    mapping, connected/disconnected/expired/error states, transient `connecting`
    never masking backend truth, connected-sheet copy mapping, and the
    status-request coordination helpers (app-state transition, stale-response,
    dedupe).
  - `./server/node_modules/.bin/tsx lib/hulaApi.test.ts` — the connect call POSTs
    to the right endpoint with the Clerk bearer and return URL, maps a 400 to
    "not configured", and rejects a malformed response instead of "succeeding".
- Backend (offline, `npm test` in `server/`): the safe status shape exposes
  **no** token/scope credential fields; provider-error classification (API
  disabled 403, insufficient scope 403, 401/404/429/5xx); `googleCalendarGet`
  faked-HTTP behaviour (empty list = success, populated list, malformed body,
  network failure, **no token leakage**); the one-refresh-and-retry policy
  (expired→refresh→retry, invalid refresh token, persistent 401→invalid_grant);
  and safe app-return-URL validation (accepts app/Expo schemes, rejects arbitrary
  redirects). No test calls a real Google API.
