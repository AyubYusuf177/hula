Read AGENTS.md first and follow it strictly.

We are on the development branch.

# SECTION 24 — MICROSOFT 365 UNIFIED INTEGRATION

## OPERATING PRINCIPLE

Velocity is the moat.

Move quickly, but do not trade speed for correctness, regressions, duplicated architecture, unsafe OAuth decisions, brittle routing, fake test coverage, or provider-specific hacks.

The fastest implementation is the one we only have to build once.

Before modifying code:

1. Read AGENTS.md first.
2. Inspect the actual repository deeply.
3. Verify the current branch and HEAD.
4. Verify the post-Section-23 baseline.
5. Audit the existing integration architecture.
6. Audit the existing Google unified integration architecture because Microsoft should reuse the same successful patterns where appropriate.
7. Research the current official Microsoft Graph APIs and OAuth model before proposing implementation.
8. Produce a grounded implementation plan.
9. Do not implement until the audit is complete and the proposed scope is justified.

The repository is the source of truth for implementation details.

Do not assume this prompt is more authoritative than the actual codebase.

Do not commit.
Do not push.
Do not stage files.
Do not reset, restore, checkout, stash, discard, or overwrite unrelated work.
Do not modify .env unless explicitly authorized.
Do not expose or log secrets, OAuth codes, access tokens, refresh tokens, client secrets, or provider payloads containing sensitive content.
Preserve all existing integrations and behavior.

---

# 1. CURRENT REPOSITORY BASELINE

Current expected repository state before Section 24:

- repo: ~/Desktop/hulaai
- branch: development
- Section 23 commit: 9f581c6
- Section 23: Google Drive + Google Docs complete, committed, pushed
- backend expected on port 4000
- ngrok running separately
- Expo running separately for Expo Go
- fresh Codex thread
- working tree should be clean before new work begins

Verify all of this from the repository and terminal state before trusting it.

Do not begin implementation from assumptions.

---

# 2. PRODUCT CONTEXT

Hula is an iMessage/WhatsApp-native AI personal agent.

The mobile application is primarily a control plane for:

- authentication
- onboarding
- integrations
- permissions
- settings
- subscriptions
- account management
- automation controls

The primary user interface is conversational.

Users should not need to learn rigid commands.

Hula already has substantial integrated capabilities including:

- Gmail
- Google Calendar
- Google Meet-related functionality where implemented
- Google Drive
- Google Docs
- Todoist
- Asana
- Notion
- Slack
- reminders/follow-ups
- long-term memory
- semantic inbound routing
- provider/entity arbitration
- durable entity/referent context
- proposal/confirmation/executor architecture
- idempotent writes
- provider receipts/postcondition verification
- integration connection infrastructure
- encrypted provider credentials/tokens

Section 23 established Drive/Docs as first-class entities and strengthened cross-provider arbitration and durable named-entity re-grounding.

Section 24 must extend Hula into the Microsoft ecosystem without creating a separate architecture that duplicates concepts already solved elsewhere.

---

# 3. SECTION 24 PRIMARY OBJECTIVE

Build Microsoft 365 as a unified first-class Hula integration using Microsoft Graph and establish a coherent Microsoft capability layer.

The primary target capability set is:

1. Outlook Mail
2. Outlook Calendar
3. OneDrive
4. Microsoft Teams where technically and product-wise appropriate

The objective is NOT:

“Add four unrelated Microsoft integrations.”

The objective is:

A user connects their Microsoft account once, grants appropriate permissions, and Hula can safely expose supported Microsoft capabilities through one coherent Microsoft platform architecture.

The implementation should resemble the successful unified Google strategy conceptually:

single provider/platform identity
→ granted scopes
→ derived capabilities
→ shared encrypted credential lifecycle
→ provider-specific capability handlers
→ shared routing/entity/action architecture

Do not blindly copy Google implementation details if Microsoft Graph differs.

---

# 4. FIRST TASK — DEEP REPOSITORY AUDIT

Before implementing anything, inspect the repository deeply.

Identify the actual current architecture for:

