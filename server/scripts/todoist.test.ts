import assert from "node:assert/strict";

import { getProvider, isKnownProvider } from "../src/integrations/catalog";
import {
  TODOIST_CAPABILITY,
  TODOIST_SCOPE,
  buildTodoistAuthorizationUrl,
  capabilitiesFromScopes,
  isUsableTodoistGrant,
  parseTodoistScopes,
  parseTodoistTokenBody,
  type TodoistOAuthConfig,
} from "../src/integrations/providers/todoist/oauth";
import {
  MAX_PAGE_LIMIT,
  TodoistError,
  buildTodoistUrl,
  classifyTodoistFetchException,
  classifyTodoistHttpError,
  isReconnectReason,
  parseRetryAfter,
  parseTodoistPage,
} from "../src/integrations/providers/todoist/client";
import {
  boundLimit,
  buildTaskWriteBody,
  normalizeDue,
  normalizeLabel,
  normalizeProject,
  normalizeSection,
  normalizeTask,
} from "../src/integrations/providers/todoist/tasks";
import {
  apiPriorityToUi,
  clampApiPriority,
  priorityLabel,
  uiPriorityToApi,
} from "../src/integrations/providers/todoist/types";

/**
 * Todoist provider tests (Section 19) — OFFLINE.
 *
 * Every assertion runs with NO network, NO database, and NO real Todoist call.
 * The provider contract these pin (paths, field names, scope names, pagination
 * shape, the create/update asymmetry) was verified against Todoist's official
 * OpenAPI document rather than prose docs, which were demonstrably wrong about
 * two endpoint paths.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("todoist: catalog");

check("todoist is a known provider with capability-based metadata", () => {
  assert.equal(isKnownProvider("todoist"), true);
  const entry = getProvider("todoist");
  assert.ok(entry);
  assert.equal(entry.displayName, "Todoist");
  assert.equal(entry.category, "productivity");
  assert.equal(entry.authType, "oauth2");
  assert.deepEqual(entry.capabilities, ["tasks.read", "tasks.write", "tasks.delete"]);
});

check("catalog requests least privilege: no project:delete, no redundant data:read", () => {
  const entry = getProvider("todoist");
  assert.ok(entry);
  // project:delete would let Hula destroy whole projects — it never does.
  assert.equal(entry.defaultScopes.includes("project:delete"), false);
  // data:read is implied by data:read_write; requesting both only widens consent.
  assert.equal(entry.defaultScopes.includes("data:read"), false);
  assert.deepEqual(entry.defaultScopes, ["data:read_write", "data:delete"]);
});

console.log("todoist: oauth scopes + capabilities");

check("scope parsing accepts Todoist's commas and is liberal about whitespace", () => {
  assert.deepEqual(parseTodoistScopes("data:read_write,data:delete"), [
    "data:read_write",
    "data:delete",
  ]);
  assert.deepEqual(parseTodoistScopes("data:read_write data:delete"), [
    "data:read_write",
    "data:delete",
  ]);
  assert.deepEqual(parseTodoistScopes("  data:read_write , data:delete "), [
    "data:read_write",
    "data:delete",
  ]);
  assert.deepEqual(parseTodoistScopes(null), []);
  assert.deepEqual(parseTodoistScopes(""), []);
});

check("authorization URL uses app.todoist.com and COMMA-joined scopes", () => {
  const config: TodoistOAuthConfig = {
    clientId: "cid",
    clientSecret: "secret-never-sent-here",
    redirectUri: "https://api.hula.test/v1/integrations/todoist/callback",
    scopes: ["data:read_write", "data:delete"],
  };
  const url = new URL(buildTodoistAuthorizationUrl({ config, state: "st8" }));

  assert.equal(url.origin + url.pathname, "https://app.todoist.com/oauth/authorize");
  // The single most breakable detail: space-joining yields invalid_scope.
  assert.equal(url.searchParams.get("scope"), "data:read_write,data:delete");
  assert.equal(url.searchParams.get("state"), "st8");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  // The client secret must never appear in a URL the user's browser visits.
  assert.equal(url.toString().includes("secret-never-sent-here"), false);
});

check("capabilities derive from GRANTED scopes: read_write implies read", () => {
  assert.deepEqual(capabilitiesFromScopes([TODOIST_SCOPE.readWrite]).sort(), [
    "tasks.read",
    "tasks.write",
  ]);
});

check("partial consent: read_write WITHOUT delete stays a usable connection", () => {
  const caps = capabilitiesFromScopes([TODOIST_SCOPE.readWrite]);
  assert.equal(caps.includes(TODOIST_CAPABILITY.read), true);
  assert.equal(caps.includes(TODOIST_CAPABILITY.write), true);
  // The section is explicit: missing delete is NOT a disconnected integration.
  assert.equal(caps.includes(TODOIST_CAPABILITY.delete), false);
  assert.equal(isUsableTodoistGrant([TODOIST_SCOPE.readWrite]), true);
});

check("full grant yields all three capabilities", () => {
  const caps = capabilitiesFromScopes([TODOIST_SCOPE.readWrite, TODOIST_SCOPE.delete]).sort();
  assert.deepEqual(caps, ["tasks.delete", "tasks.read", "tasks.write"]);
});

check("read-only grant yields read only", () => {
  assert.deepEqual(capabilitiesFromScopes([TODOIST_SCOPE.read]), ["tasks.read"]);
  assert.equal(isUsableTodoistGrant([TODOIST_SCOPE.read]), true);
});

check("task:add grants write but NOT read (it cannot list anything)", () => {
  const caps = capabilitiesFromScopes([TODOIST_SCOPE.taskAdd]);
  assert.deepEqual(caps, ["tasks.write"]);
  assert.equal(caps.includes("tasks.read"), false);
});

check("an empty or irrelevant grant is not a usable connection", () => {
  assert.deepEqual(capabilitiesFromScopes([]), []);
  assert.equal(isUsableTodoistGrant([]), false);
  assert.equal(isUsableTodoistGrant(["backups:read"]), false);
});

console.log("todoist: token responses");

check("token body parses access token, rotation, expiry and scopes", () => {
  const parsed = parseTodoistTokenBody(
    JSON.stringify({
      access_token: "at-1",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt-1",
      scope: "data:read_write,data:delete",
    }),
  );
  assert.equal(parsed.accessToken, "at-1");
  assert.equal(parsed.refreshToken, "rt-1");
  assert.equal(parsed.expiresIn, 3600);
  assert.deepEqual(parsed.scopes, ["data:read_write", "data:delete"]);
});

check("legacy app: long-lived token with no refresh_token parses as valid", () => {
  // Todoist gives refresh-disabled apps a ~10-year expires_in and no refresh
  // token. That is a WORKING connection and must not look broken.
  const tenYears = 315_360_000;
  const parsed = parseTodoistTokenBody(
    JSON.stringify({ access_token: "at-legacy", expires_in: tenYears, scope: "data:read_write" }),
  );
  assert.equal(parsed.accessToken, "at-legacy");
  assert.equal(parsed.refreshToken, null);
  assert.equal(parsed.expiresIn, tenYears);
});

check("grace-window refresh reply (no new refresh_token) means UNCHANGED, not cleared", () => {
  // Reusing a consumed refresh token inside 60s returns 200 with the same access
  // token and NO refresh_token. Recording null must never wipe the stored one.
  const parsed = parseTodoistTokenBody(
    JSON.stringify({ access_token: "at-same", expires_in: 3600 }),
  );
  assert.equal(parsed.refreshToken, null, "null signals 'leave stored value alone'");
});

check("a token body without access_token is rejected and never echoed", () => {
  assert.throws(
    () => parseTodoistTokenBody(JSON.stringify({ error: "invalid_grant", client_secret: "sh" })),
    (err: Error) => err.message.includes("missing access_token") && !err.message.includes("sh"),
  );
  assert.throws(() => parseTodoistTokenBody("not json"), /not valid JSON/);
});

console.log("todoist: client error classification");

check("HTTP statuses map to precise, safe reasons", () => {
  assert.equal(classifyTodoistHttpError(401, ""), "auth_failed");
  assert.equal(classifyTodoistHttpError(403, "missing scope"), "insufficient_scope");
  assert.equal(classifyTodoistHttpError(404, ""), "task_not_found");
  assert.equal(classifyTodoistHttpError(400, ""), "invalid_request");
  assert.equal(classifyTodoistHttpError(422, ""), "invalid_request");
  assert.equal(classifyTodoistHttpError(429, ""), "provider_rate_limited");
  assert.equal(classifyTodoistHttpError(500, ""), "provider_unavailable");
  assert.equal(classifyTodoistHttpError(503, ""), "provider_unavailable");
});

check("401 and 403 are distinguished", () => {
  assert.notEqual(
    classifyTodoistHttpError(401, ""),
    classifyTodoistHttpError(403, "scope"),
  );
});

check("dead grants are reconnect-worthy; transient failures are not", () => {
  // Todoist's replay detection revokes every token — only reconnecting fixes it.
  assert.equal(isReconnectReason("invalid_grant"), true);
  assert.equal(isReconnectReason("no_refresh_token"), true);
  assert.equal(isReconnectReason("token_refresh_failed"), true);
  assert.equal(isReconnectReason("provider_rate_limited"), false);
  assert.equal(isReconnectReason("provider_unavailable"), false);
  assert.equal(isReconnectReason("todoist_timeout"), false);
});

check("transport exceptions map to precise reasons", () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(classifyTodoistFetchException(abort), "todoist_timeout");

  const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  assert.equal(classifyTodoistFetchException(dns), "dns_failure");

  const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  assert.equal(classifyTodoistFetchException(reset), "connection_reset");

  assert.equal(classifyTodoistFetchException(new Error("odd")), "network_failure");
});

check("retry-after is bounded and defensive", () => {
  assert.equal(parseRetryAfter("30"), 30);
  assert.equal(parseRetryAfter("99999"), 300, "clamped");
  assert.equal(parseRetryAfter("-1"), null);
  assert.equal(parseRetryAfter("soon"), null);
  assert.equal(parseRetryAfter(null), null);
});

console.log("todoist: url building");

check("URLs are built safely and drop null/undefined query values", () => {
  const url = buildTodoistUrl("/tasks", { project_id: "p1", section_id: undefined, label: null });
  assert.equal(url.origin + url.pathname, "https://api.todoist.com/api/v1/tasks");
  assert.equal(url.searchParams.get("project_id"), "p1");
  // The bug this prevents: `undefined` stringifying into a literal "undefined".
  assert.equal(url.searchParams.has("section_id"), false);
  assert.equal(url.searchParams.has("label"), false);
});

check("a non-https or malformed URL is refused", () => {
  assert.throws(
    () => buildTodoistUrl("/tasks", {}, "http://api.todoist.com/api/v1"),
    (err: TodoistError) => err.reason === "malformed_request_url",
  );
  assert.throws(
    () => buildTodoistUrl("/tasks", {}, "not-a-url"),
    (err: TodoistError) => err.reason === "malformed_request_url",
  );
});

console.log("todoist: pagination");

check("a valid page parses results + next_cursor", () => {
  const page = parseTodoistPage<{ id: string }>({
    results: [{ id: "1" }, { id: "2" }],
    next_cursor: "abc",
  });
  assert.equal(page.results.length, 2);
  assert.equal(page.nextCursor, "abc");
});

check("a final page reports an exhausted cursor", () => {
  assert.equal(parseTodoistPage({ results: [], next_cursor: null }).nextCursor, null);
  assert.equal(parseTodoistPage({ results: [] }).nextCursor, null);
});

check("a malformed page is an error, NOT an empty task list", () => {
  // Reporting "you have no tasks" from a broken payload is an undetectable lie.
  assert.throws(
    () => parseTodoistPage({ tasks: [] }),
    (err: TodoistError) => err.reason === "malformed_provider_response",
  );
  assert.throws(
    () => parseTodoistPage(null),
    (err: TodoistError) => err.reason === "malformed_provider_response",
  );
});

check("page limit matches Todoist's documented maximum", () => {
  assert.equal(MAX_PAGE_LIMIT, 200);
});

console.log("todoist: priority mapping");

check("API priority is inverted relative to the UI and round-trips", () => {
  // API 4 = UI p1 = urgent. Getting this backwards silently downgrades urgency.
  assert.equal(apiPriorityToUi(4), 1);
  assert.equal(apiPriorityToUi(1), 4);
  assert.equal(uiPriorityToApi(1), 4);
  assert.equal(uiPriorityToApi(4), 1);
  for (const api of [1, 2, 3, 4]) {
    assert.equal(uiPriorityToApi(apiPriorityToUi(api)), api, `round-trip p${api}`);
  }
});

check("priority values are clamped rather than trusted", () => {
  assert.equal(clampApiPriority(0), 1);
  assert.equal(clampApiPriority(9), 4);
  assert.equal(clampApiPriority("high"), 1);
  assert.equal(clampApiPriority(undefined), 1);
});

check("priority labels read the way Todoist labels them", () => {
  assert.equal(priorityLabel(4), "Urgent");
  assert.equal(priorityLabel(3), "High");
  assert.equal(priorityLabel(2), "Medium");
  assert.equal(priorityLabel(1), "Normal");
});

console.log("todoist: normalization");

/** A realistic ItemSyncView, using the field names in the official OpenAPI doc. */
const RAW_TASK = {
  id: "6X4Vw2Hfmg73Q2XR",
  content: "Finish the pitch deck",
  description: "For Friday's review",
  project_id: "220474322",
  section_id: "7025",
  parent_id: null,
  labels: ["work", "urgent"],
  priority: 4,
  due: { date: "2026-07-17", datetime: null, timezone: null, is_recurring: false, string: "Fri 17 Jul" },
  deadline: { date: "2026-07-18" },
  checked: false,
  is_deleted: false,
  responsible_uid: "u-9",
  added_at: "2026-07-14T10:00:00.000000Z",
  completed_at: null,
};

