Read AGENTS.md first and follow it strictly.

We are on the development branch.

This is Section 16 implementation.

Do not commit.
Do not push.
Do not use git add -A.
Do not modify unrelated functionality.
Preserve all currently working Gmail read, Calendar read/write, memory,
reminder, confirmation, OAuth, webhook, and generic brain behavior.

======================================================================
SECTION 16
======================================================================

Title:

Add Gmail draft and send actions through iMessage

Objective:

Allow Gmail-connected Hula users to create real, fully populated Gmail
drafts and send new emails or replies through natural-language iMessage
requests.

Draft creation executes immediately once all required information is
safely resolved.

Every actual email send requires explicit confirmation through the
existing Section 12 proposal/confirmation runtime.

======================================================================
STABLE BASELINE
======================================================================

Repository:

~/Desktop/hulaai

Branch:

development

Expected HEAD:

2f53a55 Add Google Calendar write actions (create/update/delete) via iMessage

Before modifying anything, run:

git branch --show-current
git status --short
git log -1 --oneline

Stop and report if:

- the branch is not development
- the working tree is not clean
- HEAD is not 2f53a55

======================================================================
APPROVED PRODUCT SCOPE
======================================================================

Implement exactly these four capabilities:

1. Create a new Gmail draft.
2. Create a reply draft in an existing Gmail thread.
3. Send a new Gmail email after explicit confirmation.
4. Send a Gmail reply after explicit confirmation.

Do not implement:

- attachments
- CC
- BCC
- reply all
- forwarding
- scheduled sending
- signatures
- HTML authoring
- draft deletion
- arbitrary existing-draft editing
- arbitrary existing-draft sending
- archive/delete/mark-read/labels
- contact synchronization
- Google Contacts
- bulk email
- autonomous sending
- WhatsApp changes
- mobile UI changes

======================================================================
DRAFT REQUIREMENTS
======================================================================

A draft must be a real Gmail draft saved through the Gmail API and
visible in the user’s Gmail Drafts folder.

A new draft must contain:

- safely resolved recipient email address
- complete subject
- complete body matching the user’s intent
- valid RFC-2822 MIME
- Gmail-returned draft/message metadata

A reply draft must additionally contain:

- correct Gmail threadId
- correct recipient derived from the matched message
- correct In-Reply-To
- correct References
- correct Re: subject handling

Do not create placeholder or incomplete drafts.

If a required field cannot be safely determined, ask a concise
clarification question instead of creating the draft.

Draft creation does not require confirmation.

======================================================================
SEND REQUIREMENTS
======================================================================

Every actual email send requires explicit confirmation.

The original request:

"Send Sarah an email saying..."

does not itself authorize immediate provider execution.

Before sending, Hula must create a persisted pending action using the
existing Section 12 proposal/confirmation runtime.

The confirmation preview must show:

To:
Subject:
Body:

For replies, also show that it is a reply and identify the thread subject.

The body must be shown in full, not summarized.

Only a valid subsequent approval may execute the provider send.

Rejection, expiry, duplicate approval, or duplicate webhook delivery must
not send the email.

Gmail must confirm success before Hula reports that the email was sent.

Do not create a second confirmation framework.

======================================================================
RECIPIENT RESOLUTION
======================================================================

Allowed resolution sources:

1. A literal email address supplied by the user.
2. The actual sender address of a safely matched Gmail message/thread.
3. A single unambiguous recent Gmail sender match.

Rules:

- Never invent an email address.
- Never guess between multiple matching people.
- Never silently select one of several matching threads.
- Ask for the email address when a name cannot be resolved.
- Ask the user to clarify when multiple matches exist.
- Display the resolved recipient name and address before sending.

No Google Contacts integration belongs in this section.

======================================================================
OAUTH AND CAPABILITIES
======================================================================

Retain the existing Gmail read scope and add:

https://www.googleapis.com/auth/gmail.compose

Use gmail.compose for:

- draft creation
- sending new messages
- creating reply drafts
- sending replies

Do not request gmail.modify unless a verified Google API requirement
makes the approved Section 16 scope impossible without it. If that occurs,
stop and report before changing scopes.

