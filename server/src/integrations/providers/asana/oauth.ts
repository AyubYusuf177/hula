import { createHash, randomBytes } from "node:crypto";
import { env } from "../../../config/env";
import { getProvider } from "../../catalog";
import { ASANA_PROVIDER } from "./types";

const AUTHORIZE_URL = "https://app.asana.com/-/oauth_authorize";
const TOKEN_URL = "https://app.asana.com/-/oauth_token";

/** Current named OAuth scopes published by Asana (2026-07-15). */
export const ASANA_NAMED_OAUTH_SCOPES = [
  "attachments:read","attachments:write","attachments:delete",
  "custom_fields:read","custom_fields:write","goals:read","jobs:read",
  "ooo_entries:read","ooo_entries:write","ooo_entries:delete",
  "portfolios:read","portfolios:write","project_portfolio_settings:read","project_portfolio_settings:write",
  "project_templates:read","projects:read","projects:write","projects:delete",
  "roles:read","roles:write","roles:delete","stories:read","stories:write",
  "tags:read","tags:write","task_custom_types:read","task_templates:read",
  "tasks:read","tasks:write","tasks:delete","team_memberships:read","teams:read",
  "time_tracking_categories:read","time_tracking_categories:write","time_tracking_categories:delete",
  "time_tracking_entries:read","timesheet_approval_statuses:read","timesheet_approval_statuses:write",
  "users:read","webhooks:read","webhooks:write","webhooks:delete",
  "workspaces:read","workspaces.typeahead:read","openid","email","profile",
] as const;
const ASANA_NAMED_SCOPE_SET=new Set<string>(ASANA_NAMED_OAUTH_SCOPES);
export function validateAsanaScopes(scopes:readonly string[]):string[]{const unique=parseAsanaScopes(scopes.join(" "));const invalid=unique.filter(scope=>!ASANA_NAMED_SCOPE_SET.has(scope));if(invalid.length)throw new AsanaOAuthConfigError("Asana OAuth contains unsupported named scopes");return unique;}

export class AsanaOAuthConfigError extends Error {}
export type AsanaFetch = (url: string, init: RequestInit) => Promise<{ok:boolean;status:number;text():Promise<string>}>;
export interface AsanaOAuthConfig { clientId:string; clientSecret:string; redirectUri:string; scopes:string[] }

export function parseAsanaScopes(value: string | null | undefined): string[] {
  return [...new Set((value ?? "").split(/[\s,]+/).map((v) => v.trim()).filter(Boolean))];
}

export function getAsanaOAuthConfig(): AsanaOAuthConfig {
  const clientId = env.ASANA_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.ASANA_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.ASANA_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) throw new AsanaOAuthConfigError("Asana OAuth is not configured");
  const configured = parseAsanaScopes(env.ASANA_SCOPES);
  return { clientId, clientSecret, redirectUri, scopes: validateAsanaScopes(configured.length ? configured : [...(getProvider(ASANA_PROVIDER)?.defaultScopes ?? ["tasks:read"])]) };
}

export function createAsanaPkce(): { verifier:string; challenge:string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildAsanaAuthorizationUrl(input:{config:AsanaOAuthConfig;state:string;challenge:string}): string {
  const scopes=validateAsanaScopes(input.config.scopes);
  const query = new URLSearchParams({client_id:input.config.clientId,redirect_uri:input.config.redirectUri,response_type:"code",state:input.state,code_challenge_method:"S256",code_challenge:input.challenge,scope:scopes.join(" ")});
  return `${AUTHORIZE_URL}?${query}`;
}

export interface AsanaTokens { accessToken:string; refreshToken:string|null; expiresIn:number; scopes:string[]; account:{gid:string;name:string|null;email:string|null}|null }

export async function exchangeAsanaToken(input:{config:AsanaOAuthConfig;code?:string;refreshToken?:string;verifier?:string;fetchImpl?:AsanaFetch}): Promise<AsanaTokens> {
  const params = new URLSearchParams({grant_type:input.code ? "authorization_code" : "refresh_token",client_id:input.config.clientId,client_secret:input.config.clientSecret});
  if (input.code) { params.set("code", input.code); params.set("redirect_uri", input.config.redirectUri); if (input.verifier) params.set("code_verifier", input.verifier); }
  else if (input.refreshToken) params.set("refresh_token", input.refreshToken);
  else throw new Error("Asana token request missing grant material");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const fetchImpl = input.fetchImpl ?? (fetch as unknown as AsanaFetch);
    const response = await fetchImpl(TOKEN_URL,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:params.toString(),signal:controller.signal});
    const raw = await response.text();
    if (!response.ok) throw new Error(`Asana token exchange failed (${response.status})`);
    let body: Record<string,unknown>; try { body=JSON.parse(raw) as Record<string,unknown>; } catch { throw new Error("Asana token response was malformed"); }
    if (typeof body.access_token !== "string" || !body.access_token) throw new Error("Asana token response was malformed");
    const data = body.data && typeof body.data === "object" ? body.data as Record<string,unknown> : null;
    return {accessToken:body.access_token,refreshToken:typeof body.refresh_token === "string" ? body.refresh_token : null,expiresIn:typeof body.expires_in === "number" ? body.expires_in : 3600,scopes:parseAsanaScopes(typeof body.scope === "string" ? body.scope : null),account:data && typeof data.gid === "string" ? {gid:data.gid,name:typeof data.name === "string"?data.name:null,email:typeof data.email === "string"?data.email:null}:null};
  } finally { clearTimeout(timer); }
}

export function capabilitiesFromAsanaScopes(scopes:readonly string[]): string[] {
  const granted=new Set(scopes.filter(scope=>ASANA_NAMED_SCOPE_SET.has(scope)));
  const mapping:readonly [string,string][]=[["tasks:read","work.read"],["tasks:read","tasks.read"],["tasks:write","tasks.write"],["tasks:delete","tasks.delete"],["projects:read","projects.read"],["projects:write","projects.write"],["projects:delete","projects.delete"],["stories:read","collaboration.read"],["stories:write","collaboration.write"],["attachments:read","attachments.read"],["attachments:write","attachments.write"],["attachments:delete","attachments.delete"],["custom_fields:read","custom_fields.read"],["portfolios:read","portfolios.read"],["portfolios:write","portfolios.write"],["goals:read","goals.read"],["tags:read","tags.read"],["teams:read","teams.read"],["time_tracking_entries:read","time_tracking.read"],["users:read","users.read"],["workspaces:read","workspaces.read"]];
  return mapping.filter(([scope])=>granted.has(scope)).map(([,capability])=>capability);
}
