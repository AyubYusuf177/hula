Read AGENTS.md first and follow it strictly.

We are on the development branch.

We are implementing Section 14: Gmail read-only integration for Hula.

Repository:

* Path: ~/Desktop/hulaai
* Branch must remain: development
* Latest completed commit: bef6c45 Add Google Calendar app integration

Verified prerequisites:

* Gmail API is enabled in the same Google Cloud project used for Google Calendar
* https://www.googleapis.com/auth/gmail.readonly has been added to the OAuth consent configuration
* The development Google account is listed as an OAuth test user
* The existing OAuth client now includes this additional authorized redirect URI:
  https://handiest-brielle-unurgently.ngrok-free.dev/v1/integrations/gmail/callback
* server/.env contains GMAIL_OAUTH_REDIRECT_URI with that exact value
* Do not open, print, cat, grep, display, or expose the .env file or any secret value

Approved architecture decisions:

1. Gmail provider id is:
   gmail

2. Google Calendar provider remains:
   google_calendar

3. Gmail and Google Calendar must use separate:

   * integration connection records
   * provider identities
   * credentials
   * granted scopes
   * statuses
   * diagnostics
   * OAuth callbacks
   * provider clients
   * user-facing cards
   * error states

4. Use a separate Gmail OAuth callback route:
   /v1/integrations/gmail/callback

5. Use:
   GMAIL_OAUTH_REDIRECT_URI

6. Do not edit or replace the working Calendar callback.

7. Gmail catalog status:
   available_readonly

8. Gmail catalog capabilities:
   ["email.read"]

9. Do not advertise email draft or send capabilities.

10. Build:
    GET /v1/me/integrations/gmail/messages

11. No Prisma migration is expected. Use the existing generic integration connection architecture unless repository inspection proves it cannot represent Gmail correctly.

Primary goal:
A user connects Gmail from the Hula mobile app through Google OAuth. Hula stores the Gmail credentials encrypted on the backend. The user can then text Hula through iMessage:

“Do I have any important emails?”

Hula must answer using only real Gmail data.

Scope:
READ ONLY.

Required OAuth scope:
https://www.googleapis.com/auth/gmail.readonly

Never request:

* gmail.modify
* gmail.send
* gmail.compose
* https://mail.google.com/

Explicitly forbidden:

* sending email
* drafting email
* replying
* forwarding
* deleting
* trashing
* archiving
* modifying labels
* marking read
* marking unread
* starring
* attachment download
* attachment metadata retrieval unless unavoidable in a base Gmail response and discarded immediately
* full email body retrieval
* raw MIME retrieval
* format=full
* format=raw
* Gmail push notifications
* background inbox monitoring
* destructive actions

Implementation requirements:

A. Provider registration

* Add Gmail to the existing provider catalog/registry.
* Provider id must be gmail.
* Status must be available_readonly.
* Capabilities must be exactly ["email.read"].
* Calendar connection state must never count as Gmail connection state.
* Gmail connection state must never overwrite Calendar connection state.

B. OAuth

* Reuse existing secure Google OAuth primitives only where they are genuinely provider-agnostic.
* Preserve the current working Calendar implementation.
* Use the existing Google client ID and client secret configuration.
* Use GMAIL_OAUTH_REDIRECT_URI for Gmail.
* Request gmail.readonly and only the identity scopes genuinely required by the existing OAuth architecture.
* Verify granted Gmail scope by membership, not brittle exact-string equality.
* Use existing PKCE, OAuth state, encrypted credential storage and app return URL validation where safe.
* Gmail must have its own connect and callback route.
* Handle a user who already connected Calendar but has not granted Gmail access.
* Do not treat Calendar tokens or Calendar scope as a Gmail connection.
* Preserve refresh-token handling.
* Preserve safe invalid_grant handling.
* Never expose tokens in errors, responses or logs.

C. Gmail API client
Initial list endpoint:

GET https://gmail.googleapis.com/gmail/v1/users/me/messages

Use constrained parameters:

* labelIds=INBOX
* maxResults=20
* q=newer_than:7d

Retrieve selected messages using:

GET https://gmail.googleapis.com/gmail/v1/users/me/messages/{messageId}

Use:

* format=metadata
* metadataHeaders=From
* metadataHeaders=Subject
* metadataHeaders=Date

Do not request:

* format=full
* format=raw
* message bodies
* attachments
* unnecessary headers

Limit API fan-out:

