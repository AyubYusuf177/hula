import assert from "node:assert/strict";

import { executeAction } from "../src/actions/executor";
import { handleAsanaWrite } from "../src/integrations/providers/asana/asanaActions";
import { AsanaError, type AsanaErrorReason } from "../src/integrations/providers/asana/client";
import { isAsanaSelfReference, resolveAsanaPerson } from "../src/integrations/providers/asana/asanaIdentity";
import { buildCurrentAsanaUserRequest } from "../src/integrations/providers/asana/operations";
import type { AsanaResource } from "../src/integrations/providers/asana/types";

const project={gid:"10",name:"Hula test",resource_type:"project"};
const section={gid:"20",name:"Execution",resource_type:"section"};
const self={gid:"7",name:"Ayub Yusuf",email:"ayub@example.test",resource_type:"user"};
const taskName="Hula Asana Write Test";
const task:AsanaResource={gid:"100",name:taskName,resource_type:"task",completed:false,due_at:"2026-07-17T16:00:00.000Z",notes:"Created safely through Hula",assignee:{gid:"8",name:"Ada"},followers:[{gid:"9",name:"Grace"}],custom_fields:[{gid:"11",name:"Priority",display_value:"High"}],memberships:[{project,section}],projects:[project]};
const people:AsanaResource[]=[self,{gid:"8",name:"Ada Lovelace",email:"ada@example.test",resource_type:"user"},{gid:"9",name:"Sam",email:"sam.one@example.test",resource_type:"user"},{gid:"12",name:"Sam",email:"sam.two@example.test",resource_type:"user"}];
const identity=(current:()=>Promise<AsanaResource>=async()=>self)=>async(u:string,w:string,q:string)=>resolveAsanaPerson(u,w,q,{getCurrent:current,list:async()=>people});
const proposalInput=async(person:string,targetPhrase:string|null=taskName)=>{let proposal:any=null;const result=await handleAsanaWrite("u",`Assign ${targetPhrase??"it"} to ${person}`,{arbitrated:true,getTimezone:async()=>"Europe/London",extract:async()=>({provider:"asana",mode:"assign",entity:"task",targetPhrase,person}),resolveReference:async()=>({item:{id:"100",type:"task",title:taskName,completed:false,project:"Hula test",section:"Execution",due:null,permalink:null},ambiguous:false}),listResources:async(_u,kind)=>kind==="workspaces"?[{gid:"1",name:"Acme",resource_type:"workspace"}]:[],listTasks:async()=>[task],searchWorkspace:async()=>[task],getResource:async()=>task,resolvePerson:identity(),propose:async(_u,input)=>{proposal=input;return{id:"p"} as any;}});return{result,proposal};};
const policy=async()=>({connectedProviders:["asana"],grantedScopesByProvider:{asana:["tasks:read","tasks:write","users:read"]},capabilitiesByProvider:{asana:["tasks.read","tasks.write","users.read"]},userConfirmed:true});

