# Slack Section 22 deterministic live certification

Run this checklist through the real Sendblue/iMessage ingress against the intended development Slack workspace. Replace `<P>` everywhere with one unique lowercase-safe prefix, for example `HULA_S22_CERT_20260718_2015`; use `hula-s22-cert-20260718-2015` where Slack requires a channel name. Record the Slack timestamp/URL for every created resource.

Do not batch `conversations.history` or `conversations.replies` checks. Wait at least 60 seconds between those methods on an affected commercially distributed non-Marketplace installation, and follow any longer `Retry-After` Slack returns. A rate-limit response is a deferred test, not a logical failure.

For every confirmed mutation, inspect Slack before replying Yes, after the first Yes, and after one duplicate Yes. The invariant is zero side effects before confirmation, exactly one after the first confirmation, and still exactly one after a duplicate delivery.

## Phase 0 — installation contract

Precondition: the Slack app dashboard matches `server/docs/slack-app-manifest.yaml`. Reinstall through Hula after the Section 22 user-scope change so the user grant contains `search:read`, `channels:history`, and `groups:history`. Do not edit environment files during certification.

- Prompt: reconnect Slack from Hula's Integrations screen.
- Expected Hula behavior: OAuth succeeds and returns to the app.
- Slack side effect: one current Hula installation grant; no message/channel mutation.
- Confirmation: OAuth consent only; no Hula Yes/No proposal.
- PASS: Hula reports connected and the grant contains the manifest scopes. FAIL: missing-scope, wrong-workspace, or callback/replay error.

## Phase 1 — workspace, conversations, and people

Precondition: Hula and the certifying user are members of an existing channel chosen as `<CHANNEL>` (for example `all-hula`).

| Exact prompt | Expected Hula behavior | Slack side effect | Confirmation | PASS / FAIL |
|---|---|---|---|---|
| `Which Slack workspace is connected?` | Names the installed workspace. | None. | None. | PASS if the actual workspace is named; FAIL for invention or wrong team. |
| `Show my Slack channels.` | Lists only accessible conversations with real names. | None. | None. | PASS if `<CHANNEL>` appears; an honestly empty accessible set is valid. |
| `Who is in my Slack workspace?` | Lists real visible users/bots. | None. | None. | PASS if the certifying user and Hula resolve; FAIL for fabricated users. |
| `Who belongs to <CHANNEL>?` | Uses that channel's real member IDs and hydrated names. | None. | None. | PASS if actual membership agrees; FAIL for another channel's members. |

## Phase 2 — seeded message, history, and exact search

Precondition: `<P>_MESSAGE` does not already exist in `<CHANNEL>`.

1. Prompt: `Post "<P>_MESSAGE" in <CHANNEL>.`
   - Expected: a proposal naming the exact text/channel and “Reply Yes to confirm”.
   - Side effect: none before Yes; exactly one `chat.postMessage` after Yes.
   - Confirmation: required. Reply `Yes`, verify one message, then send a duplicate `Yes` and verify no second message.
   - PASS: one exact Slack message. FAIL: pre-confirm write, duplicate, altered text, or wrong channel.
2. Wait according to the history limit, then prompt: `Show me the latest messages in <CHANNEL>.`
   - Expected: real history including `<P>_MESSAGE`, with stable numbering.
   - Side effect/confirmation: none.
   - PASS: seeded message appears once with its real author; FAIL: omission when within the returned bound or invented content.
3. Prompt: `Search my Slack for "<P>_MESSAGE".`
   - Expected: the exact grouped `search.all` match.
   - Side effect/confirmation: none.
   - PASS: exact marker appears; FAIL: unrelated approximation or false empty result.
4. Prompt: `Search my Slack for "<P>_MESSAGE" and tell me which channel each result came from.`
   - Expected: same match with `#<CHANNEL>` and permalink when Slack supplies it.
   - Side effect/confirmation: none.
   - PASS: source metadata matches Slack; FAIL: people-only output or wrong source.

## Phase 3 — authoritative referent endurance

Precondition: finish Phase 2 with the exact search result selected.

Run these consecutively without another list/search:

1. `Who wrote that message?` → the real author of `<P>_MESSAGE`.
2. `Which channel was that message in?` → `#<CHANNEL>`.
3. `Who wrote that message?` → the same author again.
4. `Give me the Slack link to it.` → the real permalink.
5. `Which channel was that message in?` → still `#<CHANNEL>`.

All are reads with no confirmation or side effect. PASS only if every answer derives from the same Slack timestamp/channel/user ID. FAIL on clarification after an unambiguous prior turn, a different message, or prose-derived IDs.

## Phase 4 — seeded thread and reply

Precondition: re-run the exact search for `<P>_MESSAGE` so its source message is active.

1. Prompt: `Reply to that Slack message saying "<P>_REPLY".`
   - Expected: exact thread-reply proposal.
   - Side effect: none before Yes; one threaded `chat.postMessage` after Yes.
   - Confirmation: required; duplicate Yes remains one reply.
   - PASS: reply's `thread_ts` is the seed message timestamp. FAIL: top-level post, duplicate, or wrong thread.
2. After the applicable replies-method wait, prompt: `Show replies to it.`
   - Expected: normalized root/replies from `conversations.replies`, including `<P>_REPLY`.
   - Side effect/confirmation: none.
   - PASS: correct channel + source `ts/threadTs`; FAIL: history from another conversation.
3. Prompt: `Who wrote that message?`
   - Expected: the active source/reply author remains grounded, not a channel projection.
   - PASS: real author; FAIL: lost-context clarification.

## Phase 5 — reactions

Precondition: exact-search `<P>_MESSAGE` again.

