# Asana public API and named OAuth capability audit (Section 20)

Verified against Asana's current OAuth scope table and official API reference on 2026-07-16. Hula deliberately does not enable Full permissions and never requests `scope=default`. Collections use bounded offset pagination.

Default named scopes requested by Hula:

`attachments:read attachments:write custom_fields:read goals:read portfolios:read portfolios:write projects:read projects:write projects:delete stories:read stories:write tags:read tasks:read tasks:write tasks:delete teams:read time_tracking_entries:read users:read workspaces:read`

## Implemented endpoint-to-scope map

| Hula operation | Endpoint family | Current named scope | Decision |
|---|---|---|---|
| Workspace reads | `GET /workspaces` | `workspaces:read` | enabled |
| User/identity resolution | `GET /users`, workspace users | `users:read` | enabled; exact identity only |
| Team reads | workspace team GET endpoints | `teams:read` | enabled |
| Task/user-task-list/project-task/section-task reads | task GET/search/list/subtask/dependency/dependent endpoints | `tasks:read` | enabled; user task lists do not have a separate scope |
| Task create/update/subtask/dependency/project/tag/follower/section-placement relationships | task POST/PUT relationship endpoints, including `POST /sections/{section_gid}/addTask` | `tasks:write` | enabled |
| Task delete | `DELETE /tasks/{gid}` | `tasks:delete` | enabled with confirmation |
| Project reads/create/update/delete | project GET/POST/PUT/DELETE endpoints | `projects:read`, `projects:write`, `projects:delete` | enabled |
| Story/comment reads and writes | story GET/POST/PUT endpoints | `stories:read`, `stories:write` | enabled; comment writes confirm |
| Attachment metadata and external URL attach | attachment GET/POST endpoints | `attachments:read`, `attachments:write` | enabled; byte pipeline remains unavailable |
| Tag reads and task tag relationships | tag GET endpoints; task add/remove tag | `tags:read`, `tasks:write` | enabled; Hula does not request tag-definition write access |
| Custom-field definitions and task values | custom-field GET; task PUT | `custom_fields:read`; task mutation uses `tasks:write` | enabled for validated task values; Hula does not edit definitions |
| Portfolio reads/create/update/items | portfolio GET/POST/PUT and add/remove-item endpoints | `portfolios:read`, `portfolios:write` | enabled with confirmation for membership changes; plan dependent |
| Goal reads | goal GET endpoints | `goals:read` | read-only |
| Time-entry reads | time-entry GET endpoints | `time_tracking_entries:read` | read-only and plan dependent |

## Required collection parents

Hula resolves an accessible workspace before calling workspace-filtered collections. `GET /projects` receives `workspace` (or an explicitly resolved team), portfolios/goals/tags receive `workspace`, teams use `/workspaces/{workspace_gid}/teams`, and personal `GET /tasks` receives both `assignee=me` and `workspace`. Users may remain global because Asana explicitly permits `/users` across all accessible workspaces. Task time entries use the task-parent endpoint. With multiple workspaces and no exact workspace name, Hula asks and performs no child collection request.

Project-scoped task reads resolve the exact project within the resolved workspace and call `/projects/{project_gid}/tasks`. They never inherit the personal `assignee=me` filter. Requested counts are passed into bounded provider pagination, and the returned order is persisted for numbered follow-ups.

## Fail-closed named-scope gaps

The current named OAuth table does not offer scopes for section-resource reads/writes/deletes, goal writes/deletes, portfolio deletion, time-entry writes/deletes, generic memberships, project memberships, project briefs, project statuses, or time periods. Hula refuses these before any provider call. It does not substitute similarly named scopes and does not request Full permissions.

Task relationships that happen to expose project, tag, follower, dependency, or section placement are authorised only where the official table assigns that exact endpoint to `tasks:write`. Reading tasks from a section is authorised by `tasks:read`; reading the section resource or listing project sections is not exposed.

Section placement therefore resolves section compact records only from task memberships returned by the task's own project-scoped task collection. It never calls the unscoped `GET /projects/{project_gid}/sections` endpoint. This safely supports populated sections discoverable through authorised task records. A completely empty section cannot currently be resolved by name with Hula's selected named scopes and is reported as unavailable/not found rather than guessed.

## Six implementation categories

1. Fully implemented with named scopes: OAuth/PKCE/token lifecycle; task, project, story/comment, attachment metadata, tag, custom-field, workspace, user and team reads; task lifecycle and validated task relationships; project create/update/delete; portfolio read/create/update; goal/time-entry reads.
2. Clarification/confirmation required: deletes, bulk changes, comments, assignment/follower effects, and ambiguous identities/dependencies.
3. Admin/organisation-policy dependent: SCIM, audit logs, exports, service accounts and workspace events.
4. Plan/tier restricted: portfolios, goals, advanced custom fields and time tracking/timesheets.
5. Unavailable through selected named OAuth scopes: section resources, goal mutation, portfolio deletion, time-entry mutation, generic memberships, briefs/statuses and time periods. Hula no longer requests `team_memberships:read` or `tags:write`, because those surfaces are not conversationally exposed.
6. Technically available but not conversationally useful: webhook lifecycle, raw batches, jobs, OOO entries, roles, approval-status administration and category administration; Hula does not request their scopes.