check("a task normalizes with Todoist's real v1 field names", () => {
  const task = normalizeTask(RAW_TASK);
  assert.ok(task);
  assert.equal(task.id, "6X4Vw2Hfmg73Q2XR");
  assert.equal(task.content, "Finish the pitch deck");
  assert.equal(task.description, "For Friday's review");
  assert.equal(task.projectId, "220474322");
  assert.equal(task.sectionId, "7025");
  assert.deepEqual(task.labels, ["work", "urgent"]);
  assert.equal(task.priority, 4);
  assert.equal(task.completed, false);
  assert.equal(task.source, "todoist");
});

check("v1 uses `checked`, `added_at` and `responsible_uid` — not the legacy names", () => {
  const task = normalizeTask(RAW_TASK);
  assert.ok(task);
  assert.equal(task.createdAt, "2026-07-14T10:00:00.000000Z", "added_at");
  assert.equal(task.assigneeId, "u-9", "responsible_uid");
  // `deadline` is an OBJECT on v1, distinct from `due`.
  assert.equal(task.deadline, "2026-07-18");
});

check("completion is read from either `checked` or a legacy `is_completed`", () => {
  assert.equal(normalizeTask({ ...RAW_TASK, checked: true })?.completed, true);
  assert.equal(normalizeTask({ id: "x", is_completed: true })?.completed, true);
  assert.equal(normalizeTask({ id: "x" })?.completed, false);
});

