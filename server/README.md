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
embeddings/vector search (matching is simple keyword overlap), and no reminders,
integrations, WhatsApp, or tools/actions.

## Scripts

| Script                     | Description                                   |
| -------------------------- | --------------------------------------------- |
| `npm run dev`              | Run with hot reload via `tsx watch`.          |
| `npm run build`            | Compile TypeScript to `dist/`.                |
| `npm run typecheck`        | Type-check without emitting.                  |
| `npm test`                 | Offline normalize + linking + query + brain + profile + messaging-status + memory tests.|
| `npm run test:persistence` | DB-backed persistence check (skips w/o DB URL).|
| `npm run test:brain`       | Manual real-brain check (uses key if present).|
| `npm run test:memory`      | DB-backed memory check (skips w/o DB URL; cleans up).|
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
  routes/me.ts          # /v1/me/messages + /conversations (S5), /profile (S7), /memories (S8)
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
  reminders/            # proactive reminder placeholders
  integrations/         # Integration types + registry (empty)
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
  run integrations, send emails, book things, or set real reminders
- Automatic memory extraction / embeddings — Section 8 adds explicit,
  user-commanded long-term memory (keyword-matched), but Hula never mines normal
  chat for memories and there is no vector search or memory UI yet
- Voice note / media transcription (inbound media URLs are preserved, not processed)
- Webhook signature verification
- Integrations, billing, WhatsApp, reminders, chat-history/frontend UI

These arrive in later sections.
