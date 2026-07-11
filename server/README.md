# Hula Server

Channel-agnostic backend for the Hula AI messaging agent.

- **Section 1** — folder structure, core TypeScript types, env validation, health route.
- **Section 2** — a real Sendblue iMessage webhook round trip with a fixed canned
  reply. No AI, database, integrations, reminders, or billing yet.
- **Section 3** — connect a signed-in Hula app user to their real iMessage sender
  via a one-time code. Clerk token verification, `POST /v1/link-sessions`, and
  code-based linking in the webhook. In-memory only (no DB), no AI.
- **Section 4** — real Postgres persistence (Neon + Prisma). Link sessions and
  messaging identities now survive a backend restart, and inbound/outbound
  messages, conversations, and a safe summary of each provider event are stored.
  Still no AI, integrations, reminders, billing, WhatsApp, or chat-history UI.
- **Section 5** — a safe, authenticated inspection layer over the stored
  conversation data. Audits/confirms inbound + outbound persistence and adds
  read-only `GET /v1/me/messages` and `GET /v1/me/conversations` endpoints so the
  signed-in user can verify their own stored messages before the AI brain exists.
  No schema change. Still no AI, integrations, reminders, billing, WhatsApp, or
  chat-history UI.
- **Section 6** — the first Hula "brain". A **normal** message from an
  already-linked sender is now answered by Anthropic Claude with a short, useful
  reply that reads recent conversation history for short-term memory. The
  connect-code and unknown-sender flows stay **deterministic** and never call the
  model. If Anthropic is unavailable, a safe fallback reply is sent. No schema
  change. Still no integrations, reminders, billing, WhatsApp, actions/tools, or
  frontend/chat-history UI.

The server is fully separate from the Expo app and runs independently.

## Design principle

The backend is **channel-agnostic**. The Hula "brain" should not care whether a
message arrives via Sendblue, WhatsApp, Apple Messages for Business, or SMS
fallback. Provider adapters normalize inbound/outbound payloads into the neutral
types in `src/channels/types.ts`.

## Getting started

```bash
cd server
cp .env.example .env   # then fill in the Sendblue values for the round trip
npm install
npm run dev            # start with hot reload (tsx); auto-loads .env
```

Verify it's up:

```bash
curl http://localhost:4000/health
# { "ok": true, "service": "hula-server" }
```

## Sendblue environment variables

The webhook round trip needs these in `server/.env` (real values are private and
must never be committed — see `.env.example` for placeholder names):

| Variable                          | Purpose                                             |
| --------------------------------- | --------------------------------------------------- |
| `SENDBLUE_API_KEY`                | Sendblue API key id (`sb-api-key-id` header).       |
| `SENDBLUE_API_SECRET`             | Sendblue API secret (`sb-api-secret-key` header).   |
| `SENDBLUE_HULA_NUMBER`            | Hula's dedicated Sendblue line (the `from_number`). |
| `SENDBLUE_WEBHOOK_SIGNING_SECRET` | Reserved for inbound webhook signature checks.      |
| `CLERK_SECRET_KEY`                | Server-only Clerk key to verify app session tokens. |

`npm run dev` and `npm start` load `.env` automatically via Node's
`--env-file-if-exists`; no `dotenv` dependency is used.

## Test the Sendblue webhook round trip locally

1. Start the server: `npm run dev`
2. Expose it publicly with ngrok: `ngrok http 4000`
3. In the Sendblue dashboard, set the inbound webhook URL to:
   `https://YOUR-NGROK-SUBDOMAIN.ngrok-free.app/webhooks/sendblue`
4. From a phone, text Hula's Sendblue number.
5. Hula replies with the fixed Section 2 message:

   > Hey, I’m Hula. Your iMessage connection is working.

What the webhook does on each inbound message: acknowledges Sendblue with a fast
`200`, normalizes the payload into Hula's internal `InboundMessage`, then (detached
from the response) marks the thread read, sends a typing indicator, and delivers
the canned reply. Read/typing are best-effort and never block the reply. Outbound
status callbacks and duplicate provider message ids are ignored. Only safe summary
fields are logged — never message text, media URLs, phone numbers, or secrets.

## Section 3 — connect the app user to their iMessage sender

The signed-in app calls `POST /v1/link-sessions` with a Clerk session token in
the `Authorization: Bearer <token>` header. The server verifies the token
(server-only `CLERK_SECRET_KEY`), issues a short one-time code, and returns the
prefilled connect message:

```jsonc
// 201 Created
{
  "code": "HULA-8K2Q",
  "hulaNumber": "+16465480761",
  "messageBody": "Hey Hula, it's Ayub. Connect my account: HULA-8K2Q"
}
```

The app opens Messages to the Hula line with that body. When the user sends it,
the Sendblue webhook extracts the code and links the sender handle to the Clerk
user. Replies (fixed placeholders — no AI yet):

| Situation                                   | Reply                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| Valid one-time code                         | `You're connected — text me whenever you need me.`                        |
| Sender already linked (no code)             | `You're connected to Hula.`                                               |
| Unknown sender, no valid code               | `I can help once this number is connected to your Hula account. …`        |
| Valid code, but handle owned by another user| `This number is already connected to a Hula account.`                     |

Link codes expire after ~10 minutes and are single-use. Logs only ever include a
masked sender and the linking status — never the code, message text, full number,
tokens, or secrets.

## Section 4 — Postgres persistence (Neon + Prisma)

Section 4 replaces the in-memory link sessions and messaging identities with a
real Postgres database (Neon) via Prisma, and starts persisting conversations,
messages, and a safe summary of each provider event. Links now survive a backend
restart.

### Database environment variables

Add these to `server/.env` (real values are private and must never be committed —
see `.env.example` for placeholder shapes):

