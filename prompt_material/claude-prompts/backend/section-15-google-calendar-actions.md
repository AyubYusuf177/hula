Read AGENTS.md first and follow it strictly.

We are on the development branch.

DO NOT COMMIT.
DO NOT PUSH.
DO NOT USE git add -A.

This is Section 15 only.

Goal:
Add Google Calendar create, update, and delete actions through iMessage while preserving all existing Gmail and Calendar read functionality.

Before making ANY code changes, inspect the repository and understand the existing architecture.

This section must follow the same process used for previous Hula backend sections.

======================================================================
CURRENT BASELINE
======================================================================

Repository:

~/Desktop/hulaai

Branch:

development

Latest stable commit:

c7d336b Add Gmail integration and redesign integrations experience

Current state:

- Gmail readonly integration works
- Google Calendar readonly integration works
- Sendblue webhook routing works
- Google OAuth works
- Token storage works
- Token refresh works
- Integrations V2 works
- Gmail and Calendar connections work
- Mobile app works in Expo Go

Do not break any of the above.

======================================================================
SECTION 15 OBJECTIVE
======================================================================

After this section, a connected user should be able to send messages like:

"Schedule lunch with Adam tomorrow at 1pm"

"Move lunch with Adam tomorrow to 2pm"

"Delete lunch with Adam tomorrow"

through iMessage and have Hula:

1. Understand the request
2. Resolve the correct Google Calendar account
3. Execute the Calendar action
4. Confirm the result through iMessage

The flow should be:

iMessage
→ Sendblue webhook
→ existing Hula router
→ Calendar action detection
→ validation
→ Google Calendar provider
→ Google API
→ confirmation response
→ iMessage reply

======================================================================
PHASE 1 — ARCHITECTURE INSPECTION
======================================================================

Do not modify code yet.

Inspect the repository first.

Run:

cd ~/Desktop/hulaai

git branch --show-current
git status --short
git log -1 --oneline

find server/src -maxdepth 6 -type f | sort

Search for:

grep -R "calendar" -n server/src | head -250

grep -R "Sendblue\\|sendblue" -n server/src | head -200

grep -R "webhook" -n server/src | head -200

grep -R "refreshToken\\|accessToken" -n server/src | head -200

grep -R "scope\\|scopes" -n server/src | head -200

grep -R "google" -n server/src/integrations | head -250

Inspect:

server/src/app.ts

server/src/routes/webhooks.ts

server/src/integrations/catalog.ts

server/src/integrations/providers

server/prisma

server/package.json

Do not expose secrets.

Do not print tokens.

======================================================================
PHASE 2 — REPORT BEFORE IMPLEMENTING
======================================================================

Before changing any code, provide:

1. Existing Google Calendar architecture
2. Existing OAuth/token flow
3. Existing token refresh flow
4. Existing Calendar read flow
5. Existing Sendblue webhook flow
6. Existing model routing flow
7. Existing tests related to Calendar
8. Exact files you plan to modify
9. Exact files you plan to create
10. Risks

If architecture conflicts are discovered, explain them before implementation.

Otherwise continue.

======================================================================
PHASE 3 — GOOGLE CALENDAR WRITE CAPABILITY
======================================================================

Inspect existing OAuth scopes.

Confirm whether a write-capable Calendar scope already exists.

Specifically verify whether the implementation already requests:

https://www.googleapis.com/auth/calendar.events

Do not remove any Gmail scopes.

Do not remove readonly Calendar scopes.

Do not create a second OAuth implementation.

Reuse the existing Google integration architecture.

If a user lacks write permissions, return a clear message explaining that Calendar must be reconnected.

======================================================================
PHASE 4 — PROVIDER IMPLEMENTATION
======================================================================

Extend the existing Calendar provider.

Do not create duplicate Google clients.

Add typed provider operations equivalent to:

createCalendarEvent

updateCalendarEvent

deleteCalendarEvent

findCalendarEvents

Reuse existing token refresh behavior.

Google API calls should remain inside the provider layer.

Do not place Google API calls directly inside webhook routes.

======================================================================
PHASE 5 — ACTION EXTRACTION
======================================================================

Reuse the existing model/router architecture.

Do not add another model provider.

Implement structured Calendar write extraction.

Supported actions:

create

update

delete

not_calendar_write

Validate structured output before use.

Use existing validation conventions.

If Zod already exists, reuse it.

The model must never directly control Google API calls.

The backend must validate:

required fields

date/time validity

event matching

ambiguity handling

allowed operations

======================================================================
PHASE 6 — CREATE EVENT
======================================================================

Support requests such as:

"Schedule lunch with Adam tomorrow at 1pm"

"Schedule a Hula test tomorrow at 3pm for 30 minutes"

Fields:

title

start time

end time

timezone

optional location

optional description

If no duration is provided:

default to 60 minutes

Do not create events unexpectedly in the past.

Confirmation must come from the actual Google response.

Example confirmation:

Done — "Lunch with Adam" is scheduled for Tuesday from 1:00 PM to 2:00 PM.

======================================================================
PHASE 7 — UPDATE EVENT
======================================================================

