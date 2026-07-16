Read AGENTS.md first and follow it strictly.

We are on the development branch.

You are implementing Section 20: Complete Asana Integration for Hula.

Current verified baseline:

- Latest pushed commit: 0fddc19 Add complete Todoist integration via iMessage
- Gmail is implemented with comprehensive reads, search, grounded summaries, drafts, draft editing/deletion, replies, sends and message-management actions.
- Google Calendar is implemented with comprehensive reads, availability, free/busy, writes, recurring-event safety, Google Meet creation, confirmations and verified receipts.
- Todoist is implemented with OAuth, reads, task creation, updates, projects, priorities, due dates/times, completion, reopening, movement, deletion confirmation, entity context, routing arbitration and verified receipts.
- Memory and reminders work.
- Sendblue iMessage delivery works.
- The mobile integration UI works in Expo Go.
- Preserve every working capability.

The prompt file itself may appear as the only new untracked file when you begin:

prompt_material/claude-prompts/backend/section-20-complete-asana-integration.md

Do not commit.
Do not push.
Do not stage files.
Do not read, print, expose or edit .env.
Do not run any real-provider, *-real or *.manual.ts scripts.
Do not expose tokens, secrets, raw provider payloads or personal data.
Expo Go compatibility only.
Velocity is the operating principle, but never trade away truthful execution, confirmation safety, idempotency, security or existing functionality.

# PRODUCT PRINCIPLE

The user is not expected to know Asana terminology, its API, its features or every possible use case.

Hula must understand natural user requests and use the complete set of safe, useful capabilities that Asana’s official public API genuinely supports.

Examples in this prompt are tests and illustrations, not an exhaustive phrase list.

Do not build an exact-phrase command bot.

Do not implement rules such as:

- when the user says “work,” always do X;
- when the user says “project,” always do Y;
- only recognise the example sentences below;
- default every ambiguous request to Asana;
- return a rigid fixed number of results regardless of the user’s request.

Users may phrase requests in ways not shown here. Implement semantic intent extraction into typed schemas, deterministic validation, provider/entity context and safe execution.

“Complete” means:

1. Audit the complete official Asana API.
2. Identify every user-relevant capability available to an authorised Asana user.
3. Implement all safe, practical capabilities supported by the public API.
4. Classify administrative, destructive, notification-generating and organisation-level operations safely.
5. Provide honest, specific unsupported responses for anything unavailable through the public API.
6. Never fabricate success or data.
7. Never silently ignore a requested field or action.
8. Never require the user to understand Asana’s internal object model.

# PHASE 1 — BASELINE AND REPOSITORY INSPECTION

Before editing, run:

git branch --show-current
git status --short
git log -1 --oneline

Expected branch:

development

Expected HEAD:

0fddc19 Add complete Todoist integration via iMessage

The only expected untracked file is this Section 20 prompt file.

Read and inspect:

- AGENTS.md
- Prisma schema
- encrypted credentials/token-vault boundary
- integration catalog
- integration connection/capability model
- OAuth state and replay protection
- Gmail OAuth/client architecture
- Calendar OAuth/client architecture
- Todoist OAuth/client architecture
- action registry
- action policy
- proposal/confirmation/execution runtime
- receipt validation and operational honesty
- entityContextArbiter
- entityFollowup
- provider/entity context persistence
- inbound routing
- reminder and memory routing
- transport keyword handling
- mobile integrations UI
- integration API client
- all relevant tests
- package scripts

Reuse shared architecture where correct.

Do not copy Todoist blindly. Asana’s resources, identity model, hierarchy, dates, memberships, custom fields, dependencies, comments, attachments, webhooks and token behaviour must be verified independently.

# PHASE 2 — AUTHORITATIVE ASANA CAPABILITY AUDIT

Use primary sources only:

- https://developers.asana.com/docs
- https://developers.asana.com/reference
- https://developers.asana.com/docs/oauth
- https://developers.asana.com/docs/rate-limits
- https://developers.asana.com/docs/webhooks
- Asana’s official OpenAPI specification
- Asana’s official brand assets

Do not rely on model memory, third-party tutorials, unofficial SDK behaviour or guessed endpoints.

Audit every official API resource exposed to ordinary OAuth integrations, including where available:

- users
- workspaces and organisations
- teams and team memberships
- projects and project memberships
- project briefs
- project statuses/status updates
- sections
- tasks
- user task lists
- subtasks
- task memberships
- dependencies and dependents
- stories/comments/activity
- attachments
- tags
- custom fields
- custom-field settings
- portfolios and portfolio memberships
- goals
- time periods
- time-tracking entries
- task templates
- events
- webhooks
- batch operations
- search/typeahead
- jobs/asynchronous operations
- organisation exports or admin-only resources
- any other resource present in the current official API reference

