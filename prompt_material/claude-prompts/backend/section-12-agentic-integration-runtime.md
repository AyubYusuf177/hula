# Hula — Section 12: Agentic Integration Runtime (backend)

We are building Hula Section 12 only: **Agentic Integration Runtime backend**.

Do not build the integrations frontend UI yet.
Do not build automations UI yet.
Do not build automation cards yet.
Do not add Gmail / Microsoft / Notion / Slack / Todoist / Whoop/Oura/Strava OAuth yet.
Do not add WhatsApp. Do not add billing. Do not add new mobile screens.
Do not add frontend popups, visible loading states, or new user-facing buttons.
Do not add new permissions or broad autonomous execution.
Do not let Claude directly call provider APIs.
Do not add calendar event write actions yet unless only as disabled/stubbed tool metadata.
Do not execute real provider write actions in this section.
Do not change onboarding, auth, or break Expo Go compatibility.
Do not commit / push / `git add -A`. Do not expose env values or open `server/.env`.

## Research-driven architecture principle

The model should never directly call provider APIs. The model/planner produces or
requests a **typed Hula action**. The deterministic Hula backend then:

1. validates the action
2. checks provider connection and scopes
3. applies policy/risk rules
4. asks for user confirmation when needed
5. executes through provider adapters only when allowed
6. logs the proposal, confirmation, execution and result
7. sends the user a clear outcome message

## Section 12 goal

Create the backend action runtime that every future integration will use —
supporting future actions like `calendar.createEvent`, `email.sendDraft`,
`task.create`, `slack.postMessage`, etc. — **without executing real provider
write actions yet**. Build the contracts, policy, proposal/confirmation flow,
action ledger, and executor stubs.

## Requirements (summary)

1. **Typed tool/action registry** (`server/src/actions/registry.ts`) — actionId,
   category, displayName, description, providerTypes, requiredCapabilities,
   requiredScopes, riskLevel (`read|draft|write|send|purchase|destructive`),
   confirmationRequired, implemented, enabled, input/output schema metadata,
   examples, userFacingDescription. Calendar reads implemented; everything else
   stubbed.
2. **Action proposal + execution models** — additive Prisma migration
   (`ActionProposal`, `ActionExecution`). No destructive migration, no DB reset.
3. **Action policy engine** (`server/src/actions/policy.ts`) — connection, scope,
   implemented, enabled, risk, confirmation. Reads run when connected+scoped;
   drafts/writes/sends require confirmation; purchases/destructive blocked;
   unimplemented actions return a safe not-yet-supported message.
4. **Confirmation flow through iMessage** — a natural-language "yes"/"confirm"/
   "do it" only confirms the single active pending proposal (10-min expiry); it
   never becomes standing consent. "no"/"cancel" rejects it.
5. **Executor** (`server/src/actions/executor.ts`) — `executeAction(userId,
   actionId, input, context)`. Loads definition, applies policy, executes only
   implemented adapters (calendar reads), logs `ActionExecution`, returns a safe
   user-facing result. Stubs return "not enabled yet".
6. **Planner/detector integration** — deterministic detection for a few examples;
   honest replies (no pretending an action happened).
7. **Action ledger** — every attempt/proposal logged safely (no tokens, no raw
   payloads, no secrets). Reuse `IntegrationActionLog` where clean; add
   `ActionExecution`.
8. **Inspection endpoints** — `GET /v1/me/actions/catalog|proposals|executions`,
   `POST /v1/me/actions/proposals/:id/confirm|reject`. Clerk-guarded, own-rows-only,
   no tokens, no raw payloads.
9. **Brain prompt update** — Hula understands connected-app infra, read-only
   Google Calendar, that it cannot write yet, must never claim a completed action
   unless the executor says so, and stays honest when not connected/enabled.
10. **Tests** — registry, risk/confirmation rules, policy blocks
    (unconnected/missing scope/purchase/destructive), read allowed, stub not
    implemented, confirm/cancel detection, expiry, "yes" without proposal is a
    no-op, proposals scoped to owner, executor never returns tokens, calendar
    reads via read-only helper with fakes/mocks. No real provider/Anthropic calls.
11. **Optional manual script** (`server/scripts/actions.manual.ts`) — throwaway
    user, stub connection, proposal lifecycle, stub executor, cleanup, no secrets.
12. **README update** — Section 12: why a typed runtime, the flow, pieces,
    implemented vs stubbed, how future providers plug in.
13. **Save this prompt** to
    `prompt_material/claude-prompts/backend/section-12-agentic-integration-runtime.md`.
14. **Validation** — branch/status; frontend `npm run lint` + `npx tsc --noEmit`;
    backend `npm run typecheck` + `build` + `test` + `prisma:generate` (+ migrate
    if schema changed, + `test:actions` if added). Manual iMessage tests: calendar
    read still works; "schedule gym tomorrow at 7pm" does NOT pretend; "yes" with
    no pending proposal executes nothing.