| Variable       | Purpose                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL` | Pooled Neon connection string used by the Prisma client at runtime.     |
| `DIRECT_URL`   | Direct (unpooled) Neon connection Prisma may use for migrations.        |

If `DATABASE_URL` is a Neon **pooled** URL, migrations can fail against the
pooler — in that case set `DIRECT_URL` to Neon's **direct** connection string
(the endpoint host without `-pooler`). Prisma reads both from `.env` directly.

### Persisted models

`prisma/schema.prisma` defines: `User`, `UserProfile`, `MessagingIdentity`,
`LinkSession`, `Conversation`, `Message`, and `ProviderEvent`. Provider events
store only a **redacted summary** (channel, content type, flags, link outcome) —
never the raw webhook payload.

### Local DB setup

```bash
cd server
# 1. Add DATABASE_URL and DIRECT_URL to server/.env (see .env.example)
npm run prisma:generate     # generate the Prisma client
npm run prisma:migrate      # create + apply the migration to your database
npm run dev                 # start the backend (loads .env)
ngrok http 4000             # expose it publicly
# 2. Set the Sendblue inbound webhook URL to:
#    https://YOUR-NGROK-SUBDOMAIN.ngrok-free.app/webhooks/sendblue
```

Then, from the Expo app, tap **Text hula**, send the prefilled connect message,
and confirm Hula replies `You're connected — text me whenever you need me.`

### Manual persistence test (proves it survives a restart)

1. Start the backend (`npm run dev`).
2. Start ngrok and point the Sendblue webhook at it.
3. Start Expo and open the Hula app.
4. Tap **Text hula**.
5. Send the prefilled connect message.
6. Confirm Hula replies: `You're connected — text me whenever you need me.`
7. **Stop the backend.**
8. **Restart the backend** (`npm run dev`).
9. From the same iMessage thread, send another message (no code).
10. Confirm Hula replies: `You're connected to Hula.`

Because the identity is now in Postgres, step 10 works even though the backend
restarted — proving persistence.

## Section 5 — authenticated conversation inspection

Section 5 proves that the data the future AI brain will rely on is stored
correctly and can be read back safely. **No schema change was needed** — the
Section 4 `Message`/`Conversation` models already carry every field required.

### What message persistence stores

For every inbound message (from the Sendblue webhook) and every outbound reply,
a `Message` row is written with, where available: `userId` (when the sender is
linked), `conversationId`, `direction` (`inbound`/`outbound`), `channel`,
`provider`, `providerMessageId`, `senderHandle`, `recipientHandle`, `text`,
`status`, and `createdAt`. A `Conversation` is found-or-created per
user/channel/provider/handle (the normalized handle is the thread key), so the
same thread is reused across restarts and back-filled with the `userId` once the
sender links. Each webhook also writes a `ProviderEvent` holding only a
**redacted summary** — never the raw payload.

### New endpoints (Clerk-guarded, read-only)

Both require `Authorization: Bearer <clerk session token>`, resolve the Hula
`User` from the token's Clerk id, and return **only that user's** rows. They
never return secrets, other users' data, or raw provider payloads.

**`GET /v1/me/messages`** — the user's recent messages, **newest first** by
default. Query params: `limit` (default `50`, max `100`, invalid/≤0 → `50`) and
`order` (`desc` default, or `asc` for oldest-first).

```jsonc
// 200 OK — GET /v1/me/messages?limit=50
{
  "messages": [
    {
      "id": "clx…",
      "direction": "outbound",
      "channel": "imessage",
      "provider": "sendblue",
      "text": "You're connected to Hula.",
      "status": "sent",
      "conversationId": "clx…",
      "createdAt": "2026-07-10T18:40:12.123Z"
    },
    {
      "id": "clx…",
      "direction": "inbound",
      "channel": "imessage",
      "provider": "sendblue",
      "text": "Test section 5",
      "status": "received",
      "conversationId": "clx…",
      "createdAt": "2026-07-10T18:40:11.001Z"
    }
  ],
  "limit": 50,
  "order": "desc",
  "defaultLimit": 50,
  "maxLimit": 100
}
```

**`GET /v1/me/conversations`** — the user's conversations with a message count
each, most recently active first. Same auth/safety; same `limit` clamping.

```jsonc
// 200 OK — GET /v1/me/conversations
{
  "conversations": [
    {
      "id": "clx…",
      "channel": "imessage",
      "provider": "sendblue",
      "messageCount": 2,
      "createdAt": "2026-07-10T18:39:00.000Z",
      "updatedAt": "2026-07-10T18:40:12.123Z"
    }
  ],
  "limit": 50
}
```

Auth failures return `401` (`missing_bearer_token` / `invalid_token`); a server
with no `CLERK_SECRET_KEY` returns `503 auth_not_configured`.

### End-to-end test

1. Start the backend (`npm run dev`), start ngrok, confirm `GET /health` via the
   ngrok URL returns `{ "ok": true }`.
2. Start Expo and open the Hula app.
3. From the already-linked iMessage thread, text Hula: `Test section 5`.
4. Confirm Hula replies: `You're connected to Hula.`
5. Call the endpoint with a Clerk session token (see below):

   ```bash
   curl -s -H "Authorization: Bearer $CLERK_TOKEN" \
     "$HULA_API_URL/v1/me/messages?limit=50" | jq
   ```

   Confirm both the inbound `Test section 5` and the outbound
   `You're connected to Hula.` appear for the authenticated user.
6. **Restart the backend**, text Hula again, confirm the reply still works and
   the new messages appear from the endpoint — proving persistence survives a
   restart and stays queryable.

### Getting a Clerk token for local testing (no secrets exposed)

The endpoint verifies a real Clerk **session** token — auth is never weakened for
testing. The easiest safe options:

- **From the app (recommended):** temporarily log `await getToken()` in a dev
  build, copy the value into `CLERK_TOKEN` in your shell, and curl. Session
  tokens are short-lived (~60s), so grab a fresh one right before the request.
  Never commit or paste it anywhere shared.
- **Clerk dashboard:** use Clerk's "Impersonate / testing token" tooling for the
  same user, if enabled.

Do not disable `requireClerkAuth` or print the token in logs.

### Offline persistence check (no Sendblue/Clerk/ngrok)