For every official resource and operation, create an internal capability matrix containing:

- resource
- operation
- natural user value
- endpoint/method
- OAuth requirement
- required account tier or provider limitation
- read/write/destructive/external-notification classification
- confirmation policy
- provider receipt contract
- pagination behaviour
- rate-limit implications
- implementation decision
- test coverage
- honest reason if deferred or impossible

Do not silently omit an API area.

Distinguish:

1. Fully implemented user capability.
2. Available but unsafe without clarification/confirmation.
3. Admin-only or organisation-policy dependent.
4. Plan/tier restricted.
5. Not available through the public API.
6. Technically available but not valuable enough to expose conversationally.

The final report must include all six categories.

# PHASE 3 — OAUTH, TOKENS AND CONNECTION FOUNDATION

Add an `asana` provider using the existing provider-agnostic integration schema and encrypted credential storage.

Implement and test:

- OAuth connect
- OAuth callback
- exact redirect route
- cryptographically protected state
- single-use state
- safe callback replay handling
- provider-account identity
- granted-scope capture
- scope-derived capabilities
- access-token expiry
- refresh-token handling
- refresh-token rotation if documented
- refresh persistence before retry
- one safe bounded retry where appropriate
- disconnect
- reconnect-required responses
- coded provider errors
- rate-limit handling
- 401/403/404/409/429/5xx handling
- malformed provider responses
- no raw secrets or provider bodies in logs

Do not read or edit .env.

At completion, report exact environment variable names and redirect URI format for the user to configure manually.

# PHASE 4 — MOBILE INTEGRATION

Add an Asana integration card using an official Asana brand asset.

Requirements:

- Expo Go compatible
- correct official icon
- no fabricated, redrawn or recoloured logo
- data-driven integration entry
- connect route wired
- callback return handled
- disconnect works
- capability/connection status comes from the backend
- card cannot appear connectable if the backend route is unavailable
- existing Google Calendar, Gmail and Todoist cards remain unchanged and functional

# PHASE 5 — COMPLETE READ CAPABILITY

Implement all useful reads supported by the authorised API.

The user should be able to ask naturally about:

## Personal work

- tasks assigned to them
- due today
- overdue
- upcoming
- completed tasks where supported
- recently created tasks
- recently updated tasks
- tasks without due dates
- tasks by priority where represented by tags or custom fields
- tasks across multiple workspaces
- tasks awaiting them
- tasks they follow
- tasks blocked by dependencies
- tasks blocking other work

## Organisation and hierarchy

- accessible workspaces/organisations
- teams
- team membership
- projects
- archived projects where supported
- project members
- sections/columns
- project status
- project brief
- portfolios
- goals
- task templates
- user task lists
- relevant organisation structure

## Task details

- name
- description/notes
- completion state
- assignee
- creator
- followers/collaborators
- due date
- due datetime
- start date
- start datetime
- projects
- sections
- parent task
- subtasks
- dependencies
- dependents
- tags
- custom fields with human-readable values
- comments/activity
- attachment metadata
- safe provider links
- time-tracking information where supported
- membership data relevant to the task

## Search and filtering

Support semantic, typed search criteria such as:

- person
- project
- section
- team
- workspace
- date/date range
- completion state
- assignment
- dependency state
- tag
- custom field
- text
- recently changed
- overdue/upcoming
- combinations of supported filters

Construct provider queries deterministically from validated typed fields.

Do not let the model emit raw Asana query syntax.

Respect pagination and user-requested counts.

If the user asks for five, return five when five exist.

Do not always default to five.

Do not expose:

- internal IDs
- raw JSON
- raw HTML
- tokens
- unsafe attachment names
- hidden provider fields
- unbounded result sets

Persist numbered selections so follow-ups work across separate webhook requests and server restarts.

# PHASE 6 — COMPLETE WRITE CAPABILITY

Implement every safe, user-relevant mutation supported by the current official API.

## Tasks

Where officially supported:

- create task
- update task name
- update description/notes
- assign
- unassign
- change assignee
- set due date
- set due datetime
- change due date/time
- remove due date
- remove due time while retaining the date
- set/change/remove start date or datetime
- complete
- reopen
- add to project
- remove from project
- move between projects
- move between sections
- reorder where safely supported
- add/remove followers
- add/remove tags
- set/clear supported custom fields
- create subtasks
- update subtasks
- complete/reopen subtasks
- duplicate task if officially supported
- convert or otherwise transform task types only if officially supported
- delete permanently with confirmation

## Collaboration

Where officially supported:

- add comment
- read comments/activity
- manage followers
- add dependency
- remove dependency
- inspect blockers
- inspect dependents
- attach URL
- upload attachment only if the existing messaging/file pipeline can provide real bytes safely
- download/read attachment content only if genuinely implemented
- time-tracking creation/update/deletion where supported
- status updates

