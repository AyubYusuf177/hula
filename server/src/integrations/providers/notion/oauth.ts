import { env } from "../../../config/env";
import type { NotionCapability } from "./types";

const AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const REVOKE_URL = "https://api.notion.com/v1/oauth/revoke";
const INTROSPECT_URL = "https://api.notion.com/v1/oauth/introspect";

export class NotionOAuthConfigError extends Error {}
export interface NotionOAuthConfig { clientId:string; clientSecret:string; redirectUri:string; apiVersion:string }
export type NotionOAuthFetch = (url:string, init:RequestInit)=>Promise<{ok:boolean;status:number;text():Promise<string>}>;

export function getNotionOAuthConfig():NotionOAuthConfig {
  const clientId=env.NOTION_OAUTH_CLIENT_ID?.trim(), clientSecret=env.NOTION_OAUTH_CLIENT_SECRET?.trim(), redirectUri=env.NOTION_OAUTH_REDIRECT_URI?.trim();
  if(!clientId||!clientSecret||!redirectUri) throw new NotionOAuthConfigError("Notion OAuth is not configured");
  const parsed=new URL(redirectUri); if(parsed.protocol!=="https:"&&parsed.hostname!=="localhost") throw new NotionOAuthConfigError("Notion redirect URI must be HTTPS");
  return {clientId,clientSecret,redirectUri,apiVersion:env.NOTION_API_VERSION};
}

export function buildNotionAuthorizationUrl(input:{config:NotionOAuthConfig;state:string}):string {
  const q=new URLSearchParams({client_id:input.config.clientId,response_type:"code",owner:"user",redirect_uri:input.config.redirectUri,state:input.state});
  return `${AUTHORIZE_URL}?${q}`;
}

function basic(config:NotionOAuthConfig):string{return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;}
async function oauthJson(url:string,config:NotionOAuthConfig,body:Record<string,unknown>,fetchImpl:NotionOAuthFetch=fetch):Promise<Record<string,unknown>>{
  const response=await fetchImpl(url,{method:"POST",headers:{Authorization:basic(config),"Content-Type":"application/json","Notion-Version":config.apiVersion},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
  let raw:unknown; try{raw=JSON.parse(await response.text());}catch{throw new NotionOAuthConfigError("Malformed Notion OAuth response");}
  if(!response.ok||!raw||typeof raw!=="object")throw new NotionOAuthConfigError(`Notion OAuth failed (${response.status})`);
  return raw as Record<string,unknown>;
}
export interface NotionTokens {accessToken:string;refreshToken:string|null;botId:string;workspaceId:string;workspaceName:string|null;ownerName:string|null;ownerEmail:string|null}
function tokens(raw:Record<string,unknown>):NotionTokens{
  const owner=raw.owner&&typeof raw.owner==="object"?raw.owner as Record<string,unknown>:null;
  const user=owner?.user&&typeof owner.user==="object"?owner.user as Record<string,unknown>:owner;
  const person=user?.person&&typeof user.person==="object"?user.person as Record<string,unknown>:null;
  if(typeof raw.access_token!=="string"||typeof raw.bot_id!=="string"||typeof raw.workspace_id!=="string")throw new NotionOAuthConfigError("Malformed Notion token response");
  return {accessToken:raw.access_token,refreshToken:typeof raw.refresh_token==="string"?raw.refresh_token:null,botId:raw.bot_id,workspaceId:raw.workspace_id,workspaceName:typeof raw.workspace_name==="string"?raw.workspace_name:null,ownerName:typeof user?.name==="string"?user.name:null,ownerEmail:typeof person?.email==="string"?person.email:null};
}
export async function exchangeNotionCode(config:NotionOAuthConfig,code:string,fetchImpl?:NotionOAuthFetch){return tokens(await oauthJson(TOKEN_URL,config,{grant_type:"authorization_code",code,redirect_uri:config.redirectUri},fetchImpl));}
export async function refreshNotionToken(config:NotionOAuthConfig,refreshToken:string,fetchImpl?:NotionOAuthFetch){return tokens(await oauthJson(TOKEN_URL,config,{grant_type:"refresh_token",refresh_token:refreshToken},fetchImpl));}
export async function revokeNotionToken(config:NotionOAuthConfig,token:string,fetchImpl?:NotionOAuthFetch):Promise<void>{await oauthJson(REVOKE_URL,config,{token},fetchImpl);}
export async function introspectNotionToken(config:NotionOAuthConfig,token:string,fetchImpl?:NotionOAuthFetch):Promise<{active:boolean;scopes:string[]}>{const raw=await oauthJson(INTROSPECT_URL,config,{token},fetchImpl);return{active:raw.active===true,scopes:typeof raw.scope==="string"?raw.scope.split(/[ ,]+/).filter(Boolean):[]};}
export function capabilitiesFromNotionScopes(scopes:readonly string[]):NotionCapability[]{
  const set=new Set(scopes),out=new Set<NotionCapability>();
  if(set.has("content:read")||set.has("read_content")){out.add("content.read");out.add("files.read");}
  if(set.has("content:write")||set.has("write_content")||set.has("insert_content")||set.has("update_content")){out.add("content.write");out.add("files.write");}
  if(set.has("comments:read")||set.has("read_comments"))out.add("comments.read");
  if(set.has("comments:write")||set.has("insert_comments"))out.add("comments.write");
  if(set.has("user:read")||set.has("read_user_information")||set.has("read_user_without_email")||set.has("read_user_with_email"))out.add("users.read");
  return [...out];
}
