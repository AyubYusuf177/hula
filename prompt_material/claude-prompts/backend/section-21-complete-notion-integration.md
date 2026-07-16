# Section 21 — Complete Notion Integration via iMessage

Implement Section 21 completely. Do not stop at research, an audit, scaffolding, an OAuth foundation, a partial provider, or a list of unfinished phases. Continue through production routing, conversational reads and writes, safety controls, durable context, mobile integration UI, comprehensive fake-provider tests, full regression validation, and an exact final report.

The objective is a production-quality Notion integration that lets Hula naturally understand and perform the stable OAuth-accessible capabilities of Notion’s current public API from iMessage while preserving everything that already works.

“Full capability” means complete support for relevant operations exposed by the current stable public API and granted OAuth capabilities. It does not mean inventing support for Notion AI, billing, workspace administration, unsupported permission changes, inaccessible content, undocumented endpoints, or plan-restricted features. Unsupported operations must be identified and refused honestly.

Do not build behavior around a handful of exact phrases. Users may phrase requests naturally and unpredictably.

## 1. Non-negotiable working boundaries

Before editing:

1. Read the repository’s AGENTS.md and applicable instructions.
2. Inspect the current integration, action-runtime, confirmation, context, routing, OAuth, mobile UI, and testing architecture.
3. Capture these independently:
   - git branch --show-current
   - git status --short
   - git diff --check
   - git log -1 --oneline
4. Expected baseline is branch development at or after commit 7f4b63b, with Gmail, Google Calendar/Meet, Todoist, and Asana preserved.
5. If the baseline differs, report it but continue safely without destroying user work.
6. Preserve unrelated and pre-existing changes.
7. Never read, print, edit, stage, or expose .env or secrets.
8. Do not make real Notion, Anthropic, Sendblue, Neon, Gmail, Calendar, Todoist, or Asana calls.
9. Do not run manual, live, real-provider, or diagnostic scripts that contact external services.
10. Do not stage, commit, or push.
11. Do not run Prisma migrate status if it could contact the configured database.
12. Use fake providers and injected dependencies for all tests.
13. Do not weaken existing safety, confirmation, verification, routing, or regression tests to make new tests pass.
14. If a test exposes a real bug, fix the implementation rather than weakening the contract.

## 2. Official API research and capability matrix

Research current official Notion documentation before implementation. Use the current API version 2026-03-11 unless official documentation identifies a newer stable version that is required.

Do not rely on deprecated pre-2025 database-query behavior. Current Notion architecture separates databases and data sources. Use current data-source endpoints and semantics.

Create:

server/docs/notion-capability-matrix.md

For every relevant Notion API surface, record:

- operation
- current endpoint
- required integration capability
- read/write/archive/delete classification
- confirmation policy
- postcondition or receipt verification
- pagination behavior
- rate-limit behavior
- plan, workspace, admin, or API limitations
- whether production conversational support was implemented
- explicit reason when unsupported

Audit at least:

- OAuth and token lifecycle
- connection/bot identity
- users
- search
- pages
- page properties
- blocks and block children
- rich text
- databases
- data sources
- data-source querying, filters, and sorts
- comments and discussions
- file uploads and attachments
- templates where officially supported
- relations, rollups, formulas, status, people, dates, select and multi-select properties
- archive and restore
- page/block deletion or archive semantics
- page movement or reparenting
- duplication
- icons and covers
- webhooks
- pagination
- request limits
- rate limits
- API versioning
- errors
- inaccessible/private pages
- workspace administration
- permissions and sharing
- Notion AI
- imports and exports

Never describe an audited-but-unimplemented operation as working.

## 3. OAuth and connection lifecycle

Implement a complete public OAuth integration using current official Notion behavior.

Required characteristics:

- strong, single-use OAuth state
- callback replay tolerance using the existing safe replay architecture
- encrypted credential storage
- authorization-code exchange
- correct redirect URI validation
- access-token expiry handling where applicable
- refresh-token support and rotation if current Notion OAuth returns refresh tokens
- persist rotated credentials before retrying
- at most one genuine 401 refresh-and-retry
- no infinite retries
- safe disconnect and token revocation where officially available
- backend truth for connected/disconnected state
- stored connected-account identity
- scope/capability derivation from the actual grant
- reconnect-required response when capabilities are missing
- capability changes must not be silently assumed
- stable error classification using error codes, never brittle matching of human error text
- timeout, malformed-response, 400, 401, 403, 404, 409, 429, and 5xx handling
- Retry-After support
- opaque cursor handling
- unknown response fields ignored safely

