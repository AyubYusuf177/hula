Read AGENTS.md first and follow it strictly.

We are on the development branch.

SECTION 22 — COMPLETE SLACK INTEGRATION VIA IMESSAGE

Complete Section 22 end-to-end in this single working session.

Do not stop after research, scaffolding, OAuth, a generic client, a capability matrix, or partial conversational support. Continue until the complete supported Slack integration, mobile connection experience, routing, durable context, safety controls, fake-provider coverage, and full repository validation are implemented.

Do not stage, commit, push, open a PR, modify .env, print secrets, or run real-provider/manual scripts.

Do not ask the user routine implementation questions. Inspect the repository, preserve its established architecture and contracts, make conservative decisions, and continue. Only stop early if a genuinely external requirement makes safe implementation impossible.

“Complete” means full, honest coverage of the official public Slack API capabilities available to a normal OAuth-installed Hula app under the configured scopes. It does not mean pretending that Enterprise Grid administration, Discovery APIs, partner-only APIs, Slack AI internals, billing, Marketplace review, or Slack’s own UI-only features are ordinary OAuth capabilities.

Every unsupported, restricted, Marketplace-dependent, Enterprise-only, partner-only, deprecated, or tier-limited capability must be documented explicitly.

CURRENT BASELINE

- Expected branch: development.
- Expected starting HEAD: a871253.
- Expected working tree: clean except this Section 22 prompt file.
- Sections already integrated: Gmail, Google Calendar, Todoist, Asana, and Notion.
- Existing Hula reminders, memory, confirmations, action runtime, entity-context arbitration, inbound routing, Sendblue transport handling, and mobile integration UI must remain working.
- Preserve user work and unrelated changes.
- Never use destructive Git commands.
- Nothing may be staged, committed, or pushed.

FIRST ACTIONS

1. Read AGENTS.md completely.
2. Verify branch, HEAD, status, and diff check.
3. Inspect the existing implementations for:
   - Gmail
   - Google Calendar
   - Todoist
   - Asana
   - Notion
   - integration catalog and connection storage
   - OAuth state/replay protection
   - encrypted credential storage
   - action registry/executor/proposals/confirmations
   - entityContextArbiter and entityFollowup
   - inbound routing
   - webhook verification and idempotency patterns
   - untrusted provider-content handling
   - mobile integration cards, details sheet, connection status, and backend API client
4. Reuse existing safe abstractions where appropriate. Do not copy a provider-specific bug into Slack.

OFFICIAL RESEARCH REQUIREMENT

Before deciding the implementation contract, research current official Slack documentation only. Do not rely on blog posts, generated summaries, old SDK assumptions, or memory.

At minimum verify and cite:

- OAuth v2 installation and granular scopes
- bot tokens versus user tokens
- token rotation and revocation behavior
- API method scopes
- cursor pagination
- per-method and per-workspace rate limits
- 429 Retry-After behavior
- commercial non-Marketplace history/replies restrictions
- Conversations API
- message posting, updating, deletion, scheduling, and threaded replies
- users and profiles
- reactions
- pins
- bookmarks
- files and the current external-upload completion flow
- search restrictions and user-token requirements
- channel membership and administration methods
- user groups
- custom emoji
- Events API request signing, URL verification, retries, and replay resistance
- supported Socket Mode or HTTP event-delivery boundaries
- enterprise/admin/discovery and partner-only boundaries
- Marketplace/distribution requirements
- Slack developer-policy restrictions on model training and data usage
- deprecated methods and migration requirements

Primary starting sources:

https://docs.slack.dev/authentication/installing-with-oauth/
https://docs.slack.dev/apis/web-api/rate-limits/
https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/
https://docs.slack.dev/changelog/2025/05/29/tos-updates/
https://docs.slack.dev/changelog/2024/12/10/dev-policy-update/

Create:

server/docs/slack-capability-matrix.md