`npm run test:persistence` drives the persistence helpers directly against the
database: it creates two throwaway users, writes an inbound + outbound message
for one, verifies `GET /v1/me/messages`' query returns only that user's rows (and
never the other user's), then deletes everything it created. It **skips** with a
notice when `DATABASE_URL` is unset, requires no real Sendblue, and prints no
secrets.

## Section 6 — the Hula brain (Anthropic Claude)

Section 6 adds the smallest useful AI pipeline. When an **already-linked** sender
texts a **normal** (non-code) message, the webhook loads recent conversation
turns, asks Anthropic Claude for a short reply, saves it, and sends it back.

### Anthropic environment variables

Add these to `server/.env` (see `.env.example` for the shapes):

| Variable            | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY` | Server-only Anthropic key. **Optional** — absent → fallback reply. |
| `ANTHROPIC_MODEL`   | Model id. **Optional**, defaults to `claude-opus-4-8`.             |

The key is read only on the server and is never logged or returned. The current
model is **`claude-opus-4-8`**.

### Reply routing — which flows call Claude

| Situation                                             | Handled by            |
| ----------------------------------------------------- | --------------------- |
| Already-linked sender, normal (non-code) message      | **Claude** (the brain)|
| Unknown sender (no valid code)                        | Deterministic reply   |
| Valid connect code (fresh link)                       | Deterministic reply   |
| Owner re-sends their own code / any code attempt      | Deterministic reply   |
| Invalid / expired / used code                         | Deterministic reply   |

Only a normal message from a linked user reaches the model. Any message that
carries a connect-code pattern (valid or not), and any message from an unknown
sender, keeps its exact Section 3 deterministic reply and never calls Claude.

### The brain

- Input: the last ~16 stored turns for that conversation (short-term memory),
  mapped to `user`/`assistant` roles, plus lightweight channel context. No
  onboarding profile sync or long-term memory summaries yet.
- Output: plain text only — concise, direct, honest about what Hula can't yet do
  (no integrations/actions/reminders). Usually 1–6 short sentences.
- The system prompt never mentions any backend/vendor internals.

### Fallback behaviour

If the key is missing, the model is unreachable, the request errors or rate
limits, or the reply is empty, the brain logs a **safe** (masked, no-secret)
error and Hula sends:

> I’m connected and listening. My brain is being upgraded right now.

The webhook still returns its fast `2xx` and never crashes.

### Message persistence

The inbound message is saved first (as before). For a brain-answered turn the
generated reply is saved once as the **outbound** `Message` (the same single
`recordOutbound` used by the deterministic flows — no duplicate messages or
conversations). Both directions remain visible via `GET /v1/me/messages`.

### End-to-end test (text Hula from a linked thread)

1. Start the backend (`npm run dev`), start ngrok, confirm `GET /health` via the
   ngrok URL returns `{ "ok": true }`.
2. From the already-linked iMessage thread, text: `What can you help me with today?`
   → Hula replies with a real, helpful Claude answer (not just "You're connected").
3. Text: `Help me plan my next 3 hours.` → Hula returns a short, useful plan.
4. **Restart the backend** and text again → Hula still recognises the sender and
   replies with a Claude-generated answer (persistence + linking survive restart).
5. Confirm both inbound and outbound turns appear via `GET /v1/me/messages`.

If `ANTHROPIC_API_KEY` is unset, steps 2–4 return the fallback reply instead — the
connect-code and unknown-sender flows are unchanged either way.

### Offline brain check (no network, no DB)

`npm test` includes `scripts/brain.test.ts`, which covers routing (which flows
call the brain), history preparation, prompt safety (no internals leak), and the
fallback path — all with an injected fake generator, so no real Anthropic call is
made. `npm run test:brain` is a **manual** script that calls the real brain with a
small fake history (uses `ANTHROPIC_API_KEY` if present, else the fallback path)
and prints only the reply text.

## Section 7 — silent profile / onboarding context sync

The app already collects a little onboarding/profile data (name, tone, what the
user wants help with, etc.) and keeps it locally. Section 7 quietly mirrors a
**small set of safe fields** to the backend so the Hula brain can be a bit more
personal in iMessage — with **zero** new user-facing UI, popups, buttons,
permissions, or loading states.

### What gets synced

The app builds a payload from local onboarding answers + the display-name
override + the device, and the backend accepts **only** these fields (everything
else is dropped):

`displayName`, `firstName`, `birthday`, `sex`, `tone`
(`concise|witty|strategic`), `helpMost[]`, `discoverySource`, `timezone`,
`locale`, `country`.

Every field is trimmed, length-capped, and validated server-side
(`sanitizeProfileInput`); `helpMost` is capped to 12 short items. Unknown keys,
tokens, secrets, message content, and ids are never accepted or stored. Nothing
sensitive leaves the device.

### How the sync happens (silent + best-effort)

- On Home load, `hooks/useSyncHulaProfile` reads local data, builds the payload
  (`lib/hulaProfileSync.ts` → `buildProfileSyncPayload`), gets a Clerk token
  silently, and `PUT`s it.
- An in-memory per-user guard remembers the last synced payload, so re-renders
  and Home re-focuses don't spam the backend — a request only fires when the
  data actually changes.
- Any failure is a no-op (dev-only warning). It never blocks Home or "Text hula".

### New endpoints (Clerk-guarded)

Both require a valid Clerk bearer token and only ever touch the caller's own
profile (resolved from the token `sub`), exactly like `/v1/me/messages`.

```bash
# Read your own profile (empty until the first sync)
curl -s https://YOUR-NGROK.ngrok-free.app/v1/me/profile \
  -H "Authorization: Bearer $CLERK_TOKEN"
# { "profile": { "updatedAt": null } }

# Sync safe fields (idempotent upsert; partial updates never blank other fields)
curl -s -X PUT https://YOUR-NGROK.ngrok-free.app/v1/me/profile \
  -H "Authorization: Bearer $CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Ayub","tone":"strategic","helpMost":["travel","emails"],"timezone":"Europe/London"}'
