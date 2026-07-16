import { z } from "zod";
import { AsanaError, asanaPage, asanaRequest } from "./client";
import type { AsanaFetch } from "./oauth";
import type { AsanaResource } from "./types";

const gid=z.string().regex(/^\d+$/);
const count=z.number().int().min(1).max(500).default(50);
export class AsanaNamedScopeUnavailableError extends Error { constructor(operation:string){super(`Asana named OAuth scopes do not authorise ${operation}`);this.name="AsanaNamedScopeUnavailableError";} }
export const asanaSearchSchema=z.object({workspace:gid,resourceType:z.enum(["task","project","portfolio","goal","tag","team","user"]).optional(),query:z.string().trim().min(1).max(200).optional(),count:count.optional()});
export const asanaTaskInputSchema=z.object({name:z.string().trim().min(1).max(500),workspace:gid.optional(),projects:z.array(gid).max(20).optional(),parent:gid.optional(),assignee:z.union([gid,z.literal("me"),z.null()]).optional(),notes:z.string().max(100_000).optional(),due_on:z.string().date().nullable().optional(),due_at:z.string().datetime({offset:true}).nullable().optional(),start_on:z.string().date().nullable().optional(),start_at:z.string().datetime({offset:true}).nullable().optional(),completed:z.boolean().optional(),followers:z.array(gid).max(50).optional(),custom_fields:z.record(z.union([z.string(),z.number(),z.boolean(),z.null()])).optional()}).strict();

export interface AsanaReceipt {gid:string;resourceType:string;name:string|null;permalinkUrl:string|null;completed:boolean|null}
function receipt(value:unknown):AsanaReceipt{if(!value||typeof value!=="object")throw new Error("Malformed Asana receipt");const v=value as Record<string,unknown>;if(typeof v.gid!=="string"||!v.gid)throw new Error("Malformed Asana receipt");return {gid:v.gid,resourceType:typeof v.resource_type==="string"?v.resource_type:"resource",name:typeof v.name==="string"?v.name:null,permalinkUrl:typeof v.permalink_url==="string"&&v.permalink_url.startsWith("https://app.asana.com/")?v.permalink_url:null,completed:typeof v.completed==="boolean"?v.completed:null};}

type AsanaCollectionKind="workspaces"|"teams"|"projects"|"portfolios"|"goals"|"tags"|"users"|"custom_fields";
type AsanaCollectionParams={workspace?:string;team?:string;archived?:boolean;count?:number;fetchImpl?:AsanaFetch};
export function buildAsanaCollectionRequest(kind:AsanaCollectionKind,params:AsanaCollectionParams={}):{path:string;query:Record<string,string|number|undefined>}{
  if(["teams","portfolios","goals","tags","custom_fields"].includes(kind)&&!params.workspace)throw new Error(`Workspace is required to list Asana ${kind}`);
  if(kind==="projects"&&!params.workspace&&!params.team)throw new Error("Workspace or team is required to list Asana projects");
  const paths={workspaces:"/workspaces",teams:`/workspaces/${gid.parse(params.workspace??"0")}/teams`,projects:"/projects",portfolios:"/portfolios",goals:"/goals",tags:"/tags",users:"/users",custom_fields:`/workspaces/${gid.parse(params.workspace??"0")}/custom_fields`};
  const query:Record<string,string|number|undefined>={
    workspace:["projects","portfolios","goals","tags","users"].includes(kind)?params.workspace:undefined,
    team:["projects","users"].includes(kind)?params.team:undefined,
    archived:kind==="projects"?String(params.archived??false):undefined,
    opt_fields:kind==="projects"?"gid,name,resource_type,permalink_url,archived,owner.name":kind==="users"?"gid,name,email,resource_type":kind==="custom_fields"?"gid,name,resource_type,resource_subtype,enum_options.gid,enum_options.name,enum_options.enabled":"gid,name,resource_type",
  };
  return{path:paths[kind],query};
}
export async function listAsanaResources(userId:string,kind:AsanaCollectionKind,params:AsanaCollectionParams={}):Promise<AsanaResource[]>{
  const request=buildAsanaCollectionRequest(kind,params);return (await asanaPage<AsanaResource>(userId,request.path,{query:request.query,count:params.count,fetchImpl:params.fetchImpl})).data;
}

