Read AGENTS.md first and follow it strictly.

We are on the development branch.

# Section 19 — Complete Todoist Integration

## Operating principle

Velocity is the only moat.

Build a complete, reliable, end-to-end Todoist integration that users can control naturally through iMessage.

Do not stop at an inspection report. Inspect first, then implement, test, and report.

Do not commit, push, or stage files. Ayub commits manually after review and real-device testing.

Do not read, expose, print, or edit .env.

Never run:

- any `*-real` script;
- any `*.manual.ts` script;
- any command that mutates a real provider or production database;
- any real Todoist action during automated testing.

Use mocked/fake providers for automated tests.

## Current verified baseline

Repository:

~/Desktop/hulaai

Branch:

development

Latest pushed commit:

57cb322 Complete Google Calendar and Google Meet actions

Working tree should be clean except for this new Section 19 prompt file.

Current verified capabilities:

- iMessage transport through Sendblue
- Clerk user identity
- encrypted integration credentials
- Gmail search/read/summarise/reply/drafts/send/message management
- persistent Gmail conversation context
- Google Calendar reads
- Calendar availability/free-busy
- Calendar create/update/cancel
- recurring-event safety
- Google Meet creation
- durable proposal/confirmation/execution runtime
- duplicate-action prevention
- provider receipt validation
- provider postcondition verification
- OAuth state validation and safe successful-callback replay handling
- memory and reminders

Section 18 passed 960 automated assertions and real iMessage testing.

Protect all of this.

## Product goal

A user should connect Todoist in the Hula mobile app and naturally manage their tasks through iMessage.

Examples:

- “What do I need to do today?”
- “What tasks are overdue?”
- “What’s coming up this week?”
- “Show my tasks for Hula.”
- “What are my highest-priority tasks?”
- “Add finish the pitch deck to my work project for Friday at 5.”
- “Remind me to call Rob tomorrow.”
- “Move the second task to Monday.”
- “Change its priority to high.”
- “Put that in my Hula project.”
- “Add the label work.”
- “Mark the first one complete.”
- “Undo that.”
- “Reopen the task I just completed.”
- “Delete that task.”
- “Complete all of those.”
- “What did I just complete?”

Hula must understand natural task intent and follow-up references without forcing rigid phrases.

Do not implement literal keyword-only rules such as “when text contains work, return X.”

## Official API contract

Use Todoist’s current official API version and official documentation as the source of truth.

Do not use deprecated v9 endpoint assumptions.

Implement OAuth for a public multi-user integration.

Expected OAuth permissions should be capability-based:

- read-only task/project access;
- task/project write access;
- delete access only where required.

Confirm exact current scope names from official Todoist documentation before implementation.

Do not request broader access than needed.

If Todoist requires `data:read_write` for normal task lifecycle operations and `data:delete` for deletion, represent those as distinct granted capabilities.

Do not silently treat missing delete access as a disconnected integration. Read/write should continue working when only deletion is unavailable.

## Phase 1 — Inspect and design

Before editing:

1. Read AGENTS.md.
2. Confirm branch, HEAD, and working-tree status.
3. Inspect the existing integration architecture.
4. Inspect:
   - Prisma integration models;
   - integration catalog;
   - connection and credential services;
   - encrypted token storage;
   - OAuth state handling;
   - OAuth replay handling;
   - integration status API;
   - mobile integrations UI;
   - action registry;
   - policy levels;
   - proposal/confirmation/executor runtime;
   - durable idempotency;
   - operationalGuard;
   - inbound routing;
   - Gmail entity context;
   - Calendar entity context;
   - provider receipt validation;
   - postcondition verification.
5. Identify the smallest architecture that fits existing patterns.
6. State the implementation plan briefly.
7. Then implement.

Reuse existing provider-agnostic systems. Do not create a separate parallel action runtime.

## Phase 2 — Integration catalog and OAuth

Add provider id:

todoist

Add a Todoist integration entry to the backend catalog and the existing data-driven mobile integrations UI.

The card should:

- use Todoist’s correct name and icon;
- explain real current capabilities;
- show disconnected, partially connected, reconnect-required, connected, and error states accurately;
- connect and disconnect through existing Hula API patterns;
- remain Expo Go compatible;
- require no native-only package or custom development client.

Implement:

- Todoist connect endpoint;
- Todoist OAuth callback;
- encrypted credential storage;
- token expiry/refresh handling only if Todoist’s actual OAuth contract requires it;
- disconnect;
- capability derivation from granted scopes;
- safe OAuth state validation;
- safe successful-callback replay behaviour using the existing shared protection;
- app return flow;
- coded logs without tokens, authorization codes, raw provider bodies, or secrets.

Never guess refresh-token behaviour. Follow the official Todoist OAuth contract.

Do not introduce a Prisma migration unless the existing provider-agnostic schema truly cannot support Todoist.

## Phase 3 — Typed Todoist client

Create a typed provider client with:

- bounded timeouts;
- structured coded errors;
- 401/403 distinction;
- missing-scope handling;
- rate-limit handling;
- retry only where safe;
- no unsafe automatic retry of non-idempotent writes;
- provider response validation;
- pagination;
- bounded result limits;
- defensive parsing;
- no raw provider response leakage.

Support current official API resources required for:

- tasks;
- projects;
- sections where available;
- labels;
- comments where useful for task context;
- completed tasks/history where officially supported and authorised.

Do not claim unsupported functionality.

## Phase 4 — Complete read capabilities

Implement natural, grounded reads for:

- today;
- overdue;
- upcoming;
- this week;
- no due date;
- completed/recently completed when supported;
- project-specific tasks;
- section-specific tasks;
- label-specific tasks;
- priority-specific tasks;
- assignee-specific tasks where applicable;
- exact task inspection;
- natural semantic filtering over provider-grounded task metadata;
- bounded search.

Responses must be concise and useful in iMessage.

Recommended format:

1. Task title
   Due date/time · Project · Priority

Do not expose internal ids.

Do not say “I found 10, showing 5” when the user requested five. Respect explicit counts.

If the user asks an open-ended question, use a sensible bounded result and clearly say that more exist only when relevant.

Store numbered results in durable entity context so follow-ups such as these work:

- “the second one”
- “that task”
- “the one due Friday”
- “the Hula task”
- “the task I just completed”
- “undo that”

Context must:

- be user-scoped;
- expire;
- never cross users;
- never guess when ambiguous;
- re-fetch the selected provider object before mutation;
- survive a normal multi-turn iMessage exchange;
- not depend on in-memory process state.

## Phase 5 — Complete write lifecycle

Implement:

### Create

- title/content;
- description;
- due date;
- due time;
- timezone;
- recurring due expression where Todoist officially supports it;
- project;
- section;
- labels;
- priority;
- assignee where valid;
- duration/deadline only if officially supported.

### Update

- rename;
- edit description;
- change due date/time;
- remove due date;
- reschedule;
- change project;
- change section;
- add/remove labels;
- change priority;
- change assignee where valid.

### State actions

- complete;
- reopen;
- undo the immediately preceding supported state action;
- inspect recently completed tasks where supported.

### Delete

- delete one task;
- bulk deletion only with explicit bounded targets.

Do not silently create missing projects, sections, or labels after a typo.

If the requested destination does not exist, report it or ask the user to choose.

Never mutate an ambiguous task.

## Phase 6 — Safety and confirmation policy

Use the existing action registry, policy, proposal, confirmation, executor, idempotency, receipt, and operational-honesty systems.

Product policy:

### Immediate, reversible, single-task actions

These may execute without confirmation after the target is unambiguous:

- create one task;
- update one task;
- complete one task;
- reopen one task;
- add/remove a known label;
- change priority;
- move one task.

These actions still require:

- durable idempotency;
- validated provider receipts;
- postcondition verification;
- honest partial/failure reporting.

### Confirmation required

Require confirmation for:

- deleting any task;
- bulk actions affecting two or more tasks;
- bulk completion;
- bulk rescheduling;
- bulk moving;
- bulk label changes;
- any destructive or difficult-to-reverse action.

Deletion preview must say it is destructive.

Cancel must never execute.

Expired proposals must never execute.

Repeated confirmations must never execute twice.

Concurrent confirmations must race safely.

A provider response without the required receipt fields is not success.

A successful mutation that fails postcondition verification must not be reported as completed.

## Phase 7 — Idempotency and verification

For every write:

1. Resolve and re-fetch the current task.
2. Execute through the shared runtime.
3. Validate the provider receipt.
4. Re-read the task or relevant collection when possible.
5. Verify the requested postcondition.
6. Only then report success.

Create verification must confirm the real provider task exists with the expected essential fields.

Update verification must confirm the changed fields.

Complete verification must confirm completion or disappearance from active tasks using the official API’s semantics.

Reopen verification must confirm the task is active.

Delete verification must confirm absence/not-found using official semantics.

Protect against duplicate Sendblue delivery and repeated confirmation.

Do not rely only on the in-memory webhook message-id set.

## Phase 8 — Natural routing

Integrate Todoist into the single inbound routing cascade.

Preserve routing priority and all existing capabilities.

Avoid collisions with:

- Hula’s existing internal reminders;
- Calendar events;
- Gmail;
- memory;
- general brain responses.

Important distinction:

- “Remind me to call Rob tomorrow” may be ambiguous between a Hula reminder and a Todoist task.
- Do not silently change the established reminder behaviour.
- Explicit Todoist/task language should route to Todoist.
- Existing reminder phrases must remain unchanged unless the user explicitly references Todoist, tasks, projects, labels, completion, or another clearly Todoist-specific concept.
- Add collision tests.

The model may extract typed intent fields, but it must not construct raw provider query DSL or choose unvalidated provider ids.

Use bounded typed extraction and deterministic validation.

## Phase 9 — User-facing honesty

Hula must never claim:

- a task was created when it was not;
- a task was completed when it remains active;
- a task was deleted when it still exists;
- a task was moved when it was not;
- a project or label exists when it does not;
- Todoist is connected when required capabilities are absent.

Partial bulk failure must be reported as partial:

“Completed 2 of 3 tasks — one didn’t go through.”

Never collapse partial failure into success.

## Phase 10 — Tests

Add comprehensive offline tests with fake Todoist providers.

Cover at minimum:

### OAuth

- connect URL;
- state validation;
- callback;
- exact successful replay;
- invalid/expired/mismatched state;
- missing scopes;
- partial capability consent;
- disconnect;
- no token leakage.

### Reads

- today;
- overdue;
- upcoming;
- project;
- label;
- priority;
- completed;
- explicit counts;
- pagination;
- empty results;
- provider errors;
- timezone boundaries;
- recurring due dates;
- durable numbered selection.

### Writes

- create;
- update;
- reschedule;
- remove due date;
- priority;
- project;
- section;
- labels;
- complete;
- reopen;
- undo;
- delete;
- bulk actions;
- ambiguity;
- stale context;
- missing destination;
- provider failure;
- malformed receipt;
- failed postcondition;
- partial bulk failure.

### Safety

- destructive confirmation;
- bulk confirmation;
- cancellation;
- expiry;
- repeated confirmation;
- concurrent confirmation;
- duplicate webhook delivery;
- no pending proposal reaches the brain;
- cross-user context isolation.

### Routing regressions

- Gmail reads/writes;
- Calendar reads/writes/Meet;
- reminders;
- memory;
- general messages;
- explicit Todoist requests;
- ambiguous “remind me” behaviour.

### Mobile/API

- integration catalog;
- connected state;
- partial capabilities;
- reconnect-required;
- disconnect;
- no UI regression;
- Expo Go compatibility.

## Validation

Run with independently captured exit codes:

- Todoist-specific tests;
- full backend `npm test`;
- backend typecheck;
- backend build;
- root lint;
- root TypeScript;
- Prisma generate;
- Prisma migrate status;
- `git diff --check`.

Do not report a compound command’s final exit code as proof that an earlier command passed.

Do not run real-provider diagnostics.

## Final report

Report:

1. Confirmed pre-change architecture
2. Todoist architecture implemented
3. OAuth and scopes
4. Capability-based connection status
5. Complete read capabilities
6. Complete write capabilities
7. Confirmation policy
8. Durable context and natural follow-ups
9. Receipt and postcondition verification
10. Routing/collision behaviour
11. Exact files changed
12. Tests added
13. Independently captured validation results
14. Manual setup required from Ayub
15. Exact real-device iMessage test plan
16. Anything genuinely deferred or unsupported
17. Git status

Do not claim “complete” for anything not implemented and tested.

Do not commit, push, stage, or edit .env.