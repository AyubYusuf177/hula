Read AGENTS.md first and follow it strictly.

We are on the development branch.

This is a fresh Section 16 email-action reliability implementation thread.

Section 16 and its live bug fixes are currently uncommitted.

Do not commit.
Do not push.
Do not use git add -A.
Do not modify unrelated functionality.

Preserve every currently working Gmail read, draft, send, reply, Calendar,
memory, reminder, OAuth, token-refresh, proposal, confirmation,
idempotency, and webhook capability.

======================================================================
PRODUCTION BLOCKER
======================================================================

Live acceptance testing exposed two remaining failures:

1. After Hula created a real Gmail reply draft, the user said:

   "Send the draft to Rob"

   Hula replied:

   "Reply sent to Robert Ellis."

   No Gmail send occurred.

2. A separate send proposal was displayed and the user replied:

   "Yh"

   Hula did not recognise it as approval and asked for literal yes/no.

These must be fixed comprehensively.

The Gmail provider itself works. Real diagnostics, draft creation, new
email sends, and reply sends have already passed.

The failures are in missing action support, conversational context,
confirmation interpretation, routing, and operational-result honesty.

======================================================================
NON-NEGOTIABLE SYSTEM INVARIANT
======================================================================

No external action may ever be reported as completed unless the backend
has a validated provider/action receipt proving completion.

This applies to:

- Gmail draft created
- Gmail email sent
- Gmail reply sent
- Calendar created/updated/deleted
- reminder created
- memory changed
- every future integration action

Free-form model output must never be capable of producing an operational
success claim.

A model may draft wording or explain results, but the completion claim
must originate from deterministic action code using a validated receipt.

No provider-confirmed result
→ no completion claim.

Unknown, unsupported, failed, timed-out, malformed, or uncertain result
→ honest deterministic response.

======================================================================
FAILURE 1 — "SEND THE DRAFT"
======================================================================

Current observed flow:

1. User asks Hula to create a Gmail reply draft.
2. Hula creates a real Gmail draft.
3. User says:
   "Send the draft to Rob"
4. Hula claims it was sent.
5. Gmail shows it was not sent.

Investigate and implement support for sending the actual Gmail draft that
Hula most recently created for the user.

Approved product behaviour:

After Hula creates a real Gmail draft, persist or retain a safe,
user-scoped conversational reference containing sufficient identifiers
such as:

- Gmail draft ID
- Gmail message ID where available
- Gmail thread ID
- recipient
- subject
- action type
- created timestamp
- expiry
- user ID
- status

Do not retain secrets or raw access tokens.

Support natural follow-up commands including:

- send the draft
- send that draft
- send it
- send that
- send the draft to Rob
- go ahead and send the draft
- email the draft
- send my last draft
- send the reply draft

Resolution rules:

1. Resolve only the authenticated user's own recent Hula-created draft.
2. Prefer an unexpired active draft created in the immediate conversation.
3. If exactly one relevant draft exists, use it.
4. If several relevant drafts exist, ask which one.
5. If no safe draft reference exists, say so honestly.
6. Never guess a Gmail draft ID.
7. Never send another unrelated Gmail draft.

Before sending:

- re-fetch the Gmail draft
- verify it still exists
- verify recipient, subject, body, and thread metadata
- use Gmail's draft-send operation where appropriate
- do not reconstruct a different message if Gmail can send the real draft
- validate Gmail's returned message/thread identifiers

Approved authorization policy:

An explicit follow-up command such as:

"Send the draft"
"Send it"
"Go ahead and send that draft"

counts as explicit authorization to send the already-created and
referenced draft.

Do not ask for a redundant second YES after that explicit command.

Hula may only reply "sent" after Gmail confirms the draft was sent.

After success:

- mark the draft reference as sent/consumed
- prevent duplicate sends
- repeated "send it" must not send twice
- report that it was already sent where appropriate

On provider failure:

- do not mark sent
- do not claim sent
- return an honest deterministic failure
- preserve safe retry behaviour without duplication

======================================================================
FAILURE 2 — NATURAL CONFIRMATION
======================================================================

