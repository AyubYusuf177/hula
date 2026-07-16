import { getCurrentAsanaUser, listAsanaResources } from "./operations";
import type { AsanaResource } from "./types";
export type IdentityResult={kind:"resolved";user:AsanaResource}|{kind:"ambiguous";names:string[]}|{kind:"not_found"}|{kind:"self_unavailable"};
const SELF_ALIASES=new Set(["me","myself","self","current user","current_user"]);
export function isAsanaSelfReference(query:string):boolean{
  const normalized=query.trim().toLowerCase().replace(/[.!?]+$/g,"").replace(/\s+/g," ");
  if(SELF_ALIASES.has(normalized))return true;
  return /^(?:assign\s+)?(?:(?:it|this|this task)\s+)?to\s+(?:me|myself)$/.test(normalized)||/^make\s+me\s+the\s+assignee$/.test(normalized);
}
export function resolveAsanaPersonFromList(people:AsanaResource[],query:string):IdentityResult{const needle=query.trim().toLowerCase();const email=needle.includes("@");const matches=people.filter(person=>{const value=email?person.email:person.name;return typeof value==="string"&&value.trim().toLowerCase()===needle;});if(matches.length===1)return{kind:"resolved",user:matches[0]!};if(matches.length>1)return{kind:"ambiguous",names:matches.map(p=>typeof p.name==="string"?p.name:"Unknown person").slice(0,5)};return{kind:"not_found"};}
export interface AsanaIdentityDeps{getCurrent?:typeof getCurrentAsanaUser;list?:typeof listAsanaResources}
export async function resolveAsanaPerson(userId:string,workspace:string,query:string,deps:AsanaIdentityDeps={}):Promise<IdentityResult>{
  const selfReference=isAsanaSelfReference(query);let current:AsanaResource|null=null;
  try{current=await(deps.getCurrent??getCurrentAsanaUser)(userId);}catch{if(selfReference)return{kind:"self_unavailable"};}
  const needle=query.trim().toLowerCase();
  if(current&&(selfReference||(typeof current.email==="string"&&current.email.trim().toLowerCase()===needle)||(typeof current.name==="string"&&current.name.trim().toLowerCase()===needle)))return{kind:"resolved",user:current};
  return resolveAsanaPersonFromList(await(deps.list??listAsanaResources)(userId,"users",{workspace,count:500}),query);
}
