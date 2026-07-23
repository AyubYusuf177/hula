import { logger } from "../../../utils/logger";
import {
  getMicrosoftAccessToken,
  getMicrosoftConnection,
  MicrosoftConnectionError,
  refreshMicrosoftAccessToken,
} from "./client";
import { MICROSOFT_GRAPH_BASE_URL } from "./types";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_READ_RETRY_AFTER_SECONDS = 5;

export type MicrosoftGraphErrorReason =
  | "not_connected"
  | "reconnect_required"
  | "insufficient_capability"
  | "permission_denied"
  | "rate_limited"
  | "transient_provider_failure"
  | "malformed_provider_response"
  | "not_found"
  | "invalid_request"
  | "unsupported_content"
  | "unsupported_account"
  | "ambiguous_entity"
  | "response_too_large"
  | "timeout"
  | "network_failure"
  | "verification_inconclusive";

export class MicrosoftGraphError extends Error {
  constructor(
    public readonly reason: MicrosoftGraphErrorReason,
    public readonly httpStatus: number | null = null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(reason);
    this.name = "MicrosoftGraphError";
  }
}

export interface MicrosoftGraphResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}

export type MicrosoftGraphFetch = (
  url: string,
  init: RequestInit,
) => Promise<MicrosoftGraphResponse>;

export interface MicrosoftGraphRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path?: string;
  nextLink?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  capability:
    | "outlook_mail.read"
    | "outlook_mail.write"
    | "outlook_mail.send"
    | "outlook_calendar.read"
    | "outlook_calendar.write"
    | "onedrive.read"
    | "onedrive.write";
  responseKind?: "json" | "text" | "empty";
  readRetry?: boolean;
  headers?: Record<string, string>;
}

export interface MicrosoftGraphRequestDeps {
  fetchImpl?: MicrosoftGraphFetch;
  getToken?: typeof getMicrosoftAccessToken;
  refreshToken?: typeof refreshMicrosoftAccessToken;
  getConnection?: typeof getMicrosoftConnection;
  sleep?: (ms: number) => Promise<void>;
}

function graphUrl(options: MicrosoftGraphRequestOptions): string {
  const raw = options.nextLink ?? `${MICROSOFT_GRAPH_BASE_URL}${options.path ?? ""}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MicrosoftGraphError("invalid_request");
  }
  const base = new URL(MICROSOFT_GRAPH_BASE_URL);
  if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)) {
    throw new MicrosoftGraphError("invalid_request");
  }
  if (!options.nextLink) {
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function retryAfter(response: MicrosoftGraphResponse): number | null {
  const raw = response.headers?.get("retry-after");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

function classifyStatus(status: number, response: MicrosoftGraphResponse): MicrosoftGraphError {
  if (status === 401) return new MicrosoftGraphError("reconnect_required", status);
  if (status === 403) return new MicrosoftGraphError("permission_denied", status);
  if (status === 404) return new MicrosoftGraphError("not_found", status);
  if (status === 429) return new MicrosoftGraphError("rate_limited", status, retryAfter(response));
  if (status === 400 || status === 405 || status === 422) {
    return new MicrosoftGraphError("invalid_request", status);
  }
  if (status >= 500) return new MicrosoftGraphError("transient_provider_failure", status);
  return new MicrosoftGraphError("malformed_provider_response", status);
}

function mapConnectionError(error: unknown): MicrosoftGraphError {
  if (!(error instanceof MicrosoftConnectionError)) {
    return new MicrosoftGraphError("network_failure");
  }
  if (error.reason === "not_connected") return new MicrosoftGraphError("not_connected");
  if (error.reason === "reconnect_required" || error.reason === "credential_decrypt_failed") {
    return new MicrosoftGraphError("reconnect_required");
  }
  if (error.reason === "timeout") return new MicrosoftGraphError("timeout");
  return new MicrosoftGraphError("network_failure");
}

async function callGraph(
  url: string,
  token: string,
  options: MicrosoftGraphRequestOptions,
  fetchImpl: MicrosoftGraphFetch,
): Promise<MicrosoftGraphResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    try {
      return await fetchImpl(url, {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "Prefer": 'IdType="ImmutableId"',
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      throw new MicrosoftGraphError(
        error instanceof Error && error.name === "AbortError" ? "timeout" : "network_failure",
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/** A secret-safe, capability-gated Graph request. Mutations are never retried. */
export async function microsoftGraphRequest<T>(
  userId: string,
  options: MicrosoftGraphRequestOptions,
  deps: MicrosoftGraphRequestDeps = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as MicrosoftGraphFetch);
  const connection = await (deps.getConnection ?? getMicrosoftConnection)(userId);
  if (!connection || connection.status !== "connected") {
    throw new MicrosoftGraphError("not_connected");
  }
  if (!connection.capabilities.includes(options.capability)) {
    throw new MicrosoftGraphError("insufficient_capability");
  }
  const url = graphUrl(options);
  let token: string;
  try {
    token = await (deps.getToken ?? getMicrosoftAccessToken)(userId);
  } catch (error) {
    throw mapConnectionError(error);
  }

  let response = await callGraph(url, token, options, fetchImpl);
  if (response.status === 401) {
    try {
      token = await (deps.refreshToken ?? refreshMicrosoftAccessToken)(userId);
    } catch (error) {
      throw mapConnectionError(error);
    }
    response = await callGraph(url, token, options, fetchImpl);
  }

  if (
    response.status === 429 &&
    method === "GET" &&
    options.readRetry !== false
  ) {
    const seconds = retryAfter(response);
    if (seconds !== null && seconds <= MAX_READ_RETRY_AFTER_SECONDS) {
      await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(seconds * 1000);
      response = await callGraph(url, token, options, fetchImpl);
    }
  }

  if (!response.ok) {
    const error = classifyStatus(response.status, response);
    logger.info("microsoft.graph request failed", {
      method,
      status: response.status,
      errorCode: error.reason,
      retryAfterSeconds: error.retryAfterSeconds,
    });
    throw error;
  }
  const raw = await response.text();
  if (options.responseKind === "empty") return undefined as T;
  if (options.responseKind === "text") return raw as T;
  if (!raw.trim()) throw new MicrosoftGraphError("malformed_provider_response", response.status);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new MicrosoftGraphError("malformed_provider_response", response.status);
  }
}

export function isSafeMicrosoftNextLink(value: string): boolean {
  try {
    const url = new URL(value);
    const base = new URL(MICROSOFT_GRAPH_BASE_URL);
    return url.origin === base.origin && url.pathname.startsWith(`${base.pathname}/`);
  } catch {
    return false;
  }
}
