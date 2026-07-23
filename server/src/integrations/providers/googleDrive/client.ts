import { getPrisma } from "../../../db/prisma";
import { logger } from "../../../utils/logger";
import { readCredentialSecrets, storeRefreshedCredential } from "../../credentials";
import { TokenVaultConfigError } from "../../tokenVault";
import {
  getGoogleDriveOAuthConfig,
  refreshAccessToken,
  type FetchLike,
} from "./oauth";
import { GOOGLE_DRIVE_PROVIDER } from "./types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DOCS_API = "https://docs.googleapis.com/v1";
const EXPIRY_SKEW_MS = 60_000;
export const DRIVE_PROVIDER_TIMEOUT_MS = 12_000;
export const DRIVE_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export type DriveErrorReason =
  | "not_connected"
  | "credential_decrypt_failed"
  | "no_refresh_token"
  | "token_refresh_failed"
  | "invalid_grant"
  | "auth_failed"
  | "insufficient_scope"
  | "drive_api_disabled"
  | "provider_request_invalid"
  | "file_not_found"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "malformed_provider_response"
  | "response_too_large"
  | "unsupported_content"
  | "drive_timeout"
  | "network_failure";

export class DriveError extends Error {
  constructor(
    public readonly reason: DriveErrorReason,
    message?: string,
    public readonly httpStatus: number | null = null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message ?? reason);
    this.name = "DriveError";
  }
}

function safeGoogleErrorReason(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const error = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).error : null;
    if (!error || typeof error !== "object") return null;
    const value = error as Record<string, unknown>;
    const first = Array.isArray(value.errors) && value.errors[0] && typeof value.errors[0] === "object"
      ? value.errors[0] as Record<string, unknown>
      : null;
    const reason = first && typeof first.reason === "string" ? first.reason : null;
    const status = typeof value.status === "string" ? value.status : null;
    const code = typeof value.code === "number" ? String(value.code) : null;
    return [reason, status, code].filter(Boolean).join("/") || null;
  } catch {
    return null;
  }
}

function safeProviderPath(path: string): string {
  return path
    .replace(/\/files\/[^/:?]+/g, "/files/:fileId")
    .replace(/\/documents\/[^/:?]+/g, "/documents/:documentId");
}

export interface DriveConnectionRef {
  id: string;
  status: string;
}

export interface DriveFetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers?: { get(name: string): string | null };
}

export type DriveFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<DriveFetchResponse>;

export function classifyDriveHttpError(
  status: number,
  bodyText: string,
): DriveErrorReason {
  const body = bodyText.toLowerCase();
  if (status === 401) return "auth_failed";
  if (status === 403) {
    if (body.includes("supportsteamdrivesrequired")) return "provider_request_invalid";
    if (
      body.includes("accessnotconfigured") ||
      body.includes("service_disabled") ||
      body.includes("has not been used in project") ||
      body.includes("it is disabled")
    ) return "drive_api_disabled";
    if (
      body.includes("insufficient") ||
      body.includes("scope_insufficient") ||
      body.includes("insufficientpermissions")
    ) return "insufficient_scope";
    return "provider_unavailable";
  }
  if (status === 404 || status === 410) return "file_not_found";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
}

export function buildDriveUrl(
  api: "drive" | "docs",
  path: string,
  query: Record<string, string | undefined> = {},
): URL {
  const base = api === "drive" ? DRIVE_API : DOCS_API;
  let url: URL;
  try {
    url = new URL(`${base}${path}`);
  } catch {
    throw new DriveError("network_failure", "Google Drive request URL was invalid");
  }
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url;
}

export async function getGoogleDriveConnection(
  userId: string,
): Promise<DriveConnectionRef | null> {
  return getPrisma().integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: GOOGLE_DRIVE_PROVIDER } },
    select: { id: true, status: true },
  });
}

async function markConnection(
  connectionId: string,
  status: "expired" | "error",
): Promise<void> {
  try {
    await getPrisma().integrationConnection.update({
      where: { id: connectionId },
      data: { status },
    });
  } catch {
    logger.error("googleDrive.connection health update failed", {
      provider: GOOGLE_DRIVE_PROVIDER,
    });
  }
}

async function refreshConnectionToken(
  connectionId: string,
  refreshToken: string | null,
  fetchImpl?: FetchLike,
): Promise<string> {
  if (!refreshToken) {
    await markConnection(connectionId, "expired");
    throw new DriveError("no_refresh_token");
  }
  try {
    const refreshed = await refreshAccessToken({
      config: getGoogleDriveOAuthConfig(),
      refreshToken,
      fetchImpl,
    });
    await storeRefreshedCredential(connectionId, refreshed);
    return refreshed.accessToken;
  } catch (error) {
    const invalid = error instanceof Error && /invalid_grant/i.test(error.message);
    if (invalid) await markConnection(connectionId, "expired");
    throw new DriveError(invalid ? "invalid_grant" : "token_refresh_failed");
  }
}