check("a task with no usable id is dropped, never guessed", () => {
  // An unidentifiable task would create a numbered follow-up that silently fails.
  assert.equal(normalizeTask({ content: "no id" }), null);
  assert.equal(normalizeTask(null), null);
  assert.equal(normalizeTask("nope"), null);
});

check("numeric ids coerce to strings so ids never compare wrongly", () => {
  const task = normalizeTask({ id: 12345, project_id: 678 });
  assert.equal(task?.id, "12345");
  assert.equal(task?.projectId, "678");
});

check("due dates normalize, distinguishing all-day from timed", () => {
  assert.equal(normalizeDue({ date: "2026-07-17" })?.datetime, null);
  const timed = normalizeDue({ date: "2026-07-17", datetime: "2026-07-17T17:00:00Z" });
  assert.equal(timed?.datetime, "2026-07-17T17:00:00Z");
  const recurring = normalizeDue({ date: "2026-07-17", is_recurring: true, string: "every Friday" });
  assert.equal(recurring?.isRecurring, true);
  assert.equal(recurring?.string, "every Friday");
});

check("an absent or contentless due object is null, not a fake date", () => {
  assert.equal(normalizeDue(null), null);
  assert.equal(normalizeDue({}), null);
  assert.equal(normalizeTask({ id: "x" })?.due, null);
});