type AsanaTaskListParams={assignee?:string;workspace?:string;project?:string;section?:string;completedSince?:string;modifiedSince?:string;count?:number;fetchImpl?:AsanaFetch};
export function normalizeAsanaTask(value:unknown):AsanaResource|null{
  if(!value||typeof value!=="object")return null;const task=value as Record<string,unknown>;
  if(typeof task.gid!=="string"||!/^\d+$/.test(task.gid))return null;
  if(task.resource_type!=="task"||task.resource_subtype==="section")return null;
  if(typeof task.name!=="string"||!task.name.trim())return null;
  return{...task,gid:task.gid,name:task.name.trim()} as AsanaResource;
}
export function buildAsanaTaskListRequest(params:AsanaTaskListParams={}):{path:string;query:Record<string,string|undefined>}{
  if(!params.project&&!params.section&&(!params.assignee||!params.workspace))throw new Error("Asana task listing requires project, section, or assignee with workspace");
  const path=params.project?`/projects/${gid.parse(params.project)}/tasks`:params.section?`/sections/${gid.parse(params.section)}/tasks`:"/tasks";
  const parentScoped=Boolean(params.project||params.section);return{path,query:{assignee:parentScoped?undefined:params.assignee,workspace:parentScoped?undefined:params.workspace,completed_since:params.completedSince,modified_since:params.modifiedSince,opt_fields:"gid,name,resource_type,resource_subtype,completed,completed_at,assignee.name,created_by.name,due_on,due_at,start_on,start_at,projects.gid,projects.name,memberships.project.gid,memberships.project.name,memberships.section.gid,memberships.section.name,parent.name,num_subtasks,dependencies.name,dependents.name,followers.name,tags.name,custom_fields.name,custom_fields.display_value,custom_fields.resource_subtype,custom_fields.enum_options.gid,custom_fields.enum_options.name,custom_fields.enum_options.enabled,notes,permalink_url,modified_at,created_at"}};
}
export async function listAsanaTasks(userId:string,params:AsanaTaskListParams={}):Promise<AsanaResource[]>{
  const request=buildAsanaTaskListRequest(params);return (await asanaPage<AsanaResource>(userId,request.path,{count:params.count,fetchImpl:params.fetchImpl,query:request.query,normalize:normalizeAsanaTask})).data;
}

export async function searchAsanaTasksInWorkspace(userId:string,workspaceGid:string,title:string,countValue=100,fetchImpl?:AsanaFetch):Promise<AsanaResource[]>{const query=title.trim();if(!query)throw new Error("Task title is required");return(await asanaPage<AsanaResource>(userId,`/workspaces/${gid.parse(workspaceGid)}/tasks/search`,{count:Math.min(countValue,100),fetchImpl,query:{text:query,resource_subtype:"default_task",opt_fields:buildAsanaTaskListRequest({project:"1"}).query.opt_fields},normalize:normalizeAsanaTask})).data;}

export async function getAsanaResource(userId:string,kind:"tasks"|"projects"|"sections"|"portfolios"|"goals"|"teams"|"users"|"workspaces"|"tags"|"custom_fields"|"attachments"|"stories"|"time_tracking_entries",resourceGid:string,fetchImpl?:AsanaFetch):Promise<AsanaResource>{if(kind==="sections")throw new AsanaNamedScopeUnavailableError("section reads");return asanaRequest<AsanaResource>(userId,"GET",`/${kind}/${gid.parse(resourceGid)}`,{query:{opt_fields:"gid,name,resource_type,resource_subtype,completed,assignee.gid,assignee.name,created_by.name,followers.gid,followers.name,due_on,due_at,start_on,start_at,projects.gid,projects.name,memberships.project.gid,memberships.project.name,memberships.section.gid,memberships.section.name,parent.name,notes,custom_fields.gid,custom_fields.name,custom_fields.display_value,custom_fields.resource_subtype,tags.gid,tags.name,dependencies.gid,dependencies.name,dependents.gid,dependents.name,num_subtasks,permalink_url,archived,html_notes,current_status.title,current_status.text,metric.current_number_value,metric.target_number_value"},fetchImpl});}

