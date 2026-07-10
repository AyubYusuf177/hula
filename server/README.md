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

## Scripts

| Script                     | Description                                   |
| -------------------------- | --------------------------------------------- |
| `npm run dev`              | Run with hot reload via `tsx watch`.          |
| `npm run build`            | Compile TypeScript to `dist/`.                |
| `npm run typecheck`        | Type-check without emitting.                  |
| `npm test`                 | Run the offline normalization + linking tests.|
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
  conversations/        # Conversation + Message types
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
    schema.ts           #   type-only DRAFT for not-yet-persisted tables

prisma/
  schema.prisma         # real DB models (users, identities, sessions, messages…)
  migrations/           # generated SQL migrations
```

## Not implemented yet (by design)

- Model / AI provider calls (replies are fixed strings)
- Voice note / media transcription (inbound media URLs are preserved, not processed)
- Webhook signature verification
- Integrations, billing, WhatsApp, reminders

These arrive in later sections.