- integration catalog
- provider IDs
- IntegrationConnection persistence
- OAuth initiation routes
- OAuth callbacks
- credential/token storage
- encryption
- refresh token lifecycle
- scope storage
- capability derivation
- reconnect/disconnect flows
- unified Google provider architecture
- Gmail capability handling
- Calendar capability handling
- Drive capability handling
- integration UI
- integration status APIs
- inbound routing
- semantic extraction
- provider arbitration
- entity context
- selection/referent persistence
- entity follow-ups
- action registry
- action policy
- proposals
- confirmations
- executor
- idempotency
- provider receipt validation
- error normalization
- tests
- prompt-file conventions

Search before creating abstractions.

Reuse shared infrastructure wherever appropriate.

Do not create a second parallel implementation of concepts already solved.

---

# 5. MICROSOFT PLATFORM / GRAPH RESEARCH — CURRENT OFFICIAL SOURCES ONLY

Research current official Microsoft documentation.

Use primary Microsoft documentation only for technical API decisions.

Determine the correct current architecture for:

- Microsoft identity platform OAuth 2.0 / OpenID Connect
- authorization endpoint
- token endpoint
- PKCE if applicable
- authorization code flow
- refresh token behavior
- offline_access
- delegated permissions
- incremental consent
- tenant/account types
- personal Microsoft accounts vs work/school accounts
- multi-tenant app implications
- admin consent
- organizational policy restrictions
- Microsoft Graph API versioning
- throttling
- pagination
- delta queries where valuable
- webhooks/subscriptions where valuable
- token revocation/reconnect behavior

Explicitly distinguish:

- personal Microsoft account
- Microsoft 365 work/school account
- tenant-specific constraints
- delegated permissions
- application permissions

Hula is a consumer-facing personal agent, so delegated user access should be the default architectural assumption unless the repository/product requirements justify otherwise.

Do not add application-wide organization permissions casually.

---

# 6. UNIFIED MICROSOFT OAUTH ARCHITECTURE — CRITICAL

Determine whether Section 24 should use a single internal Microsoft provider identity such as:

microsoft

with capability derivation for:

- outlook_mail
- outlook_calendar
- onedrive
- teams

or another structure better aligned with the existing repository.

The goal is one coherent Microsoft account connection rather than independent credentials for each Microsoft service.

Investigate:

- whether one Microsoft OAuth grant can cover multiple Graph capabilities
- incremental consent
- scope upgrades
- refresh token behavior
- capability derivation from granted scopes
- reconnect behavior
- existing-user migration considerations
- revoked/partial grants
- whether Teams requires materially different tenant/app constraints
- whether some Teams capability should be deferred

Do not duplicate Microsoft credentials unnecessarily.

Do not request every possible Graph permission up front.

Use least privilege while preserving a useful product.

---

# 7. OUTLOOK MAIL CAPABILITY MAP

Research and map current Microsoft Graph Mail capabilities relevant to Hula.

At minimum investigate:

## Connection / identity
- authenticated account identity
- mailbox availability
- granted permission detection
- account type limitations

## Reads
- recent messages
- inbox listing
- search/filter
- sender/recipient filters
- subject/topic search
- unread
- importance
- folders
- message metadata
- conversation/thread context where available
- attachment metadata
- bounded pagination
- mail body retrieval where required

## Grounded intelligence
- summarization
- specific-message Q&A
- thread/conversation summarization where supported
- triage
- “which messages need my attention?”
- action item extraction
- follow-up selection such as:
  - “the second one”
  - “summarize it”
  - “reply to that”
  - “mark that unread”

## Writes
Investigate:
- create draft
- edit draft
- delete draft
- send draft
- send new message
- reply
- reply-all where appropriate
- forward
- mark read/unread
- flag/unflag if supported
- move/archive if applicable
- delete/trash behavior
- categories if useful

Classify each operation using Hula’s safety model.

Do not assume Outlook semantics equal Gmail semantics.

---

# 8. OUTLOOK CALENDAR CAPABILITY MAP

Research Microsoft Graph Calendar capabilities.