Comments, assignments, follower changes or other operations that notify real people must follow a consistent external-communication confirmation policy.

## Projects and sections

Where officially supported and safely verifiable:

- create project
- update project
- archive/unarchive project
- delete project with explicit confirmation
- create section
- rename section
- delete section with confirmation if destructive
- move/reorder sections where supported
- add/remove project members with verified identity
- update project status
- update project brief
- instantiate task/project templates where supported

## Teams, portfolios and goals

Where officially supported and appropriate:

- create/update portfolios
- add/remove portfolio items
- create/update goals
- associate goals with supported work
- manage team/project membership only with verified identity and appropriate confirmation
- clearly refuse admin-only operations when the OAuth user lacks authority

Do not omit a requested field silently.

If Asana ignores or rejects a field, report the precise failure honestly.

# PHASE 7 — IDENTITY RESOLUTION

Never assign, invite, follow, comment to, or modify membership for the wrong person.

Resolve people using:

1. exact verified email;
2. exact unique accessible name;
3. recent compatible entity context;
4. concise clarification when ambiguous.

Never guess between multiple people with the same or similar name.

Do not send an invitation merely because no current user match exists unless the user explicitly requests an invitation and the API supports it safely.

# PHASE 8 — RISK, CONFIRMATION AND RECEIPTS

Use the existing shared action runtime.

Do not invent a separate Asana confirmation system.

Classify every mutation.

At minimum, require confirmation for:

- permanent task deletion
- project deletion
- section deletion where destructive
- bulk mutation
- organisation/team membership changes
- invitations
- actions that notify or communicate with other people where shared policy requires confirmation
- ambiguous multi-entity operations
- destructive custom-field or administrative changes

For every confirmed action:

- proposal must name the exact target
- `No` performs zero provider writes
- `Yes` executes exactly once
- concurrent/repeated confirmations cannot execute twice
- expired proposals cannot execute
- provider receipt must be validated
- malformed receipts are failures
- provider failures never become success
- unknown outcomes are reported honestly
- do not repeat destructive requests because a read-after-write check is stale

Use authoritative documented provider receipts.

Postcondition reads may provide additional confidence but must not contradict a definitive successful provider receipt merely because of temporary provider staleness.

# PHASE 9 — DURABLE ENTITY CONTEXT

Extend the shared provider/entity context architecture.

Do not create an isolated Asana conversation-memory system.

Persist:

- shown task/project/section/team/portfolio/goal lists
- acted-on entities
- provider type
- entity type
- provider identity
- human-readable title
- verified post-write state
- freshness/expiry

Refresh context after verified writes.

Invalidate deleted entities.

Natural follow-ups must work:

- “open the second one”
- “complete it”
- “undo that”
- “assign it to Sarah”
- “move it to In Progress”
- “change its due date”
- “remove the time”
- “add a subtask”
- “comment on that”
- “show its dependencies”
- “what’s blocking it?”
- “delete it”
- “add the third one to that project”

Pronouns such as `it`, `that`, `that task` and `the one I just changed` are references, not literal task names.

When context is missing or ambiguous, ask a concise clarification and perform zero mutation.

# PHASE 10 — CROSS-PROVIDER ROUTING

Asana must coexist with:

- memory
- reminders
- Gmail
- Google Calendar
- Google Meet
- Todoist
- transport keywords
- the general brain

Use semantic typed intent, explicit provider/entity language, durable compatible context and deterministic routing.

Do not build a growing list of exact phrase checks.

These examples define routing outcomes, not the only recognised wording:

- a request to be reminded later → Hula reminder
- a request to reserve time or schedule a meeting → Calendar
- a request to create work in an explicitly named Asana project → Asana
- a request to create work in an explicitly named Todoist project → Todoist
- an email/draft/reply request → Gmail
- a memory request → Memory
- a pronoun follow-up → newest compatible verified entity context
- START/UNSTOP → transport acknowledgement only

When Asana and Todoist both contain similarly named projects or tasks:

- explicit provider wins;
- compatible recent provider context may resolve a follow-up;
- otherwise ask which provider;
- never silently write to both;
- never guess.

# PHASE 11 — TIMEZONE AND DATE SEMANTICS

Use the user’s stored IANA timezone.

Never assume:

- London
- UTC
- server timezone
- browser timezone

Support and test:

- date-only work
- timed work
- relative dates
- due date removal
- time removal while keeping date
- start dates
- daylight-saving changes
- locale-safe display
- Asana’s documented floating/fixed date semantics
- users travelling between timezones

Never invent a time when the user supplied only a date.

Never drop a supplied time silently.

# PHASE 12 — RESPONSE QUALITY

Responses must be concise, natural and useful in iMessage.