async function main(){
  assert.deepEqual(buildCurrentAsanaUserRequest(),{path:"/users/me",query:{opt_fields:"gid,name,email,resource_type"}});
  for(const value of ["me","myself","self","current_user","current user","assign to me","assign it to me","assign this task to me","make me the assignee"])assert.equal(isAsanaSelfReference(value),true,value);
  for(const value of ["me","myself","self","current_user"]){const {proposal}=await proposalInput(value);assert.equal(proposal.input.fields.assignee,"7",value);}
  assert.equal((await proposalInput("me")).result.reply?.includes("Yes to confirm"),true);
  assert.equal((await proposalInput("me",null)).proposal.input.taskIds[0],"100");
  assert.equal((await proposalInput("myself",null)).proposal.input.fields.assignee,"7");
  let unassignProposal:any=null;const unassign=await handleAsanaWrite("u","Unassign this task",{arbitrated:true,getTimezone:async()=>"UTC",extract:async()=>({provider:"asana",mode:"unassign",entity:"task",targetPhrase:"this task"}),resolveReference:async()=>({item:{id:"100",type:"task",title:taskName,completed:false,project:"Hula test",section:"Execution",due:null,permalink:null},ambiguous:false}),getResource:async()=>task,propose:async(_u,input)=>{unassignProposal=input;return{id:"unassign"} as any;}});assert.deepEqual(unassignProposal.input.fields,{assignee:null});assert.match(unassign.reply??"",/Reply Yes/);
  let multiWorkspaceProposal:any=null;await handleAsanaWrite("u","Assign it to me",{arbitrated:true,getTimezone:async()=>"UTC",extract:async()=>({provider:"asana",mode:"assign",entity:"task",person:"me"}),resolveReference:async()=>({item:{id:"100",type:"task",title:taskName,completed:false,project:"Hula test",section:"Execution",due:null,permalink:null},ambiguous:false}),getResource:async()=>task,listResources:async()=>[{gid:"1",name:"Acme",resource_type:"workspace"},{gid:"2",name:"Other",resource_type:"workspace"}],resolvePerson:identity(),propose:async(_u,input)=>{multiWorkspaceProposal=input;return{id:"multi"} as any;}});assert.equal(multiWorkspaceProposal.input.fields.assignee,"7");

  const byName=await resolveAsanaPerson("u","1","Ada Lovelace",{getCurrent:async()=>self,list:async()=>people});assert.equal(byName.kind,"resolved");if(byName.kind==="resolved")assert.equal(byName.user.gid,"8");
  const byEmail=await resolveAsanaPerson("u","1","ada@example.test",{getCurrent:async()=>self,list:async()=>people});assert.equal(byEmail.kind,"resolved");if(byEmail.kind==="resolved")assert.equal(byEmail.user.gid,"8");
  assert.equal((await resolveAsanaPerson("u","1","Ayub Yusuf",{getCurrent:async()=>self,list:async()=>{throw new Error("self must resolve first")}})).kind,"resolved");
  assert.equal((await resolveAsanaPerson("u","1","ayub@example.test",{getCurrent:async()=>self,list:async()=>{throw new Error("self must resolve first")}})).kind,"resolved");
  assert.equal((await resolveAsanaPerson("u","1","Sam",{getCurrent:async()=>self,list:async()=>people})).kind,"ambiguous");
  assert.equal((await resolveAsanaPerson("u","1","Unknown",{getCurrent:async()=>self,list:async()=>people})).kind,"not_found");

  let writes=0;const unavailable=await handleAsanaWrite("u","Assign Hula Asana Write Test to me",{arbitrated:true,getTimezone:async()=>"UTC",extract:async()=>({provider:"asana",mode:"assign",entity:"task",targetPhrase:"Hula Asana Write Test",person:"me"}),listResources:async(_u,kind)=>kind==="workspaces"?[{gid:"1",name:"Acme",resource_type:"workspace"}]:[],listTasks:async()=>[task],searchWorkspace:async()=>[task],getResource:async()=>task,resolvePerson:identity(async()=>{throw new AsanaError("provider_unavailable",503)}),propose:async()=>{writes++;throw new Error("must not propose")}});assert.match(unavailable.reply??"",/couldn’t verify your authenticated Asana identity/);assert.equal(writes,0);
  for(const [person,pattern] of [["Sam",/multiple people/],["Unknown",/couldn’t find/]] as const){const result=await handleAsanaWrite("u",`Assign it to ${person}`,{arbitrated:true,getTimezone:async()=>"UTC",extract:async()=>({provider:"asana",mode:"assign",entity:"task",person}),resolveReference:async()=>({item:{id:"100",type:"task",title:taskName,completed:false,project:null,section:null,due:null,permalink:null},ambiguous:false}),getResource:async()=>task,listResources:async(_u,kind)=>kind==="workspaces"?[{gid:"1",name:"Acme",resource_type:"workspace"}]:[],resolvePerson:identity(),propose:async()=>{writes++;throw new Error("must not propose")}});assert.match(result.reply??"",pattern);assert.equal(writes,0);}

  let updatePayload:unknown=null,remembered=0;const assigned:AsanaResource={...task,assignee:self};const run=async(overrides:Record<string,unknown>={})=>executeAction("u","asana.task.update",{input:{taskIds:["100"],titles:[taskName],fields:{assignee:"7"}},userConfirmed:true},{buildContext:policy,record:async()=>"execution",updateAsanaTask:async(_u:string,id:string,input:unknown)=>{updatePayload=input;return{gid:id,resourceType:"task",name:taskName,permalinkUrl:null,completed:false}},getAsanaResource:async()=>assigned,recordAsanaEntity:async()=>{remembered++;return{id:"context"}},...overrides} as any);
  const success=await run();assert.equal(success.ok,true);assert.deepEqual(updatePayload,{assignee:"7"});assert.equal(remembered,1);assert.equal(success.receipt?.asanaResourceIds?.[0],"100");assert.deepEqual({projects:assigned.projects,memberships:assigned.memberships,due_at:assigned.due_at,notes:assigned.notes,followers:assigned.followers,custom_fields:assigned.custom_fields},{projects:task.projects,memberships:task.memberships,due_at:task.due_at,notes:task.notes,followers:task.followers,custom_fields:task.custom_fields});
  for(const [reason,status] of [["invalid_request",400],["auth_failed",401],["forbidden",403],["not_found",404],["rate_limited",429],["provider_unavailable",503]] as [AsanaErrorReason,number][]){const result=await run({updateAsanaTask:async()=>{throw new AsanaError(reason,status)},recordAsanaEntity:async()=>{throw new Error("must not remember")}});assert.equal(result.ok,false,reason);assert.equal(result.receipt,undefined,reason);}
  const malformed=await run({updateAsanaTask:async()=>({gid:"999",resourceType:"task",name:null,permalinkUrl:null,completed:null}),recordAsanaEntity:async()=>{throw new Error("must not remember")}});assert.equal(malformed.ok,false);assert.match(malformed.userMessage,/invalid assignment receipt/);
  const mismatch=await run({getAsanaResource:async()=>({...task,assignee:{gid:"8",name:"Ada"}}),recordAsanaEntity:async()=>{throw new Error("must not remember")}});assert.equal(mismatch.ok,false);assert.match(mismatch.userMessage,/couldn’t verify the assignee/);

  console.log("asana self-assignment tests passed");
}
void main();