# { "profile": { "firstName": "Ayub", "tone": "strategic", ... } }
```

Storage reuses the existing `UserProfile` table. The only schema change is one
additive nullable column, `preferencesJson` (JSONB), holding `helpMost` +
`discoverySource` — no data reset, no destructive migration.

### How the brain uses it

For a normal message from an already-linked user, the webhook loads the user's
`UserProfile` (`loadBrainContextForUser`) alongside recent history and passes a
**safe** context into the system prompt. The prompt uses it *lightly*: addresses
the user by first name when natural, maps `tone` to a style
(concise → direct/minimal, witty → sharper personality, strategic →
structured/planning), biases suggestions toward `helpMost`, and adds
timezone/locale/country + an approximate age. It is explicitly told **not** to
announce what it knows or mention onboarding/profiles, and no vendor/internal
detail is ever exposed (asserted by `scripts/profile.test.ts`). A missing
profile simply means less personalisation — it never breaks a reply.

### Verify it

```bash
# Offline unit tests (sanitisation, context derivation, tone mapping, prompt safety)
npm test        # includes scripts/profile.test.ts

# In the app: open Home while signed in — no new UI appears. Confirm the sync with:
curl -s https://YOUR-NGROK.ngrok-free.app/v1/me/profile -H "Authorization: Bearer $CLERK_TOKEN"

# Then text Hula from a linked thread, e.g.:
#   "What do you know about how I want you to help me?"
#   "Plan my next 3 hours in my preferred style."
# Hula answers using your tone/helpMost — without mentioning internals or onboarding.
```

## Section 7.1 — connected-aware "Text hula"

Previously, tapping **Text hula** always created a new one-time link session and
opened Messages with a prefilled `HULA-XXXX` connect code — even for users who
were already connected. Section 7.1 makes the button connection-aware:

- Before deciding, the app calls a new endpoint to check whether the signed-in
  user is already connected to a messaging sender.
- **If connected:** it opens the Hula thread with **no prefilled text** and does
  **not** generate a new code (no link session is created).
- **If not connected:** it keeps the existing flow — a fresh one-time link code
  and a prefilled connect message.
- One-time codes stay **temporary and random** (unchanged) — they are never made
  constant per account. The old bug was only that new codes kept being generated
  after the user was already linked.
- If the status check fails for any reason, the app safely falls back to the
  connect-code flow and logs a dev-only warning. No new UI or user action added.

### New endpoint (Clerk-guarded, read-only)

**`GET /v1/me/messaging-status`** — the signed-in user's masked connection
status. Resolved from the token `sub`, scoped to that user only. Never exposes
the full handle, other users' identities, or secrets.

```jsonc
// 200 OK — connected
{
  "imessage": {
    "connected": true,
    "provider": "sendblue",
    "linkedAt": "2026-07-11T12:00:00.000Z",
    "handleDisplay": "+*******0761"   // masked: only the last 4 digits
  },
  "hulaNumber": "+16465480761"        // public Hula line, used to open the thread
}

// 200 OK — not connected
{
  "imessage": {
    "connected": false,
    "provider": "sendblue",
    "linkedAt": null,
    "handleDisplay": null
  },
  "hulaNumber": "+16465480761"
}
```

### Verify it

```bash
# Offline unit test for the handle masking:
npm test        # includes scripts/messagingStatus.test.ts

# While signed in, check your own status (masked handle only):
curl -s https://YOUR-NGROK.ngrok-free.app/v1/me/messaging-status \
  -H "Authorization: Bearer $CLERK_TOKEN" | jq

# In the app, with the current sender already connected, tap "Text hula":
#   - Messages opens to Hula with NO prefilled connect-code text.
#   - No new HULA-XXXX code is generated.
# From a fresh/unconnected account, tapping "Text hula" still prefills a new code.
```

## Section 8 — explicit long-term memory

Section 8 gives Hula a small, conservative, **user-controlled** long-term memory,
similar in spirit to ChatGPT/Claude memory but deliberately minimal. It works
entirely through **natural iMessage commands** — there is no memory UI, and Hula
never extracts memories automatically from normal chat.

- **Remember** — when the user explicitly asks, Hula saves a short, stable fact
  or preference and confirms it.
- **List** — the user can ask what Hula remembers and get a numbered list.
- **Forget** — the user can remove one memory or clear everything. Deletes are
  **soft** (the row is deactivated, never destroyed).
- Normal replies use active memories **lightly** — Hula personalises without
  reciting or announcing them (unless the user asks what it remembers).

Only a **linked** sender's normal (non-connect-code) messages are checked for
memory commands. Connect-code and unknown-sender flows are unchanged. Memory
commands are handled **deterministically** in the backend and do **not** call the
Anthropic brain.

### Supported commands

| Intent   | Example phrasings                                                         |
| -------- | ------------------------------------------------------------------------ |
| Remember | `remember …`, `please remember …`, `don't forget …`, `save this …`, `keep in mind …` |
| List     | `what do you remember about me?`, `what have you remembered?`, `show my memories`, `list my memories` |
| Forget   | `forget …`, `delete that memory …`, `remove that memory …`               |
| Forget all | `forget everything you remember about me`, `clear my memory`            |

### Memory policy