export async function getValidDriveAccessToken(
  connectionId: string,
  fetchImpl?: FetchLike,
): Promise<string> {
  let credential;
  try {
    credential = await readCredentialSecrets(connectionId);
  } catch (error) {
    if (error instanceof TokenVaultConfigError) {
      throw new DriveError("credential_decrypt_failed");
    }
    throw error;
  }
  if (!credential || (!credential.accessToken && !credential.refreshToken)) {
    throw new DriveError("not_connected");
  }
  const validUntil = credential.accessTokenExpiresAt?.getTime() ?? 0;
  if (credential.accessToken && validUntil > Date.now() + EXPIRY_SKEW_MS) {
    return credential.accessToken;
  }
  return refreshConnectionToken(connectionId, credential.refreshToken, fetchImpl);
}

async function forceRefresh(
  connectionId: string,
  fetchImpl?: FetchLike,
): Promise<string> {
  const credential = await readCredentialSecrets(connectionId);
  return refreshConnectionToken(connectionId, credential?.refreshToken ?? null, fetchImpl);
}

function retryAfterMs(response: DriveFetchResponse): number | null {
  const raw = response.headers?.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, 60_000)
    : null;
}

export async function driveHttpRequest(input: {
  accessToken: string;
  api?: "drive" | "docs";
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  fetchImpl?: DriveFetchLike;
  maxBytes?: number;
}): Promise<string> {
  if (!input.accessToken || /[^\x20-\x7e]/.test(input.accessToken)) {
    throw new DriveError("auth_failed", "Invalid Google Drive access token");
  }
  const method = input.method ?? "GET";
  const url = buildDriveUrl(input.api ?? "drive", input.path, input.query);
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.accessToken}`,
  };
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRIVE_PROVIDER_TIMEOUT_MS);
  let response: DriveFetchResponse;
  try {
    response = await (input.fetchImpl ?? (fetch as unknown as DriveFetchLike))(
      url.toString(),
      { method, headers, ...(body !== undefined ? { body } : {}), signal: controller.signal },
    );
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new DriveError("drive_timeout");
    }
    throw new DriveError("network_failure");
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) {
    const reason = classifyDriveHttpError(response.status, text.slice(0, 500));
    logger.warn("googleDrive.provider response", {
      api: input.api ?? "drive",
      method,
      path: safeProviderPath(input.path),
      status: response.status,
      reason,
      googleReason: safeGoogleErrorReason(text.slice(0, 500)),
      queryKeys: Object.keys(input.query ?? {}).sort(),
    });
    throw new DriveError(
      reason,
      `Google Drive request failed (${response.status})`,
      response.status,
      retryAfterMs(response),
    );
  }
  const maxBytes = input.maxBytes ?? DRIVE_MAX_RESPONSE_BYTES;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new DriveError("response_too_large");
  }
  return text;
}

export async function driveJsonRequest<T>(
  input: Parameters<typeof driveHttpRequest>[0],
): Promise<T> {
  const text = await driveHttpRequest(input);
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DriveError("malformed_provider_response");
  }
}

/** Exactly one refresh after a genuine 401; request replay can be disabled for writes. */
export async function withDriveAuthRetry<T>(input: {
  connectionId: string;
  run: (accessToken: string) => Promise<T>;
  tokenFetchImpl?: FetchLike;
  replayAfterAuthFailure?: boolean;
}): Promise<T> {
  const token = await getValidDriveAccessToken(input.connectionId, input.tokenFetchImpl);
  try {
    return await input.run(token);
  } catch (error) {
    if (!(error instanceof DriveError) || error.reason !== "auth_failed") throw error;
    const refreshed = await forceRefresh(input.connectionId, input.tokenFetchImpl);
    if (input.replayAfterAuthFailure === false) {
      // Refresh prepares the next idempotent user attempt, but an ambiguous write
      // is never replayed automatically after its request left Hula.
      throw new DriveError("auth_failed", undefined, error.httpStatus);
    }
    try {
      return await input.run(refreshed);
    } catch (retryError) {
      if (retryError instanceof DriveError && retryError.reason === "auth_failed") {
        await markConnection(input.connectionId, "expired");
        throw new DriveError("invalid_grant", undefined, retryError.httpStatus);
      }
      throw retryError;
    }
  }
}

export async function driveRequestForUser<T>(input: {
  userId: string;
  mutation?: boolean;
  run: (accessToken: string, connectionId: string) => Promise<T>;
  sleep?: (ms: number) => Promise<void>;
  tokenFetchImpl?: FetchLike;
}): Promise<T> {
  const connection = await getGoogleDriveConnection(input.userId);
  if (!connection || connection.status !== "connected") {
    throw new DriveError("not_connected");
  }
  const execute = () => withDriveAuthRetry({
    connectionId: connection.id,
    tokenFetchImpl: input.tokenFetchImpl,
    replayAfterAuthFailure: !input.mutation,
    run: (token) => input.run(token, connection.id),
  });
  try {
    return await execute();
  } catch (error) {
    // One bounded retry for safe reads only. Long Retry-After values are surfaced
    // immediately rather than stalling an iMessage route.
    if (
      !input.mutation &&
      error instanceof DriveError &&
      (error.reason === "provider_rate_limited" || error.reason === "provider_unavailable") &&
      (error.retryAfterMs ?? 0) <= 2_000
    ) {
      await (input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
        error.retryAfterMs ?? 250,
      );
      return execute();
    }
    throw error;
  }
}

export function isDriveReconnectReason(reason: DriveErrorReason): boolean {
  return reason === "no_refresh_token" || reason === "invalid_grant";
}
