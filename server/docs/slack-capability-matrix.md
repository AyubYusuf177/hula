# Slack capability matrix (Section 22)

Contract date: 2026-07-18. “Supported” means reachable from Hula’s production Slack conversation path; lower-level provider primitives that have no trusted messaging input are called out separately. Provider data is always untrusted. All exposed writes use the shared expiring, single-use confirmation runtime.

The sources below are Slack’s official developer documentation: [OAuth v2](https://docs.slack.dev/authentication/installing-with-oauth/), [token rotation](https://docs.slack.dev/authentication/using-token-rotation/), [revocation](https://docs.slack.dev/reference/methods/auth.revoke/), [Web API rate limits](https://docs.slack.dev/apis/web-api/rate-limits/), [2025 non-Marketplace limits](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/), [Conversations API](https://docs.slack.dev/apis/web-api/using-the-conversations-api/), [methods](https://docs.slack.dev/reference/methods/), [Events API](https://docs.slack.dev/apis/events-api/), [request signing](https://docs.slack.dev/authentication/verifying-requests-from-slack/), [distribution](https://docs.slack.dev/distribution/), [2025 terms update](https://docs.slack.dev/changelog/2025/05/29/tos-updates/), and [developer policy update](https://docs.slack.dev/changelog/2024/12/10/dev-policy-update/).

| Capability | Official method/family | Bot scopes | User scopes | Token | Effect | Conversation / confirmation | Verification and limits | Status / restriction |
|---|---|---|---|---|---|---|---|---|
| Installation identity/team | `auth.test`, `team.info` | `team:read` | — | bot | read | connected identity; none | `ok:true`; per-method tier | Supported |
| Users/profiles/email | `users.list`, `users.profile.get`, `users.getPresence` | `users:read`, `users.profile:read`, `users:read.email` | — | bot | read | people resolution/list; none | cursor bounded; email optional | Supported, scope-dependent; `users.info` is not currently called |
| Public/private/DM/MPIM list/info/members/open/close | Conversations API | `channels:read`, `groups:read`, `im:read/write`, `mpim:read`, `mpim:history` | — | bot | read/write | list/history and resolved targets; opening/DM closing asks | cursor bounded | Bot tokens can list/read accessible MPIMs, but Slack documents `mpim:write` as user-token-only. Hula does not request it and cannot open/close MPIMs. Private visibility/membership applies |
| History and thread replies | `conversations.history`, `.replies` | corresponding `*:history` | `channels:history`, `groups:history` | history: bot; channel replies: user; DM/MPIM replies: bot | read | latest/thread summaries; none | one page, max 15 for affected commercial non-Marketplace installations | Scope changes require reinstall; Marketplace/distribution limits still apply |
| Search messages/files | `search.all` | — | `search:read` | user | read | global grouped message/file search; none | bounded result count; search tier | Supported only with user token; `search.messages`/`search.files` are not separately called |
| Post/reply/update/delete | `chat.postMessage/update/delete` | `chat:write` | — | bot | external write/delete | exposed; always confirm | authoritative `channel`/`ts`; no ambiguous retry | Supported only for messages Slack authorizes the token to alter |
| Schedule/list/delete scheduled | `chat.scheduleMessage`, `chat.scheduledMessages.list`, `chat.deleteScheduledMessage` | `chat:write` | — | bot | external write/delete | exposed; changes confirm | `scheduled_message_id`; Slack horizon/timestamp rules | Supported; scheduling must use stored IANA timezone |
| Ephemeral message | `chat.postEphemeral` | `chat:write` | — | bot | external write | not exposed | — | Unsupported by the current implementation |
| Permalink | `chat.getPermalink` | channel history/read scope | — | bot | read | useful links; none | `permalink` receipt | Supported where message accessible |
| Reactions | `reactions.get/add/remove` | `reactions:read/write` | — | bot | read/social write | exposed; writes confirm | `ok:true`, durable message ref | Supported |
| Pins | `pins.list/add/remove` | `pins:read/write` | — | bot | read/shared write | exposed; writes confirm | `ok:true`, durable message ref | Supported |
| Files metadata | `files.list`, `files.info` | `files:read` | — | bot | read | list/info exposed; none | bounded | Supported |
| File delete | `files.delete` | `files:write` | — | bot | delete | not exposed | ownership applies | Unsupported by the current conversation/action allowlist |
| File upload | `files.getUploadURLExternal` + external POST + `files.completeUploadExternal` | `files:write` | — | bot | external write | lower-level provider primitive only; no messaging proposal is created | raw byte transfer then completion | Not end-to-end supported until a trusted binary ingress can enter confirmation safely |
| Deprecated upload | `files.upload` | — | — | — | write | never | retired method | Unsupported/deprecated; current external-upload flow only |
| Channel create/rename/archive/unarchive/join/leave/topic/purpose | Conversations API management methods | `channels:manage`, `channels:join` and relevant read | — | bot | shared write | exposed; confirm | `ok:true`/channel receipt | Supported subject to public/private, owner/admin and workspace policy |
| Invite/remove members | `conversations.invite/kick` | `channels:manage` plus relevant scopes | — | bot | shared write | exposed; confirm | authoritative envelope | Supported where Slack permits; admin/owner restrictions apply |
| Bookmarks | `bookmarks.list/add/edit/remove` | `bookmarks:read/write` | — | bot | read/shared write | client/action runtime; writes confirm | cursor/method tier, `ok:true` | Supported |
| User groups and membership | `usergroups.*`, `usergroups.users.update` | `usergroups:read/write` | — | bot | read/shared write | client/action runtime; writes confirm | `ok:true`; plan/admin restrictions | Scope-supported; paid-plan/admin-policy dependent |
| Custom emoji | `emoji.list` | `emoji:read` | — | bot | read | client read; none | envelope map | Supported. Emoji creation/removal is admin surface, not exposed |
| Link unfurls | `chat.unfurl` / Events | `links:read/write` | — | bot | external write | not advertised | domain registration and event flow | Deliberately unsupported and scopes are not requested: no registered-domain/interactivity product need |
| Events over HTTP | Events API | event-dependent + signing secret | — | app | inbound read | `app_mention` verification only; no core dependency | raw HMAC, ±5 min, timing-safe, `event_id` dedupe, retry-safe | Supported. Socket Mode disabled; HTTP boundary is deployed |
| Reminders/saved items | legacy reminders / saved-items UI | varies | varies | user | personal write | not exposed | current public applicability insufficient | Unsupported/deprecated or no ordinary current API contract; Hula reminders remain separate |
| Canvases/Lists | Canvas/List APIs where documented | feature scopes | varies | bot/user | read/write | not exposed | product/tier constraints | Not in configured scopes; tier-dependent and omitted conservatively |
| Workflow Builder internals | Workflow APIs/triggers | product-specific | — | app | external | not exposed | distribution constraints | Unsupported without applicable public workflow product contract |
| Calls media | Calls API registers call metadata; media transport external | `calls:write` | — | bot | external | not exposed | Slack does not transport media | Unsupported for Hula’s Slack pack |
| Admin, Audit Logs, SCIM | `admin.*`, Audit Logs, SCIM | admin/org scopes | — | org/admin | organization-wide | never | Enterprise product/admin installation | Enterprise Grid/admin-only; not ordinary OAuth |
| Discovery/compliance exports | Discovery APIs | partner grant | — | partner | sensitive read | never | partner review | Partner-only; unsupported |
| Real-time Search/Data Access | Slack partner data interfaces | partner grant | — | partner | sensitive read | never | select partner | Partner-only; unsupported |
| Billing, Slack AI internals, Marketplace review status | no ordinary OAuth method | — | — | — | restricted | never | N/A | Unsupported; UI/internal/commercial processes, not API capabilities |

## Safety, pagination, and policy

Every Web API request names its method explicitly, uses a ten-second timeout, validates both HTTP status and Slack’s `ok` envelope, bounds pagination and result counts, parses `Retry-After`, and never automatically retries an ambiguous mutation. Affected commercially distributed non-Marketplace apps use a maximum history/replies page size of 15 and must respect the documented one-request-per-minute limit; Hula optimizes/limits reads rather than scanning around it. Provider text, blocks, attachments, file bytes, profile fields, topics, unfurls, and events remain quoted data and cannot select tools, resolve recipients, or manufacture confirmation.

Slack’s developer terms prohibit using Slack data to train general-purpose models and impose data-use/distribution requirements. Hula treats data as request-scoped user context, does not claim training rights, and does not imply Marketplace approval. Distribution beyond a single workspace requires Slack’s applicable distribution/Marketplace review process.

## Development installation and OAuth alignment

An undistributed Slack app can be installed only in its associated development workspace. Hula normally omits Slack's optional `team` parameter so distributed users can choose an eligible workspace. During development, `SLACK_DEVELOPMENT_TEAM_ID=T…` may be set to the development workspace ID. This adds Slack's documented workspace hint without hard-coding a workspace into the product. The user must still belong to the workspace and have installation permission or obtain admin approval.

The OAuth request, dashboard, and manifest must use the same bot/user scope split. In particular, `mpim:write` must not be placed under bot scopes. Hula's user token is limited to `search:read`, `channels:history`, and `groups:history`; the two history scopes are required by Slack's channel-thread reply contract. Dashboard-generated install tokens are not Hula credentials and must never be copied into Hula configuration. Scope changes require updating the dashboard from this manifest and reinstalling through Hula so Slack issues a current grant.

## Official source map by capability

This source map is part of the matrix. Each row above maps to the current official Slack reference below; method pages also state their accepted token types and required scopes.

| Matrix capability | Official source URL |
|---|---|
| Installation identity/team | [auth.test](https://docs.slack.dev/reference/methods/auth.test/), [team.info](https://docs.slack.dev/reference/methods/team.info/) |
| Users/profiles/email/presence | [users.list](https://docs.slack.dev/reference/methods/users.list/), [users.profile.get](https://docs.slack.dev/reference/methods/users.profile.get/), [users.getPresence](https://docs.slack.dev/reference/methods/users.getPresence/) |
| Public/private/DM/MPIM conversations | [Conversations API](https://docs.slack.dev/apis/web-api/using-the-conversations-api/), [conversations.open](https://docs.slack.dev/reference/methods/conversations.open/) |
| History/thread replies and commercial limits | [conversations.history](https://docs.slack.dev/reference/methods/conversations.history/), [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/), [non-Marketplace rate-limit change](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/) |
| Search messages/files | [search.all](https://docs.slack.dev/reference/methods/search.all/), [search.messages](https://docs.slack.dev/reference/methods/search.messages/), [search.files](https://docs.slack.dev/reference/methods/search.files/) |
| Post/reply/update/delete/ephemeral/permalink | [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/), [chat.update](https://docs.slack.dev/reference/methods/chat.update/), [chat.delete](https://docs.slack.dev/reference/methods/chat.delete/), [chat.postEphemeral](https://docs.slack.dev/reference/methods/chat.postEphemeral/), [chat.getPermalink](https://docs.slack.dev/reference/methods/chat.getPermalink/) |
| Scheduled messages | [chat.scheduleMessage](https://docs.slack.dev/reference/methods/chat.scheduleMessage/), [chat.scheduledMessages.list](https://docs.slack.dev/reference/methods/chat.scheduledMessages.list/), [chat.deleteScheduledMessage](https://docs.slack.dev/reference/methods/chat.deleteScheduledMessage/) |
| Reactions | [reactions methods](https://docs.slack.dev/reference/methods/#reactions) |
| Pins | [pins methods](https://docs.slack.dev/reference/methods/#pins) |
| Files metadata/delete/upload | [files methods](https://docs.slack.dev/reference/methods/#files), [uploading files](https://docs.slack.dev/messaging/working-with-files/#upload) |
| Channel lifecycle/topic/purpose/membership | [conversations methods](https://docs.slack.dev/reference/methods/#conversations) |
| Bookmarks | [bookmarks methods](https://docs.slack.dev/reference/methods/#bookmarks) |
| User groups | [usergroups methods](https://docs.slack.dev/reference/methods/#usergroups) |
| Custom emoji | [emoji.list](https://docs.slack.dev/reference/methods/emoji.list/) |
| Link unfurls | [chat.unfurl](https://docs.slack.dev/reference/methods/chat.unfurl/), [link_shared event](https://docs.slack.dev/reference/events/link_shared/) |
| Events over HTTP | [Events API](https://docs.slack.dev/apis/events-api/), [request signing](https://docs.slack.dev/authentication/verifying-requests-from-slack/) |
| Reminders and saved items | [reminders methods](https://docs.slack.dev/reference/methods/#reminders), [Web API methods index](https://docs.slack.dev/reference/methods/) |
| Canvases and Lists | [canvases methods](https://docs.slack.dev/reference/methods/#canvases), [lists methods](https://docs.slack.dev/reference/methods/#lists) |
| Workflows | [Workflow steps](https://docs.slack.dev/workflows/workflow-steps/) |
| Calls | [Calls API](https://docs.slack.dev/apis/web-api/using-the-calls-api/) |
| Admin/Audit Logs/SCIM | [Admin APIs](https://docs.slack.dev/admins/), [Audit Logs API](https://docs.slack.dev/admins/audit-logs-api/), [SCIM API](https://docs.slack.dev/admins/scim-api/) |
| Discovery/compliance, partner data interfaces | [Slack platform overview](https://docs.slack.dev/), [distribution](https://docs.slack.dev/distribution/) |
| Billing, Slack AI internals, Marketplace review | [distribution and Marketplace](https://docs.slack.dev/distribution/) |
| OAuth/token rotation/revocation | [OAuth v2](https://docs.slack.dev/authentication/installing-with-oauth/), [token rotation](https://docs.slack.dev/authentication/using-token-rotation/), [auth.revoke](https://docs.slack.dev/reference/methods/auth.revoke/) |
| Rate limiting and 429 handling | [Web API rate limits](https://docs.slack.dev/apis/web-api/rate-limits/) |
| Data use/model-training policy | [2025 terms update](https://docs.slack.dev/changelog/2025/05/29/tos-updates/), [developer policy update](https://docs.slack.dev/changelog/2024/12/10/dev-policy-update/) |