The matrix must contain, for each meaningful Slack capability:

- capability
- official endpoint or official API family
- required bot scopes
- required user scopes, if any
- token type
- read/write/delete/external-effect classification
- Hula conversational exposure
- confirmation requirement
- verification strategy
- pagination/rate-limit constraints
- supported status
- explicit reason when unsupported
- tier, Enterprise, Marketplace, admin, or partner restriction
- official source URL

Do not label the section complete if the matrix claims capabilities that the production conversation path cannot reach.

SLACK APP MANIFEST

Create a developer-facing Slack manifest template, containing no credentials:

server/docs/slack-app-manifest.yaml

It must include:

- display information
- OAuth configuration
- exact redirect callback path
- exact bot scopes
- exact user scopes, only where technically required
- event subscriptions only for implemented, verified event handlers
- request URL placeholder using <BACKEND_BASE_URL>
- interactivity configuration only if actually implemented
- token rotation configuration guidance
- no client ID, client secret, signing secret, tokens, or real user information

The final report must explain exactly how to use the manifest in Slack’s developer console.

OAUTH AND CONNECTION CONTRACT

Implement production-quality Slack OAuth v2 consistent with Hula’s existing integrations:

- exact redirect URI handling
- cryptographically strong, expiring, single-use OAuth state
- callback replay protection
- encrypted credential persistence
- bot access token support
- user-token support only where a real implemented capability requires it
- bot user ID, app ID, team/workspace ID and name, enterprise ID where returned
- granted-scope persistence
- scope-derived Hula capabilities
- honest handling of missing or declined scopes
- token rotation where enabled and officially supported
- refresh-token rotation persisted before retry
- at most one bounded refresh/retry
- no automatic retry of ambiguous mutations
- revoke/disconnect behavior
- installation/reinstallation behavior when scopes change
- installation replacement or coexistence behavior defined explicitly
- no mixing “Sign in with Slack” identity scopes with ordinary Slack OAuth scopes in an invalid authorization request
- replay-safe callback behavior that cannot show a false failure after a successful callback replay

Use existing INTEGRATION_TOKEN_ENCRYPTION_KEY infrastructure. Do not invent another encryption system.

Determine the exact environment contract from the actual implementation. It will likely include names such as:

SLACK_CLIENT_ID
SLACK_CLIENT_SECRET
SLACK_REDIRECT_URI
SLACK_SIGNING_SECRET
SLACK_BOT_SCOPES
SLACK_USER_SCOPES

Do not modify .env. Do not read or print its values. Report exact required names and formats at the end.

CLIENT AND API RUNTIME

Build a typed Slack client with:

- explicit method name in each request
- correct JSON, form, and multipart handling
- request timeout
- bounded cursor pagination
- configurable result limits
- response-envelope validation, including Slack HTTP 200 responses with ok:false
- malformed response handling
- 400, 401, 403, 404, 409, 429 and 5xx classification
- Slack error-code classification
- Retry-After parsing
- bounded rate-limit handling
- no retry storm
- no unsafe automatic mutation retry
- idempotency or local duplicate prevention where the API supports no native idempotency key
- redacted structured logs
- no message text, file contents, tokens, email addresses, or sensitive workspace data in logs
- authoritative provider receipts
- post-write verification only where reliable and useful
- no false failure caused by eventual consistency
- no invented success after ambiguous failure

Respect Slack’s current restrictions for commercially distributed non-Marketplace apps, including any special conversations.history and conversations.replies pagination and rate limits. Optimize reads rather than trying to evade them.

SUPPORTED PUBLIC OAUTH CAPABILITY SURFACE

Implement the supported official public OAuth capabilities that are reasonable and useful through Hula’s iMessage interface. Do not reduce Slack to only “search and send.”

At minimum audit and, where officially available with ordinary OAuth scopes, implement conversational access for:

WORKSPACE AND IDENTITY

