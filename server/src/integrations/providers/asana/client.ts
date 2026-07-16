import { getPrisma } from "../../../db/prisma";
import { readCredentialSecrets, storeCredentialSecrets } from "../../credentials";
import { TokenVaultConfigError } from "../../tokenVault";
import { exchangeAsanaToken, getAsanaOAuthConfig, type AsanaFetch } from "./oauth";
import { ASANA_PROVIDER, type AsanaPage } from "./types";

const API = "https://app.asana.com/api/1.0";
const MAX_PAGES = 10;
export type AsanaErrorReason = "not_connected"|"credential_decrypt_failed"|"reconnect_required"|"auth_failed"|"plan_restricted"|"forbidden"|"not_found"|"conflict"|"invalid_request"|"rate_limited"|"provider_unavailable"|"malformed_response"|"timeout"|"network_failure";
export class AsanaError extends Error { constructor(public reason:AsanaErrorReason, public status:number|null=null, public retryAfterSeconds:number|null=null){super(reason);this.name="AsanaError";} }

export function classifyAsanaStatus(status:number): AsanaErrorReason {
  if(status===400||status===422)return "invalid_request"; if(status===401)return "auth_failed";
  if(status===402)return "plan_restricted"; if(status===403)return "forbidden";
  if(status===404)return "not_found"; if(status===409)return "conflict";
  if(status===429)return "rate_limited"; return status>=500?"provider_unavailable":"provider_unavailable";
}

export function buildAsanaUrl(path:string, query:Record<string,string|number|boolean|null|undefined>={}): URL {
  if(!path.startsWith("/")) throw new AsanaError("invalid_request");
  const url=new URL(`${API}${path}`); for(const [key,value] of Object.entries(query)) if(value!==null&&value!==undefined)url.searchParams.set(key,String(value)); return url;
}

async function connection(userId:string){return getPrisma().integrationConnection.findUnique({where:{userId_provider:{userId,provider:ASANA_PROVIDER}},select:{id:true,status:true,grantedScopes:true}});}

async function token(userId:string, fetchImpl?:AsanaFetch, force=false):Promise<{value:string;connectionId:string}> {
  const row=await connection(userId); if(!row||row.status!=="connected")throw new AsanaError("not_connected");
  let secret; try{secret=await readCredentialSecrets(row.id);}catch(error){if(error instanceof TokenVaultConfigError)throw new AsanaError("credential_decrypt_failed");throw error;}
  if(!secret?.accessToken)throw new AsanaError("not_connected");
  if(!force && (!secret.accessTokenExpiresAt || secret.accessTokenExpiresAt.getTime()>Date.now()+60_000))return {value:secret.accessToken,connectionId:row.id};
  if(!secret.refreshToken)throw new AsanaError("reconnect_required");
  let refreshed; try{refreshed=await exchangeAsanaToken({config:getAsanaOAuthConfig(),refreshToken:secret.refreshToken,fetchImpl});}catch{throw new AsanaError("reconnect_required");}
  await storeCredentialSecrets(row.id,{accessToken:refreshed.accessToken,refreshToken:refreshed.refreshToken,accessTokenExpiresAt:new Date(Date.now()+refreshed.expiresIn*1000),scopes:refreshed.scopes.length?refreshed.scopes:undefined});
  return {value:refreshed.accessToken,connectionId:row.id};
}

export async function asanaRequest<T>(userId:string, method:"GET"|"POST"|"PUT"|"DELETE", path:string, options:{query?:Record<string,string|number|boolean|null|undefined>;data?:Record<string,unknown>;fetchImpl?:AsanaFetch;retry401?:boolean}={}):Promise<T>{
  const auth=await token(userId,options.fetchImpl); const fetchImpl=options.fetchImpl??(fetch as unknown as AsanaFetch); const url=buildAsanaUrl(path,options.query); const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),12_000);
  try{
    let response; try{response=await fetchImpl(url.toString(),{method,headers:{authorization:`Bearer ${auth.value}`,accept:"application/json",...(options.data?{"content-type":"application/json"}:{})},...(options.data?{body:JSON.stringify({data:options.data})}:{}),signal:controller.signal});}catch(error){throw new AsanaError(error instanceof Error&&error.name==="AbortError"?"timeout":"network_failure");}
    if(response.status===401 && options.retry401!==false){const fresh=await token(userId,options.fetchImpl,true);return requestWithToken<T>(fresh.value,method,url,options,fetchImpl);}
    return parseResponse<T>(response);
  }finally{clearTimeout(timer);}
}

async function requestWithToken<T>(accessToken:string,method:string,url:URL,options:{data?:Record<string,unknown>;fetchImpl?:AsanaFetch},fetchImpl:AsanaFetch):Promise<T>{const response=await fetchImpl(url.toString(),{method,headers:{authorization:`Bearer ${accessToken}`,accept:"application/json",...(options.data?{"content-type":"application/json"}:{})},...(options.data?{body:JSON.stringify({data:options.data})}:{})});return parseResponse<T>(response);}
async function parseResponse<T>(response:{ok:boolean;status:number;text():Promise<string>}):Promise<T>{const raw=await response.text();if(!response.ok)throw new AsanaError(classifyAsanaStatus(response.status),response.status);if(response.status===204||raw==="")return undefined as T;let body:unknown;try{body=JSON.parse(raw);}catch{throw new AsanaError("malformed_response",response.status);}if(!body||typeof body!=="object"||!("data" in body))throw new AsanaError("malformed_response",response.status);return (body as {data:T}).data;}

export async function asanaPage<T>(userId:string,path:string,input:{query?:Record<string,string|number|boolean|null|undefined>;count?:number;fetchImpl?:AsanaFetch;normalize?:(value:unknown)=>T|null}={}):Promise<AsanaPage<T>>{
  const wanted=Math.min(Math.max(input.count??50,1),500);const items:T[]=[];let offset:string|undefined;
  for(let page=0;page<MAX_PAGES&&items.length<wanted;page++){const url=buildAsanaUrl(path,{...input.query,limit:Math.min(100,wanted-items.length),offset});const auth=await token(userId,input.fetchImpl);const fetchImpl=input.fetchImpl??(fetch as unknown as AsanaFetch);const response=await fetchImpl(url.toString(),{method:"GET",headers:{authorization:`Bearer ${auth.value}`,accept:"application/json"}});const raw=await response.text();if(!response.ok)throw new AsanaError(classifyAsanaStatus(response.status),response.status);let body:{data?:unknown;next_page?:{offset?:unknown}|null};try{body=JSON.parse(raw) as typeof body;}catch{throw new AsanaError("malformed_response");}if(!Array.isArray(body.data))throw new AsanaError("malformed_response");for(const value of body.data){const normalized=input.normalize?input.normalize(value):value as T;if(normalized!==null)items.push(normalized);if(items.length===wanted)break;}offset=typeof body.next_page?.offset==="string"?body.next_page.offset:undefined;if(!offset)break;}
  return {data:items.slice(0,wanted),nextPageOffset:offset??null};
}