When a pending send preview exists, interpret short replies contextually.

Approved confirmations include:

- yes
- y
- yh
- yeah
- yea
- yep
- sure
- okay
- ok
- absolutely
- send
- send it
- send that
- go ahead
- go for it
- looks good
- sounds good
- confirm
- do it
- proceed

Approved cancellations include:

- no
- nope
- nah
- cancel
- cancel it
- don't send
- do not send
- stop
- leave it
- forget it

Requirements:

- only apply this vocabulary when an active confirmable proposal exists
- normalize punctuation, capitalization, apostrophes, and surrounding
  whitespace
- keep matching conservative
- short standalone approval phrases may confirm
- ordinary long sentences must not accidentally confirm
- ambiguous replies must re-prompt safely
- never route an active-proposal reply to the generic brain
- one approval executes exactly once
- rejection executes nothing
- expired proposals execute nothing
- repeated approval cannot duplicate the provider action

The displayed prompt should not imply only literal YES/NO are accepted.

Use wording such as:

"Reply ‘send it’ to continue or ‘cancel’ to stop."

======================================================================
SYSTEM-WIDE OPERATIONAL HONESTY
======================================================================

Inspect every route capable of returning wording equivalent to:

- sent
- created
- updated
- deleted
- scheduled
- completed
- done
- connected
- disconnected

Identify whether each claim originates from:

- a validated action receipt
- deterministic backend state
- or free-form model output

External-action completion claims must never originate solely from the
generic brain.

Implement a robust boundary, not only a prompt instruction.

Potential acceptable approaches include:

- typed action result objects
- receipt-required success formatters
- deterministic operational response functions
- preventing the brain from handling recognised action-like messages
- sanitising/forbidding unsupported completion claims in generic fallback

Use the repository's established architecture.

Do not build an unrelated second framework.

The brain prompt should retain a defence-in-depth rule:

- never claim an external action succeeded without confirmed system result
- never invent action execution
- never tell the user something was sent/created/deleted unless provided
  a validated result

But prompt wording alone is not sufficient.

======================================================================
CONVERSATIONAL EMAIL CONTEXT
======================================================================

Hula must understand follow-ups to the action it just performed.

Examples:

User:
"Draft a reply to Rob's latest email accepting the Relief Officer role."

Hula:
"Reply draft created in Gmail."

User:
"Send it."

Expected:
Resolve and send that exact draft.

User:
"Change the last sentence to ask when I start."

Editing is not currently approved for Section 16. Respond honestly that
draft editing is not yet supported, rather than claiming it happened.

User:
"Delete it."

Draft deletion remains outside current product scope unless already
implemented solely for diagnostics. Respond honestly.

Do not let the generic brain fabricate unsupported draft operations.

Use a narrowly scoped user-level email action context with expiry.

Do not create a Prisma schema change unless existing action/proposal or
conversation-state infrastructure is demonstrably insufficient. If a
schema change is necessary, stop and explain before proceeding.

======================================================================
ROUTING PRIORITY
======================================================================

Inspect the current webhook handler order.

The intended order must ensure:

1. duplicate webhook protection
2. memory/reminder/Calendar-specific deterministic handlers as currently
   required
3. active action confirmation handling
4. active Gmail draft follow-up handling
5. Gmail write intents
6. Gmail read intents
7. other deterministic actions
8. generic brain fallback

The exact order must preserve existing behaviour, but:

- active proposal replies must not reach the brain
- active draft follow-ups must not reach the brain
- recognised action-like requests must not receive invented success text

"Send the draft" must not be interpreted as:
- a generic send-new-email request
- a Gmail read request
- a brain-only conversational request

======================================================================
GMAIL PROVIDER REQUIREMENTS
======================================================================

Inspect whether the provider currently supports Gmail's draft-send
operation.

Implement the narrow provider operation required to send an existing
Gmail draft.

Requirements:

- use existing encrypted connection/token handling
- reuse token refresh
- reuse one retry after 401
- validate the draft belongs to the active user integration
- validate Gmail response identifiers
- normalize provider errors
- never log raw MIME, tokens, authorization headers, or private bodies
- no false success from malformed HTTP 2xx responses
- no duplicate send on retries or repeated user messages

