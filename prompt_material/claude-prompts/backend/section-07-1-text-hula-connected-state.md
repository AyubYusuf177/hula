Read AGENTS.md first and follow it strictly.

We are on the development branch.

We are building a small Section 7.1 patch only: fix the Text hula connected-state UX.

Do not add integrations.
Do not add reminders.
Do not add billing.
Do not add WhatsApp.
Do not add chat history UI.
Do not add memory summaries.
Do not add tool/action execution.
Do not change onboarding screens.
Do not add onboarding questions.
Do not add frontend popups.
Do not add visible loading states unless already present and unavoidable.
Do not add new user-facing buttons.
Do not add new permissions.
Do not change auth.
Do not break Expo Go compatibility.
Do not commit.
Do not push.
Do not use git add -A.
Do not expose env values.
Do not open, print, cat, grep, or display server/.env.
Only inspect .env.example if needed.
Do not print API keys, Clerk secrets, Sendblue secrets, database URLs, Anthropic keys, or tokens.

Current confirmed state:
- Section 7 is committed and pushed.
- Latest commit is 27efcd1 Add silent Hula profile context sync.
- git status was clean before starting this patch.
- Hula can receive iMessages.
- Hula can link iMessage sender to Clerk user.
- Hula persists that link in Neon/Postgres.
- Hula can call Claude and reply through Sendblue.
- Hula now silently syncs profile/onboarding context from Home.
- Hula uses profile context in the brain prompt.
- Expo Go, ngrok, backend, Sendblue, Clerk, Neon, and Anthropic are all working.

Problem:
The Home screen “Text hula” button currently always creates a new link session and opens iMessage with a prefilled connect-code message, even if the user is already connected.

This is bad UX.

Correct behaviour:
1. If the signed-in user is NOT connected to an iMessage/SMS sender:
   - create a new one-time link session
   - open iMessage/SMS to Hula with the prefilled connect message:
     “Hey Hula, it's {firstName}. Connect my account: HULA-XXXX”

2. If the signed-in user IS already connected:
   - do NOT create a new link session
   - do NOT generate a new code
   - do NOT prefill the connect text
   - simply open the existing Messages thread to Hula’s number

Important:
The HULA-XXXX code should remain random, temporary, and one-time-use.
Do not make it constant per account.
The bug is that the app keeps generating new codes after the user is already linked.

Patch requirements:

1. Add backend messaging status endpoint.

Add an authenticated endpoint such as:

GET /v1/me/messaging-status

Auth:
- Require Clerk bearer token.
- Verify using existing Clerk middleware.
- Resolve/create internal User from Clerk token sub.
- Query MessagingIdentity for that user.

Response shape should be simple, for example:
{
  "imessage": {
    "connected": true,
    "provider": "sendblue",
    "linkedAt": "...",
    "handleDisplay": "+*******6078" or null
  }
}

If not connected:
{
  "imessage": {
    "connected": false,
    "provider": "sendblue",
    "linkedAt": null,
    "handleDisplay": null
  }
}

Safety:
- Do not expose full phone number if avoidable.
- Mask handleDisplay.
- Do not expose other users’ identities.
- Do not expose secrets.
- Do not expose raw provider data.

2. Add frontend API helper.

In lib/hulaApi.ts or the existing API helper file, add a typed function to fetch messaging status.

Do not add UI.

3. Update Text hula button logic.

In Home screen:
- When user taps Text hula:
  - get Clerk token
  - call /v1/me/messaging-status
  - if imessage.connected === true:
    - open Messages to Hula number only
    - no prefilled body
    - do not call /v1/link-sessions
  - else:
    - keep current link-session behaviour
    - create code
    - open prefilled connect text

Fallback:
- If status check fails, keep current safe connect-code behaviour.
- But log a safe dev warning only.
- Do not block user.
- Do not show popup.

4. Keep Add hula to Contacts unchanged.

Do not alter contact flow unless necessary.

5. Tests.

Add/update tests for:
- messaging status endpoint/helper if backend testable
- connected user returns connected true
- unconnected user returns connected false
- response masks handle
- Text hula logic chooses no-prefill open when connected if frontend helper is testable
- Text hula logic chooses connect-code flow when unconnected
- existing tests still pass

Do not require real Sendblue, Anthropic, or Clerk calls in normal tests.

6. README update.

Add a short Section 7.1 note:
- Text hula now checks whether the user is already connected.
- If connected, it opens the Hula thread without generating a new code.
- If not connected, it generates a one-time link code.
- One-time codes remain temporary and random.
- No new UI or user action added.

7. Validation commands.

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

Manual test:
1. Start backend.
2. Start ngrok.
3. Start Expo.
4. Make sure the current iMessage sender is already connected.
5. Tap Text hula.
6. Expected:
   - Messages opens to Hula.
   - No prefilled connect-code text appears.
   - No new HULA-XXXX code appears.
7. Send a normal text:
   “Testing after connected-state fix”
8. Expected:
   Hula replies with Claude-generated response.
9. Optional unconnected test:
   - Sign in as a fresh test account or clear link state only if safe.
   - Tap Text hula.
   - Expected: prefilled connect text with new HULA-XXXX code.
   - Do not delete real user data.

Final response:
1. Files changed
2. Endpoint added
3. Exact response shape
4. How Text hula logic changed
5. How existing connected users are handled
6. How unconnected users are handled
7. Test results
8. Manual test results
9. Confirm no reminders/integrations/billing/WhatsApp/frontend UI/chat-history UI/memory summaries/tool execution were added
10. Confirm no commit was made