Update:

- integration catalog defaults
- Gmail OAuth scope generation
- capability detection
- missing-scope/reconnect behavior
- tests
- operational documentation where appropriate

Inspect environment scope overrides.

Do not commit server/.env.

Existing users with read-only Gmail grants must receive an honest
reconnect instruction before any Gmail write action can run.

======================================================================
IMPLEMENTATION ARCHITECTURE
======================================================================

Follow established provider and Calendar-write conventions where they fit
the Gmail domain.

The model may extract structured intent but must never call Gmail.

Backend code must validate all extracted values.

Implement or extend:

- Gmail mutation-capable client behavior
- token refresh reuse
- one retry after 401
- normalized Gmail errors
- MIME generation
- base64url encoding
- Gmail draft creation
- Gmail message sending
- reply metadata retrieval
- recipient/thread resolution
- deterministic Gmail-write prefilter
- Zod-validated extraction
- immediate draft action service
- send proposal creation
- Gmail send executor adapter
- webhook routing
- capability checks
- user-facing responses
- tests
- safe manual diagnostic

Reuse existing abstractions instead of duplicating:

- encrypted token storage
- OAuth connection records
- refresh handling
- action proposals
- confirmation persistence
- expiry
- idempotency
- duplicate webhook protection
- executor
- audit/status handling

Do not add Prisma schema changes unless the existing action runtime is
demonstrably insufficient. Stop and explain before making an avoidable
schema change.

======================================================================
STRUCTURED ACTIONS
======================================================================

Support validated interpretations equivalent to:

- create_new_draft
- create_reply_draft
- send_new_email
- send_reply
- not_gmail_write

Use repository naming conventions rather than blindly using these names.

Validate fields appropriate to the action, including:

- recipient name
- recipient email
- subject
- complete body
- Gmail message reference
- Gmail thread reference
- missing fields
- clarification reason

Do not let model output bypass backend recipient or thread validation.

======================================================================
ROUTING
======================================================================

Inspect the actual current webhook order before changing it.

Gmail writes must not intercept Gmail reads.

Examples:

"Send me the latest email from Rob."
= read request

"Send Rob an email saying Friday works."
= write request

"Draft a response to Rob’s latest email."
= write request

"What emails do I have from Rob?"
= read request

Preserve routing for:

- memory
- reminders
- pending confirmations
- Calendar writes
- Calendar reads
- Gmail reads
- action intents
- generic brain fallback

Add regression tests for routing conflicts.

Pending confirmation handling must remain before new action execution so
"yes" approves the correct pending action rather than being interpreted
as a new request.

======================================================================
MIME AND REPLY RULES
======================================================================

Implement a pure, independently tested MIME builder.

Requirements:

- valid RFC-2822 output
- base64url encoding accepted by Gmail
- To header
- Subject header
- MIME-Version
- Content-Type for plain UTF-8 text
- Content-Transfer-Encoding where needed
- protection against header injection
- correct Unicode handling

For replies:

- use Gmail threadId
- include In-Reply-To from the matched message’s Message-ID
- preserve/build References correctly
- avoid duplicate Re: prefixes
- respect Reply-To where present
- otherwise reply to the actual sender
- do not implement reply all
- do not include quoted-message history unless required by the existing
  product convention

Do not log full raw MIME payloads.

======================================================================
USER-FACING BEHAVIOR
======================================================================

Draft success:

Draft created in Gmail.

Include:

- To
- Subject

Do not expose internal draft IDs.

Reply-draft success:

Reply draft created in Gmail.

Include:

- recipient
- thread subject

Send proposal:

Ready to send:

To: name <address>
Subject: subject

Body:
complete body

Reply YES to send or NO to cancel.

Use the existing confirmation language conventions where available.

Send success:

Email sent to name/address.

Reply success:

Reply sent to name/address.

Errors must be concise and honest for:

- Gmail not connected
- Gmail connected without compose permission
- unresolved recipient
- ambiguous recipient
- thread not found
- multiple thread matches
- missing subject
- missing body
- expired confirmation
- rejected confirmation
- duplicate approval
- Gmail provider failure

