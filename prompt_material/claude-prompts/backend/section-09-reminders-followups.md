Read AGENTS.md first and follow it strictly.

We are on the development branch.

We are building Hula Section 9 only: explicit reminders + lightweight follow-up engine.

Do not add Google Calendar integration yet.
Do not add Zoom integration yet.
Do not add Gmail integration yet.
Do not add Notion integration yet.
Do not add WhatsApp.
Do not add billing.
Do not add frontend UI.
Do not add reminders UI/screens.
Do not add chat history UI.
Do not add automatic reminder inference from every message.
Do not add broad proactive follow-up logic yet.
Do not add tool/action execution.
Do not change onboarding screens.
Do not add onboarding questions.
Do not add frontend popups.
Do not add visible loading states.
Do not add new user-facing buttons.
Do not add new permissions.
Do not change auth.
Do not break Expo Go compatibility.
Do not commit.
Do not push.
Do not use git add -A.
Do not expose env values.
Do not open, print, cat, grep, or display server/.env.
Only inspect .env.example if needed.
Do not print API keys, Clerk secrets, Sendblue secrets, database URLs, Anthropic keys, or tokens.

Current confirmed state:
- Hula app is on Expo Go.
- Backend lives in server/.
- Clerk is the auth system.
- Neon Postgres is the database.
- Prisma is set up and migrated.
- Sendblue is connected.
- Dedicated Hula iMessage number is +1 646 548 0761.
- Anthropic Claude is connected.
- ANTHROPIC_MODEL is claude-opus-4-8.
- ngrok forwards to local backend.
- Sendblue webhook reaches /webhooks/sendblue.
- Section 4 persistence is complete and tested.
- Section 5 message persistence inspection is complete and committed.
- Section 6 Claude brain/router is complete and committed.
- Section 7 silent profile/onboarding context sync is complete and committed.
- Section 7.1 Text hula connected-state UX fix is complete and committed.
- Section 8 explicit long-term memory is complete and committed.
- Latest commit before this section:
  55dc40e Add explicit Hula memory commands
- git status was clean before starting Section 9.

Current architecture:
- Clerk = user identity/auth.
- Neon Postgres = persistence.
- Prisma = database access.
- Sendblue = iMessage transport.
- Anthropic Claude = Hula brain provider.
- Hula backend = router/orchestrator.
- Expo app = user control panel.

Product direction:
Hula is an AGI-style personal assistant that primarily lives inside iMessage and WhatsApp.
The mobile app is the control panel for auth, onboarding, settings, integrations, permissions, subscription, and setup.
The user experience must stay extremely low-friction.
For Section 9, reminders and follow-ups should work through natural iMessage commands only.

Strategic principle:
Reminders and follow-ups are the first real proactive agentic feature.
They must be useful without becoming spammy.
Every proactive message has a user-trust cost and a future delivery/token cost.
Therefore Section 9 should be conservative:
- explicit reminders only
- no automatic follow-up guessing yet
- no integration-based reminders yet
- strong cooldown/limits
- clear cancel/list commands

Future direction:
Later, reminders will also come from integrations:
- Google Calendar meetings
- Zoom calls
- Gmail follow-ups
- Notion/Asana tasks
- travel bookings
- delivery updates
- health/work routines

But Section 9 should only build the foundation those future sources will use.

Section 9 first-principles goal:
When the user explicitly asks Hula to remind them about something, Hula should:
1. Understand the reminder request.
2. Store it persistently.
3. Confirm it.
4. Deliver the reminder proactively through Sendblue/iMessage when due.
5. Save the outbound reminder message.
6. Avoid duplicate sends.
7. Allow the user to list/cancel reminders.

Supported user examples:
- “Remind me to go gym tomorrow at 7pm.”
- “Remind me in 30 minutes to call Rob.”
- “Remind me every Monday at 9am to plan my week.”
- “Remind me tonight to submit the form.”
- “What reminders do I have?”
- “Cancel my gym reminder.”
- “Cancel all reminders.”
- “Stop reminding me about the form.”

Implementation requirements:

1. Add Prisma Reminder model.

Add a safe additive migration.

