Read AGENTS.md first and follow it strictly.

We are on the development branch.

We are building Hula Section 8 only: explicit long-term memory for iMessage.

Do not add reminders.
Do not add integrations.
Do not add WhatsApp.
Do not add billing.
Do not add memory UI/screens.
Do not add chat history UI.
Do not add automatic memory extraction from every message.
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
- Latest commit before this section:
  28bc2d4 Fix Text hula connected-state flow
- git status was clean before starting Section 8.

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
Users should not need to manage memory in UI yet.
For Section 8, memory should work through natural iMessage commands only.

Section 8 first-principles purpose:
Hula can already identify users, store messages, sync profile context, and call Claude.
Now Hula needs explicit long-term memory, similar to ChatGPT/Claude memory, but conservative and user-controlled.

Goal:
When the user explicitly asks Hula to remember something useful and stable, Hula saves it.
When the user asks Hula what it remembers, Hula lists active memories.
When the user asks Hula to forget something, Hula deletes/deactivates matching memory.
Normal Claude replies should use active memories lightly.

Important memory philosophy:
Do not remember everything.
Do not infer sensitive memories automatically.
Do not store raw chat as memory.
Do not store secrets.
Do not store creepy or unnecessary personal details.
Do store stable, useful preferences and facts that improve future help.

Sensitive memory policy:
Hula may save sensitive-adjacent details only when the user clearly asks Hula to remember them and they are directly useful.

Allowed if explicitly requested:
- religious/dietary preference, e.g. “Remember I’m Muslim and don’t eat pork.”
- health/accessibility preference, e.g. “Remember I’m lactose intolerant.”
- political/work preference if directly useful, e.g. “Remember I prefer politically neutral wording.”
- personal constraints, e.g. “Remember I avoid alcohol.”

Do NOT save automatically inferred sensitive facts.
Example:
- User mentions prayer once → do not infer/save religion.
- User mentions medication once → do not infer/save health condition.
- User discusses politics once → do not infer/save political identity.

Blocked even if requested:
- passwords
- API keys
- bank/card details
- government IDs
- precise home address
- private information about another person without clear consent
- instructions to hide dangerous or illegal activity

For blocked memories, reply politely:
“I can keep that in mind for this chat, but I won’t save it as long-term memory.”

Section 8 memory UX in iMessage:
Examples:

User:
Remember I prefer blunt, concise replies.

Hula:
Got it — I’ll remember that you prefer blunt, concise replies.

User:
Remember I’m Muslim and don’t eat pork.

Hula:
Got it — I’ll remember that you don’t eat pork.

User:
What do you remember about me?

Hula:
I remember:
1. You prefer blunt, concise replies.
2. You’re building Hula.
3. You don’t eat pork.

User:
Forget that I prefer blunt replies.

Hula:
Done — I forgot that preference.

User:
Forget everything you remember about me.

Hula:
Done — I cleared your saved memories.

Implementation requirements:

1. Add Prisma Memory model.

Add a safe additive migration.

Suggested model:
Memory
- id
- userId
- type: preference | fact | instruction | goal | project | routine | constraint
- text
- source: explicit_user_request
- status: active | deleted
- confidence: float default 1.0
- tags: Json nullable
- importance: low | medium | high default medium
- createdAt
- updatedAt
- deletedAt nullable
- lastUsedAt nullable

Relations:
- belongs to User.

Indexes:
- userId/status
- userId/type/status

Do not reset DB.
Do not delete existing real user/profile/message/link data.
No destructive migration.

2. Add backend memory helpers.

Suggested file:
server/src/users/memory.ts

Functions:
- createMemoryForUser(userId, input)
- listActiveMemoriesForUser(userId, limit?)
- softDeleteMemory(userId, memoryId)
- softDeleteMemoriesByTextMatch(userId, query)
- softDeleteAllMemoriesForUser(userId)
- classifyMemoryCommand(text)
- buildMemoryContext(userId)

Keep matching simple for Section 8.
No vector DB yet.
No semantic search yet.
No embeddings yet.

3. Memory command detection.

Before normal Claude brain response, detect explicit memory commands.

Supported intents:
- remember
- forget
- list

Remember triggers:
- “remember ...”
- “please remember ...”
- “don’t forget ...”
- “save this ...”
- “keep in mind ...”

Forget triggers:
- “forget ...”
- “delete that memory ...”
- “remove that memory ...”
- “forget everything you remember about me”
- “clear my memory”

List triggers:
- “what do you remember about me?”
- “what have you remembered?”
- “show my memories”
- “list my memories”

Important:
- Memory command messages from already-linked users should be handled deterministically by backend logic.
- They should not call the normal Claude brain unless needed for wording after the deterministic action.
- Unknown/unconnected sender flows stay unchanged.
- Connect-code flows stay unchanged.