Support requests such as:

"Move lunch with Adam tomorrow to 2pm"

"Rename lunch with Adam to Project Planning"

When updating:

preserve fields that were not requested to change

Example:

moving an event should preserve:

title

description

location

attendees

duration

Only change the requested fields.

Use patch semantics where possible.

Example confirmation:

Updated — "Lunch with Adam" is now scheduled for Tuesday from 2:00 PM to 3:00 PM.

======================================================================
PHASE 8 — DELETE EVENT
======================================================================

Support requests such as:

"Delete lunch with Adam tomorrow"

Before deletion:

1. Find the intended event
2. Capture its details
3. Delete the exact event
4. Confirm deletion

Example:

Deleted — "Lunch with Adam" on Tuesday at 2:00 PM.

Never delete when several plausible matches exist.

======================================================================
PHASE 9 — EVENT MATCHING SAFETY
======================================================================

For update and delete:

Search a narrow relevant time range.

Match using:

title

date

time

Calendar context already available

Required behavior:

ZERO MATCHES

Return:

I couldn't find a matching calendar event.

ONE STRONG MATCH

Proceed.

MULTIPLE MATCHES

Do not perform any write.

Return a clarification such as:

I found two matching events tomorrow:

1. Lunch with Adam at 1:00 PM
2. Lunch with Adam at 5:00 PM

Which one did you mean?

Do not implement a large multi-turn clarification system in this section.

======================================================================
PHASE 10 — RECURRING EVENTS
======================================================================

Keep this simple.

Do not build full recurring-series management.

Do not accidentally modify or delete an entire recurring series.

If a recurring event cannot be safely resolved:

return a clarification request.

======================================================================
PHASE 11 — WEBHOOK INTEGRATION
======================================================================

Integrate Calendar writes into the existing webhook flow.

Do not rewrite the webhook architecture.

Keep routing responsibilities separated.

Preferred flow:

webhooks.ts
→ detect Calendar write request
→ call Calendar action service
→ receive response
→ send Sendblue message

Preserve:

Calendar readonly routing

Gmail routing

generic Hula routing

phone-number user resolution

Sendblue response behavior

======================================================================
PHASE 12 — AUTOMATED TESTS
======================================================================

Use mocked Google API calls.

Do not write to a real Calendar in automated tests.

Add tests for:

CREATE

- valid create request
- create request missing time
- default duration
- custom duration
- optional location
- Google failure handling

UPDATE

- valid update
- duration preservation
- title update
- zero match
- multiple match
- Google failure handling

DELETE

- valid delete
- zero match
- multiple match
- Google failure handling

REGRESSION

- existing Calendar read still works
- existing Gmail functionality still works
- token refresh still works
- missing Calendar connection handled safely

======================================================================
PHASE 13 — SAFE MANUAL DIAGNOSTIC
======================================================================

After automated tests pass, create a diagnostic script if the repository already uses diagnostics.

Suggested name:

calendarWriteDiagnostic.ts

The diagnostic should:

1. Verify configuration
2. Resolve a connected test user
3. Create a temporary future event
4. Fetch it
5. Update it
6. Fetch again
7. Delete it
8. Verify deletion
9. Clean up if any step fails

Use the title:

Hula Calendar Diagnostic — Safe to Delete

Do not run the diagnostic automatically.

Provide the command and wait for approval.

======================================================================
PHASE 14 — VALIDATION
======================================================================

Run:

cd ~/Desktop/hulaai

npm run lint

npx tsc --noEmit

cd ~/Desktop/hulaai/server

npm run lint

npx tsc --noEmit

Use the actual scripts defined in package.json.

Also run:

git diff --check

git status --short

git diff --stat

git diff --name-only

======================================================================
CONSTRAINTS
======================================================================

Section 15 only.

No commits.

No pushes.

No git add -A.

Do not redesign mobile UI.

Do not build conversation memory.

Do not build future sections.

Do not add unrelated integrations.

Do not add another OAuth system.

Do not replace Clerk.

Do not enable Neon Auth.

Do not break Gmail.

Do not break Calendar reads.

Do not expose tokens.

Do not expose secrets.

Do not claim success before Google confirms success.

Do not modify ambiguous events.

Do not delete ambiguous events.

Do not create events in the past.

Preserve Expo Go compatibility.

======================================================================
DEFINITION OF DONE
======================================================================

Section 15 is complete when:

- Calendar create works through iMessage
- Calendar update works through iMessage
- Calendar delete works through iMessage
- Missing information returns clarification
- Multiple matches do not trigger writes
- Existing Calendar reads still work
- Existing Gmail functionality still works
- OAuth/token refresh still works
- Tests pass
- TypeScript passes
- Validation passes
- A manual diagnostic is available
- No commit has been made
- No push has been made

======================================================================
FINAL RESPONSE FORMAT
======================================================================

Return:

1. Architecture discovered

2. Section 15 implementation

3. Files changed

4. OAuth scope findings

5. Safety behavior

6. Tests

7. Validation results

8. Manual diagnostic command

9. iMessage acceptance tests

10. Git status

Do not commit.

Do not push.