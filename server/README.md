# Hula Server

Channel-agnostic backend for the Hula AI messaging agent. This is the **Section 1
skeleton only** — folder structure, core TypeScript types, env validation, and a
health route. No provider logic (Sendblue, model, database, integrations,
billing) is implemented yet.

The server is fully separate from the Expo app and runs independently.

## Design principle

The backend is **channel-agnostic**. The Hula "brain" should not care whether a
message arrives via Sendblue, WhatsApp, Apple Messages for Business, or SMS
fallback. Provider adapters normalize inbound/outbound payloads into the neutral
types in `src/channels/types.ts`.

## Getting started

```bash
cd server
cp .env.example .env   # placeholders are fine for Section 1
npm install
npm run dev            # start with hot reload (tsx)
```

Verify it's up:

```bash
curl http://localhost:4000/health
# { "ok": true, "service": "hula-server" }
```

## Scripts

| Script              | Description                          |
| ------------------- | ------------------------------------ |
| `npm run dev`       | Run with hot reload via `tsx watch`. |
| `npm run build`     | Compile TypeScript to `dist/`.       |
| `npm run typecheck` | Type-check without emitting.         |
| `npm start`         | Run the compiled server.             |

## Structure

```txt
src/
  index.ts              # entrypoint (starts the listener)
  app.ts                # builds the Express app
  config/env.ts         # Zod-validated env (placeholders for Section 1)
  routes/health.ts      # GET /health
  utils/logger.ts       # minimal leveled logger

  channels/             # channel-agnostic messaging core
    types.ts            # Channel, Provider, In/OutboundMessage, events, statuses
    registry.ts         # ChannelAdapter contract + registry (empty)
    sendblue/           # Sendblue provider (types + normalize placeholders)

  users/                # UserProfile, MessagingIdentity, LinkSession
  conversations/        # Conversation + Message
  media/                # media / voice note placeholders
  agent/                # AgentContext, ToolDefinition, prompt layers
  reminders/            # proactive reminder placeholders
  integrations/         # Integration types + registry (empty)
  actions/              # ActionApproval placeholders
  billing/              # Subscription placeholders
  legal/                # LegalConsent placeholders
  db/schema.ts          # database schema DRAFT (types only, no connection)
```

## Not implemented yet (by design)

- Real Sendblue API calls, webhooks, or SDK
- Model / AI provider calls
- Database connection or ORM
- Integrations, billing, WhatsApp
- The app-side "Text Hula" link flow

These arrive in later sections.