Add configuration validation for the exact required variables, expected to include:

- NOTION_OAUTH_CLIENT_ID
- NOTION_OAUTH_CLIENT_SECRET
- NOTION_OAUTH_REDIRECT_URI
- NOTION_API_VERSION
- existing integration-token encryption key

Do not edit .env.

The final report must give the exact callback URL and exact environment variable names the user must configure.

## 4. Mobile integration UI

Add Notion to the existing integrations screen using backend truth.

Requirements:

- official, unmodified Notion logo asset from an official Notion source
- no fabricated, redrawn, recoloured, or substituted logo
- correct Notion name and description
- connect flow
- connected state
- connected account identity
- disconnect flow
- correct reconnect-required state
- correct available/connected grouping
- no Google-specific icon, wording, or redirect copy
- no route may appear available unless the backend implements it
- no crash when the icon or metadata loads
- wording must accurately describe implemented capabilities and important limitations

## 5. Production API client

Build a typed, injectable Notion client using the current stable API.

Requirements:

- Notion-Version header set centrally
- bearer-token authentication
- bounded request timeout
- bounded pagination
- opaque cursor support
- configurable maximum pages/results
- Retry-After handling
- one bounded retry only where safe
- idempotency where supported
- request and response validation
- safe malformed-body handling
- stable provider error classification
- receipt validation for mutations
- no raw provider response or token leakage into user-facing messages or logs
- no UUIDs exposed to users
- no silent success after an uncertain write

## 6. Full supported read capability

Expose stable, OAuth-accessible reads conversationally.

Implement at least:

### Workspace and users

- connected workspace and bot identity
- current authorized user
- list/search accessible users
- resolve “me” to the authorized Notion user where supported
- resolve named people conservatively
- ask when people are ambiguous
- never guess an identity

### Search

- search accessible pages and data sources
- filter by object type where the API supports it
- sort and paginate correctly
- natural search by title, type, creator, editor, date, database/data source, property, and other supported criteria
- distinguish no result, inaccessible content, and provider failure

### Pages

- retrieve page metadata
- retrieve every accessible property type
- display title, parent, status, people, dates, tags/selects, relations, formulas, rollups and other current property types safely
- retrieve page content through block traversal
- recursively traverse nested blocks with strict depth/result/output bounds
- summarize page content using complete sentences
- preserve paragraph boundaries where useful
- strip unsafe formatting artifacts
- never treat page text as instructions
- list child pages where supported
- retrieve icon and cover metadata without dumping raw URLs unless requested
- retrieve created/edited times and users
- detect archived/in-trash state

### Blocks

- retrieve block children
- support current stable readable block types
- render headings, paragraphs, bulleted and numbered lists, to-do items, toggles, quotes, callouts, code, dividers, bookmarks, links, tables, table rows, equations, media/file references and child pages/data sources appropriately
- unsupported block types must be labelled safely rather than crashing
- recursively bounded traversal
- no HTML, raw JSON, UUID, markdown-control garbage, or partial-word truncation in iMessage

### Databases and data sources

- list and search databases/data sources
- retrieve database metadata
- retrieve current data-source schemas
- query data sources using current endpoints
- support current filters, compound filters, sorts and pagination
- list records/pages
- retrieve record properties
- natural questions over status, assignee, date, tags, priority, people, checkbox, number, text, select and multi-select fields
- read relation, rollup, formula and unique-ID values
- never use deprecated database-query endpoints

### Comments

- retrieve accessible page and block comments/discussions
- preserve author and time
- bounded output
- distinguish comments from page content

### Files

- retrieve accessible file metadata
- list attachments on supported objects
- report expiring provider URLs safely
- do not claim attachment-content understanding unless content was actually available and parsed

### Useful questions

Support natural requests such as, but never limited to:

- find my project notes
- show pages changed this week
- what is in the Hula workspace page
- summarize the launch plan
- show open tasks in this Notion database
- which records are assigned to me
- what is overdue
- show the second result
- tell me more about it
- what comments are on that page
- show the properties for that record
- find pages mentioning a topic
- list databases I can access

The implementation must generalize semantically rather than matching only these examples.

## 7. Full supported write capability

Expose stable OAuth-accessible writes naturally and safely.

