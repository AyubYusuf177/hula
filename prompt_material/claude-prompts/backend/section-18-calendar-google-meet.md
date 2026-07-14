Read AGENTS.md first and follow it strictly.

We are on the development branch.

Repository:
- ~/Desktop/hulaai
- Starting commit: 879842b
- Commit is pushed to origin/development
- Working tree must begin clean

Section 18 — Complete Google Calendar and Google Meet

Inspect and implement this section. Do not stop after writing a plan.

Goal:
Hula must understand flexible Calendar requests through iMessage and reliably read, search, create, modify and cancel Calendar events, including Google Meet events.

Preserve everything working at commit 879842b, especially:
- Gmail search, summaries and thread-centric context
- Gmail drafts, replies, sends and message management
- Gmail postcondition verification
- Calendar proposal → confirmation → executor → receipt architecture
- Calendar durable idempotency
- Calendar never-past and ambiguity safeguards
- memory
- reminders
- Sendblue messaging
- current mobile UI
- separate Gmail and Google Calendar cards
- Expo Go compatibility

Do not:
- modify the mobile UI
- create a unified Google card
- touch onboarding or Clerk auth
- modify Gmail unless required for a demonstrated regression
- weaken confirmations
- weaken idempotency
- read or edit .env
- expose secrets
- run real provider mutations
- commit
- push

Implement:

1. Flexible Calendar interpretation
- arbitrary dates and date ranges
- today, tomorrow, this/next week
- natural relative dates
- event title/topic search
- attendee search
- location search
- “my next meeting”
- numbered results and natural follow-ups
- “the second event”
- “that meeting”
- “the meeting you just created”
- “move it to Friday”
- “cancel it”
- structured, validated intent extraction
- deterministic provider execution
- no broad phrase-by-phrase regex expansion

2. Calendar entity context
Track per user:
- last event result set
- last selected event
- last successfully created/updated/cancelled event
- last verified action
- expiring references
- stable event IDs so newly created events do not change old numbered references
- user isolation
- clarification on stale or ambiguous references

3. Calendar reads and presentation
- day and date-range schedules
- event search
- clean, concise iMessage formatting
- title
- date/time
- timezone when useful
- location
- attendees when useful
- Google Meet link when present
- no raw provider payloads
- no duplicate recurring-series results
- grounded responses only

4. Availability and free/busy
Use Google Calendar’s real free/busy capability where appropriate:
- “Am I free tomorrow at 3?”
- “When am I free Friday afternoon?”
- “Find me a free hour next week”
- “Do I have a conflict at 10?”
- configurable/bounded working window using existing profile/timezone data where available
- correct timezone handling
- busy intervals merged correctly
- useful free windows
- do not infer free/busy from an incomplete event list
- no fabricated availability

5. Complete event creation
Support:
- title
- start/end
- duration
- timezone
- all-day events
- location
- description
- attendees
- reminders where supported
- target calendar where safely supported
- conflict warning
- Google Meet link on request

Every create:
- produces a clear preview
- requires confirmation
- executes once
- validates the Google response
- stores verified context
- never reports success without the expected event ID

6. Google Meet
Through supported Google Calendar conference-data APIs:
- create an event with a genuine Google Meet conference
- use conferenceDataVersion correctly
- use a unique createRequest requestId
- validate the returned conference entry point
- return the real Meet URL
- retrieve Meet links from existing events
- add a Meet link to an existing event where supported
- never construct or invent a Meet URL
- never claim conference creation before Google returns it
- handle asynchronous/pending conference creation honestly if Google returns pending state
- cancelling/deleting a Meet event must use the normal Calendar confirmation and receipt path

Do not claim support for:
- Meet recordings
- transcripts
- live meeting control
- attendance administration
unless a real authorised API is separately implemented.

7. Complete event updates
Support:
- reschedule
- change duration
- rename
- location
- description
- add/remove attendees
- reminders
- add/retrieve Meet link
- all-day ↔ timed conversion where safe
- target the correct event
- preview exact before/after values
- require confirmation
- verify provider postconditions

8. Cancellation and recurrence
Support safe distinctions:
- delete/cancel a normal event
- modify one occurrence
- delete one occurrence
- update future occurrences where Google safely supports it
- update the entire recurring series
- decline/remove attendance only when explicitly requested and supported

Never guess which recurrence scope the user means.
Ask:
- this event
- this and following events
- entire series
when required.

Preserve existing recurring-event protection until the replacement is demonstrably safe.

9. Attendees and invitations
- resolve explicit email addresses
- never invent an attendee email
- ask for clarification if only a name is supplied and no verified address exists
- clearly preview attendees
- warn that confirmation will send invitations when Google will notify attendees
- use safe notification behaviour
- never send invitations before confirmation
- report partial/provider failures honestly

10. Postcondition verification
After create/update/delete:
- re-fetch when possible
- verify expected title/time/location/attendees/conference state
- verify deletion/nonexistence appropriately
- never treat malformed responses as success
- do not automatically retry ambiguous writes
- preserve durable idempotency across duplicate confirmations and webhook delivery

11. Natural conversation
These should work without exact phrases:
- “What am I doing next Tuesday?”
- “Find my meetings with Rob this month”
- “Am I free Friday afternoon?”
- “Book an hour with Sarah next Monday”
- “Make it a Google Meet”
- “Move it back thirty minutes”
- “Add Rob and change the location to the office”
- “Cancel the second one”
- “Only cancel this occurrence”
- “Undo that” where a safe verified inverse exists

The model may interpret language into strict typed fields.
The model must never call Google directly or claim an action occurred.
Provider data is untrusted.
All writes remain deterministic and confirmed.

12. Tests
Use fake providers, fake persistence and fake model responses.
No real Google, Neon, Sendblue or Anthropic calls.

Add focused tests for:
- arbitrary date/range reads
- event search
- stable numbered references
- pronoun and last-action context
- free/busy and free-window calculation
- timezone and DST boundaries
- all-day events
- attendees
- invitation warning
- locations/descriptions/reminders
- Google Meet creation
- unique conference request IDs
- pending conference state
- missing Meet result
- retrieve existing Meet link
- create/update/delete postcondition verification
- duplicate delivery and confirmation
- ambiguous event matches
- recurrence instance/series choices
- past-event protection
- insufficient scope
- malformed provider responses
- no fabricated success
- Gmail regression
- memory/reminder routing priority
- pending proposals never reaching model fallback

Run:
- backend npm test with its own captured exit code
- backend typecheck
- backend build
- root lint
- root TypeScript
- Prisma generation
- Prisma migration status

Do not run:
- test:calendar-write-real
- test:gmail-write-real
- any *.manual.ts script
- any real external mutation

Final report:
1. Starting Git state
2. Architecture findings
3. Capabilities implemented
4. Google Meet implementation
5. Context and natural-language behaviour
6. Confirmation/idempotency/postcondition behaviour
7. Files created and modified
8. Tests and independently captured exit codes
9. OAuth scope implications
10. Real-device test plan
11. Deferred capabilities
12. Git status

Do not commit or push.