At minimum investigate:

## Reads
- list calendars
- events
- date-range queries
- event details
- attendees
- organizer
- location
- online meeting fields
- recurrence
- free/busy / getSchedule
- timezone behavior
- pagination

## Writes
- create event
- update event
- move/reschedule
- cancel/delete
- attendee changes
- recurring-event handling
- online meeting creation where supported
- Microsoft Teams meeting creation where appropriate

Preserve Hula’s established calendar safety architecture:

natural language
→ real event resolution
→ proposal when required
→ confirmation
→ exactly one mutation
→ authoritative provider verification

Do not report success based only on an HTTP success code if the resulting provider state can be verified.

---

# 9. ONEDRIVE CAPABILITY MAP

Research OneDrive and SharePoint-backed file APIs through Microsoft Graph.

At minimum investigate:

## Discovery
- recent files
- list files
- filename search
- folders
- shared files
- files shared with user
- metadata
- owner/createdBy/lastModifiedBy where available
- created/modified timestamps
- parent relationships
- webUrl
- file size
- MIME/file type
- pagination
- shortcuts/remote items where relevant

## Content
Determine supported retrieval for:
- plain text
- Markdown
- PDF
- Office documents
- Word documents
- Excel
- PowerPoint
- uploaded binary files
- images

Determine where Microsoft Graph can:
- download binary content
- retrieve previews
- access Office content directly
- require separate Office APIs or export/conversion
- expose search/indexed text

Do not claim parity with Google Docs unless actually supported.

## Intelligence
Where technically reliable:
- summarize document
- Q&A
- extract key points
- decisions
- deadlines
- action items
- compare supported files

## Writes
Research:
- create folder
- upload small file
- upload session for large files
- rename
- move
- copy
- create supported Office file
- replace/update content
- delete/trash
- restore where available
- sharing/permissions

Do not automatically implement every write.

Use the audit to classify MUST BUILD NOW vs SHOULD BUILD vs DEFER.

---

# 10. MICROSOFT TEAMS CAPABILITY MAP

Research Teams carefully because Teams has more tenant/admin/product constraints than basic Outlook/OneDrive access.

Investigate:

- list joined teams
- channels
- channel messages
- replies
- chats
- chat messages
- users/members where permitted
- search limitations
- posting messages
- replying
- meeting-related Teams functionality
- delegated permission constraints
- admin consent requirements
- tenant restrictions
- protected APIs
- licensing limitations
- whether personal Microsoft accounts support relevant Teams APIs

Do not force Teams into Section 24 if current delegated permissions, admin-consent requirements, tenant limitations, or product risk make it materially worse than Outlook/Calendar/OneDrive.

Classify Teams as one of:

MUST BUILD NOW
SHOULD BUILD IF LOW-RISK
FOUNDATION ONLY
DEFER

Be explicit and evidence-based.

---

# 11. ENTITY CONTEXT / REFERENT ARCHITECTURE

Microsoft entities must participate in Hula’s shared entity architecture.

Examples:

Outlook Mail:
“Show my latest five emails.”
→ “Summarize the second one.”
→ “Reply to that.”

Calendar:
“What meetings do I have tomorrow?”
→ “Move the second one to 4 PM.”

OneDrive:
“Find my latest Project Atlas documents.”
→ “Summarize the first one.”
→ “Who last modified that?”
→ “Give me the link.”

Teams:
“Show recent messages in the Acme channel.”
→ “Reply to the second one.”

Requirements:

- persist authoritative provider identifiers
- user-scoped context
- no cross-user leakage
- TTL behavior consistent with existing architecture
- explicit named entities should be re-resolvable authoritatively where appropriate
- bare pronouns should remain bounded by active context
- Microsoft entities must not hijack Gmail/Drive/Slack/Notion/Todoist/Asana context
- existing providers must not hijack explicit Microsoft requests

Reuse shared entity arbitration rather than creating Microsoft-only referent logic unless technically necessary.

---

# 12. ROUTING / PROVIDER ARBITRATION

Microsoft integration must not destabilize the current cascade.