4. Memory safety validation.

Create a lightweight validator/policy.

Allowed memory categories:
- communication preference
- assistant behaviour preference
- project/goals
- routine
- non-sensitive likes/dislikes
- dietary/religious constraint if explicit
- health/accessibility constraint if explicit and practical
- work/study preference
- planning preference

Blocked:
- secrets/passwords/API keys
- bank/card details
- government IDs
- precise address
- illegal evasion instructions
- private details about third parties
- automatically inferred sensitive identity

For Section 8, since all memory is explicit, allow sensitive-adjacent practical constraints when phrased as a direct “remember” command and not dangerous.

Sanitise:
- trim text
- cap memory text length
- cap tags
- avoid storing raw whole paragraphs if too long
- do not store message metadata as memory
- do not store tokens/secrets

5. Include memory in Hula brain.

For normal non-memory messages from linked users:
- load active memories for user, capped, e.g. max 20
- pass memory context into Hula brain along with profile context and recent messages
- system prompt should use memories lightly
- do not over-mention memory
- do not say “from your saved memory” unless user asks what it remembers
- update lastUsedAt best-effort when memories are included

6. Add authenticated memory endpoint for inspection.

Add:
GET /v1/me/memories

Auth:
- Clerk bearer token
- only current user
- return active memories only by default

Response shape:
{
  "memories": [
    {
      "id": "...",
      "type": "preference",
      "text": "User prefers blunt, concise replies.",
      "importance": "medium",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}

Optional:
DELETE /v1/me/memories/:id
Only if easy and safe.

No frontend UI for this endpoint yet.

7. Hula replies for memory commands.

Remember success:
“Got it — I’ll remember that [clean memory].”

Forget one/matching:
“Done — I forgot that.”

Forget all:
“Done — I cleared your saved memories.”

List none:
“I don’t have any saved memories for you yet.”

List some:
“I remember:
1. ...
2. ...
3. ...”

Blocked:
“I can keep that in mind for this chat, but I won’t save it as long-term memory.”

Keep replies short and iMessage-friendly.

8. Tests.

Add/update tests for:
- remember command detection
- forget command detection
- list command detection
- non-memory normal messages do not trigger memory command
- memory text sanitisation
- sensitive practical explicit memory allowed, e.g. “Remember I’m Muslim and don’t eat pork.”
- blocked secret memory rejected, e.g. “Remember my password is abc123”
- create/list/soft-delete helpers
- forget all
- memory context included in brain prompt
- unknown sender/connect-code flows unchanged
- existing normalization/linking/query/brain/profile/messaging-status tests still pass

Normal tests must not call real Anthropic.
Manual scripts may call real DB/Anthropic only if env present and must clean up.

9. Optional manual script.

Add:
server/scripts/memory.manual.ts

It should:
- create throwaway user
- create memories
- list memories
- delete one
- clear all
- clean up
- print no secrets

10. README update.

Add Section 8:
- what explicit memory does
- supported commands
- allowed/blocked memory policy
- example iMessage flows
- how to run tests
- how to inspect memories with GET /v1/me/memories
- limitations:
  no automatic memory extraction yet
  no memory UI yet
  no embeddings/vector search yet
  no reminders
  no integrations
  no WhatsApp
  no tools/actions

11. Save this prompt.

If prompt_material/claude-prompts/backend exists, save a copy as:
prompt_material/claude-prompts/backend/section-08-explicit-memory.md

12. Validation commands.

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

If memory manual script added:
npm run test:memory
or whatever script name was added

Manual end-to-end test:
1. Start backend.
2. Start ngrok.
3. Start Expo if needed.
4. From already-linked iMessage thread, send:
   Remember I prefer blunt, concise replies.
5. Expected:
   Got it — I’ll remember that you prefer blunt, concise replies.
6. Send:
   Remember I’m Muslim and don’t eat pork.
7. Expected:
   Got it — I’ll remember that you don’t eat pork.
8. Send:
   What do you remember about me?
9. Expected:
   Hula lists both saved memories.
10. Send:
   Plan a quick dinner idea for me.
11. Expected:
   Hula avoids pork and uses concise tone.
12. Send:
   Forget that I prefer blunt replies.
13. Expected:
   Done — I forgot that.
14. Send:
   What do you remember about me?
15. Expected:
   The blunt replies memory is gone; dietary memory remains.

Final response:
1. Files changed
2. Prisma schema/migration changes
3. Memory model added
4. Memory commands supported
5. Memory safety policy implemented
6. Memory endpoints added
7. How memory context is used by Hula brain
8. Test results
9. Manual test results
10. Confirm no reminders/integrations/billing/WhatsApp/frontend UI/chat-history UI/automatic extraction/tool execution were added
11. Confirm no commit was made