* list at most 20 recent inbox message IDs
* fetch metadata only for the limited selected set
* do not recursively fetch threads or attachments
* do not retrieve full mailbox totals for the initial milestone unless the API response already supplies safe estimates

Safe normalized output only:

* internal Gmail message id
* internal Gmail thread id
* sender name/address
* subject
* received timestamp
* unread boolean
* Gmail IMPORTANT label boolean
* useful category/system labels
* short Gmail-provided snippet

Normalization must whitelist fields.

Do not return:

* body data
* raw MIME
* payload parts
* attachment IDs or data
* Authorization headers
* access tokens
* refresh tokens
* complete raw headers
* unnecessary Gmail response properties

D. Token refresh and errors

* Follow the working Calendar provider’s secure refresh-and-retry approach where appropriate.
* Retry once after an authenticated 401 when refresh succeeds.
* Map invalid_grant to reconnect-required status.
* Map missing Gmail scope safely.
* Handle:

  * 401
  * 403
  * 404
  * 429
  * 5xx
  * timeout
  * DNS failure
  * connection reset
  * malformed response
* Return safe provider error codes.
* Do not leak upstream response bodies when they may contain sensitive data.

E. Gmail question classification
Support these questions:

* “Do I have any important emails?”
* “Any important emails?”
* “What are my latest emails?”
* “What emails did I get today?”
* “Do I have any unread emails?”

Create deterministic Gmail intents for:

* important
* latest
* today
* unread

Requirements:

* Gmail questions must intercept before general Anthropic generation.
* A supported Gmail question must never fall through as handled:false.
* Normal conversations must not be classified as Gmail requests.
* Do not let the model invent or infer inbox contents.
* Use deterministic logic for this milestone.

F. Likely-important policy
Use deterministic signals approximately equivalent to:

Positive:

* +5 Gmail IMPORTANT label
* +3 unread
* +2 received within 24 hours
* +2 action-oriented subject
* +2 direct-looking sender or business communication

Negative:

* -3 CATEGORY_PROMOTIONS
* -3 CATEGORY_SOCIAL
* -2 newsletter or bulk indicators
* -2 promotional no-reply patterns

Action-oriented subject terms may include:

* urgent
* action required
* interview
* appointment
* deadline
* payment
* invoice
* account
* confirmation
* verification
* application
* offer
* security
* booking
* document
* response required

Use a documented deterministic threshold.

Never claim certainty.

Allowed language:

* looks important
* likely important
* may need your attention

Never use:

* definitely important

G. User-facing responses
Keep responses concise for iMessage.

Disconnected:
“Your Gmail isn’t connected yet. Connect it from Hula → Integrations → Gmail.”

Reconnect required:
“Your Gmail access needs reconnecting. Open Hula → Integrations → Gmail.”

Temporary provider failure:
“I couldn’t check Gmail right now. Your connection still appears active, so try again shortly.”

No important messages:
“I couldn’t find any recent emails that clearly look important.”

Likely-important messages:
“You have 3 recent emails that look important:

1. Sender — Subject
   Received today at 10:42 AM. Unread.”

Latest:
“Here are your latest emails:

1. Sender — Subject
2. Sender — Subject”

Unread:
“You have 4 unread emails in your recent inbox.”

Today:
List only messages that match the user’s effective local date using the project’s existing timezone/profile architecture where available.

Do not fabricate summaries beyond the sender, subject, timestamp, unread state and safe Gmail snippet.

H. Authenticated messages endpoint
Build:

GET /v1/me/integrations/gmail/messages

Requirements:

* Require the same authenticated user mechanism as the Calendar events endpoint.
* Return only normalized safe Gmail metadata and snippets.
* Use small bounded limits.
* Do not expose credentials or raw Gmail responses.
* Return safe disconnected, reconnect-required and provider-failure errors.
* Do not add mutation methods.

I. Real diagnostic
Create a real Gmail diagnostic equivalent to the Calendar diagnostic.

Preferred command:

npm run test:gmail-real -- <userId>

It should report only safe booleans and coded states:

* connected
* credentialPresent
* credentialDecryptable
* scopeGranted
* accessTokenPresent
* refreshTokenPresent
* nodeFetchAvailable
* googleReachable or gmailReachable
* inboxListAccessible
* metadataReadAccessible
* safeMessageCount
* errorStage
* errorCode
* safeErrorName
* safeCauseCode

Never print:

* sender
* subject
* snippet
* message IDs
* tokens
* credentials
* headers
* email content

An empty inbox must be treated as a successful result.

J. Mobile integration flow
Reuse the existing integrations design and components.

