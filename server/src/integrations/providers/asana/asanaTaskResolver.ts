import { AsanaError } from "./client";
import { listAsanaResources, listAsanaTasks, searchAsanaTasksInWorkspace } from "./operations";
import { asanaPlainText } from "./plainText";
import type { AsanaResource } from "./types";

export interface AsanaTaskResolverDeps {
  listResources?: typeof listAsanaResources;
  listTasks?: typeof listAsanaTasks;
  searchWorkspace?: typeof searchAsanaTasksInWorkspace;
}

export type AsanaTaskResolution =
  | { kind:"resolved"; task:AsanaResource }
  | { kind:"ambiguous"; tasks:AsanaResource[] }
  | { kind:"not_found" };

const normalizedName=(value:unknown)=>asanaPlainText(value).toLocaleLowerCase();
const uniqueByGid=(items:AsanaResource[])=>[...new Map(items.map(item=>[item.gid,item])).values()];
const records=(value:unknown):Record<string,unknown>[]=>Array.isArray(value)?value.filter((item):item is Record<string,unknown>=>Boolean(item)&&typeof item==="object"):[];

async function workspaceCandidates(userId:string,workspace:AsanaResource,title:string,deps:AsanaTaskResolverDeps):Promise<AsanaResource[]>{
  const search=deps.searchWorkspace??searchAsanaTasksInWorkspace;const found:AsanaResource[]=[];
  try{found.push(...await search(userId,workspace.gid,title,100));}catch(error){if(!(error instanceof AsanaError)||error.reason!=="plan_restricted")throw error;}
  // Search is premium and eventually consistent. Enumerating accessible projects is
  // the named-scope fallback and prevents a recent task from disappearing.
  const projects=await(deps.listResources??listAsanaResources)(userId,"projects",{workspace:workspace.gid,count:500});
  for(const project of projects){found.push(...await(deps.listTasks??listAsanaTasks)(userId,{project:project.gid,count:500}));}
  found.push(...await(deps.listTasks??listAsanaTasks)(userId,{workspace:workspace.gid,assignee:"me",count:500}));return found;
}

/** Resolve a human task title across accessible work without defaulting to assignee=me. */
export async function resolveAsanaTaskTitle(userId:string,titleValue:string,deps:AsanaTaskResolverDeps={}):Promise<AsanaTaskResolution>{
  const title=asanaPlainText(titleValue);if(!title)return{kind:"not_found"};const workspaces=await(deps.listResources??listAsanaResources)(userId,"workspaces",{count:100});const candidates:AsanaResource[]=[];
  for(const workspace of workspaces)candidates.push(...await workspaceCandidates(userId,workspace,title,deps));
  const unique=uniqueByGid(candidates);const needle=normalizedName(title);const exact=unique.filter(task=>normalizedName(task.name)===needle);if(exact.length===1)return{kind:"resolved",task:exact[0]!};if(exact.length>1)return{kind:"ambiguous",tasks:exact};
  const partial=unique.filter(task=>normalizedName(task.name).includes(needle));if(partial.length===1)return{kind:"resolved",task:partial[0]!};if(partial.length>1)return{kind:"ambiguous",tasks:partial};return{kind:"not_found"};
}

export type AsanaSectionResolution = {kind:"resolved";section:AsanaResource}|{kind:"ambiguous"}|{kind:"not_found"};
export async function resolveProjectSection(userId:string,projectGid:string,sectionNameValue:string,deps:Pick<AsanaTaskResolverDeps,"listTasks">={}):Promise<AsanaSectionResolution>{
  const tasks=await(deps.listTasks??listAsanaTasks)(userId,{project:projectGid,count:500});const sections:AsanaResource[]=[];
  for(const task of tasks){for(const membership of records(task.memberships)){const project=membership.project&&typeof membership.project==="object"?membership.project as Record<string,unknown>:null;const section=membership.section&&typeof membership.section==="object"?membership.section as Record<string,unknown>:null;if(project?.gid!==projectGid||typeof section?.gid!=="string"||typeof section.name!=="string")continue;sections.push({gid:section.gid,name:section.name,resource_type:"section"});}}
  const needle=normalizedName(sectionNameValue);const matches=uniqueByGid(sections).filter(section=>normalizedName(section.name)===needle);return matches.length===1?{kind:"resolved",section:matches[0]!}:matches.length>1?{kind:"ambiguous"}:{kind:"not_found"};
}

export function taskProjectMemberships(task:AsanaResource):AsanaResource[]{const projects:AsanaResource[]=[];for(const membership of records(task.memberships)){const project=membership.project&&typeof membership.project==="object"?membership.project as Record<string,unknown>:null;if(typeof project?.gid==="string")projects.push({gid:project.gid,name:typeof project.name==="string"?project.name:undefined,resource_type:"project"});}for(const project of records(task.projects)){if(typeof project.gid==="string")projects.push({gid:project.gid,name:typeof project.name==="string"?project.name:undefined,resource_type:"project"});}return uniqueByGid(projects);}