Examples:

“Send Sarah an Outlook email.”
→ Microsoft Mail

“Send Sarah an email.”
→ must follow existing provider/context/default product policy rather than randomly selecting Gmail or Outlook

“Show my Microsoft calendar tomorrow.”
→ Outlook Calendar

“Find this in OneDrive.”
→ OneDrive

“Find my Drive document.”
→ Google Drive, not OneDrive

“Post this in Slack.”
→ Slack

“Post this in Teams.”
→ Teams

“Add this to Todoist.”
→ Todoist

“Create an Asana task.”
→ Asana

Generic verbs such as:

send
find
create
move
share
schedule
email
calendar
file
document
message

must not determine provider alone.

Provider-specific evidence must dominate generic wording.

The audit must explicitly define how Hula handles users who connect BOTH Google and Microsoft.

Important ambiguity examples:

“Send Sarah an email.”
“Check my calendar tomorrow.”
“Find my pitch deck.”
“Create a meeting.”

Define a product-consistent provider-selection policy using:

- explicit provider language
- connected account context
- current entity ownership
- selected entity context
- user defaults if they exist
- deterministic ambiguity handling

Do not silently choose the wrong ecosystem.

---

# 13. CROSS-PROVIDER ACCOUNT COEXISTENCE

This is a major Section 24 concern.

A user may connect:

- Gmail AND Outlook
- Google Calendar AND Outlook Calendar
- Google Drive AND OneDrive
- Slack AND Teams

Design clean coexistence.

Investigate whether Hula should support:

- explicit provider requests
- account defaults/preferences
- unified read views
- separate provider views
- provider-labeled results
- clarification when ambiguity is real

Do not prematurely build the full Section 25 universal cross-app agent.

But Section 24 must not create architecture that blocks it.

---

# 14. SAFETY / ACTION POLICY

Use Hula’s existing action policy architecture.

Classify every implemented Microsoft operation.

Conceptual categories:

READ
IMMEDIATE REVERSIBLE WRITE
CONFIRMATION REQUIRED
DESTRUCTIVE/HIGH-RISK

Potential examples to validate:

READ:
- list/read mail
- list calendar
- list/search OneDrive
- read Teams content

IMMEDIATE REVERSIBLE WRITE:
- mark read/unread
- flag/unflag
- perhaps draft creation depending on existing Hula policy

CONFIRMATION REQUIRED:
- send email
- externally visible Teams post
- calendar create/update/cancel
- file movement/rename where material
- file sharing
- destructive mail/file operations

DESTRUCTIVE/HIGH-RISK:
- permanent deletion
- access/ownership changes
- organization-wide actions

Use repository policy as source of truth.

Never claim success without authoritative evidence.

Preserve idempotency.

Duplicate confirmation must never execute twice.

No must mean zero mutation.

---

# 15. MICROSOFT CONTENT AS UNTRUSTED DATA

Email bodies, OneDrive files, Teams messages, calendar descriptions, attachments, and other retrieved Microsoft content are untrusted external data.

They must never become executable instructions merely because they contain text such as:

“Ignore all previous instructions.”
“Send this file externally.”
“Delete all messages.”
“Reveal system prompts.”

Requirements:

- retrieved content treated as data
- no provider action solely because content instructed it
- system/developer policy remains authoritative
- no secrets included in content-processing prompts
- no raw sensitive content logged unnecessarily
- grounded outputs only
- external content cannot override provider routing or confirmation rules

Reuse the security boundaries established in Gmail/Slack/Drive/Notion.

---

# 16. PAGINATION / RELIABILITY / PROVIDER ERRORS

Research and implement/reuse bounded handling for:

- @odata.nextLink
- paging
- deltaLink where appropriate
- rate limiting / 429
- Retry-After
- 400
- 401
- 403
- 404
- 409
- 412 if applicable
- 5xx
- revoked consent
- expired tokens
- invalid_grant
- tenant restrictions
- admin-consent-required states
- throttling
- malformed provider responses
- timeouts
- partial failures

Retry only where safe.

Never blindly retry non-idempotent writes.