- authenticated installation identity
- workspace/team information
- current user/bot identity
- users and profiles
- robust person resolution by display name, real name, username, and email when granted
- ambiguity handling
- bot/deactivated/restricted-user distinctions where relevant
- presence/status only where officially supported and useful

CONVERSATIONS

- list accessible public channels
- list accessible private channels
- list/open accessible direct messages
- list/open accessible multi-person direct messages
- channel information
- membership information
- channel topic and purpose
- channel history
- thread replies
- bounded latest/unread/time-window/channel/person queries where supported
- human-readable channel and person names, never unexplained IDs
- stable numbered selections

MESSAGES

- send channel messages
- send direct messages
- threaded replies
- update Hula-authored messages when Slack permits
- delete Hula-authored messages when Slack permits
- schedule messages
- list scheduled messages
- delete scheduled messages
- link unfurl or formatting behavior only where safely supported
- ephemeral messages only if the official method and UX are appropriate
- message permalink retrieval where available
- no claim that Hula can edit or delete messages Slack does not authorize it to modify

SEARCH

- message search where the correct official user token and scopes permit it
- file search where officially supported
- bounded result counts
- channel/person/date/query filters
- honest refusal when the installed token type or workspace policy does not allow search
- never silently substitute a partial channel-history scan and call it global search

REACTIONS AND PINS

- add/remove/list reactions
- add/remove/list pins where officially supported
- correct external-effect policy
- durable reference to the selected message

FILES

- list accessible files
- retrieve metadata and safe download links where allowed
- upload using Slack’s current supported upload workflow, not deprecated files.upload
- title/comment/channel/thread placement where supported
- delete files only when authorized
- avoid loading unbounded or oversized file content into model context
- attachments and downloaded content are untrusted provider content

CHANNEL AND MEMBERSHIP MANAGEMENT

Where allowed by normal OAuth scopes and token type:

- create channel
- rename channel
- archive/unarchive channel
- join/leave channel
- invite members
- remove members only where Slack permits and policy allows
- open/close direct conversations
- update topic
- update purpose
- distinguish public/private channel constraints
- explain owner/admin restrictions honestly

BOOKMARKS, USER GROUPS, AND EMOJI

Audit and implement where public ordinary OAuth methods permit:

- list/add/edit/remove channel bookmarks
- list/create/update/enable/disable user groups
- user-group membership updates
- custom emoji listing
- any write capability only if supported, scoped, verified, and useful

REMINDERS, SAVED ITEMS, CANVASES, LISTS, WORKFLOWS, CALLS, AND OTHER SURFACES

Research each officially.

Implement it only if:

- it has a current public endpoint
- it is available to ordinary OAuth apps
- the configured token can obtain the necessary scope
- it can be exposed safely and honestly through Hula
- it is not deprecated or restricted to select partners/admin products

Otherwise document the boundary precisely in the capability matrix. Do not invent endpoints or pretend a Slack UI feature automatically has a public API.

ENTERPRISE AND RESTRICTED BOUNDARIES

Do not expose the following as ordinary capabilities unless official current documentation proves they are available to this OAuth app and the implementation genuinely supports them:

- Enterprise Grid admin APIs
- Discovery APIs and compliance exports
- audit logs requiring special products
- SCIM provisioning
- billing
- organization-wide admin actions
- Slack AI internals
- select-partner Real-time Search/Data Access
- Calls media transport
- Marketplace review status
- Workflow Builder internals without a public applicable API

Document these honestly.

EVENTS AND WEBHOOK SECURITY

If Events API support materially improves Hula, implement it fully rather than adding a decorative route:

- Slack signing-secret verification
- raw-body-compatible signature calculation
- timestamp freshness validation
- timing-safe comparison
- URL verification challenge
- event_id deduplication
- retry-header handling
- replay protection
- event subtype handling
- ignore Hula’s own events when necessary
- no event content logged
- no duplicate user-visible actions
- no dependency on events for core read/write correctness