Use the existing gmail.compose scope if sufficient.

Do not request gmail.modify or broader mailbox access unless Google
requires it for this exact operation. Stop and report before broadening
scope.

======================================================================
USER-FACING RESPONSES
======================================================================

Successful existing-draft send:

"Draft sent to Robert Ellis."

Only after Gmail confirms success.

Already sent:

"That draft was already sent."

No active draft:

"I couldn't find a recent Hula-created draft to send. Please create the
draft again."

Several drafts:

"I found a few recent drafts. Which one should I send?"

Provider failure:

"I couldn't confirm that Gmail sent the draft, so I haven't marked it as
sent."

Pending proposal re-prompt:

"I'm waiting for your go-ahead. Reply 'send it' to continue or 'cancel'
to stop."

Never respond with:

- "sent" before provider confirmation
- "my mistake" followed by an invented retry state
- "confirm and I'll do it" unless a real recoverable proposal/draft exists
- unsupported operational promises

======================================================================
TEST REQUIREMENTS
======================================================================

Reproduce the exact live failures.

SEND EXISTING DRAFT

- create real mocked Gmail reply draft
- persist conversational draft reference
- "send the draft to Rob" resolves that draft
- provider draft-send operation is invoked once
- validated Gmail response produces success
- no Gmail result produces no success wording
- provider throw produces no success wording
- malformed provider response produces no success wording
- repeated "send it" does not send twice
- expired draft context does not send
- no active draft does not send
- multiple active drafts asks for clarification
- another user's draft can never be resolved
- draft is re-fetched before sending
- recipient/thread metadata matches the real draft
- success marks context consumed/sent

NATURAL CONFIRMATION

Table-test approval phrases:

- yes
- y
- yh
- yeah
- yea
- yep
- sure
- okay
- ok
- absolutely
- send
- send it
- send that
- go ahead
- go for it
- looks good
- sounds good
- confirm
- do it
- proceed

Table-test cancellation phrases:

- no
- nope
- nah
- cancel
- cancel it
- don't send
- do not send
- stop
- leave it
- forget it

Also test:

- capitalization
- punctuation
- whitespace
- ambiguous long sentences
- no active proposal
- expired proposal
- duplicate confirmation
- provider failure
- malformed provider success
- active proposal reply never reaches brain

OPERATIONAL HONESTY

- generic brain output cannot claim Gmail email sent
- generic brain output cannot claim Gmail draft sent
- generic brain output cannot claim Calendar action completed
- generic brain output cannot claim reminder/action completed
- unsupported "send the draft" never generates a fake success
- only validated action receipts reach operational success formatters
- an uncertain provider result never says completed
- retries do not duplicate actions

REGRESSION

- Gmail list
- Gmail read one
- Gmail summarise one
- Gmail create new draft
- Gmail create reply draft
- Gmail send new email
- Gmail send reply
- Gmail clarification
- Gmail latest resolution
- professional signature
- Calendar read/create/update/delete
- memory
- reminders
- action proposals
- action confirmations
- token refresh
- 401 retry
- webhook deduplication
- idempotency

No automated test may contact Gmail or send real email.

======================================================================
VALIDATION
======================================================================

Run:

cd ~/Desktop/hulaai/server

npm test
npx tsc --noEmit

cd ~/Desktop/hulaai

npm run lint
npx tsc --noEmit

Then:

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

1. Exact root cause of "Send the draft" producing a false success.
2. Exact root cause of "Yh" not confirming.
3. Exact handler paths before and after the fix.
4. How recent Hula-created drafts are referenced safely.
5. How sending an existing Gmail draft works.
6. How duplicate draft sends are prevented.
7. Full supported confirmation/cancellation vocabulary.
8. How operational success claims are now receipt-gated.
9. Every source of false action-success wording that was removed or
   blocked.
10. Exact files created.
11. Exact files modified.
12. Tests added.
13. Exact test results.
14. Type-check and lint results.
15. Remaining limitations.
16. Git status.
17. Confirmation that nothing was committed or pushed.