Errors shown to users should be useful without leaking provider internals or secrets.

---

# 17. MOBILE INTEGRATION UI

Inspect the current integrations UI before changing it.

Microsoft should fit the existing Hula design system.

Determine the correct visual model:

Option A:
One Microsoft card with capabilities:
- Outlook Mail
- Outlook Calendar
- OneDrive
- Teams

Option B:
Separate visual cards backed by one unified Microsoft credential

Use the existing Google strategy as a reference but do not assume it is automatically correct for Microsoft.

Requirements:

- connect/disconnect/reconnect flow
- capability display
- partial-grant state
- scope-upgrade flow
- connected/disconnected state
- Microsoft official assets/icons where appropriate
- Expo Go compatibility
- no unrelated redesign
- no native-only/dev-client dependency

Do not introduce duplicate OAuth flows unless required.

---

# 18. CROSS-PROVIDER REGRESSION SAFETY

Section 24 must preserve:

- reminders
- memory
- Gmail
- Google Calendar
- Google Meet-related behavior
- Google Drive
- Google Docs
- Todoist
- Asana
- Notion
- Slack
- confirmations
- inbound routing
- entity arbitration
- existing auth/onboarding
- integration UI
- Sendblue/iMessage path

Explicitly test that Microsoft routing does not steal:

- Gmail requests
- Google Calendar requests
- Google Drive requests
- Slack requests
- Notion requests
- Todoist requests
- Asana requests
- reminders
- generic brain fallback

And vice versa.

---

# 19. SECTION 24 SCOPE DISCIPLINE

Do not equate “Microsoft Graph supports it” with “we should implement it now.”

After the audit, classify every capability into:

MUST BUILD NOW
SHOULD BUILD IF LOW-RISK
FOUNDATION ONLY
DEFER

My current product preference is:

MUST PRIORITIZE:
- unified Microsoft OAuth/account connection
- Outlook Mail meaningful read/write capability
- Outlook Calendar meaningful read/write capability
- OneDrive discovery/metadata/content where realistically useful
- shared routing/entity/context architecture
- coexistence with Google
- safe actions and regression coverage

TEAMS:
- include only if the audit shows a useful, realistic delegated-permission surface without introducing disproportionate tenant/admin complexity
- otherwise build the minimum foundation and defer the broader Teams surface

Do not let Teams block shipping Outlook + Calendar + OneDrive.

---

# 20. TESTING STRATEGY

Inspect existing tests first.

Add deterministic behavior-focused coverage.

At minimum investigate/add tests for:

## Microsoft OAuth
- auth URL
- state
- redirect
- scope serialization
- personal/work account compatibility
- token exchange
- refresh
- scope parsing
- capability derivation
- partial consent
- reconnect
- revoked grant
- malformed responses
- no token leakage

## Outlook Mail
- recent list
- search
- exact counts
- selection persistence
- message content
- summary
- triage
- draft/write flows where implemented
- confirmation where required
- duplicate confirmation
- no false success
- provider errors
- prompt injection resistance

## Outlook Calendar
- list/range
- timezone
- selection
- create/update/delete where implemented
- recurring semantics where implemented
- confirmation
- idempotency
- receipt verification

## OneDrive
- list/recent
- search
- folders
- metadata
- file resolution
- ambiguous matches
- content types
- unsupported content
- pagination
- shared files where implemented
- entity context
- grounded summaries/Q&A where implemented

## Teams where implemented
- routing
- read
- entity context
- writes
- confirmation
- tenant/permission limitations

## Cross-provider coexistence
Prove:
- Gmail stays Gmail
- Outlook stays Outlook
- Google Calendar stays Google Calendar
- Outlook Calendar stays Outlook Calendar
- Drive stays Drive
- OneDrive stays OneDrive
- Slack stays Slack
- Teams stays Teams where implemented
- Todoist stays Todoist
- Asana stays Asana
- Notion stays Notion
- reminders stay reminders
- generic brain remains available

