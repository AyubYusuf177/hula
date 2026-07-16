import { getPrisma } from "../../../db/prisma";
import { readCredentialSecrets, storeCredentialSecrets } from "../../credentials";
import { logger } from "../../../utils/logger";
import { getNotionOAuthConfig, refreshNotionToken } from "./oauth";
import { NOTION_API_BASE, NOTION_API_VERSION, NOTION_PROVIDER, type NotionList, type NotionObject } from "./types";

export type NotionErrorCode="not_connected"|"reconnect_required"|"invalid_request"|"unauthorized"|"forbidden"|"not_found"|"conflict"|"rate_limited"|"provider_unavailable"|"timeout"|"malformed_response"|"uncertain_write";
export class NotionError extends Error {constructor(public code:NotionErrorCode,public status=0,public retryAfter:number|null=null,public providerCode:string|null=null,public requestId:string|null=null){super(code);this.name="NotionError";}}
export interface NotionResponse {ok:boolean;status:number;text():Promise<string>;headers?:{get(name:string):string|null}}
export type NotionFetch=(url:string,init:RequestInit)=>Promise<NotionResponse>;
export interface NotionClientDeps {fetchImpl?:NotionFetch;baseUrl?:string;token?:string;refresh?:()=>Promise<string>;timeoutMs?:number;sleep?:(ms:number)=>Promise<void>}
export interface NotionRequest {method:"GET"|"POST"|"PATCH"|"DELETE";path:string;body?:unknown;query?:Record<string,string|string[]|undefined>;idempotencyKey?:string;safeRetry?:boolean}

export function classifyNotionStatus(status:number):NotionErrorCode {if(status===400)return"invalid_request";if(status===401)return"unauthorized";if(status===403)return"forbidden";if(status===404)return"not_found";if(status===409)return"conflict";if(status===429)return"rate_limited";if(status>=500)return"provider_unavailable";return"invalid_request";}
export function parseNotionRetryAfter(value:string|null|undefined):number|null{const n=Number(value);return Number.isFinite(n)&&n>=0?Math.min(n,60):null;}
function requestStrings(value:unknown,out=new Set<string>()):Set<string>{if(typeof value==="string"&&value.length>1)out.add(value);else if(Array.isArray(value))for(const item of value)requestStrings(item,out);else if(value&&typeof value==="object")for(const item of Object.values(value as Record<string,unknown>))requestStrings(item,out);return out;}
export function sanitizeNotionProviderMessage(value:unknown,requestBody?:unknown):string|null{if(typeof value!=="string")return null;let clean=value.replace(/[\u0000-\u001f\u007f]/g," ").replace(/Bearer\s+\S+/gi,"Bearer [redacted]").replace(/\b(?:secret|token|key)_[A-Za-z0-9_-]+\b/gi,"[redacted]").replace(/https?:\/\/\S+/gi,"[redacted URL]").replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,"[redacted email]").replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,"[redacted id]");for(const text of requestStrings(requestBody))clean=clean.split(text).join("[redacted input]");clean=clean.replace(/\s+/g," ").trim();return clean?clean.slice(0,240):null;}
export function parseNotionErrorDiagnostic(rawText:string,requestBody?:unknown):{providerCode:string|null;providerMessage:string|null;requestId:string|null}{try{const raw=JSON.parse(rawText) as Record<string,unknown>;return{providerCode:typeof raw.code==="string"?raw.code.slice(0,80):null,providerMessage:sanitizeNotionProviderMessage(raw.message,requestBody),requestId:typeof raw.request_id==="string"?raw.request_id.slice(0,120):null};}catch{return{providerCode:null,providerMessage:null,requestId:null};}}

async function connection(userId:string){return getPrisma().integrationConnection.findUnique({where:{userId_provider:{userId,provider:NOTION_PROVIDER}},select:{id:true,status:true}});}
async function productionToken(userId:string):Promise<{token:string;refresh:()=>Promise<string>}>{
  const conn=await connection(userId);if(!conn||conn.status!=="connected")throw new NotionError("not_connected");
  const credential=await readCredentialSecrets(conn.id);if(!credential?.accessToken)throw new NotionError("not_connected");
  const refresh=async()=>{if(!credential.refreshToken)throw new NotionError("reconnect_required",401);const rotated=await refreshNotionToken(getNotionOAuthConfig(),credential.refreshToken);await storeCredentialSecrets(conn.id,{accessToken:rotated.accessToken,refreshToken:rotated.refreshToken});return rotated.accessToken;};
  return {token:credential.accessToken,refresh};
}

