Read AGENTS.md first and follow it strictly.

We are on the development branch.

# Section 17 — Complete Google Core

Repository:
- Path: ~/Desktop/hulaai
- Branch must remain: development
- Latest known pushed commit: ebb9de5
- Working tree was clean at the start of this section

This is an inspect-and-implement section.

Read this entire prompt before making changes.

## Operating principle

Velocity is the only moat.

Move quickly, but preserve every working capability. Make focused, production-quality changes built on the existing architecture. Do not perform broad rewrites merely to make the architecture look cleaner.

Do not stop after producing a plan. Inspect first, form an internal implementation plan, then implement the complete bounded scope in this prompt. Only stop if there is a genuine external blocker or a product decision that cannot safely be inferred.

## Product goal

Hula is an iMessage-native personal agent.

After this section, Gmail and Google Calendar should feel complete, reliable and natural through iMessage.

Users should be able to:

- ask natural Gmail and Calendar questions
- refer naturally to emails, drafts and events
- receive grounded summaries based on real provider data
- create and manage Gmail drafts
- send and reply to emails
- manage normal Gmail message state
- read and manage Calendar events
- check availability
- create meetings, including Google Meet links when supported
- continue requests across multiple messages
- receive honest success and failure responses
- never accidentally trigger duplicate external actions

This section is about completing the existing Gmail and Google Calendar integrations.

Drive and Docs are explicitly postponed until the next section.

## Critical UI constraint

The current mobile integrations UI is functioning.

It currently has two working cards:

- Gmail
- Google Calendar

Preserve those two cards.

Do not:

- replace them with a unified Google card
- redesign the integrations screen
- change the current visual structure
- rewrite the integration components
- change navigation unnecessarily
- change onboarding
- modify authentication
- introduce a new design system
- perform unrelated frontend cleanup

Only make a minimal frontend change if it is strictly necessary to expose a real capability, fix incorrect capability copy, support required OAuth scopes, or preserve accurate backend-confirmed connection state.

If no frontend change is required, do not change the frontend.

The mobile app must remain compatible with Expo Go.

Do not add native-only dependencies or require a custom development client.

## Safety and repository rules

- Do not commit.
- Do not push.
- Do not stage files.
- Do not use git add -A.
- Do not create another branch.
- Do not modify or expose any .env file.
- Do not print, cat, grep, search, summarize or reveal .env contents.
- Do not expose tokens, credentials, Authorization headers, database URLs, Clerk secrets, Sendblue secrets, Anthropic keys or encryption keys.
- Do not log raw provider payloads containing private user data.
- Do not expose complete emails, attachments, access tokens or refresh tokens in diagnostics.
- Do not run database migrations without first proving one is required.
- Do not run real external write diagnostics.
- Do not send a real email.
- Do not create, edit or delete a real Calendar event.
- Do not alter real Gmail messages or drafts during automated testing.
- Use injected fakes for all automated provider tests.

Never run:

- npm run test:gmail-write-real
- npm run test:calendar-write-real
- any server/scripts/*.manual.ts script

Treat the existing offline test suite as the regression contract.

## Verified starting architecture

The following was verified from the repository at ebb9de5:

- Sendblue inbound processing is in server/src/routes/webhooks.ts.
- Routing is currently an ordered deterministic handler cascade.
- The model never directly calls provider APIs.
- Gmail writes use proposals, confirmations, the action executor and validated provider receipts.
- Gmail duplicate-send prevention is implemented.
- Calendar writes currently bypass the proposal/confirmation runtime.
- Calendar writes currently lack durable idempotency.
- Calendar writes use real Google responses but lack Gmail-equivalent explicit receipt validation.
- Calendar availability/free-busy is not implemented.
- Gmail draft editing is not implemented.
- Gmail draft deletion has an unused provider method but no user-facing action path.
- General Gmail inbox search is incomplete.
- Existing Gmail and Calendar cards work independently.
- Gmail and Calendar use separate provider connection and credential rows.
- include_granted_scopes=true is already used by the shared Google OAuth primitives.
- Gmail currently requests gmail.readonly and gmail.compose.
- Calendar currently requests calendar.readonly and calendar.events.
- Existing capabilities stored on connection rows are copied from the catalog and are not necessarily trustworthy.
- The current action registry contains stale Calendar capability declarations.
- The Sendblue signing-secret environment variable is declared, but webhook authentication was not implemented.
- Existing provider-agnostic Prisma models are likely sufficient.
- Existing Gmail, Calendar, memory, reminder, auth, onboarding and UI behaviour must not regress.

Confirm all of these against the current code before relying on them.

## Systems that must be preserved

Do not rebuild or weaken:

- server/src/integrations/tokenVault.ts
- server/src/integrations/credentials.ts
- the rule preventing credentials from reaching route responses
- OAuth state single-use and provider filtering
- app-return URL validation
- Gmail MIME construction and header-injection protection
- Gmail reply threading
- Gmail proposal and confirmation behaviour
- Gmail atomic draft claiming
- Gmail duplicate-send prevention
- Gmail validated receipt rules
- Gmail provider error taxonomy
- Calendar never-past safety
- Calendar never-ambiguous safety
- Calendar recurring-event safety until an equally safe replacement exists
- brainEligible identity gate
- pending-proposal safety net
- backend-as-truth integration status
- current working mobile integration cards
- memory
- reminders
- Clerk authentication
- onboarding
- Sendblue messaging

## Phase 1 — Inspect and establish exact boundaries

Before editing:

1. Read AGENTS.md completely.
2. Verify:
   - pwd
   - current branch
   - git status --short
   - git log -1 --oneline
3. Inspect the current implementations and tests for:
   - Sendblue webhook normalization and routing
   - action registry, policies, proposals, confirmations, executor and executions
   - Gmail reads, read-one, summaries, search, drafts, MIME, writes and context
   - Calendar reads, extraction, event resolution and writes
   - Gmail and Calendar OAuth routes and scopes
   - integration catalog and connection status
   - Prisma action and integration models
   - mobile integration data and API client
4. Identify the smallest coherent file set required.
5. Check whether there are existing uncommitted changes before editing.
6. Preserve unrelated user changes if any exist.

Do not output a long planning report and stop. Continue into implementation.

## Phase 2 — External-action reliability

### 2.1 Calendar confirmation

Move Calendar create, update/reschedule and delete/cancel actions into the existing durable proposal → confirmation → executor → execution/receipt architecture already used successfully by Gmail.

Requirements:

- A Calendar write must not execute immediately from the initial request.
- The first message should produce a concise preview of the proposed change.
- The user must confirm or cancel naturally.
- Existing natural confirmations such as “Yh”, “Yes”, “Do it”, “Go ahead” and equivalent supported confirmations should work.
- A confirmation applies only to one active, unexpired proposal.
- Cancellation must not perform the provider action.
- Expired proposals must not execute.
- Repeated confirmations must not execute twice.
- Existing Gmail confirmation behaviour must remain unchanged.
- Calendar create, update/reschedule and delete/cancel must all use the same reliable pattern.
- Preserve Calendar’s never-past, never-ambiguous and never-recurring safeguards.
- Do not silently select an ambiguous event.
- Do not weaken timezone handling.

### 2.2 Calendar durable idempotency

Calendar writes must be safe against:

- duplicate Sendblue delivery
- repeated confirmation
- process restart
- multiple backend instances
- retry after a provider response

Use the existing database-backed proposal/execution architecture where possible.

Do not rely only on the process-level seenMessageIds Set.

Do not invent an unsafe automatic retry for ambiguous provider outcomes.

### 2.3 Calendar provider receipt validation

Apply Gmail-equivalent operational honesty:

- Create success requires the expected real Google event identifier and required response evidence.
- Update success requires validated response evidence for the intended event.
- Delete success must be based on an expected successful provider response, not an assumed outcome.
- A malformed or incomplete provider result must never be formatted as success.
- Persist a safe, redacted receipt or execution result.
- Do not store raw provider payloads unnecessarily.
- Map failures into honest user-facing responses.

### 2.4 Sendblue webhook authentication

Inspect the repository and determine the exact Sendblue webhook authentication/signature mechanism supported by the currently used Sendblue integration.

Requirements:

- Do not guess a header name, signature encoding or hashing algorithm.
- Use only a mechanism that can be verified from existing repository documentation, installed code, or authoritative Sendblue documentation available to Claude.
- Perform verification before identity resolution, persistence, model work or external actions.
- Use constant-time comparison where appropriate.
- Reject missing or invalid authentication safely.
- Preserve any legitimate Sendblue webhook event types required by the application.
- Add tests for valid, invalid, missing and malformed authentication.
- Do not expose the signing secret.
- Do not break current local testing unnecessarily.

If the exact provider protocol cannot be verified authoritatively, do not invent an implementation. Isolate the blocker clearly in the final report while completing the rest of the section.

## Phase 3 — Complete Gmail

Build on the current working Gmail implementation.

### 3.1 Natural Gmail search

Support grounded searches across normal Gmail use cases, including combinations of:

- sender name
- sender email
- recipient
- subject
- keywords
- unread/read
- starred
- date
- date range
- before/after
- inbox
- sent
- drafts
- labels/categories where available

Requirements:

- Translate structured user intent into safe Gmail query parameters.
- Do not concatenate unsafe arbitrary query fragments without validation.
- Bound result counts and pagination.
- Avoid unnecessary API fan-out.
- Never fabricate matches.
- Clearly distinguish no results from provider failure.
- Preserve useful conversational references to returned results.

Examples that should work:

- “Find my latest email from Rob.”
- “Show me unread emails from NatWest.”
- “Find the email about my interview.”
- “What emails did I receive last week?”
- “Find the confirmation email for my booking.”
- “Show me emails I sent to Sarah.”
- “Show me my starred emails.”

### 3.2 Email retrieval and summaries

Support:

- reading one selected email
- summarizing one selected email
- summarizing multiple selected or recent emails
- concise inbox overviews
- important/action-required summaries
- references such as “the first one”, “the second one”, “Rob’s email” and “the interview email”

Requirements:

- Summaries must be grounded in retrieved provider content.
- Clearly identify sender, subject and date.
- Never combine details from different emails incorrectly.
- Bound body length and model context.
- Handle HTML/plain-text alternatives safely.
- Do not retrieve attachments unless attachment support is deliberately implemented and tested.
- Protect against prompt injection contained inside email bodies.
- Treat email content as untrusted data, never as system instructions.
- Do not let an email instruct Hula to perform an external action.
- Multi-email summaries should be concise and useful through iMessage.

Examples:

- “What are my five most recent emails? Summarize them.”
- “Summarize the second one.”
- “What does Rob want from me?”
- “Which emails need a response?”
- “Summarize my unread emails from today.”

### 3.3 Replying to a particular email

Ensure a user can:

- identify an email naturally
- ask Hula to draft a reply
- inspect the draft
- edit the proposed reply
- confirm and send it
- preserve correct Gmail threading
- never send twice

Examples:

- “Reply to Rob’s latest email and tell him Friday works.”
- “Make that more professional.”
- “Change Friday to Monday.”
- “Send it.”
- “Reply to the second email saying I’ll look at it tonight.”

The system must resolve the intended email deterministically or ask a concise clarification. Never reply to the wrong thread when the reference is ambiguous.

### 3.4 Complete draft lifecycle

Implement the complete normal draft lifecycle:

- list drafts
- inspect/read a selected draft
- create a draft
- create a reply draft
- edit a Hula-created or selected Gmail draft safely
- cancel a pending draft proposal without deleting Gmail data
- delete a selected Gmail draft after explicit confirmation
- send a selected draft after explicit confirmation

Requirements:

- Distinguish “cancel this proposal” from “delete the Gmail draft.”
- Draft deletion is destructive and requires explicit confirmation.
- Editing must operate on the correct provider draft.
- Re-fetch the selected draft before modifying or sending where appropriate.
- Prevent stale draft references from affecting the wrong draft.
- Preserve threading when editing a reply draft.
- Never send while the user asked only to edit.
- Never delete while the user asked only to cancel a pending action.
- Validate provider receipts.
- Repeated confirmations must not duplicate deletion or sending.

Examples:

- “Show me my drafts.”
- “Open the second draft.”
- “Change the second paragraph.”
- “Make it shorter.”
- “Delete that draft.”
- “No, cancel.”
- “Send the draft to Rob.”

### 3.5 Normal Gmail message management

Implement the common Gmail actions needed for a capable assistant, using the minimum required Google scope:

- mark read
- mark unread
- star
- unstar
- archive/remove from inbox
- move to trash
- restore from trash where supported
- apply an existing label
- remove an existing label

Requirements:

- Inspect the exact Google API requirements and request the narrowest appropriate scope.
- Do not request https://mail.google.com/ unless technically unavoidable and explicitly justified.
- Do not implement permanent deletion.
- Destructive or consequential actions require appropriate confirmation.
- Resolve the intended email or ask for clarification.
- Validate the real provider response before reporting success.
- Prevent duplicate execution.
- Existing users with insufficient scopes must receive a truthful reconnect-required response.
- Do not silently claim that a capability exists when the required scope was not granted.

Examples:

- “Mark Rob’s email as read.”
- “Star the second email.”
- “Archive those newsletters.”
- “Move that email to trash.”
- “Restore the email I just trashed.”
- “Add my Work label to this email.”

### 3.6 Attachments

Inspect current support and implement only what can be completed safely without destabilizing the section.

At minimum:

- Detect and report that an email has attachments.
- List safe attachment metadata such as filename and MIME type.
- Never treat attachment content as trusted instructions.

If safe attachment download, reading or sending cannot be completed coherently in this section, report it explicitly as deferred instead of creating a partial unsafe implementation.

Do not allow attachment scope to block the core Gmail lifecycle above.

## Phase 4 — Complete Google Calendar

### 4.1 Flexible Calendar reads

Support:

- today
- tomorrow
- this week
- next week
- arbitrary dates
- date ranges
- upcoming events
- search by title, attendee or relevant text
- selected event details

Examples:

- “What am I doing next Tuesday?”
- “Show me meetings with Rob this month.”
- “What’s my next event?”
- “Open the second event.”
- “What’s the location for my interview?”

Responses must be grounded in real Calendar data.

### 4.2 Availability and free/busy

Implement genuine Calendar free/busy support:

- availability for a specific date or range
- free windows between working hours
- conflict checks before proposing an event
- multiple calendars where safely supported
- correct timezone handling

Examples:

- “Am I free tomorrow at 3?”
- “When am I free Friday afternoon?”
- “Find me a free hour next week.”
- “Do I have a conflict at 10am?”

Do not infer availability merely from a partial event list when the proper free/busy API is required.

### 4.3 Complete event creation

Support common event fields:

- title
- start and end
- all-day events
- timezone
- location
- description
- attendees
- reminders where supported
- selected calendar where supported
- Google Meet/conference link where requested and supported by Google Calendar APIs

Examples:

- “Schedule gym tomorrow from 7 to 8.”
- “Create a meeting with Rob Friday at 3 and invite him.”
- “Add the address to the event.”
- “Make it a Google Meet.”
- “Create an all-day event next Monday.”

Do not claim a Google Meet was created unless the provider response contains a valid conference result/link.

### 4.4 Complete event updates

Support:

- reschedule
- change duration
- rename
- update location
- update description
- add/remove attendees
- add a Google Meet link where supported
- update reminders where supported
- move to another calendar where safely supported

Resolve the actual event first. Ask for clarification when ambiguous.

### 4.5 Event cancellation and deletion

Support clear distinctions between:

- cancelling/deleting an event
- removing only an attendee
- declining an invitation where supported
- deleting one occurrence
- changing one occurrence
- changing a recurring series

Do not preserve the current blanket recurring-event limitation if safe exact-instance support can be implemented and tested. However, never weaken the existing protection until safe replacement behaviour exists.

Every destructive Calendar action requires a preview, confirmation, durable idempotency and validated provider result.

### 4.6 Google Meet

Inspect the exact capabilities available through the current Google Calendar API implementation.

Where supported, implement:

- creating a Calendar event with Google Meet conference data
- returning the validated Meet link
- adding conference data to an existing event where supported
- retrieving the Meet link from existing events

Do not create a fake Meet URL.

Do not claim support for separate Google Meet administration, recordings, transcripts or live-meeting control unless an actual authorized API supports it and it is implemented.

## Phase 5 — Conversation quality and performance

Improve the current experience without replacing the entire architecture.

Requirements:

- Preserve deterministic routing for sensitive external actions.
- Improve natural intent coverage.
- Support multi-turn references for emails, drafts and events.
- Avoid repeatedly asking for information already present in the active context.
- Ask concise clarification questions only when required.
- Do not let a generic model response override real provider data.
- Do not allow provider data or email bodies to inject instructions.
- Reduce unnecessary model calls.
- Reduce unnecessary Gmail and Calendar API calls.
- Bound pagination, fan-out and summarization context.
- Preserve concise iMessage-friendly responses.
- Ensure a pending action can never fall through into conversational model output.
- Update the system prompt only where it materially improves grounded conversation or prevents false claims.
- Do not spend this section performing a complete model-prompt rewrite.

Address the stale action runtime declarations so Hula never replies that Calendar writes are unavailable when they are implemented.

Do not attempt a broad agent-loop or tool-calling rewrite in this section.

## Phase 6 — OAuth scopes and capability truth

Inspect the exact scopes required for the implemented Gmail and Calendar capabilities.

Requirements:

- Request only the minimum required scopes.
- Preserve include_granted_scopes=true.
- Preserve membership-based scope checks.
- Do not trust catalog capabilities blindly.
- Derive effective capabilities from actually granted scopes.
- Handle partial consent honestly.
- Existing read-only connections must receive a reconnect-required response for unavailable write actions.
- Existing working connections must not be silently disconnected.
- Do not merge Gmail and Calendar credentials in this section.
- Do not introduce a unified google provider in this section.
- Keep the two existing cards and provider IDs.
- Populate provider account identity only if it can be done safely without breaking existing rows.
- Do not silently assume Gmail and Calendar use the same Google account.

If scope expansion requires user re-consent, implement truthful reconnect-required handling and report the exact manual OAuth retest needed.

## Phase 7 — Tests

Add rigorous offline automated tests for every implemented path.

At minimum test:

### Regression

- all existing tests continue passing
- auth/onboarding files remain unaffected
- Gmail and Calendar connection status remains independent
- existing Gmail read flows
- existing Gmail send flows
- existing Calendar read flows
- existing Calendar safety guards
- memory and reminders remain unaffected at the routing level

### Gmail

- natural search combinations
- empty search
- search failure
- bounded pagination
- sender/date/subject/unread/starred queries
- one-email retrieval
- one-email summary grounding
- multi-email summary grounding
- email-body prompt-injection resistance
- natural email references
- ambiguous references
- reply to selected email
- correct threading
- edit draft
- delete draft
- cancel proposal versus delete draft
- list/read drafts
- send edited draft
- mark read/unread
- star/unstar
- archive
- trash
- restore
- label add/remove
- insufficient scope
- partial consent
- expired connection
- malformed provider response
- provider failure
- duplicate confirmation
- retry/replay protection
- no false success
- no token or private-payload leakage

### Calendar

- flexible date and range queries
- event search
- selected-event references
- free/busy
- conflict detection
- event create preview
- confirmation
- cancellation
- repeated confirmation
- restart/multi-instance-safe idempotency
- update/reschedule
- delete/cancel
- attendees
- location
- description
- timezones
- all-day events
- Google Meet creation
- missing conference result
- recurring-event exact-instance safety
- ambiguity handling
- past-date protection
- malformed provider response
- insufficient scope
- provider failures
- no false success

### Webhook

- valid Sendblue authentication
- missing authentication
- invalid authentication
- malformed authentication
- rejected webhook performs no persistence, model call or provider action
- duplicate event handling
- action-confirmation routing precedence
- pending proposals never reach model fallback

Use injected fakes. Tests must not access real Gmail, Calendar, Sendblue, Neon or Anthropic services.

If HTTP-level webhook testing requires a focused test harness, add the smallest safe harness rather than starting the production server against real environment variables.

## Required validation

Run all safe relevant validation after implementation.

Root:

cd ~/Desktop/hulaai
npm run lint
npx tsc --noEmit

Backend:

cd ~/Desktop/hulaai/server
npm run typecheck
npm test
npm run build
npm run prisma:generate
npx prisma migrate status

Before running any command, verify it is non-mutating and does not load real provider credentials unexpectedly.

Do not run real write diagnostics.

Do not create a migration merely to satisfy the prompt. If no schema change is needed, state that clearly.

## Definition of done

Do not claim Section 17 is complete merely because code was written.

The code stage is complete only when:

- current Gmail capabilities still work
- current Calendar capabilities still work
- current two-card UI still works
- Gmail search and grounded summaries work
- selected-email replies work
- complete draft lifecycle works
- implemented Gmail message-management actions work
- Calendar flexible reads work
- Calendar free/busy works
- Calendar writes require confirmation
- Calendar writes are durably idempotent
- Calendar receipts are validated
- supported Google Meet creation works
- partial OAuth consent is handled honestly
- stale capability declarations are corrected
- no external action can fall through to fabricated model success
- all offline automated tests pass
- root lint and TypeScript pass
- backend typecheck, tests and build pass
- Prisma generation and migration status pass
- no secrets are exposed
- no real email or Calendar mutation was performed
- no commit or push was made

Real-device and real-provider testing will happen only after code review. Do not claim those tests passed.

## Final response format

When finished, provide:

A. Starting Git State

B. Architecture Findings

C. Implementation Completed
Group by:
- external-action reliability
- Gmail
- Calendar
- conversation/performance
- OAuth/capabilities
- webhook security
- mobile impact

D. Exact Files Created

E. Exact Files Modified

F. Database/Migration Decision

G. OAuth Scope Changes
List scope names only, never credentials.

H. Automated Tests Added or Updated

I. Validation Results
Include command and pass/fail totals.

J. Deferred Capabilities
Be explicit and honest.

K. Real-World Test Plan
Provide a numbered iMessage test script covering every implemented Gmail and Calendar capability. Clearly identify any test that changes real Gmail or Calendar data and how to clean it up safely.

L. Risks or Blockers

M. Git Status
Confirm that nothing was staged, committed or pushed.

Do not commit.
Do not push.