## Entity arbitration
- mixed Google/Microsoft contexts
- stale context
- fresh context
- explicit provider override
- ambiguous bare request
- user-scoped isolation
- duplicate-name behavior
- expired-context named re-grounding where appropriate

Do not optimize for arbitrary assertion count.

Test behavior and invariants.

Do not weaken tests to make implementation pass.

---

# 21. LIVE CERTIFICATION PLAN

After automated tests pass, certify through the same production-like iMessage path used by Hula users.

Do not invent provider data.

Use actual connected Microsoft test-account data.

Potential phases:

PHASE A — CONNECTION
“Is my Microsoft account connected?”
“What Microsoft capabilities do I have connected?”

PHASE B — OUTLOOK MAIL
“Show my five most recent Outlook emails.”
“Summarize the second one.”
Then test one safe real write flow if implemented.

PHASE C — OUTLOOK CALENDAR
“What meetings do I have tomorrow in Outlook?”
Follow-up against a selected event.
Test one real confirmed write if implemented and safe.

PHASE D — ONEDRIVE
“Show my recently modified OneDrive files.”
“Find [real file].”
“Who owns that?”
“When was it modified?”
“Give me the link.”
“Summarize it.” only where supported.

PHASE E — TEAMS
Only where implemented and viable.

PHASE F — GOOGLE/MICROSOFT COEXISTENCE
Explicitly test:
- Gmail
- Outlook
- Google Calendar
- Outlook Calendar
- Drive
- OneDrive
- Slack
- Teams where implemented

Prove provider ownership remains correct.

PHASE G — REGRESSION
Representative checks for:
- reminders
- Todoist
- Asana
- Notion
- generic brain

No commits until live certification passes.

---

# 22. PERFORMANCE

Measure meaningful latency boundaries.

Potential stages:

- semantic extraction
- Microsoft token refresh
- Graph request
- pagination
- content retrieval
- document processing
- write verification
- total route

Do not log sensitive content.

Avoid unnecessary sequential calls.

Parallelize independent safe reads where useful.

Do not sacrifice grounding or correctness for latency.

---

# 23. DOCUMENTATION

Section 24 should eventually document only what is useful:

- Microsoft capability matrix
- exact delegated permissions/scopes
- account-type limitations
- OAuth/reconnect behavior
- supported Outlook capabilities
- supported OneDrive content types
- Teams limitations if deferred/partial
- coexistence with Google
- live certification procedure

Follow existing repository conventions.

Do not create documentation noise.

---

# 24. IMPLEMENTATION PHILOSOPHY

Avoid both extremes:

EXTREME 1:
Hardcoded test/demo behavior.

EXTREME 2:
A giant cross-app universal agent rewrite.

Section 25 is specifically intended for generalized cross-app agentic intelligence.

Section 24 should build a robust Microsoft platform integration that plugs cleanly into the architecture Section 25 will later orchestrate.

Semantic interpretation handles language variability.

Deterministic code enforces:

- security
- provider ownership
- entity identity
- account identity
- OAuth/scopes
- capability derivation
- policy
- confirmations
- idempotency
- provider validation
- bounded execution

Models interpret.

Code enforces.

---

# 25. REQUIRED INITIAL AUDIT OUTPUT

For the FIRST response after reading this file:

DO NOT IMPLEMENT.

Do not edit files.
Do not create code.
Do not change OAuth scopes.
Do not install dependencies.
Do not modify .env.
Do not stage.
Do not commit.
Do not push.

Perform the repository + Microsoft Graph audit and return:

## A. CURRENT REPOSITORY ARCHITECTURE

Exact relevant files and current behavior for:

- integration catalog
- unified Google architecture
- connections
- credentials
- OAuth
- scope/capability derivation
- inbound routing
- semantic extraction
- entity arbitration/context
- action policy
- confirmation/executor
- UI
- tests

## B. SECTION 23 BASELINE

Explain exactly what Section 23 added that should be reused in Section 24.

## C. MICROSOFT IDENTITY / OAUTH MODEL

Current official Microsoft identity architecture.

Include:

- supported account types
- endpoints
- delegated permissions
- refresh/offline access
- incremental consent
- admin-consent constraints
- tenant considerations