Never expose raw provider responses, tokens, MIME, or stack traces.

======================================================================
ACTION REGISTRY AND POLICY
======================================================================

Inspect the existing registry entries for:

- email.createDraft
- email.sendDraft

Reconcile them with the approved product behavior.

Expected policy:

- draft creation: implemented and no confirmation required
- actual send: implemented and confirmation required
- required integration: Gmail
- required scope: gmail.compose

Do not misuse a misleading action name if the registry can safely be
clarified without breaking existing data or tests.

Maintain backward compatibility where action identifiers may already be
persisted or referenced.

======================================================================
TESTS
======================================================================

Automated tests must use injected/mocked dependencies.

No automated test may contact Google or send a real email.

Cover at minimum:

INTENT AND ROUTING

- create new draft
- create reply draft
- send new email
- send reply
- Gmail read request not intercepted
- Calendar request not intercepted
- memory request not intercepted
- generic request not intercepted
- malformed extractor output rejected

RECIPIENT RESOLUTION

- literal email address
- unambiguous Gmail sender
- unresolved name asks
- ambiguous name asks
- no invented address
- Reply-To respected
- sender fallback

THREAD RESOLUTION

- one valid thread
- no matching thread
- multiple matching threads
- correct message/thread metadata
- correct Re: handling
- correct In-Reply-To
- correct References

MIME

- valid plain-text MIME
- Unicode subject/body
- base64url encoding
- header-injection rejection
- no CC/BCC
- no attachments
- no raw MIME logging

DRAFT CREATION

- complete new draft
- complete reply draft
- immediate execution
- no proposal created
- returned Gmail draft metadata validated
- provider failure produces no false success
- missing compose scope requests reconnect

SEND CONFIRMATION

- proposal created
- full preview persisted/displayed
- no send before approval
- YES sends exactly once
- NO sends nothing
- expired proposal sends nothing
- duplicate approval sends once
- duplicate webhook sends once
- provider failure never reports success
- provider success reports success
- final provider payload matches approved preview

REGRESSION

- Gmail reads
- Calendar reads
- Calendar create/update/delete
- memory routing
- reminder routing
- existing confirmations
- token refresh
- one retry after 401
- disconnected integration behavior
- read-only Gmail behavior
- action policy tests
- integration catalog tests

Add the Section 16 test script to server/package.json following existing
conventions.

======================================================================
REAL DIAGNOSTIC
======================================================================

Add a manually invoked Gmail-write diagnostic following repository
conventions.

It must not run during normal tests.

Safe default behavior:

1. Verify Gmail is connected.
2. Verify compose scope exists.
3. Create a temporary fully populated draft addressed to the authenticated
   user or another explicitly provided test address.
4. Fetch and verify the draft.
5. Delete the temporary draft during cleanup if supported safely by the
   diagnostic’s narrow cleanup requirement.

Do not send the email by default.

Any real send diagnostic must require:

- an explicit command-line flag
- an explicit user-controlled recipient
- a clear warning
- separate manual approval

Use a title such as:

Hula Gmail Draft — Safe to Delete

Never print access tokens, refresh tokens, raw authorization headers, or
full provider responses.

======================================================================
VALIDATION
======================================================================

After implementation, run the relevant existing and new tests.

At minimum:

cd ~/Desktop/hulaai/server

npm test
npx tsc --noEmit

cd ~/Desktop/hulaai

npm run lint
npx tsc --noEmit

Then run:

git diff --check
git status --short
git diff --stat
git diff --name-only

Do not commit.

Do not push.

======================================================================
FINAL REPORT
======================================================================

Return:

1. Summary of implemented behavior.
2. Exact files created.
3. Exact files modified.
4. OAuth scope changes.
5. Reconnect requirements.
6. Draft execution behavior.
7. Send confirmation behavior.
8. Recipient-resolution behavior.
9. Reply/thread behavior.
10. Tests added.
11. Exact test results.
12. Type-check and lint results.
13. Real diagnostic command.
14. Any manual setup required.
15. Known limitations.
16. Git status.
17. Confirmation that nothing was committed or pushed.