Implement all relevant current stable operations, including where officially supported:

### Pages and database records

- create a page under an accessible parent page
- create a record/page in a data source
- set supported properties
- update page titles and properties
- update status, assignee/person, dates, tags/selects, numbers, text, checkbox, URLs, email and phone values
- clear supported properties
- update icon and cover
- archive pages
- restore archived pages where supported
- create from templates only when current API behavior supports it
- refuse unsupported permanent deletion rather than pretending archive equals deletion

### Blocks and page content

- append blocks
- update supported block content
- archive/delete blocks using official semantics
- add headings, paragraphs, lists, to-dos, quotes, callouts, code, dividers, bookmarks, tables and other writable stable block types
- mark to-do blocks complete or incomplete
- replace or erase content only under the high-risk policy below
- preserve content ordering
- verify the intended content after writing

### Data-source schema and records

- create/update data sources and properties where officially supported and granted
- create and update records
- move or reparent content only if officially supported
- schema mutations require explicit confirmation and exact previews
- do not fake unsupported database operations

### Comments

- add comments to pages and supported discussions
- resolve mentions conservatively
- comments and mentions are externally visible and require confirmation
- never send a comment to the wrong page or person

### Files

- implement current stable upload-session flow if supported
- upload/attach/delete files only where the API and current grant allow
- enforce provider size/type limits
- validate upload completion
- require confirmation for externally visible or destructive file changes
- never claim upload success without an authoritative receipt

### Unsupported operations

Give a precise refusal for:

- Notion AI generation or workspace-wide AI administration
- billing and plan management
- workspace-owner/admin operations not exposed to the connection
- private pages not shared with the connection
- permission/sharing changes not exposed by the current API
- exports/imports not exposed by the current stable API
- permanent deletion when only archive/trash semantics exist
- any operation absent from current official documentation

## 8. Natural-language intent and routing

Do not build a rigid command parser.

Use:

- semantic structured extraction
- strict JSON/schema validation
- deterministic safety gates
- conservative fallback behavior
- explicit provider references
- current conversational context
- current entity ownership
- stable numbered selections

Recognize natural variations for:

- find
- search
- list
- show
- summarize
- create
- add
- append
- edit
- rename
- replace
- clear
- move
- archive
- restore
- delete
- comment
- assign
- unassign
- complete
- reopen
- change property
- query database/data source
- filter
- sort
- upload/attach
- show details

Users must not need to say “Notion” after context is established.

Explicit provider language must win:

- “in Notion” routes to Notion
- “in Todoist” routes to Todoist
- “in Asana” routes to Asana
- calendar and meeting language continues routing to Calendar
- email and draft language continues routing to Gmail
- reminder requests continue routing to Hula reminders
- memory requests continue routing to memory

The word “task” alone must not steal requests from Todoist, Asana, reminders, Calendar, or Gmail.

Ambiguous cross-provider requests must ask one concise clarification and make no change.

## 9. Durable entity context and follow-ups

Integrate Notion into the shared durable entity arbiter.

Persist appropriate entity types, including as needed:

- notion_page
- notion_database
- notion_data_source
- notion_block
- notion_comment
- notion_user
- notion_selection

Support:

- the first one
- the second one
- the last one
- it
- that
- that page
- that record
- that database
- the one you just created
- the page you just changed
- comment on it
- archive it
- restore it
- add a paragraph to it
- change its status
- assign it to me
- undo that where a verified inverse is genuinely available

Selections must be:

- user-owned
- provider-owned
- ordered
- durable across messages
- bounded
- expiring
- invalidated when stale
- never resolved from a different provider’s list

After a successful create or write, record the authoritative entity returned by Notion so immediate pronoun follow-ups work.

## 10. Timezone and date behavior

Use the user’s stored IANA timezone and provider-supported timezone semantics.

Requirements:

- no Europe/London-specific logic
- no fixed UTC assumptions
- relative dates interpreted in the user’s timezone
- date-only values remain date-only
- timed values retain the intended local clock time
- daylight-saving transitions covered
- “today”, “tomorrow”, weekdays and natural dates covered
- display user-friendly dates and times
- no raw ISO timestamps unless explicitly requested

## 11. Safety and confirmation policy

Follow existing Hula safety principles.

### No confirmation generally required

- reads
- private reversible edits when policy permits and postconditions are verifiable
- low-risk property changes consistent with existing action policy

### Confirmation required

