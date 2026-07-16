import { createActionProposal, listRecentProposalsByAction } from "../../../actions/proposals";
import type { NotionObject } from "./types";
import { notionPlainText, notionTitle, richText } from "./display";

export const NOTION_SELECTION_ACTION_ID="notion.lastSelection";
export const NOTION_ENTITY_ACTION_ID="notion.entityContext";
const TTL=30*60*1000;
export interface NotionRef {id:string;type:"page"|"database"|"data_source"|"block"|"comment"|"user";title:string;parentTitle?:string;discussionId?:string}
export const toNotionRef=(o:NotionObject):NotionRef=>({id:String(o.id),type:o.object==="data_source"?"data_source":o.object==="database"?"database":o.object==="block"?"block":o.object==="comment"?"comment":o.object==="user"?"user":"page",title:o.object==="comment"?(notionPlainText(richText(o.rich_text),160)||"Comment"):notionTitle(o),...(typeof o.discussion_id==="string"?{discussionId:o.discussion_id}:{})});
let lastContextEstablishedAt=0;
const nextContextEstablishedAt=()=>{lastContextEstablishedAt=Math.max(Date.now(),lastContextEstablishedAt+1);return lastContextEstablishedAt;};
export async function recordNotionSelection(userId:string,objects:NotionObject[]){const refs=objects.filter(o=>typeof o.id==="string").slice(0,20).map(toNotionRef);if(!refs.length)return;await createActionProposal(userId,{provider:"notion",actionId:NOTION_SELECTION_ACTION_ID,riskLevel:"read",confirmationRequired:false,input:{kind:"notion_selection",refs,contextEstablishedAt:nextContextEstablishedAt()},previewText:"Notion selection context",ttlMs:TTL});}
export async function recordNotionEntity(userId:string,object:NotionObject){const ref=toNotionRef(object);await createActionProposal(userId,{provider:"notion",actionId:NOTION_ENTITY_ACTION_ID,riskLevel:"read",confirmationRequired:false,input:{kind:"notion_entity",ref,contextEstablishedAt:nextContextEstablishedAt()},previewText:"Notion entity context",ttlMs:TTL});}
export async function resolveNotionReference(userId:string,text:string|undefined,position?:number|null):Promise<NotionRef|null>{const now=Date.now(),ordinal=position??(/\blast\b/i.test(text??"")?-1:/\bsecond|\b2nd|\b2\b/i.test(text??"")?2:/\bthird|\b3rd|\b3\b/i.test(text??"")?3:/\bfirst|\b1st|\b1\b/i.test(text??"")?1:null);for(const actionId of ordinal?[NOTION_SELECTION_ACTION_ID]:[NOTION_ENTITY_ACTION_ID,NOTION_SELECTION_ACTION_ID]){const rows=await listRecentProposalsByAction(userId,actionId,5);const row=rows.find(r=>Date.parse(r.expiresAt)>now);const input=row?.input;if(!input)continue;if(actionId===NOTION_ENTITY_ACTION_ID){const ref=input.ref as NotionRef|undefined;if(ref?.id)return ref;}const refs=input.refs as NotionRef[]|undefined;if(refs?.length){const i=ordinal===-1?refs.length-1:(ordinal??1)-1;return refs[i]??null;}}return null;}