## D. MICROSOFT 365 CAPABILITY MATRIX

For each capability:

CAPABILITY
GRAPH API / METHOD
PERMISSION
READ/WRITE
POLICY CLASS
ACCOUNT/TENANT LIMITATIONS
SECTION 24 YES/NO

Cover:

- Outlook Mail
- Outlook Calendar
- OneDrive
- Teams

## E. UNIFIED MICROSOFT ARCHITECTURE

Propose the provider/account/capability model.

Explain how one Microsoft connection should map to capabilities.

## F. EXACT SECTION 24 SCOPE

Separate:

MUST BUILD NOW
SHOULD BUILD IF LOW-RISK
FOUNDATION ONLY
DEFER

Be ruthless.

Maximum user value, minimum unnecessary code.

## G. OAUTH / PERMISSION STRATEGY

Recommend exact permissions.

Explain:

- why each is required
- delegated vs application
- sensitive/admin implications
- incremental consent
- reconnect/upgrades
- partial grants
- least privilege

## H. PROVIDER COEXISTENCE PLAN

Explain exactly how Hula behaves when both Google and Microsoft are connected.

Cover:

- Gmail vs Outlook
- Google Calendar vs Outlook Calendar
- Drive vs OneDrive
- Slack vs Teams

Define ambiguity policy.

## I. ROUTING / ENTITY PLAN

Explain how these work:

“Show my Outlook emails.”
“Summarize the second one.”
“Check my Microsoft calendar tomorrow.”
“Move the second event to 4 PM.”
“Find my OneDrive proposal.”
“Summarize that.”
“Give me its link.”

And how mixed Google/Microsoft context is arbitrated.

## J. SAFETY MODEL

Classify all proposed operations:

READ
IMMEDIATE REVERSIBLE WRITE
CONFIRMATION REQUIRED
DESTRUCTIVE/HIGH-RISK

## K. FILE-BY-FILE IMPLEMENTATION PLAN

CREATE:
exact proposed files + purpose

MODIFY:
exact existing files + purpose

Reuse existing architecture.

Do not invent parallel abstractions.

## L. TEST PLAN

Deterministic tests.
Regression tests.
Entity arbitration.
OAuth.
Live iMessage certification.

## M. RISKS / BLOCKERS

Include:

- Microsoft app registration
- personal vs work accounts
- admin consent
- Teams limitations
- Graph throttling
- token lifecycle
- provider ambiguity with Google
- OneDrive/SharePoint complexity
- Office content extraction
- tenant restrictions
- security/prompt injection
- architecture debt only if it genuinely blocks implementation

## N. RECOMMENDED IMPLEMENTATION SEQUENCE

Provide exact implementation order.

Then STOP.

We will review the audit before authorizing implementation.

---

# 26. AFTER IMPLEMENTATION IS LATER AUTHORIZED

Only after explicit authorization:

- implement incrementally
- preserve existing architecture
- test after meaningful slices
- fix root causes rather than patching test phrases
- run focused tests
- run full regression
- typecheck
- lint
- build
- prisma generate where relevant
- git diff --check
- inspect git status
- perform live certification
- verify .env safety
- do not stage/commit/push unless explicitly authorized

Never hardcode production behavior to certification prompts.

Never weaken tests.

Never remove working provider functionality to make Microsoft pass.

Never claim Section 24 complete based only on mocks.

The Section 24 completion standard is:

REAL MICROSOFT PROVIDER DATA
+
UNIFIED MICROSOFT ACCOUNT ARCHITECTURE
+
OUTLOOK MAIL / CALENDAR / ONEDRIVE CAPABILITIES
+
TEAMS ONLY WHERE REALISTICALLY JUSTIFIED
+
DURABLE ENTITY CONTEXT
+
SAFE AGENTIC ACTIONS
+
GOOGLE/MICROSOFT COEXISTENCE
+
CROSS-PROVIDER REGRESSION SAFETY
+
LIVE IMESSAGE CERTIFICATION

Velocity is the moat.