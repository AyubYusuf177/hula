Read AGENTS.md first and follow it strictly.

We are on the development branch.

We are starting Section 14: Gmail read-only integration for Hula.

Repository:

* Path: ~/Desktop/hulaai
* Branch must remain: development
* Latest completed commit: bef6c45 Add Google Calendar app integration

Confirmed Google Cloud preparation:

* Gmail API is enabled in the same Google Cloud project used for Google Calendar
* https://www.googleapis.com/auth/gmail.readonly has been added
* The development Google account remains an OAuth test user

Constraints:

* Expo Go compatibility only
* Do not install native-only packages
* Do not edit any files during this task
* Do not create a commit
* Do not push
* Do not open, print, cat, grep, or expose any .env file
* Never expose access tokens, refresh tokens, Authorization headers, client secrets, encrypted credentials, database URLs, Clerk tokens, Sendblue secrets, Anthropic keys, or vault keys
* Do not use git add -A
* Preserve the existing working Google Calendar integration
* Reuse existing integration, OAuth, vault, policy, action-runtime, API-client, diagnostics, routing, and UI architecture where appropriate
* Make the smallest coherent production-quality implementation plan

Current verified state:

* Branch: development
* Working tree: clean
* HEAD and origin/development: bef6c45 Add Google Calendar app integration
* Real Google Calendar diagnostic passes
* Calendar connection, encrypted credentials, scope, token refresh, Google reachability, primary calendar access, and event reads are working
* An empty calendar is treated as a successful result

Goal:
A user connects Gmail in the Hula mobile app through Google OAuth. Hula stores credentials encrypted on the backend. The user can then text Hula through iMessage:

“Do I have any important emails?”

Hula reads recent Gmail inbox messages and gives an honest, concise answer based only on real Gmail data.

Scope:
READ ONLY.

Provider identity:

* Preferred Gmail provider id: gmail
* Existing Calendar provider id: google_calendar
* Gmail and Google Calendar must remain separate connection records
* Connecting Gmail must not overwrite Calendar credentials, scopes, status, diagnostics, or connection state
* An existing Calendar connection must not count as Gmail being connected

Required OAuth scope:
https://www.googleapis.com/auth/gmail.readonly

Do not request:

* gmail.modify
* gmail.send
* gmail.compose
* https://mail.google.com/

Explicitly forbidden:

* sending emails
* drafting emails
* replying
* forwarding
* deleting
* trashing
* archiving
* modifying labels
* marking read or unread
* starring
* attachment download
* full email body retrieval
* raw MIME retrieval
* Gmail push notifications
* background inbox monitoring
* purchases
* destructive actions

First task only:
Inspect the repository and produce a concise implementation plan.

Inspect:

* AGENTS.md
* current branch and working tree
* root and server package files
* Prisma schema and migrations
* integration registry/catalog
* Google Calendar OAuth implementation
* encrypted credential vault
* OAuth state implementation
* PKCE utilities
* app return URL handling
* connection records and status API
* integration routes
* action registry and executor
* Sendblue webhook
* command/message routing pipeline
* deterministic handlers that intercept before general Anthropic generation
* integration UI data and components
* current automated tests
* current real diagnostic scripts
* existing safe provider error handling
* existing Google Calendar token refresh and retry implementation

Determine:

1. Whether Gmail should use provider id gmail.
2. How much Google OAuth code can safely be reused without destabilizing Calendar.
3. How to preserve separate Calendar and Gmail connection records, credentials, statuses and scopes.
4. How Gmail consent should work when Calendar is already connected but its grant lacks Gmail access.
5. Whether incremental authorization parameters are needed.
6. Exact Gmail API endpoints and query parameters.
7. How to retrieve only metadata and short Gmail snippets.
8. How to prevent full body, raw MIME and attachment retrieval by construction.
9. How to limit Gmail API fan-out.
10. Deterministic likely-important scoring.
11. Exact files to create and modify.
12. Whether a Prisma migration is needed.
13. Automated test plan.
14. Real diagnostic plan.
15. Safe logging rules.
16. Mobile Gmail card implementation.
17. How Gmail questions intercept before general model generation.
18. Any risk of breaking existing Calendar OAuth, credentials or connection state.
19. How status refresh should work after the browser returns to Expo Go.
20. Whether shared Google OAuth helpers should be extracted now or whether provider-local reuse is safer for this milestone.