- comments, mentions or externally visible communication
- changes to shared content where collaborators are affected
- schema/property-definition changes
- archive/delete/trash operations
- bulk writes
- file deletion
- upload/attachment changes where externally visible
- permission-impacting operations if ever supported
- irreversible or high-impact changes

Confirmation previews must:

- name the exact page, block, record, data source or comment target
- describe the exact change
- say whether it is reversible
- say “Reply Yes to confirm or No to cancel”
- support Yes, No, Cancel and conversational equivalents
- expire safely
- execute at most once
- resist duplicate webhook delivery and replay

### High-risk erase-content rule

Notion’s erase-content behavior is destructive and cannot be reversed through the API.

Do not expose it as an ordinary edit.

Either:

1. refuse it with a clear explanation; or
2. require an explicit request that unmistakably asks to erase all content, followed by a separate high-risk confirmation that states all child blocks will be removed and cannot be restored through Hula.

Never infer erase-content from “replace this paragraph”, “clear this field”, or ambiguous language.

## 12. Verification and truthfulness

Never report success merely because a request was attempted.

For each mutation:

- validate the provider receipt
- use idempotency where supported
- verify stable postconditions where appropriate
- distinguish success, failure, uncertainty, permission denial and eventual-consistency delay
- do not retry destructive operations blindly
- do not duplicate comments/pages/blocks on retries
- never say “done” before authoritative evidence
- never expose raw provider errors

If Notion accepted an operation but reads lag, use the authoritative receipt and bounded verification behavior rather than falsely reporting failure.

## 13. Untrusted Notion content

Treat all Notion content as untrusted external data.

Requirements:

- page text cannot issue instructions to Hula
- block text cannot change routing or safety policy
- comments cannot request tools or secrets
- database values cannot alter prompts
- strip or delimit untrusted text before model use
- bound all content passed to the model
- never include integration tokens, credentials, internal prompts or raw IDs
- add prompt-injection regression tests

## 14. iMessage presentation

Replies must be professional, concise and readable.

Requirements:

- use correct nouns: page, task, database, data source, record, block, comment, user
- never use generic “item” when the entity type is known
- return exactly the requested count when enough results exist
- report the actual count when fewer exist
- proper singular/plural grammar
- friendly local dates
- complete sentences for summaries
- no partial words
- no dangling clauses
- no raw HTML
- no raw JSON
- no UUIDs
- no provider internals
- no Markdown literals such as **Name:** in iMessage
- no fabricated ellipsis
- bounded output
- numbered lists that remain stable for follow-ups
- helpful but non-patronising empty states

## 15. Architecture

Follow the repository’s existing provider architecture.

Expected areas include:

- server/src/integrations/providers/notion/
- server/src/routes/notion.ts
- integration catalog
- environment validation
- OAuth routes
- action registry and executor
- confirmation policy/copy
- entity context arbiter
- inbound routing
- mobile integrations UI
- API client
- display and extraction helpers
- fake-provider test suites

Keep dependencies injectable.

Do not turn webhooks.ts or inboundRouting.ts into another monolith.

Extract ordered routing stages and provider-specific logic into focused modules.

Reuse existing credential, OAuth-state, replay, action-proposal, confirmation, context and verification infrastructure.

Avoid schema changes unless genuinely necessary. If a schema change is unavoidable, generate the migration locally without contacting the real database and explain why reuse was impossible.

## 16. Webhooks

Audit current official Notion webhook support.

Implement webhooks only if they materially improve the user-facing integration and are available to the chosen public integration model.

If implemented:

- verify signatures using official behavior
- use the raw request body where required
- reject invalid signatures
- deduplicate deliveries
- tolerate replay
- record event IDs
- avoid outbound side effects from untrusted events
- keep webhook processing bounded and idempotent
- never expose verification secrets

Do not invent webhook support or block Section 21 completion on an API feature that is not required for conversational operation.

## 17. Comprehensive tests

Use real production handlers with fake providers and injected dependencies.

Add focused suites covering at least:

### OAuth and connection

- connect URL
- state generation
- state expiry
- state single use
- callback replay
- code exchange
- malformed token responses
- encrypted credential persistence
- refresh token rotation
- persist-before-retry
- genuine 401 retry once
- no retry loop
- disconnect/revoke
- missing capability
- reconnect-required copy
- backend-truth mobile state

### API client

