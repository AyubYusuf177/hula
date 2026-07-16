import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getProvider } from "../src/integrations/catalog";
import { buildAsanaUrl, classifyAsanaStatus } from "../src/integrations/providers/asana/client";
import { ASANA_NAMED_OAUTH_SCOPES, buildAsanaAuthorizationUrl, capabilitiesFromAsanaScopes, createAsanaPkce, exchangeAsanaToken, parseAsanaScopes } from "../src/integrations/providers/asana/oauth";
import { asanaTaskInputSchema, ASANA_CONFIRMATION_POLICY, buildAsanaCollectionRequest, buildAsanaTaskListRequest, createAsanaResource, deleteAsanaResource, listAsanaChildren, listAsanaResources, listAsanaTasks, normalizeAsanaTask } from "../src/integrations/providers/asana/operations";

async function main() {
  const pkce = createAsanaPkce();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(pkce.verifier, pkce.challenge);
  const config = { clientId: "client", clientSecret: "secret", redirectUri: "https://hula.test/v1/integrations/asana/callback", scopes: ["tasks:read", "tasks:write"] };
  const auth = new URL(buildAsanaAuthorizationUrl({ config, state: "state", challenge: pkce.challenge }));
  assert.equal(auth.origin, "https://app.asana.com");
  assert.equal(auth.searchParams.get("scope"), "tasks:read tasks:write");
  let sentBody = "";
  const tokens = await exchangeAsanaToken({
    config, code: "code", verifier: pkce.verifier,
    fetchImpl: async (_url, init) => {
      sentBody = String(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "tasks:read tasks:write", data: { gid: "1", name: "Ada", email: "ada@example.test" } }) };
    },
  });
  assert.equal(tokens.account?.gid, "1");
  assert.match(sentBody, /code_verifier=/);
  assert.deepEqual(parseAsanaScopes("tasks:read, tasks:write tasks:read"), ["tasks:read", "tasks:write"]);
  assert.deepEqual(capabilitiesFromAsanaScopes(["tasks:read", "tasks:delete"]), ["work.read", "tasks.read", "tasks.delete"]);
  const officialFixture=new Set<string>(ASANA_NAMED_OAUTH_SCOPES);const requested=getProvider("asana")?.defaultScopes??[];assert.ok(requested.length>0);for(const scope of requested)assert.equal(officialFixture.has(scope),true,scope);
  assert.equal(requested.includes("team_memberships:read"),false);assert.equal(requested.includes("tags:write"),false);
  for(const removed of ["goals:write","goals:delete","memberships:read","memberships:write","portfolios:delete","project_briefs:read","project_briefs:write","project_memberships:read","project_memberships:write","project_sections:read","project_sections:write","project_sections:delete","project_statuses:read","project_statuses:write","time_periods:read","time_tracking_entries:write","time_tracking_entries:delete","user_task_lists:read","default"])assert.throws(()=>buildAsanaAuthorizationUrl({config:{...config,scopes:[removed]},state:"s",challenge:"c"}),/unsupported named scopes/);
  assert.deepEqual(capabilitiesFromAsanaScopes(["goals:read","goals:write","projects:read","stories:write"]),["projects.read","collaboration.write","goals.read"]);
  assert.equal(capabilitiesFromAsanaScopes(["portfolios:write"]).includes("portfolios.delete"),false);
  const url = buildAsanaUrl("/tasks", { assignee: "me", workspace: "123", offset: undefined, limit: 5 });
  assert.equal(url.searchParams.has("offset"), false);
  for (const [status, reason] of [[401,"auth_failed"],[402,"plan_restricted"],[403,"forbidden"],[404,"not_found"],[409,"conflict"],[429,"rate_limited"],[503,"provider_unavailable"]] as const) assert.equal(classifyAsanaStatus(status), reason);
  assert.equal(asanaTaskInputSchema.parse({ name: "Ship", due_on: "2026-07-16" }).due_at, undefined);
  const projects=buildAsanaCollectionRequest("projects",{workspace:"123"});assert.equal(projects.path,"/projects");assert.equal(projects.query.workspace,"123");assert.equal(projects.query.archived,"false");
  assert.equal(buildAsanaCollectionRequest("projects",{workspace:"123",archived:true}).query.archived,"true");
  const workspaces=buildAsanaCollectionRequest("workspaces");assert.equal(workspaces.path,"/workspaces");assert.equal(workspaces.query.workspace,undefined);assert.equal(workspaces.query.archived,undefined);
  const teams=buildAsanaCollectionRequest("teams",{workspace:"123"});assert.equal(teams.path,"/workspaces/123/teams");assert.equal(teams.query.workspace,undefined);
  const projectTasks=buildAsanaTaskListRequest({project:"456",assignee:"me",workspace:"123"});assert.equal(projectTasks.path,"/projects/456/tasks");assert.equal(projectTasks.query.assignee,undefined);assert.equal(projectTasks.query.workspace,undefined);
  assert.equal(normalizeAsanaTask({gid:"1",name:"",resource_type:"task"}),null);
  assert.equal(normalizeAsanaTask({gid:"2",name:"Heading",resource_type:"task",resource_subtype:"section"}),null);
  assert.equal(normalizeAsanaTask({gid:"3",name:"Project",resource_type:"project"}),null);
  assert.equal(normalizeAsanaTask({gid:"4",name:"  Real task  ",resource_type:"task"})?.name,"Real task");
  assert.throws(() => asanaTaskInputSchema.parse({ name: "Ship", unknown: true }));
  assert.equal(ASANA_CONFIRMATION_POLICY.task_delete, "always");
  assert.equal(ASANA_CONFIRMATION_POLICY.comment, "always");
  let unavailableCalls=0;const never=async()=>{unavailableCalls++;return{ok:true,status:200,text:async()=>'{"data":{}}'}};
  await assert.rejects(()=>createAsanaResource("u","goals",{name:"Nope"},{fetchImpl:never}),/do not authorise/);
  await assert.rejects(()=>deleteAsanaResource("u","portfolios","1",never),/do not authorise/);
  await assert.rejects(()=>listAsanaChildren("u","projects","1","sections",10,never),/do not authorise/);
  for(const kind of ["projects","teams","portfolios","goals","tags"] as const)await assert.rejects(()=>listAsanaResources("u",kind,{fetchImpl:never}),/Workspace|workspace/);
  await assert.rejects(()=>listAsanaTasks("u",{assignee:"me",fetchImpl:never}),/assignee with workspace/);
  assert.equal(unavailableCalls,0);
  const sourcePath=(relative:string)=>decodeURIComponent(new URL(relative,import.meta.url).pathname);
  const mobileConfig=readFileSync(sourcePath("../../data/integrations.ts"),"utf8"),asanaBlock=/id: ASANA_PROVIDER,[\s\S]*?disconnectLabel: 'Disconnect Asana'/.exec(mobileConfig)?.[0]??"";assert.match(asanaBlock,/iconImage: integrationIcons\.asana/);assert.match(asanaBlock,/connectLabel: 'Connect Asana'/);assert.match(asanaBlock,/authorizationProviderLabel: 'Asana'/);assert.doesNotMatch(asanaBlock,/Google|named least-privilege/);
  const mobileScreen=readFileSync(sourcePath("../../app/integrations/index.tsx"),"utf8");assert.match(mobileScreen,/\[ASANA_PROVIDER\]: \(token, appReturnUrl\) => connectAsana/);assert.match(mobileScreen,/\[ASANA_PROVIDER\]: disconnectAsana/);
  const mobileApi=readFileSync(sourcePath("../../lib/hulaApi.ts"),"utf8");assert.match(mobileApi,/\/v1\/me\/integrations\/\$\{ASANA_PROVIDER\}\/connect/);assert.match(mobileApi,/disconnectAsana=.*disconnectIntegration\(token,ASANA_PROVIDER\)/);
  console.log("asana tests passed");
}
void main();