**Allowed** (when explicitly requested): communication/assistant-behaviour
preferences, projects/goals, routines, non-sensitive likes/dislikes, and
practical constraints — including sensitive-adjacent ones such as
dietary/religious/health/accessibility needs (e.g. _"Remember I'm Muslim and
don't eat pork"_, _"Remember I'm lactose intolerant"_, _"Remember I avoid
alcohol"_).

**Blocked** (even if asked): passwords/API keys/secrets, bank/card details,
government IDs, precise home address, evasion/illegal-concealment instructions,
and long bare number sequences (card/account/ID-like). Blocked requests get:

> I can keep that in mind for this chat, but I won’t save it as long-term memory.

Hula does **not** infer sensitive facts automatically — mentioning prayer,
medication, or politics once never creates a memory. Memory is only created from
an explicit "remember" command.

### Example iMessage flows

```txt
You:  Remember I prefer blunt, concise replies.
Hula: Got it — I’ll remember that you prefer blunt, concise replies.

You:  Remember I’m Muslim and don’t eat pork.
Hula: Got it — I’ll remember that you're Muslim and don't eat pork.

You:  What do you remember about me?
Hula: I remember:
      1. You prefer blunt, concise replies.
      2. You're Muslim and don't eat pork.

You:  Forget that I prefer blunt replies.
Hula: Done — I forgot that.

You:  Forget everything you remember about me.
Hula: Done — I cleared your saved memories.
```

### Inspect your memories (Clerk-guarded, read-only)

**`GET /v1/me/memories`** — the signed-in user's active memories only, scoped to
that user. **`DELETE /v1/me/memories/:id`** soft-deletes one of your own.

```jsonc
// GET /v1/me/memories → 200 OK
{
  "memories": [
    {
      "id": "…",
      "type": "preference",
      "text": "You prefer blunt, concise replies.",
      "importance": "medium",
      "createdAt": "2026-07-11T13:00:00.000Z",
      "updatedAt": "2026-07-11T13:00:00.000Z"
    }
  ]
}
```

### Verify it

```bash
# Offline unit tests (classification, sanitisation, policy, phrasing, prompt).
npm test               # includes scripts/memory.test.ts

# DB-backed end-to-end helper check (skips without DATABASE_URL; cleans up).
npm run test:memory

# While signed in, read back your own saved memories:
curl -s https://YOUR-NGROK.ngrok-free.app/v1/me/memories \
  -H "Authorization: Bearer $CLERK_TOKEN" | jq
```

**Limitations (by design):** no automatic memory extraction, no memory UI, no
embeddings/vector search (matching is simple keyword overlap), and no
integrations, WhatsApp, or tools/actions.

## Section 9 — explicit reminders + a lightweight follow-up engine

Section 9 is Hula's **first proactive** feature. When the user **explicitly**
asks, Hula schedules a reminder, confirms it, and later delivers it as a
proactive iMessage — all through **natural iMessage commands**. There is no
reminders UI, and Hula never infers reminders from ordinary chat.

It is deliberately conservative (every proactive message has a trust and cost
cost): explicit reminders only, deterministic delivery text (no Anthropic call
to send a reminder), strong caps, and daily/weekly recurrence at most. The
`future_calendar`/`future_integration` reminder **sources** reserve space for
integration-driven reminders (Calendar/Zoom/Gmail/…) later **without** building
any of that now.

Only a **linked** sender's normal messages are checked for reminder commands.
Connect-code and unknown-sender flows are unchanged. Reminder commands are
handled **deterministically** and run **after** memory commands and **before**
the brain — so memory always takes precedence and neither calls Claude.

### Supported commands

| Intent      | Example phrasings                                                              |
| ----------- | ----------------------------------------------------------------------------- |
| Create      | `remind me to go gym tomorrow at 7pm`, `remind me in 30 minutes to call Rob`, `remind me tonight to submit the form`, `remind me every Monday at 9am to plan my week`, `can you remind me …`, `follow up with me tomorrow about …` |
| List        | `what reminders do I have?`, `show my reminders`, `list my reminders`          |
| Cancel one  | `cancel my gym reminder`, `delete the form reminder`, `stop reminding me about the form` |
| Cancel all  | `cancel all reminders`, `stop reminding me`                                    |

### Date/time parsing (deterministic, no NLP library)

Parsing is small and predictable — anything it can't confidently read makes Hula
ask **one** clarifying question rather than guess. Supported:

| Phrase                 | Meaning                                            |
| ---------------------- | -------------------------------------------------- |
| `in 10 minutes` / `in 2 hours` | relative offset from now                   |
| `tonight`              | today at **8:00 PM** local                         |
| `today at 6pm`         | today at that local time                           |
| `tomorrow at 7pm`      | next day at that local time                        |
| `Monday at 9am`        | next occurrence of that weekday (one-off)          |
| `every day at 8am`     | **daily** recurrence                               |
| `every Monday at 9am`  | **weekly** recurrence                              |

Times use the user's **timezone** from their profile (Section 7) when known,
computed with the built-in `Intl` API (no new dependency). **Fallback:** if the
user has no stored timezone, times are interpreted in **UTC**.

Hula asks for clarification when:

- there's **no time** (`remind me to call Rob` → _"What time should I remind
  you?"_) — including bare `tomorrow`/a weekday with no time,
- there's a time but **no task** (`remind me tomorrow at 7pm` → _"What should I
  remind you about?"_),
- the recurrence is **too frequent** (`every minute`/`every hour` → _"I can only
  do daily or weekly reminders for now …"_) — minimum recurrence is **daily**,
- the time is **already in the past** (`today at 6pm` when it's 8pm).

### Delivery worker

A conservative in-process poller (`reminders/worker.ts`) starts on boot and every
**30s** looks for due reminders (`status = scheduled`, `nextRunAt <= now`):

- delivers each as a proactive iMessage to the user's active messaging identity,
- uses **deterministic** text — `Reminder: {title}` (`+ body` when present) — so
  **no Anthropic call** happens on delivery,
- marks **one-off** reminders `sent`; **advances** `nextRunAt` for recurring ones,
- is safe across restarts and **won't double-send** (status-guarded atomic claim
  + overlapping-tick guard),
- marks a reminder `failed` (with a reason) if there's no active identity or the
  send throws — conservative, no infinite retries.

### Cost / spam controls

- **≤ 10** reminders delivered per worker tick.
- **≤ 50** active reminders per user (further creates get a "hit the limit" reply).
- Minimum recurrence is **daily**; more frequent is rejected.
- Recurring reminders auto-complete after **365** sends (cost bound).
- Titles capped at 200 chars; delivery text is fixed and Claude-free.

### Example iMessage flow

```txt
You:  Remind me in 2 minutes to test Hula reminders.
Hula: Got it — I’ll remind you in 2 minutes: test Hula reminders.
      … (2 minutes later, proactively) …
Hula: Reminder: test Hula reminders

You:  Remind me tomorrow at 7pm to go gym.
Hula: Got it — I’ll remind you tomorrow at 7:00 PM: go gym.

You:  What reminders do I have?
Hula: Your active reminders:
      1. go gym — Jul 12 at 7:00 PM

You:  Cancel my gym reminder.
Hula: Done — I cancelled that reminder.
```

### Inspect your reminders (Clerk-guarded)

**`GET /v1/me/reminders`** — the signed-in user's active reminders only.
**`DELETE /v1/me/reminders/:id`** cancels one of your own. No frontend UI yet.

```jsonc
// GET /v1/me/reminders → 200 OK
{
  "reminders": [
    {
      "id": "…",
      "title": "go gym",
      "body": null,
      "status": "scheduled",
      "dueAt": "2026-07-12T23:00:00.000Z",
      "nextRunAt": "2026-07-12T23:00:00.000Z",
      "recurrenceRule": null,
      "timezone": "America/New_York",
      "createdAt": "2026-07-11T13:00:00.000Z"
    }
  ]
}
```

### Verify it

```bash
# Offline unit tests (classification, parsing, recurrence, phrasing, matching).
npm test                 # includes scripts/reminders.test.ts

# DB-backed worker check (skips without DATABASE_URL; stubs the sender so NO
# real iMessage is sent; cleans up its throwaway data).
npm run test:reminders

# While signed in, read back your own active reminders:
curl -s https://YOUR-NGROK.ngrok-free.app/v1/me/reminders \
  -H "Authorization: Bearer $CLERK_TOKEN" | jq
```

**End-to-end (real iMessage):** start the backend + ngrok, then from a linked
thread text `Remind me in 2 minutes to test Hula reminders.` You'll get the
confirmation immediately and the proactive `Reminder: …` about two minutes later.

**Future plan:** the same worker + `Reminder` model will later back
integration-sourced reminders (Google Calendar meetings, Zoom calls, Gmail
follow-ups, Notion/Asana tasks, travel/delivery updates) via the `future_*`
sources — none of which are built yet.

**Limitations (by design):** no Google Calendar, Zoom, Gmail, Notion, or
WhatsApp; no automatic follow-up inference; no reminders/chat-history/frontend
UI; and no Anthropic call for due-reminder delivery.

## Section 10 — integrations foundation

**Purpose.** Before wiring any real provider OAuth, Hula needs a clean, provider-
agnostic foundation so future integrations (Google Calendar, Gmail, Zoom, Notion,
Asana, Slack, aggregators like Nylas) plug in without one-off code. Section 10
adds that foundation: a provider registry, database models, a server-only
encrypted token vault, read-only status endpoints, a disconnect, an action-risk
policy, and full offline test coverage. **No real provider is connected**, no
provider data is synced, and no action is executed.

### Provider registry

`src/integrations/catalog.ts` is the single source of truth for known providers
and their metadata — display name, category, auth type, least-privilege default
scopes, capabilities, and a note. It is metadata only: no OAuth URLs, no network,
no tokens. Providers: `google_calendar`, `gmail`, `zoom`, `notion`, `asana`,
`slack`, `nylas`, and an internal `generic` stub (hidden from user-facing status).

### Connection model

- **`IntegrationConnection`** — one row per (user, provider): status
  (`disconnected | connected | expired | revoked | error`), granted/requested
  scopes, capabilities, and timestamps. The source of truth for whether Hula may
  later read from a provider.
- **`IntegrationCredential`** — server-only encrypted token store (1:1 with a
  connection). The mobile app can never read it.
- **`IntegrationSyncState`** — reserved per-resource sync cursors (unused yet).
- **`IntegrationEvent` / `IntegrationActionLog`** — redacted, audit-style rows
  that survive a disconnect. Only sanitised summaries are stored — never raw
  provider payloads or tokens.

### Token vault

`src/integrations/tokenVault.ts` encrypts tokens with **AES-256-GCM** using
`INTEGRATION_TOKEN_ENCRYPTION_KEY` (a 32-byte key, base64 or hex). The key is
read lazily, so the server still boots without it — it is only required the
moment a token is actually encrypted/decrypted. Ciphertext is versioned
(`v1:<iv>:<authTag>:<ciphertext>`), each encryption uses a fresh random IV, and
authentication means a wrong key or tampered data fails to decrypt. Token values
are never logged, thrown, or returned to the app.

### Status + disconnect endpoints

All require a Clerk bearer token and are scoped to the signed-in user. No tokens,
scopes-as-secrets, or raw payloads are ever exposed.

```bash
# Provider catalog (static metadata)
GET  /v1/me/integrations/catalog

# The signed-in user's statuses (merged catalog + their connections)
GET  /v1/me/integrations

# One provider's status (unknown provider → 404)
GET  /v1/me/integrations/:provider

# Not implemented yet — returns 501 { "status": "not_implemented" }
POST /v1/me/integrations/:provider/connect

# Mark a provider disconnected (idempotent); clears credentials, keeps audit logs
POST /v1/me/integrations/:provider/disconnect
```

### Future OAuth flow (planned, not built)

Real connects will use **Authorization Code + PKCE** via the system/external
browser (native mobile OAuth), request **least-privilege scopes**, and track the
**exact granted scopes**. Tokens will be stored **only server-side**, encrypted
via the vault; access tokens stay short-lived and refresh tokens are protected.
The design supports both direct provider APIs and aggregators (e.g. Nylas), and
**incremental permissions** — users enable only what they want Hula to access.

### Future Google Calendar plan

Google Calendar is the first planned provider: read-only events first
(`calendar.events.readonly`), then free/busy, then event creation gated behind
the action policy. It will reuse the same connection/credential/sync models and
the `future_calendar` reminder source added in Section 9.

### Future action policy

`src/integrations/policy.ts` defines action risk levels — `read`, `draft`,
`write`, `send`, `purchase`, `destructive` — and a pure gate: reads/drafts need
the provider connected **and** the scope granted; writes/sends additionally need
**explicit user confirmation**; purchases and destructive actions are **not
allowed yet**. Nothing executes actions — this is the single gate real actions
will pass through later.

### Security model

- Provider tokens live **only** server-side, encrypted at rest; the app never
  sees them.
- Every endpoint requires Clerk auth and returns only the caller's own records.
- Unknown providers are rejected (`404`).
- Only redacted summaries are persisted for events/actions — never raw payloads.
- Hula stays **honest**: connected app names may be surfaced to the brain, but
  the prompt still forbids claiming it accessed data or performed an action.

### Verify it

```bash
# Offline unit tests (registry, AES-256-GCM vault roundtrip + refusal + tamper,
# scope hashing, action policy, honest brain context).
npm test                     # includes scripts/integrations.test.ts

# DB-backed end-to-end helper check (skips without DATABASE_URL; uses a FAKE
# token; proves no helper returns token values; cleans up).
npm run test:integrations

# While signed in, read your own catalog + statuses:
curl -s https://YOUR-NGROK.ngrok-free.app/v1/me/integrations/catalog \
  -H "Authorization: Bearer $CLERK_TOKEN" | jq
curl -s https://YOUR-NGROK.ngrok-free.app/v1/me/integrations \
  -H "Authorization: Bearer $CLERK_TOKEN" | jq
```

> Apply the additive migration first: `npm run prisma:migrate`
> (creates the `integration_*` tables; touches no existing data).

**Limitations (by design):** no real OAuth yet, no provider data sync, no
tool/action execution, and no frontend integrations UI. `connect` is a `501`
stub.

## Section 11 — Google Calendar (read-only)

Section 11 is Hula's **first real integration**. A user connects their Google
Calendar over OAuth (Authorization Code + PKCE, least-privilege **read-only**
scopes), tokens are stored **encrypted server-side** in the Section 10 token
vault, and Hula answers calendar questions over iMessage from live data. There
is **no** event creation/edit/delete, **no** Google push webhooks, and **no**
automatic calendar reminders — this section proves the full read path only.

### Google Cloud setup

1. Create/select a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. **Enable the Google Calendar API** (APIs & Services → Library).
3. Configure the **OAuth consent screen** (External is fine for dev; add your
   Google account as a **Test user**).
4. Create an **OAuth 2.0 Client ID** of type **Web application**.
5. Under **Authorized redirect URIs**, add your ngrok callback (must match
   exactly):

   ```txt
   https://YOUR-NGROK-URL/v1/integrations/google_calendar/callback
   ```

6. Set the server env (see `.env.example`):

   ```bash
   GOOGLE_OAUTH_CLIENT_ID=...
   GOOGLE_OAUTH_CLIENT_SECRET=...
   GOOGLE_OAUTH_REDIRECT_URI=https://YOUR-NGROK-URL/v1/integrations/google_calendar/callback
   GOOGLE_CALENDAR_SCOPES=https://www.googleapis.com/auth/calendar.readonly
   INTEGRATION_TOKEN_ENCRYPTION_KEY=<32-byte base64, e.g. openssl rand -base64 32>
   ```

   All Google values are **optional at boot** — the server starts without them.
   If a user tries to connect while they're missing, `connect` returns a safe
   `400 { "error": "google_calendar_not_configured" }` (never a crash).

> Apply the additive migration first: it creates `integration_oauth_states`
> (`prisma migrate deploy`, or `npm run prisma:migrate`). It touches no existing
> data and stores **no** tokens.

### Endpoints

| Method + path | Auth | Purpose |
| ------------- | ---- | ------- |
| `POST /v1/me/integrations/google_calendar/connect` | Clerk bearer | Start OAuth; returns `{ provider, authorizationUrl, expiresAt }`. No tokens. |
| `GET /v1/integrations/google_calendar/callback` | public (Google redirect) | Validates `state`, exchanges the code, stores an **encrypted** connection, shows a simple success page. |
| `GET /v1/me/integrations/google_calendar/events?range=today\|tomorrow\|week\|next&limit=10` | Clerk bearer | Read the signed-in user's **own** normalized events. `409 { "error": "google_calendar_not_connected" }` when not connected. |

### Local connect flow

```bash
# 1. Start backend + ngrok, confirm the redirect URI matches the OAuth client.
# 2. While signed in, get an authorization URL:
curl -s -X POST https://YOUR-NGROK-URL/v1/me/integrations/google_calendar/connect \
  -H "Authorization: Bearer $CLERK_TOKEN" | jq
# 3. Open authorizationUrl in a browser, approve the READ-ONLY consent.
# 4. The callback shows "Google Calendar connected".
# 5. Read events:
curl -s "https://YOUR-NGROK-URL/v1/me/integrations/google_calendar/events?range=today" \
  -H "Authorization: Bearer $CLERK_TOKEN" | jq
```

### Ask Hula over iMessage

From your linked iMessage thread (once connected):

```txt
You:  What's on my calendar today?
Hula: Here's today:
      • 9:00 AM — Standup
      • 3:00 PM — 1:1 with Sam

You:  When's my next meeting?
Hula: Your next event is "1:1 with Sam" on Wed, Jul 15 at 3:00 PM.

You:  Can you create a calendar event?
Hula: (honest — it can draft/plan but cannot create/edit/delete events yet)
```

If Google Calendar isn't connected, Hula replies honestly:
*"I don't have your Google Calendar connected yet. Once you connect it in Hula,
I'll be able to answer that."*

### Security model

- **Least-privilege, read-only** scope (`calendar.readonly`); no write scope path
  exists.
- Access/refresh tokens are encrypted (AES-256-GCM) via the Section 10 token
  vault and stored server-side only — they are **never** returned to the app or
  logged.
- OAuth uses an unguessable **`state`** (CSRF) plus **PKCE**; state rows are
  single-use and expire in 10 minutes.
- Expired access tokens are refreshed **server-side**; a failed refresh marks the
  connection `expired`.
- Only **normalized** events (no raw Google payloads, no event descriptions)
  leave the provider layer.

### Verify it

```bash
# Offline unit tests: OAuth config/PKCE/URL, faked token exchange + refresh,
# range computation, strict normalization (raw payload stripped), calendar intent
# detection, answer formatting.
npm test                       # includes scripts/googleCalendar.test.ts

# Offline + (when DATABASE_URL is set) a DB-backed token-vault + refresh check
# using a FAKE Google token endpoint — no real Google call, cleans up.
npm run test:google-calendar
```

**Limitations (by design):** read-only calendar access; no event
create/edit/delete; no Google push webhooks; no automatic calendar reminders; no
frontend integrations UI.

## Scripts

| Script                     | Description                                   |
| -------------------------- | --------------------------------------------- |
| `npm run dev`              | Run with hot reload via `tsx watch`.          |
| `npm run build`            | Compile TypeScript to `dist/`.                |
| `npm run typecheck`        | Type-check without emitting.                  |
| `npm test`                 | Offline normalize + linking + query + brain + profile + messaging-status + memory + reminders + integrations + google-calendar tests.|
| `npm run test:persistence` | DB-backed persistence check (skips w/o DB URL).|
| `npm run test:brain`       | Manual real-brain check (uses key if present).|
| `npm run test:memory`      | DB-backed memory check (skips w/o DB URL; cleans up).|
| `npm run test:reminders`   | DB-backed reminder worker check (skips w/o DB URL; stubs sender; cleans up).|
| `npm run test:integrations`| DB-backed integration foundation check (skips w/o DB URL; fake token; cleans up).|
| `npm run test:google-calendar`| Offline Google Calendar check + (with DB URL) token-vault/refresh check using a FAKE Google endpoint; cleans up.|
| `npm run prisma:generate`  | Generate the Prisma client from the schema.   |
| `npm run prisma:migrate`   | Create + apply a dev migration to the DB.     |
| `npm start`                | Run the compiled server.                      |

> Run `npm run prisma:generate` before `typecheck`/`build` so the generated
> `@prisma/client` types are available.

## Structure

```txt
src/
  index.ts              # entrypoint (starts the listener)
  app.ts                # builds the Express app
  config/env.ts         # Zod-validated env (placeholders for Section 1)
  routes/health.ts      # GET /health
  utils/logger.ts       # minimal leveled logger

  routes/webhooks.ts    # POST /webhooks/sendblue (inbound + code linking)
  routes/linkSessions.ts# POST /v1/link-sessions (Section 3, Clerk-guarded)
  routes/me.ts          # /v1/me/messages + /conversations (S5), /profile (S7), /memories (S8), /reminders (S9)
  auth/clerk.ts         # Clerk token verification + requireClerkAuth middleware

  channels/             # channel-agnostic messaging core
    types.ts            # Channel, Provider, In/OutboundMessage, events, statuses
    registry.ts         # ChannelAdapter contract + registry (empty)
    sendblue/           # Sendblue provider
      types.ts          #   webhook + outbound payload shapes
      normalize.ts      #   payload -> InboundMessage / ProviderEvent
      client.ts         #   sendMessage / sendTypingIndicator / markRead

  users/                # user + DB-backed linking (Section 4)
    store.ts            #   getOrCreateUserByClerkId (Clerk id -> Hula user)
    linkSessions.ts     #   one-time connect codes (DB-backed create/get/consume)
    messagingIdentity.ts#   sender handle -> Hula user (DB-backed)
    linking.ts          #   pure decideLinkOutcome + DB-backed resolveInboundLink
    profile.ts          #   safe profile sanitise/upsert/query + brain context (Section 7)
    memory.ts           #   explicit long-term memory: commands, policy, helpers (Section 8)
  conversations/        # Conversation + Message types
  ai/                   # the Hula brain (Section 6)
    anthropicClient.ts  #   minimal Anthropic Messages API client (fetch, no SDK)
    hulaBrain.ts        #   generateHulaReply + history/message shaping + fallback
    prompts.ts          #   dedicated Hula system prompt (no internals leak)
  media/                # media / voice note placeholders
  agent/                # AgentContext, ToolDefinition, prompt layers
  reminders/            # explicit reminders (Section 9)
    types.ts            #   shared reminder types (source/status/recurrence/view)
    parse.ts            #   pure date/time + timezone parsing (Intl, no deps)
    reminders.ts        #   command classify, title/phrasing, DB helpers, orchestrator
    worker.ts           #   conservative delivery worker (deterministic text)
  integrations/         # integrations foundation (Section 10) + Google Calendar (Section 11)
    catalog.ts          #   provider registry (metadata only, no OAuth/tokens)
    tokenVault.ts       #   AES-256-GCM server-only token encrypt/decrypt
    connections.ts      #   DB-backed connection status/upsert/disconnect + audit
    credentials.ts      #   server-only encrypted token store/read/refresh (Section 11)
    oauthState.ts       #   single-use OAuth state (CSRF) + PKCE verifier store (Section 11)
    policy.ts           #   action-risk policy gate (no execution yet)
    providers/googleCalendar/ # read-only Google Calendar (Section 11)
      oauth.ts          #     config, PKCE, auth URL, token exchange/refresh
      client.ts         #     connection lookup + valid-access-token (refresh) + GET
      events.ts         #     range computation + strict event normalization + fetch
      calendarQuestion.ts #   intent detection + deterministic answers + orchestrator
      types.ts          #     normalized event + raw Google shapes
    types.ts / registry.ts # legacy Section 1 agent-tool placeholders
  actions/              # ActionApproval placeholders
  billing/              # Subscription placeholders
  legal/                # LegalConsent placeholders
  db/
    prisma.ts           #   lazy Prisma client singleton
    persist.ts          #   record inbound/outbound messages + provider events
    queries.ts          #   read-side helpers for the Section 5 inspection routes
    schema.ts           #   type-only DRAFT for not-yet-persisted tables

prisma/
  schema.prisma         # real DB models (users, identities, sessions, messages…)
  migrations/           # generated SQL migrations
```

## Not implemented yet (by design)

- Tool/action execution — the brain can think, plan, and draft, but cannot yet
  run integrations, send emails, or book things
- Automatic memory extraction / embeddings — Section 8 adds explicit,
  user-commanded long-term memory (keyword-matched), but Hula never mines normal
  chat for memories and there is no vector search or memory UI yet
- Automatic follow-up inference / integration-sourced reminders — Section 9 adds
  **explicit** reminders + a delivery worker; Hula never guesses reminders, and
  Calendar/Zoom/Gmail/Notion sources are reserved (`future_*`) but not built
- Voice note / media transcription (inbound media URLs are preserved, not processed)
- Webhook signature verification
- Provider **write/action** execution — Section 11 adds read-only Google Calendar
  (connect + read events + answer over iMessage), but Hula cannot create/edit/
  delete events, and other providers' `connect` is still a `501` stub
- Google Calendar **push webhooks** and **automatic calendar reminders** — not
  built; reads are on-demand only
- Billing, WhatsApp, chat-history/frontend/reminders/integrations UI

These arrive in later sections.