check("projects, sections and labels normalize", () => {
  assert.deepEqual(normalizeProject({ id: "1", name: "Hula", is_inbox_project: false }), {
    id: "1",
    name: "Hula",
    isInboxProject: false,
    parentId: null,
  });
  assert.equal(normalizeProject({ id: "2", is_inbox_project: true })?.isInboxProject, true);
  assert.deepEqual(normalizeSection({ id: "s1", project_id: "p1", name: "Later" }), {
    id: "s1",
    projectId: "p1",
    name: "Later",
  });
  // A section with no project cannot be targeted.
  assert.equal(normalizeSection({ id: "s1", name: "Later" }), null);
  assert.deepEqual(normalizeLabel({ id: "l1", name: "work" }), { id: "l1", name: "work" });
});

console.log("todoist: write bodies");

check("a create body uses Todoist's documented field names", () => {
  const body = buildTaskWriteBody(
    {
      content: "Call Rob",
      description: "about the deck",
      projectId: "p1",
      sectionId: "s1",
      labels: ["work"],
      priority: 4,
      dueDate: "2026-07-15",
    },
    "create",
  );
  assert.deepEqual(body, {
    content: "Call Rob",
    description: "about the deck",
    project_id: "p1",
    section_id: "s1",
    labels: ["work"],
    priority: 4,
    due_date: "2026-07-15",
  });
});

