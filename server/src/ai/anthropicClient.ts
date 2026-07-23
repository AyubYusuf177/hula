import { env } from "../config/env";

/**
 * Minimal Anthropic Messages API client (Section 6).
 *
 * Uses the global `fetch` (Node 18+) so no HTTP/SDK dependency is added. The API
 * key comes from validated env and is NEVER logged or included in a thrown error.
 * Callers (the Hula brain) are responsible for catching failures and falling
 * back — this module only talks to the provider.
 */

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** A single turn in the model conversation. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export type AnthropicFailureReason =
  | "not_configured"
  | "invalid_request"
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "provider_error"
  | "malformed_response"
  | "empty_response";

/** A secret-safe failure that callers can classify without parsing provider text. */
export class AnthropicClientError extends Error {
  constructor(
    public readonly reason: AnthropicFailureReason,
    public readonly status?: number,
  ) {
    super(`anthropic_${reason}`);
    this.name = "AnthropicClientError";
  }
}

/** True only when an Anthropic API key is configured. */
export function isAnthropicConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * Call Anthropic and return the concatenated text of the reply. Throws a
 * redacted Error on a missing key, a non-2xx response, or an unparseable body.
 * The thrown message never contains the API key.
 */
export async function generateAnthropicText(params: {
  system: string;
  messages: AnthropicMessage[];
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<string> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AnthropicClientError("not_configured");
  }
  if (params.messages.length === 0) {
    throw new AnthropicClientError("invalid_request");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(params.timeoutMs ?? 30_000, 1_000), 60_000));
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL,
        max_tokens: params.maxTokens ?? 600,
        system: params.system,
        messages: params.messages,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AnthropicClientError("timeout");
    }
    throw new AnthropicClientError("network_error");
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    // Never copy the provider response body into an exception or application log.
    const reason = res.status === 429 ? "rate_limited" : "provider_error";
    throw new AnthropicClientError(reason, res.status);
  }

  let body: { content?: { type?: string; text?: string }[] };
  try {
    body = (await res.json()) as { content?: { type?: string; text?: string }[] };
  } catch {
    throw new AnthropicClientError("malformed_response", res.status);
  }

  const text = (body.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!text) {
    throw new AnthropicClientError("empty_response", res.status);
  }
  return text;
}