export async function notionRequest<T extends unknown>(userId:string,request:NotionRequest,deps:NotionClientDeps={}):Promise<T>{
  const auth=deps.token?{token:deps.token,refresh:deps.refresh}:await productionToken(userId);let token=auth.token;let refreshed=false,retried=false;
  const url=new URL(`${deps.baseUrl??NOTION_API_BASE}${request.path}`);for(const[k,v]of Object.entries(request.query??{})){if(Array.isArray(v))for(const value of v)url.searchParams.append(k,value);else if(v!==undefined)url.searchParams.set(k,v);}
  const perform=async()=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),deps.timeoutMs??12_000);try{return await(deps.fetchImpl??fetch)(url.toString(),{method:request.method,headers:{Authorization:`Bearer ${token}`,Accept:"application/json","Content-Type":"application/json","Notion-Version":NOTION_API_VERSION,...(request.idempotencyKey?{"Idempotency-Key":request.idempotencyKey}:{})},...(request.body!==undefined?{body:JSON.stringify(request.body)}:{}),signal:controller.signal});}catch(error){if((error as {name?:string}).name==="AbortError")throw new NotionError("timeout");throw new NotionError(request.method==="GET"?"provider_unavailable":"uncertain_write");}finally{clearTimeout(timer);}};
  let response=await perform();if(response.status===401&&!refreshed&&auth.refresh){token=await auth.refresh();refreshed=true;response=await perform();}
  if((response.status===429||response.status>=500)&&request.safeRetry&&!retried){retried=true;const seconds=parseNotionRetryAfter(response.headers?.get("retry-after"))??1;const sleep=deps.sleep??((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)));await sleep(seconds*1000);response=await perform();}
  const text=await response.text();if(!response.ok){const code=classifyNotionStatus(response.status),diagnostic=parseNotionErrorDiagnostic(text,request.body);logger.error("notion.request failed",{operation:`${request.method} ${request.path}`,httpStatus:response.status,notionErrorCode:diagnostic.providerCode??code,providerMessage:diagnostic.providerMessage,requestId:diagnostic.requestId});throw new NotionError(code,response.status,parseNotionRetryAfter(response.headers?.get("retry-after")),diagnostic.providerCode,diagnostic.requestId);}
  if(!text.trim())return null as T;try{return JSON.parse(text) as T;}catch{throw new NotionError("malformed_response",response.status);}
}

export async function notionPaginate<T extends NotionObject>(userId:string,request:Omit<NotionRequest,"body">&{body?:Record<string,unknown>},options:{maxPages?:number;maxResults?:number;deps?:NotionClientDeps}={}):Promise<T[]>{
  const maxPages=Math.min(Math.max(options.maxPages??10,1),100),maxResults=Math.min(Math.max(options.maxResults??100,1),1000);const results:T[]=[];let cursor:string|undefined;
  for(let page=0;page<maxPages&&results.length<maxResults;page++){const pageSize=String(Math.min(100,maxResults-results.length));const paged=request.method==="GET"?{...request,query:{...(request.query??{}),page_size:pageSize,...(cursor?{start_cursor:cursor}:{})}}:{...request,body:{...(request.body??{}),page_size:Number(pageSize),...(cursor?{start_cursor:cursor}:{})}};const list=await notionRequest<NotionList<T>>(userId,paged,options.deps);if(list.object!=="list"||!Array.isArray(list.results)||typeof list.has_more!=="boolean")throw new NotionError("malformed_response");results.push(...list.results.slice(0,maxResults-results.length));if(!list.has_more)break;if(typeof list.next_cursor!=="string"||!list.next_cursor)throw new NotionError("malformed_response");cursor=list.next_cursor;}
  return results;
}