/** Asana documents `me` as the current authenticated user wherever a user GID is accepted. */
export function buildCurrentAsanaUserRequest(){return{path:"/users/me",query:{opt_fields:"gid,name,email,resource_type"}} as const;}
export async function getCurrentAsanaUser(userId:string,fetchImpl?:AsanaFetch):Promise<AsanaResource>{
  const request=buildCurrentAsanaUserRequest();const user=await asanaRequest<AsanaResource>(userId,"GET",request.path,{query:request.query,fetchImpl});
  if(!user||typeof user.gid!=="string"||!/^\d+$/.test(user.gid)||typeof user.name!=="string"||!user.name.trim())throw new AsanaError("malformed_response",200);
  return user;
}

export async function listAsanaChildren(userId:string,parent:"tasks"|"projects"|"portfolios"|"goals",parentGid:string,child:"subtasks"|"dependencies"|"dependents"|"stories"|"attachments"|"time_tracking_entries"|"sections"|"memberships"|"items",countValue=50,fetchImpl?:AsanaFetch):Promise<AsanaResource[]>{if(child==="sections"||child==="memberships")throw new AsanaNamedScopeUnavailableError(`${child} reads`);return(await asanaPage<AsanaResource>(userId,`/${parent}/${gid.parse(parentGid)}/${child}`,{count:countValue,fetchImpl,query:{opt_fields:"gid,name,resource_type,resource_subtype,completed,assignee.name,due_on,due_at,created_by.name,text,type,download_url,host,permanent_url,duration_minutes,entered_on,description,project.name,section.name,user.name,access_level"}})).data;}

export async function createAsanaResource(userId:string,kind:"projects"|"sections"|"portfolios"|"goals"|"time_tracking_entries",data:Record<string,unknown>,options:{parentPath?:string;fetchImpl?:AsanaFetch}={}):Promise<AsanaReceipt>{if(kind!=="projects"&&kind!=="portfolios")throw new AsanaNamedScopeUnavailableError(`${kind} creation`);const path=options.parentPath?`${options.parentPath}/${kind}`:`/${kind}`;return receipt(await asanaRequest(userId,"POST",path,{data,fetchImpl:options.fetchImpl}));}
export async function updateAsanaResource(userId:string,kind:"projects"|"sections"|"portfolios"|"goals"|"time_tracking_entries",resourceGid:string,data:Record<string,unknown>,fetchImpl?:AsanaFetch):Promise<AsanaReceipt>{if(kind!=="projects"&&kind!=="portfolios")throw new AsanaNamedScopeUnavailableError(`${kind} updates`);if(!Object.keys(data).length)throw new Error("No changes supplied");return receipt(await asanaRequest(userId,"PUT",`/${kind}/${gid.parse(resourceGid)}`,{data,fetchImpl}));}