Return relevant information such as:

- task
- project/section
- assignee
- due date/time
- completion/blocking state
- priority/custom-field value when meaningful

Avoid:

- raw provider terminology
- raw IDs
- JSON
- fabricated totals
- fixed five-item boilerplate
- truncated words
- dangling sentences
- unsupported claims
- asking users to inspect Asana when Hula can verify itself
- telling users an action succeeded without a validated receipt

# PHASE 13 — TESTING

Use injected fakes only.

No real:

- Asana
- Neon
- Sendblue
- Anthropic
- Gmail
- Calendar
- Todoist

No test may silently fall back to real Prisma or real network access.

Add comprehensive suites for:

## OAuth and client

- OAuth URL
- state validation
- replay safety
- callback
- encrypted credential boundary
- access expiry
- refresh lifecycle
- refresh rotation
- refresh persistence
- retry safety
- disconnect/reconnect
- scope/capability derivation
- pagination
- rate limits
- 401
- 403
- 404
- 409
- 429
- 5xx
- malformed payloads
- timeout/unknown outcome

## Every implemented read

- personal task filters
- workspace/team/project hierarchy
- projects and sections
- task detail
- subtasks
- dependencies
- comments/activity
- followers
- tags
- custom fields
- attachments
- portfolios
- goals
- status
- time tracking
- search combinations
- empty states
- pagination
- bounded counts
- sanitisation
- timezone formatting

## Every implemented write

- exact provider payload
- correct provider target
- identity resolution
- verified receipt
- context refresh
- failure honesty
- no silent field loss
- date-only versus datetime
- complete/reopen
- movement
- membership changes
- comments
- dependencies
- custom fields
- time tracking
- project/section operations
- deletion

## Safety

- cancellation makes zero writes
- deletion requires confirmation
- repeated confirmation executes once
- concurrent confirmation executes once
- expired proposal never executes
- malformed receipt never succeeds
- provider failure never succeeds
- stale postcondition never repeats destructive writes
- ambiguous entity/person performs no mutation
- bulk partial failure is reported accurately

## Conversation and routing

Use real production handlers with fake providers.

Test:

- varied natural paraphrases
- unseen but semantically equivalent wording
- numbered selections
- pronoun references
- multi-turn follow-ups
- context after writes
- cross-provider context
- Asana/Todoist ambiguity
- reminder/Calendar/Gmail/Memory collisions
- transport keywords
- fail-closed ambiguity
- no rigid fixed-count behaviour
- no literal search for pronouns such as `it`

Pin routing order and ownership.

Examples must not become the only recognised phrases.

# PHASE 14 — VALIDATION

Capture every exit code independently.

Run:

- focused Asana tests
- OAuth/client tests
- read tests
- write tests
- context tests
- routing tests
- action-runtime tests
- entity-arbitration tests
- transport tests
- memory tests
- reminder tests
- Gmail regressions
- Calendar/Meet regressions
- Todoist regressions
- full backend npm test
- backend TypeScript
- backend build
- root lint
- root TypeScript
- Prisma generate
- Prisma migrate status
- git diff --check

Do not report a compound shell command’s final exit code as proof that an earlier command passed.

# REAL-WORLD BOUNDARY

Do not make real Asana API calls during implementation.

At completion provide exact first-principles instructions for:

- creating the Asana developer application
- official app name/description suggestions
- exact redirect URI
- exact environment variable names
- OAuth scopes
- restart requirements
- mobile connection
- real iMessage testing
- verifying changes in Asana
- cleaning up test data

Clearly label every real test that:

- creates data
- edits data
- assigns another person
- sends a comment/notification
- completes/reopens work
- changes membership
- deletes permanently

# FINAL REPORT

Report:

1. Baseline verified
2. Complete official API capability audit
3. Implemented capability matrix
4. Unsupported, admin-only and plan-restricted capabilities
5. OAuth/token architecture
6. Read capabilities
7. Write capabilities
8. Collaboration capabilities
9. Project/team/portfolio/goal capabilities
10. Identity resolution
11. Confirmation and receipt policy
12. Context and routing
13. Timezone/date behaviour
14. Mobile integration
15. Exact files changed
16. Exact tests added
17. Independent validation exit codes
18. Real-world setup instructions
19. Real-device test plan
20. Anything incomplete, deferred or unverified
21. Git status

Do not stop at an inspection report.

Proceed phase-by-phase within this same Section 20 implementation.

Implement the complete safe, user-relevant capability supported by Asana’s current official public API.

If the scope is large, continue through internally managed phases rather than replacing implementation with a plan.

Only stop for:

- a genuine external credential requirement;
- a provider limitation requiring a product decision;
- contradictory official documentation;
- a safety issue that cannot be resolved from the repository and official API contract.

Do not commit.
Do not push.