Expected flow:
Integrations
→ Gmail card
→ details sheet
→ Connect Gmail
→ backend OAuth URL
→ system browser
→ Google consent
→ backend callback
→ Expo app return
→ refresh backend status
→ Gmail card displays Connected only after backend confirmation

Requirements:

* Preserve Expo Go compatibility.
* Do not install native-only packages.
* Reuse existing integration card, details sheet and status handling.
* Gmail card must not imply draft/send functionality.
* Display read-only wording honestly.
* Do not mark connected based only on browser return.
* Status must come from the backend.
* Preserve the existing Google Calendar card and flow.

Use a local Gmail integration image if an appropriate asset already exists or can be safely added using the project’s existing asset conventions.
Do not perform a broad redesign.

K. Expected file structure
The plan suggested a provider folder similar to:

server/src/integrations/providers/gmail/

Likely files:

* oauth.ts
* client.ts
* messages.ts
* gmailQuestion.ts
* importance.ts
* diagnostic.ts

Likely route:

* server/src/routes/gmail.ts

Likely scripts:

* server/scripts/gmail.test.ts
* server/scripts/gmailRealDiagnostic.ts

These names may be adjusted if the repository architecture clearly indicates a better existing convention.

Keep edits additive and narrowly scoped.

Do not edit existing Google Calendar provider files unless an unavoidable provider-agnostic bug is found. If that happens:

* stop before making the Calendar edit
* explain exactly why it is required
* identify the precise file and risk

L. Tests
Add comprehensive automated tests covering:

Provider and OAuth:

* Gmail exists in registry
* provider id is separate from Google Calendar
* exact Gmail readonly scope
* no Gmail write scopes in OAuth URL
* callback stores Gmail connection
* Gmail does not overwrite Calendar
* Calendar does not count as Gmail
* encrypted credentials
* granted scope verification
* app return URL safety
* safe not-configured behaviour

API:

* list request uses INBOX
* list request uses a bounded maxResults
* list request uses newer_than:7d
* metadata request uses format=metadata
* only From, Subject and Date headers are requested
* no format=full
* no format=raw
* no attachment endpoint
* safe normalization
* empty inbox
* malformed response
* refresh and retry after 401
* invalid_grant
* 403 scope issue
* 404
* 429
* 5xx
* timeout
* DNS failure
* connection reset
* no token leakage

Classification:

* all five required questions classify correctly
* important intent
* latest intent
* today intent
* unread intent
* normal conversation returns no Gmail intent
* supported Gmail requests do not fall through to the model
* promotions are downranked
* social messages are downranked
* unread is detected
* IMPORTANT label is detected
* recent messages are handled correctly

Formatting:

* no messages
* likely-important list
* latest list
* today list
* unread count
* disconnected
* reconnect required
* transient provider failure
* wording uses likely/looks important
* the word “definitely” never appears

Privacy:

* no full body
* no raw MIME
* no attachments
* no Authorization header
* no access token
* no refresh token
* no complete header collection
* no credential data in normalized output
* no secret substrings in errors or logs

Regression:

* existing Google Calendar tests continue to pass
* existing integration foundation tests continue to pass
* existing action/message pipeline tests continue to pass
* existing memory and reminder behaviour must not be changed

M. Validation
After implementation, run the appropriate available commands, including:

Root:

* npm run lint
* npx tsc --noEmit

Backend:

* npm run typecheck
* npm run build
* npm test
* npm run prisma:generate
* npx prisma migrate status

Also run:

* Gmail-specific automated tests
* existing Google Calendar automated tests

Do not run the real Gmail diagnostic until the user has completed the Gmail OAuth connection.

Do not run the real Calendar diagnostic if it requires external credentials unavailable to the current process. Instead clearly tell Ayub which real diagnostic must be run manually.

N. Git and safety constraints

* Do not commit
* Do not push
* Do not stage files
* Do not use git add -A
* Do not alter Git history
* Do not switch branches
* Do not expose .env contents
* Do not expose secrets
* Do not delete working functionality
* Do not perform unrelated refactors
* Do not claim the Gmail integration works end-to-end until it has been tested through the real Hula app and iMessage path

At completion, output:

A. Architecture implemented
B. Exact files created
C. Exact files modified
D. Database/migration decision
E. Security and privacy guarantees
F. Automated validation results
G. Manual Google OAuth and Expo test steps
H. Real Gmail diagnostic command
I. Calendar regression checks still required
J. Git status summary
K. Any blockers or incomplete items

Do not commit.
Do not push.