If Events API is not required for the MVP, document why and do not add an insecure or unused endpoint.

UNTRUSTED SLACK CONTENT

Every Slack message, profile, channel topic, file name, file body, attachment, unfurl, block, comment, and event payload is untrusted provider content.

It must never:

- override system or developer instructions
- select tools or actions
- manufacture a confirmation
- alter recipient/channel resolution
- bypass policy
- cause a write because its text says to
- expose secrets or hidden prompts
- be interpreted as an instruction from the Hula user

Add explicit prompt-injection and malicious-content regression tests.

CONVERSATIONAL EXPERIENCE

Users must not need to know Slack API vocabulary.

Support natural requests such as:

- “What did the product team say about launch timing?”
- “Show my latest messages in #general.”
- “Summarize the thread about the release.”
- “What did Sarah say yesterday?”
- “Reply to the second one.”
- “Tell Rob I’ll send the draft tomorrow.”
- “Send this to #launch.”
- “React to that with a thumbs up.”
- “Pin the second message.”
- “Schedule this for tomorrow at 9.”
- “Show my scheduled Slack messages.”
- “Cancel the second scheduled message.”
- “Upload this file to the project channel.”
- “Create a private channel called launch-war-room.”
- “Invite Sarah and Rob.”
- “Change the topic to Release coordination.”
- “Archive that channel.”
- “Show the files shared in this thread.”

Do not hard-code only these phrases. Implement semantic extraction, deterministic validation, and conservative routing so equivalent natural language works.

Use plain iMessage-safe text. Do not emit raw Markdown syntax that iMessage displays literally. Preserve useful links without relying on Markdown rendering.

DURABLE ENTITY CONTEXT

Add durable Slack context integrated with Hula’s existing entity arbitration.

Support stable references for:

- workspace
- channel
- DM/MPIM
- user
- message
- thread
- file
- scheduled message
- bookmark
- user group where supported

Required behaviors:

- numbered result lists
- “the second one”
- “that message”
- “that thread”
- “reply to it”
- “send it to her”
- “pin that”
- “delete it”
- “undo that” only when a genuine safe inverse exists
- context survives independent inbound webhook requests
- selections expire safely
- a newer explicit selection replaces an older one
- stale context never silently targets the wrong object
- ambiguous cross-provider references ask one concise clarification question

Explicit provider nouns win:

- “Slack message” routes to Slack
- “email” routes to Gmail
- “event/meeting/calendar” routes to Calendar
- “Todoist task” routes to Todoist
- “Asana task/project” routes to Asana
- “Notion page/note/database” routes to Notion
- “remind me” remains Hula reminders
- memory language remains Hula memory

Test routing collisions extensively.

ACTION POLICY AND CONFIRMATIONS

Integrate Slack writes through Hula’s shared action proposal/execution runtime.

Classify every action by real-world effect.

READ WITHOUT CONFIRMATION

Ordinary authorized reads, including:

- listing channels/messages/threads
- search
- summaries
- user/profile lookup
- file metadata
- reaction/pin/bookmark reads
- scheduled-message reads

CONFIRM EXTERNAL COMMUNICATION OR SHARED CHANGES

Require explicit confirmation naming the real target before:

- sending a message or DM
- posting a threaded reply
- editing an existing message
- deleting a message
- scheduling a message
- deleting a scheduled message
- uploading/sharing a file
- deleting a file
- creating/renaming/archiving/unarchiving a channel
- changing channel topic or purpose
- inviting/removing members
- posting an ephemeral message where applicable
- pinning/unpinning shared content
- adding/removing a reaction if Hula’s existing policy treats externally visible social actions as confirmation-required
- creating/updating/deleting bookmarks
- user-group changes

Confirmation previews must include:

- workspace
- channel or recipient
- thread when applicable
- exact sanitized message/file/channel effect
- scheduled time in the user’s timezone where applicable
- whether the action is externally visible or permanent
- “Reply Yes to confirm or No to cancel.”