export async function createAsanaTask(userId:string,input:unknown,fetchImpl?:AsanaFetch):Promise<AsanaReceipt>{const data=asanaTaskInputSchema.parse(input);return receipt(await asanaRequest(userId,"POST","/tasks",{data,fetchImpl}));}
export async function updateAsanaTask(userId:string,taskGid:string,input:unknown,fetchImpl?:AsanaFetch):Promise<AsanaReceipt>{const data=asanaTaskInputSchema.partial().parse(input);if(!Object.keys(data).length)throw new Error("No task changes supplied");return receipt(await asanaRequest(userId,"PUT",`/tasks/${gid.parse(taskGid)}`,{data,fetchImpl}));}
export interface AsanaRelationshipReceipt{taskGid:string;operation:string;sectionGid:string|null;accepted:true}
export function buildAsanaSectionMoveRequest(taskGid:unknown,sectionGid:unknown):{path:string;data:{task:string}}{const task=gid.parse(taskGid),section=gid.parse(sectionGid);return{path:`/sections/${section}/addTask`,data:{task}};}
export async function mutateAsanaRelationship(userId:string,taskGid:string,action:"addProject"|"removeProject"|"addFollowers"|"removeFollowers"|"addDependencies"|"removeDependencies"|"addTag"|"removeTag"|"attachUrl"|"moveToSection",input:Record<string,unknown>,fetchImpl?:AsanaFetch):Promise<AsanaReceipt|AsanaRelationshipReceipt>{if(action==="attachUrl"){const value=typeof input.url==="string"?input.url:"";return attachAsanaUrl(userId,taskGid,value,typeof input.name==="string"?input.name:undefined,fetchImpl);}if(action==="moveToSection"){const request=buildAsanaSectionMoveRequest(taskGid,input.section);const data=await asanaRequest<Record<string,unknown>>(userId,"POST",request.path,{data:request.data,fetchImpl});if(!data||typeof data!=="object"||Array.isArray(data))throw new AsanaError("malformed_response",200);return{taskGid:request.data.task,operation:action,sectionGid:request.path.split("/")[2]??null,accepted:true};}const endpoint={addProject:"addProject",removeProject:"removeProject",addFollowers:"addFollowers",removeFollowers:"removeFollowers",addDependencies:"addDependencies",removeDependencies:"removeDependencies",addTag:"addTag",removeTag:"removeTag"} as const;const value=receipt(await asanaRequest(userId,"POST",`/tasks/${gid.parse(taskGid)}/${endpoint[action]}`,{data:input,fetchImpl}));return value;}
export async function mutateAsanaPortfolioItem(userId:string,portfolioGid:string,action:"addItem"|"removeItem",itemGid:string,fetchImpl?:AsanaFetch):Promise<{portfolioGid:string;itemGid:string;operation:string;accepted:true}>{const portfolio=gid.parse(portfolioGid),item=gid.parse(itemGid),data=await asanaRequest<Record<string,unknown>>(userId,"POST",`/portfolios/${portfolio}/${action}`,{data:{item},fetchImpl});if(!data||typeof data!=="object"||Array.isArray(data))throw new AsanaError("malformed_response",200);return{portfolioGid:portfolio,itemGid:item,operation:action,accepted:true};}
export async function attachAsanaUrl(userId:string,taskGid:string,url:string,name?:string,fetchImpl?:AsanaFetch):Promise<AsanaReceipt>{const parsed=new URL(url);if(parsed.protocol!=="https:")throw new Error("Only HTTPS attachment URLs are allowed");return receipt(await asanaRequest(userId,"POST",`/tasks/${gid.parse(taskGid)}/attachments`,{data:{resource_subtype:"external",url:parsed.toString(),name:name?.trim()||undefined},fetchImpl}));}
export async function deleteAsanaResource(userId:string,kind:"tasks"|"projects"|"sections"|"portfolios"|"goals"|"attachments"|"time_tracking_entries",resourceGid:string,fetchImpl?:AsanaFetch):Promise<{deleted:true;gid:string}>{if(!["tasks","projects","attachments"].includes(kind))throw new AsanaNamedScopeUnavailableError(`${kind} deletion`);await asanaRequest(userId,"DELETE",`/${kind}/${gid.parse(resourceGid)}`,{fetchImpl,retry401:false});return {deleted:true,gid:resourceGid};}

export const ASANA_CONFIRMATION_POLICY={task_delete:"always",project_delete:"always",section_delete:"always",portfolio_delete:"always",goal_delete:"always",bulk_mutation:"always",membership_change:"always",comment:"always",assignment_other_person:"always",followers_change:"always",dependency_change:"reversible",single_task_edit:"none"} as const;