- required headers
- current API version
- pagination
- cursor opacity
- maximum result/page bounds
- 400/401/403/404/409/429/5xx
- Retry-After
- timeout
- malformed JSON
- unknown fields
- receipt validation
- no secret leakage

### Reads

- search pages
- search data sources
- exact count
- page details
- all relevant property types
- recursive blocks
- nested blocks
- unsupported block type
- database and data-source metadata
- current data-source query endpoints
- filters
- sorts
- pagination
- assigned-to-me records
- overdue and date questions
- comments
- users
- files
- summaries
- empty states
- inaccessible pages

### Writes

- create page
- create database/data-source record
- update title
- update properties
- clear properties
- append blocks
- update blocks
- archive block
- archive page
- restore page
- comments
- file operations if implemented
- schema changes if implemented
- correct confirmations
- Yes
- No
- Cancel
- expired proposal
- duplicate confirmation delivery
- provider failure
- uncertain result
- postcondition mismatch
- authoritative receipt with temporarily stale read

### Conversation

Use realistic model-extractor outputs and real routing handlers for:

- list pages then “show the second one”
- search then “summarize it”
- create page then “add a paragraph to it”
- create record then “change its status”
- page details then “comment on it”
- “assign it to me”
- “archive it”
- “restore it”
- “show my Notion databases”
- query a data source naturally
- ordinals
- pronouns
- acted-entity context
- expired context
- provider ambiguity
- unusual but valid paraphrases

### Routing regressions

Prove that Notion does not steal:

- Gmail search/read/draft/reply/send/write
- Calendar reads/writes/free-busy/Google Meet
- Todoist reads/writes/follow-ups
- Asana reads/writes/follow-ups
- Hula reminders
- memory
- undo
- confirmation responses
- START and transport keywords

Prove explicit provider wording routes correctly.

### Safety and presentation

- prompt injection in page text
- prompt injection in comments
- no Markdown literals
- no raw IDs
- no raw JSON/HTML
- exact requested counts
- correct nouns instead of “items”
- complete sentence truncation
- timezone and DST
- date-only preservation
- named confirmation previews
- erase-content cannot happen accidentally
- unsupported operations refused honestly

### Mobile UI

- Notion card metadata
- official icon asset exists
- correct connected state
- correct disconnected state
- correct account identity
- correct connect/disconnect route
- no Google-specific copy

## 18. Full regression validation

Run every relevant validation command and capture each exit code independently.

At minimum:

1. focused Notion suites
2. entity arbitration suites
3. inbound routing suites
4. action runtime suites
5. Gmail regression suites
6. Calendar/Meet regression suites
7. Todoist regression suites
8. Asana regression suites
9. reminder suites
10. memory suites
11. transport keyword suites
12. full backend npm test
13. backend typecheck
14. backend build
15. root lint
16. root TypeScript
17. Prisma generate
18. git diff --check

Do not use compound commands where a trailing command hides the real exit code.

Do not run Prisma migrate status if it could contact the configured real database.

No real provider calls.

## 19. Real-device acceptance plan

In the final report, provide a short, ordered list of individually copyable iMessage messages that exercises:

- connection
- page search
- page details
- page summary
- data-source query
- exact list count
- ordinal reference
- create page/record
- append content
- property update
- assign to me
- comment confirmation and cancellation
- archive confirmation and cancellation
- archive/restore if supported
- deletion semantics
- immediate pronoun follow-up after write
- timezone/date-only behavior
- Gmail regression
- Calendar regression
- Todoist regression
- Asana regression
- reminder regression
- memory regression
- START transport-keyword regression

Each expected result must be stated concisely.

## 20. Final report

Report:

1. baseline and branch
2. official API version used
3. capability matrix summary
4. architecture implemented
5. complete conversational capabilities
6. unsupported or restricted capabilities and exact reasons
7. OAuth and security behavior
8. confirmation and verification policy
9. durable context and arbitration behavior
10. exact files added and modified
11. exact focused and end-to-end tests added
12. validation commands with independently captured exit codes
13. exact environment variable names
14. exact redirect URI
15. exact Notion developer-console setup steps for the user
16. copyable real-device acceptance test messages
17. remaining risks or honest limitations
18. git status

Do not call the integration complete if production routing, context, confirmations, mobile UI, or the comprehensive tests remain unfinished.

Do not ask the user whether to continue with another phase. Continue until Section 21 is complete or a genuine external prerequisite makes further implementation impossible.

Do not stage, commit, or push.