Suggested model:
Reminder
- id
- userId
- source: explicit_user_request | future_calendar | future_integration
- channel: imessage
- provider: sendblue
- title
- body nullable
- originalText
- status: scheduled | sent | cancelled | failed
- dueAt
- timezone nullable
- recurrenceRule nullable
- nextRunAt nullable
- lastSentAt nullable
- sendCount default 0
- maxSends default 1
- createdAt
- updatedAt
- cancelledAt nullable
- failureReason nullable

Relations:
- belongs to User.

Indexes:
- userId/status
- status/nextRunAt
- status/dueAt

Important:
- Do not reset DB.
- Do not delete existing real user/profile/message/link/memory data.
- No destructive migration.

2. Reminder command detection.

Create helper logic, likely:
server/src/users/reminders.ts

Detect intents:
- create reminder
- list reminders
- cancel reminder
- cancel all reminders

Reminder create triggers:
- “remind me ...”
- “remind me in ...”
- “remind me at ...”
- “remind me tomorrow ...”
- “remind me every ...”
- “can you remind me ...”

List triggers:
- “what reminders do I have?”
- “show my reminders”
- “list my reminders”

Cancel triggers:
- “cancel my ... reminder”
- “delete my ... reminder”
- “stop reminding me about ...”
- “cancel all reminders”

Important:
- Reminder command messages from already-linked users should be handled deterministically by backend logic.
- They should not call the normal Claude brain unless parsing fails and a normal reply is needed.
- Unknown/unconnected sender flows stay unchanged.
- Connect-code flows stay unchanged.
- Memory command flows from Section 8 stay unchanged and should take precedence where appropriate.

3. Date/time parsing.

Use simple deterministic parsing for Section 9.

Must support:
- “in 10 minutes”
- “in 2 hours”
- “tomorrow at 7pm”
- “tonight”
- “today at 6pm”
- “Monday at 9am”
- “every Monday at 9am”
- “every day at 8am”

Use user timezone from UserProfile if available.
Fallback to server timezone or UTC only if no user timezone exists.
Document fallback.

Do not overbuild natural language parsing.
If the date/time is ambiguous, ask one clarification:
“What time should I remind you?”

Examples:
- “Remind me to call Rob” → ask for time.
- “Remind me tomorrow” → ask for time.
- “Remind me later” → ask for time.

If adding a small date parsing library is justified, use one lightweight dependency and update package-lock. Otherwise implement simple parser manually.

4. Reminder delivery worker.

Add a safe local worker in the backend process.

Requirements:
- On server start, worker checks due reminders on an interval.
- Interval should be conservative for local MVP, e.g. every 30–60 seconds.
- Due reminders are reminders with status scheduled and nextRunAt/dueAt <= now.
- Worker sends proactive iMessage through Sendblue to the user’s active MessagingIdentity.
- If no active identity exists, mark failed or keep scheduled with failure reason.
- Save outbound Message for the reminder.
- Avoid duplicate sends.
- Must be safe across restarts.
- Must not send the same one-off reminder multiple times.
- For recurring reminders, update nextRunAt after successful send.
- For one-off reminders, mark sent after successful send.

Concurrency:
- Since local MVP has one backend process, a simple safe transaction/update is enough.
- But design to avoid obvious double-sends if worker ticks twice.

5. Cost/spam control.

Add hard limits:
- Do not send more than a small number of due reminders per worker tick, e.g. 10.
- Do not allow extremely frequent recurrence like every minute.
- Minimum recurrence interval should be daily for Section 9.
- Cap active reminders per user, e.g. 50.
- Cap message length.
- Do not call Claude to generate due reminder delivery text.
- Reminder delivery should use deterministic text to save tokens/cost.

Reminder delivery text:
“Reminder: {title}”

If body exists:
“Reminder: {title}\n{body}”

No Claude call for reminder delivery in Section 9.

6. Reminder confirmations.

For create:
“Got it — I’ll remind you {human time}: {title}.”

For recurring:
“Got it — I’ll remind you every Monday at 9:00 AM: {title}.”

For list none:
“You don’t have any active reminders.”

For list some:
“Your active reminders:
1. {title} — {time}
2. ...”

For cancel one:
“Done — I cancelled that reminder.”

For cancel all:
“Done — I cancelled all active reminders.”

For ambiguous time:
“What time should I remind you?”

Keep replies short and iMessage-friendly.

7. Follow-up model, but minimal.

Do not build autonomous follow-up suggestions yet.