check("UPDATE omits project_id/section_id — Todoist's update schema has no such fields", () => {
  // This is the asymmetry that would otherwise produce a false success: update
  // answers 200 while ignoring the field, and Hula would claim it moved the task.
  const body = buildTaskWriteBody({ content: "New title", projectId: "p2", sectionId: "s2" }, "update");
  assert.deepEqual(body, { content: "New title" });
  assert.equal("project_id" in body, false);
  assert.equal("section_id" in body, false);
});

check("due fields are mutually exclusive, in a fixed precedence", () => {
  const both = buildTaskWriteBody({ dueDate: "2026-07-15", dueDatetime: "2026-07-15T17:00:00Z" });
  assert.equal(both.due_datetime, "2026-07-15T17:00:00Z");
  assert.equal("due_date" in both, false);

  const recurring = buildTaskWriteBody({ dueString: "every Monday" });
  assert.deepEqual(recurring, { due_string: "every Monday" });
});

check("removing a due date sends Todoist's explicit 'no date', not an omission", () => {
  // Omitting the field leaves the due date UNCHANGED — the opposite of the ask.
  const body = buildTaskWriteBody({ removeDue: true, dueDate: "2026-07-15" });
  assert.deepEqual(body, { due_string: "no date" });
});

check("priority in a write body is clamped to the valid API range", () => {
  assert.equal(buildTaskWriteBody({ priority: 99 }).priority, 4);
  assert.equal(buildTaskWriteBody({ priority: 0 }).priority, 1);
});

check("an empty field set produces an empty body (callers refuse it)", () => {
  assert.deepEqual(buildTaskWriteBody({}), {});
});

console.log("todoist: read bounds");

check("result counts are bounded, and an explicit count is respected", () => {
  assert.equal(boundLimit(5), 5, "an explicit 'show me 5' is honoured exactly");
  assert.equal(boundLimit(undefined), 5, "sensible default for an open-ended ask");
  assert.equal(boundLimit(1000), 50, "clamped to the hard cap");
  assert.equal(boundLimit(0), 1);
  assert.equal(boundLimit(-3), 1);
  assert.equal(boundLimit(Number.NaN), 5);
});

console.log(`\ntodoist: ${passed} assertions passed`);
