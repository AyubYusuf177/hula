import { logger } from "../../../utils/logger";

export type SlackFetch = typeof fetch;

export interface SlackCallOptions {
  mutation?: boolean;
  form?: boolean;
  retryRateLimit?: boolean;
}

export interface SlackClientOptions {
  fetchImpl?: SlackFetch;
  baseUrl?: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxAutomaticRetryAfterMs?: number;
}

export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly ambiguous = false,
    readonly diagnostics?: SlackErrorDiagnostics,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

export interface SlackErrorDiagnostics {
  needed?: string;
  provided?: string;
  warning?: string;
  messages?: string[];
}

function safeErrorDiagnostics(envelope: Record<string, unknown> | null): SlackErrorDiagnostics | undefined {
  if (!envelope) return undefined;
  const metadata = envelope.response_metadata && typeof envelope.response_metadata === "object"
    ? envelope.response_metadata as Record<string, unknown>
    : null;
  const clean = (value: unknown) => typeof value === "string"
    ? value
        .replace(/xox[a-z]-[a-zA-Z0-9-]+/gi, "[redacted]")
        .replace(/https?:\/\/\S+|\b\S+@\S+\b/g, "[redacted]")
        .replace(/[^a-zA-Z0-9_.,:\[\] -]/g, "")
        .slice(0, 300)
    : undefined;
  const diagnostics: SlackErrorDiagnostics = {
    needed: clean(envelope.needed),
    provided: clean(envelope.provided),
    warning: clean(envelope.warning),
    messages: Array.isArray(metadata?.messages)
      ? metadata.messages.map(clean).filter((value): value is string => Boolean(value)).slice(0, 10)
      : undefined,
  };
  return Object.values(diagnostics).some((value) => value !== undefined) ? diagnostics : undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function firstArray<T>(envelope: Record<string, unknown>): T[] {
  for (const value of Object.values(envelope)) {
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

export class SlackClient {
  private readonly fetchImpl: SlackFetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAutomaticRetryAfterMs: number;

  constructor(
    private readonly token: string,
    options: SlackClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://slack.com/api";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAutomaticRetryAfterMs = options.maxAutomaticRetryAfterMs ?? 3_000;
  }

  async call<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: SlackCallOptions = {},
  ): Promise<T> {
    const startedAt = Date.now();
    logger.info("slack.provider method", { provider: "slack", method, mutation: Boolean(options.mutation) });
    const attempts = options.retryRateLimit && !options.mutation ? 2 : 1;
    let lastError: SlackApiError | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await this.callOnce<T>(method, params, options);
        logger.info("slack.provider duration", {
          provider: "slack", method, mutation: Boolean(options.mutation),
          durationMs: Date.now() - startedAt, outcome: "succeeded", attempt: attempt + 1,
        });
        return result;
      } catch (error) {
        if (!(error instanceof SlackApiError)) throw error;
        lastError = error;
        if (error.status !== 429 || error.retryAfterMs === undefined || attempt + 1 >= attempts) {
          logger.info("slack.provider duration", {
            provider: "slack", method, mutation: Boolean(options.mutation),
            durationMs: Date.now() - startedAt, outcome: "failed", attempt: attempt + 1,
          });
          throw error;
        }
        if (error.retryAfterMs > this.maxAutomaticRetryAfterMs) {
          logger.info("slack.rate_limit deferred", { method, retryAfterMs: error.retryAfterMs });
          logger.info("slack.provider duration", {
            provider: "slack", method, mutation: Boolean(options.mutation),
            durationMs: Date.now() - startedAt, outcome: "deferred", attempt: attempt + 1,
          });
          throw error;
        }
        logger.info("slack.rate_limit retry", { method, retryAfterMs: error.retryAfterMs });
        await this.sleep(error.retryAfterMs);
      }
    }

    throw lastError ?? new SlackApiError("Slack request failed", "unknown_error", 0);
  }

  async paginate<T extends object>(
    method: string,
    params: Record<string, unknown>,
    resultLimit = 100,
    maxPages = 10,
    options: Pick<SlackCallOptions, "form"> = {},
  ): Promise<T[]> {
    const boundedLimit = Math.min(Math.max(resultLimit, 1), 500);
    const commerciallyLimited = method === "conversations.history" || method === "conversations.replies";
    // Affected non-Marketplace installations receive one call per minute and at
    // most 15 objects. Never immediately chase a cursor and manufacture a 429.
    const boundedPages = commerciallyLimited ? 1 : Math.min(Math.max(maxPages, 1), 20);
    const output: T[] = [];
    let cursor = "";

    for (let pageNumber = 0; pageNumber < boundedPages && output.length < boundedLimit; pageNumber += 1) {
      const pageLimit = commerciallyLimited
        ? Math.min(15, boundedLimit - output.length)
        : Math.min(200, boundedLimit - output.length);
      const envelope = await this.call<Record<string, unknown>>(
        method,
        { ...params, limit: pageLimit, ...(cursor ? { cursor } : {}) },
        { retryRateLimit: true, form: options.form },
      );
      output.push(...firstArray<T>(envelope));
      const metadata = envelope.response_metadata;
      cursor =
        metadata && typeof metadata === "object" &&
        typeof (metadata as Record<string, unknown>).next_cursor === "string"
          ? String((metadata as Record<string, unknown>).next_cursor)
          : "";
      if (!cursor) break;
    }

    return output.slice(0, boundedLimit);
  }

  safeLog(method: string, params: Record<string, unknown>): Record<string, unknown> {
    return {
      provider: "slack",
      method,
      parameterNames: Object.keys(params).sort(),
    };
  }

  private async callOnce<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    options: SlackCallOptions,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let body: string;

    if (options.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) form.set(key, String(value));
      }
      body = form.toString();
    } else {
      headers["Content-Type"] = "application/json;charset=utf-8";
      body = JSON.stringify(params);
    }

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
      } catch (error) {
        const timeout = error instanceof Error && error.name === "AbortError";
        throw new SlackApiError(
          timeout ? "Slack request timed out" : "Slack network request failed",
          timeout ? "timeout" : "network_error",
          0,
          undefined,
          Boolean(options.mutation),
        );
      }

      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      let raw: unknown;
      try {
        raw = JSON.parse(await response.text());
      } catch {
        throw new SlackApiError(
          "Malformed Slack response",
          "malformed_response",
          response.status,
          retryAfterMs,
          Boolean(options.mutation),
        );
      }

      const envelope = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
      if (!response.ok || !envelope || envelope.ok !== true) {
        const code = typeof envelope?.error === "string"
          ? envelope.error
          : `http_${response.status}`;
        throw new SlackApiError(
          "Slack API request failed",
          code,
          response.status,
          retryAfterMs,
          Boolean(options.mutation) && (response.status === 0 || response.status >= 500),
          safeErrorDiagnostics(envelope),
        );
      }
      return envelope as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