| Exact prompt | Expected behavior / side effect | Confirmation | PASS / FAIL |
|---|---|---|---|
| `React to that Slack message with thumbs up.` | Proposal, then exactly one `reactions.add` on the seed channel/timestamp. | Required. | PASS if `:thumbsup:` appears once only after Yes. |
| `Show reactions on that Slack message.` | Lists the real reaction/count via `reactions.get`. | None. | PASS if count agrees with Slack. |
| `Remove the thumbs up reaction from that Slack message.` | Proposal, then exactly one `reactions.remove`. | Required. | PASS if Hula's reaction disappears and no other reaction is changed. |
| `Show reactions on that Slack message.` | Honest empty/remaining list. | None. | FAIL if removed reaction is still claimed absent provider evidence. |

## Phase 6 — pins

Precondition: exact-search `<P>_MESSAGE`; ensure it is not already pinned.

1. `Pin that Slack message.` → confirmed `pins.add`; exactly one shared pin.
2. `Show pins in <CHANNEL>.` → seeded message appears in the real `pins.list` envelope.
3. Re-run exact search for `<P>_MESSAGE`, then `Unpin that Slack message.` → confirmed `pins.remove`.
4. `Show pins in <CHANNEL>.` → seeded pin is absent.

PASS requires exact channel/timestamp and confirmation on add/remove. Empty pin lists are legitimate. FAIL on pre-confirm mutation or wrong pinned item.

## Phase 7 — scheduled messages

Precondition: choose a time at least 15 minutes in the future in the user's stored IANA timezone.

1. `Schedule "<P>_SCHEDULED" in <CHANNEL> for <EXACT LOCAL DATE AND TIME>.`
   - Expected: proposal renders exact channel/text/time; one `chat.scheduleMessage` after Yes.
   - Confirmation: required; duplicate Yes creates no duplicate schedule.
2. `Show my scheduled Slack messages.`
   - Expected: `<P>_SCHEDULED` from `chat.scheduledMessages.list`; this selects its real scheduled ID.
3. `Cancel that scheduled Slack message.`
   - Expected: confirmed `chat.deleteScheduledMessage` with its authoritative channel/scheduled ID.
4. List again and verify absence.

PASS requires zero delivered message and zero scheduled item after cancellation. FAIL on UTC/local-time drift, wrong ID, or duplicate.

## Phase 8 — DM

Precondition: choose one uniquely resolvable real workspace user `<PERSON>` who can receive a DM.

1. `Message <PERSON> on Slack saying "<P>_DM".`
   - Expected: proposal only; after Yes Hula opens/resolves the DM and posts once.
   - Confirmation: required; duplicate Yes remains one DM.
2. `Show my Slack direct messages.`
   - Expected: the actual DM conversation is listed without opening a new one as a read side effect.

PASS if the exact person receives one message. FAIL for ambiguous recipient execution, pre-confirm `conversations.open`, or wrong DM.

## Phase 9 — channel lifecycle

Use `<CERT_CHANNEL>=hula-s22-cert-<timestamp>`. Workspace policy may legitimately refuse some operations; a precise Slack policy/permission response is an honest constrained result, not a provider-contract failure.

1. `Create a public Slack channel called <CERT_CHANNEL>.` → confirmed create; one channel.
2. `Set the Slack topic of <CERT_CHANNEL> to "<P> topic".` → confirmed; verify topic.
3. `Set the Slack purpose of <CERT_CHANNEL> to "<P> purpose".` → confirmed; verify purpose.
4. `Rename <CERT_CHANNEL> to <CERT_CHANNEL>-renamed on Slack.` → confirmed; verify exact rename.
5. `Archive the Slack channel <CERT_CHANNEL>-renamed.` → confirmed; verify archived.
6. `Unarchive the Slack channel <CERT_CHANNEL>-renamed.` → confirmed; verify active.
7. If testing membership with `<PERSON>`: invite, verify membership, then remove; each requires a separate proposal/Yes and must preserve all unrelated members.

PASS requires zero mutation before each Yes, exactly one after it, and truthful policy errors. Do not delete unrelated channels.

## Phase 10 — bookmarks, files, and user groups

Bookmarks precondition: use the cert channel and a harmless URL such as `https://example.com/?cert=<P>`.

1. Add `<P> bookmark` to the cert channel → confirmed `bookmarks.add`.
2. List bookmarks → real bookmark selected.
3. Edit it to `<P> bookmark edited` → confirmed `bookmarks.edit`.
4. Remove it → confirmed `bookmarks.remove`; list verifies absence.

Files:

- `Show Slack files in <CHANNEL>.` and file-info follow-up are read-only; an honestly empty set passes.
- `Upload this file to Slack.` and `Delete that Slack file.` must state that the messaging interface does not support the operation and must create no proposal/side effect. Claiming success is FAIL.

User groups are conditional on the workspace plan and installing user's authority:

1. List groups. Empty is valid.
2. Only when supported, create `<P> Reviewers`, list it, rename/update it, set a complete seeded membership list, then disable/enable it. Every write requires confirmation.
3. A precise `plan_upgrade_required`, admin, or policy response is PASS for contract honesty but means the feature is not live-certified on this workspace.

## Completion record

Record each row as PASS, FAIL, DEFERRED-RATE-LIMIT, POLICY-UNAVAILABLE, or NOT-RUN. Offline tests do not convert a NOT-RUN live operation into PASS. At the end, verify there is exactly one of every seeded message/reply/DM/channel resource expected, no cancelled schedule, no leftover reaction/pin/bookmark unless intentionally retained, and no mutation from any declined file-write request.