Never send, modify, delete, upload, schedule, invite, archive, or otherwise change Slack from the initial request when confirmation is required.

Cancellation changes nothing.

Confirmations must be single-use, expiring, and replay-safe.

UNDO

Only advertise undo where a real safe inverse is available and stored:

- reaction add/remove may be reversible
- pin/unpin may be reversible
- message edit may be reversible only if the previous text is stored safely and Slack permits the inverse
- channel topic/purpose may be reversible only if the prior state is verified and stored
- do not advertise undo for irreversible deletes
- do not recreate a deleted message and call that an undo

VERIFICATION

Use authoritative Slack receipts.

- Validate ok:true and required identifiers.
- For sends, preserve ts/channel/thread identifiers.
- For scheduled messages, preserve scheduled_message_id.
- For modifications, verify returned state or perform a bounded targeted reread only where official behavior makes it reliable.
- Do not convert read-after-write lag into false failure.
- Do not report success from a guessed state.
- Do not retry ambiguous writes automatically.
- Record verified Slack entity context after successful writes.

TIMEZONE AND SCHEDULING

Use the user’s stored IANA timezone.

- Parse relative dates/times in that timezone.
- Display scheduled times in that timezone.
- Handle DST correctly.
- Never assume London, UTC, or the server timezone.
- Validate Slack’s scheduling horizon and timestamp requirements.
- Add non-UTC and DST tests.

MOBILE INTEGRATION UI

Add Slack to the existing integrations screen using the established architecture.

Requirements:

- official Slack logo asset from Slack’s official brand resources
- no fabricated, recolored, or distorted logo
- backend-truth connection status
- available and connected grouping
- connect flow
- disconnect flow
- loading and error states
- details sheet
- connected workspace/team identity
- honest capability copy
- Slack-specific OAuth copy, never Google/Notion/Asana copy
- no missing asset crash
- no optimistic “Connected” before backend confirmation
- no mobile .env changes
- preserve every existing integration

The UI description must explain that Hula only sees Slack content and workspaces granted during installation and that permissions can require reinstalling when changed.

TEST REQUIREMENTS

Use fake providers, injected dependencies, deterministic clocks, and realistic model-shaped extractor replies.

Do not make any real request to Slack, Sendblue, Anthropic, Neon, Google, Todoist, Asana, Notion, or another external provider.

Do not run *.manual.ts, *-real scripts, or live-provider scripts.

Add focused suites covering at minimum:

OAUTH

- authorization URL
- exact scopes
- bot versus user scopes
- state expiry
- single use
- callback replay
- denied callback
- malformed callback
- token exchange
- encrypted persistence
- missing scopes
- reinstall requirements
- rotation persistence before retry
- one bounded refresh
- revoke/disconnect

CLIENT

- ok:true
- HTTP 200 with ok:false
- malformed response
- timeout
- network failure
- 400/401/403/404/409/429/5xx
- Retry-After
- bounded cursor pagination
- commercial history/replies page-size restrictions
- redacted logging
- no unsafe mutation retry

READS

- channels
- DMs/MPIMs
- users
- history
- threads
- search
- files
- reactions
- pins
- bookmarks
- user groups
- scheduled messages
- empty results
- inaccessible resources
- exact count requests
- duplicate removal
- human-readable display

WRITES

- send channel message
- send DM
- threaded reply
- edit
- delete
- schedule
- delete scheduled message
- reaction add/remove
- pin/unpin
- file upload current flow
- file deletion
- channel creation and lifecycle
- topic/purpose update
- membership changes
- bookmarks
- user groups where implemented
- authoritative receipts
- uncertain outcomes
- verification behavior
- eventual-consistency behavior
- confirmation cancellation and replay

CONVERSATION