Add only a data model field/source design that future follow-ups can use:
- Reminder.source supports future_integration.
- Do not add auto-follow-up logic.
- Do not make Hula proactively guess.
- Do not have Claude decide to schedule reminders without explicit user ask.

If user says:
“Follow up with me tomorrow about this”
that counts as an explicit reminder and should create a reminder.

8. Endpoints for inspection.

Add authenticated endpoints:
GET /v1/me/reminders
DELETE /v1/me/reminders/:id

Auth:
- Clerk bearer token.
- User can only see/delete their own reminders.
- Return active scheduled reminders by default.
- No frontend UI yet.

Optional:
POST /v1/me/reminders only if clean and useful for future app UI, but iMessage path is the priority.

9. Wire into webhook.

Order of handling for already-linked user:
1. Connect-code deterministic handling if relevant.
2. Memory commands from Section 8.
3. Reminder commands from Section 9.
4. Normal Claude brain reply.

Unknown sender and connect-code flows must stay unchanged.

10. Tests.

Add/update tests for:
- create reminder command detection
- list reminder command detection
- cancel reminder command detection
- ambiguous reminder asks clarification
- parse “in 10 minutes”
- parse “tomorrow at 7pm”
- parse “every Monday at 9am”
- reject too-frequent recurrence
- create/list/cancel helpers
- active reminder cap if implemented
- worker selects due reminders
- worker marks one-off sent after successful send
- worker advances recurring reminder after successful send
- worker avoids duplicate send if already sent/cancelled
- no Claude call for due reminder delivery
- reminder commands do not break memory commands
- unknown/connect-code flows unchanged
- existing normalization/linking/query/brain/profile/messaging-status/memory tests still pass

Normal tests must not call real Anthropic or Sendblue.
Manual scripts may use real DB/Sendblue only if env present and must be clearly marked.

11. Optional manual script.

Add:
server/scripts/reminders.manual.ts

It should test DB create/list/cancel/worker selection safely with throwaway data.
Do not send real SMS/iMessage from the script unless explicitly separated behind a flag.
Print no secrets.

12. README update.

Add Section 9:
- what explicit reminders do
- supported reminder phrases
- list/cancel commands
- date/time limitations
- recurrence limitations
- worker behaviour
- cost/spam controls
- how to run locally
- how to test with iMessage
- future integration plan
- limitations:
  no Google Calendar yet
  no Zoom yet
  no Gmail yet
  no WhatsApp yet
  no automatic follow-up inference yet
  no reminder UI yet
  no Claude call for due reminder delivery

13. Save this prompt.

If prompt_material/claude-prompts/backend exists, save a copy as:
prompt_material/claude-prompts/backend/section-09-reminders-followups.md

14. Validation commands.

Run from repo root:
git branch --show-current
git status --short

Frontend:
npm run lint
npx tsc --noEmit

Backend:
cd server
npm run typecheck
npm run build
npm test
npm run prisma:generate

If schema changed:
npm run prisma:migrate

If reminder manual script added:
npm run test:reminders
or whatever script name was added

Manual end-to-end test:
1. Start backend.
2. Start ngrok.
3. Start Expo if needed.
4. From already-linked iMessage thread, send:
   Remind me in 2 minutes to test Hula reminders.
5. Expected:
   Got it — I’ll remind you [time]: test Hula reminders.
6. Wait for due time.
7. Expected proactive iMessage:
   Reminder: test Hula reminders
8. Send:
   What reminders do I have?
9. Expected:
   No active reminders, or list only future scheduled reminders.
10. Send:
   Remind me tomorrow at 7pm to go gym.
11. Expected:
   Confirmation.
12. Send:
   What reminders do I have?
13. Expected:
   gym reminder appears.
14. Send:
   Cancel my gym reminder.
15. Expected:
   Done — I cancelled that reminder.
16. Confirm Hula still handles normal Claude replies after reminder commands.

Final response:
1. Files changed
2. Prisma schema/migration changes
3. Reminder model added
4. Reminder commands supported
5. Date/time parsing supported
6. Reminder worker behaviour
7. Cost/spam controls
8. Reminder endpoints added
9. How reminders are delivered through Sendblue
10. Test results
11. Manual test results
12. Confirm no integrations/billing/WhatsApp/frontend UI/chat-history UI/automatic follow-up inference/tool execution were added
13. Confirm no commit was made