Initial Gmail list request should be based on:

GET https://gmail.googleapis.com/gmail/v1/users/me/messages

Use initial constraints similar to:

* labelIds=INBOX
* maxResults approximately 20
* q=newer_than:7d

Selected messages should then be retrieved from:

GET https://gmail.googleapis.com/gmail/v1/users/me/messages/{messageId}

Use:

* format=metadata
* metadataHeaders=From
* metadataHeaders=Subject
* metadataHeaders=Date

Safe normalized fields only:

* internal Gmail message id
* internal Gmail thread id
* sender name/address
* subject
* received timestamp
* unread boolean
* Gmail IMPORTANT label boolean
* useful category or system labels
* short Gmail-provided snippet

Do not retrieve:

* format=raw
* format=full
* complete message body
* attachment data
* full MIME payload
* unnecessary headers

Questions required:

* “Do I have any important emails?”
* “Any important emails?”
* “What are my latest emails?”
* “What emails did I get today?”
* “Do I have any unread emails?”

The Gmail handler must intercept supported Gmail questions before general Anthropic generation.

The model must not invent inbox content.

The first implementation should use deterministic classification and ranking rather than asking the model to decide what the inbox contains.

Potential likely-important score:

* +5 Gmail IMPORTANT label
* +3 unread
* +2 received within 24 hours
* +2 action-oriented subject
* +2 direct-looking sender or business communication
* -3 CATEGORY_PROMOTIONS
* -3 CATEGORY_SOCIAL
* -2 newsletter or bulk indicators
* -2 promotional no-reply patterns

Potential action-oriented words:

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

User-facing language must not claim certainty.

Use language such as:

* “looks important”
* “likely important”
* “may need your attention”

Do not say:

* “This is definitely important”

Expected disconnected response:
“Your Gmail isn’t connected yet. Connect it from Hula → Integrations → Gmail.”

Expected invalid-grant response:
“Your Gmail access needs reconnecting. Open Hula → Integrations → Gmail.”

Expected temporary failure response:
“I couldn’t check Gmail right now. Your connection still appears active, so try again shortly.”

Tests should cover at least:

Provider and OAuth:

* Gmail exists in the integration registry
* provider id is separate from Google Calendar
* exact requested scope is gmail.readonly
* OAuth URL does not request write scopes
* callback stores a Gmail connection
* Gmail connection does not overwrite Calendar
* Calendar connection does not count as Gmail
* credentials remain encrypted
* granted scope verification
* app return URL safety

API:

* list messages request
* metadata request
* safe fields only
* no full body retrieval
* no attachment retrieval
* empty inbox
* malformed response
* access token refresh and retry after 401
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

* important email question
* latest email question
* today email question
* unread email question
* normal conversation is not misclassified
* Gmail questions do not fall through to general model generation
* promotional downranking
* social downranking
* unread detection
* IMPORTANT label detection
* recent-message handling

Formatting:

* no messages
* likely-important list
* latest list
* unread count
* disconnected
* reconnect required
* temporary provider failure

Privacy:

* no full message body
* no raw MIME
* no Authorization header
* no access token
* no refresh token
* no complete raw headers
* no attachment data

Real diagnostic:

* provider connection exists
* credentials present
* credentials decryptable
* required scope granted
* access token present
* refresh token present
* Gmail reachable
* inbox list accessible
* metadata read accessible
* safe message count
* safe error stage
* safe error code

Likely new backend location:

server/src/integrations/providers/gmail/

Potential files:

* oauth.ts
* client.ts
* messages.ts
* gmailQuestion.ts
* importance.ts
* diagnostic.ts

Potential route:

* server/src/routes/gmail.ts

Potential tests and diagnostics:

* server/scripts/gmail.test.ts
* server/scripts/gmailRealDiagnostic.ts

Potential mobile asset:

* assets/images/integrations/gmail.png

Do not assume these names are correct until the repository has been inspected.

Prefer the existing generic integration connection table.

Do not introduce a Prisma migration unless the current schema cannot correctly represent a separate Gmail provider connection.

Output only:

A. Current architecture findings
B. Recommended implementation design
C. Exact file-by-file plan
D. Database and migration decision
E. Test plan
F. Security and privacy risks
G. Ambiguities or blockers requiring Ayub’s decision

Do not edit files.
Do not commit.
Do not push.