- natural paraphrases
- provider-explicit routing
- numbered selections
- pronouns
- thread context
- message context
- user resolution
- ambiguous user/channel asks
- stale selection
- expired context
- context replacement
- cross-provider collision
- Gmail regression
- Calendar regression
- Todoist regression
- Asana regression
- Notion regression
- reminder regression
- memory regression
- START/STOP transport-keyword regression

SECURITY

- Slack request signing
- stale timestamp
- invalid signature
- duplicate event
- retry delivery
- malicious Slack message text
- malicious file content
- malicious channel topic
- action-looking provider content
- no provider content becomes a user instruction
- no secrets in logs or replies

UI/INTEGRATION STATUS

- catalog entry
- backend connection truth
- connected/disconnected state
- scope-derived copy
- exact connect/disconnect route
- official asset exists
- no missing icon
- no unrelated integration regression

Do not weaken existing tests. If an old assertion is intentionally superseded, explain exactly why the new contract is safer or more correct and add a stronger replacement test.

VALIDATION GATES

Capture each exit code independently.

Run:

1. Every focused Slack suite independently.
2. Relevant routing/entity/action/transport suites independently.
3. Gmail regression suites relevant to routing and message actions.
4. Calendar regression suites relevant to routing and confirmations.
5. Todoist regression suites relevant to routing and entity context.
6. Asana regression suites relevant to routing and entity context.
7. Notion regression suites relevant to routing and entity context.
8. Full backend npm test.
9. Backend typecheck.
10. Backend build.
11. Root lint.
12. Root TypeScript.
13. Prisma generate.
14. git diff --check.

Do not run Prisma migrate status if it may contact the configured real database. Explain that boundary honestly.

If any gate fails, diagnose and fix it, then rerun it. Do not report green until its independently captured exit code is zero.

REAL-WORLD BOUNDARY

Do not perform a real Slack OAuth flow or real Slack API request.

Do not modify .env.

Do not stage, commit, or push.

Do not run a real Sendblue message.

Do not run real Gmail, Calendar, Todoist, Asana, Notion, Anthropic, or Neon requests.

The user will configure Slack and perform the live-device acceptance test after your offline work is complete.

REQUIRED FINAL REPORT

Do not simply say “done.”

Report:

1. Baseline branch, HEAD, and initial status.
2. Official sources consulted.
3. Capability matrix summary:
   - implemented
   - scope-dependent
   - tier-dependent
   - Marketplace-dependent
   - Enterprise/admin/partner-only
   - unsupported/deprecated
4. Exact OAuth/token-rotation/reinstall behavior.
5. Exact environment variable names and formats.
6. Exact Slack developer-console setup steps.
7. Exact redirect URI:
   https://<backend-host>/v1/integrations/slack/callback
8. Exact event request URL if implemented:
   https://<backend-host>/v1/integrations/slack/events
9. Exact Slack app manifest instructions.
10. Exact bot scopes and exact user scopes, with justification.
11. Every implemented conversational read capability.
12. Every implemented conversational write capability.
13. Confirmation policy table.
14. Entity-context and arbitration behavior.
15. Rate-limit and non-Marketplace behavior.
16. Untrusted-content protections.
17. Mobile UI behavior.
18. Every file added or modified.
19. Every test command and independently captured exit code.
20. Tests intentionally not run and why.
21. Honest remaining limitations.
22. Git status confirming nothing was staged, committed, or pushed.
23. A single copyable, ordered real-device acceptance sequence with expected outcomes.

The live sequence must cover:

- connection and workspace identity
- channel listing
- latest channel messages
- thread summary
- numbered follow-up
- user resolution
- send preview/cancel
- send preview/confirm
- DM
- threaded reply
- reaction
- pin
- scheduled message and cancellation
- file handling if implemented
- channel update if implemented
- cross-provider routing regressions
- reminder regression
- transport START behavior
- disconnect/reconnect if necessary

Finish all safe, in-scope implementation and validation work before returning.