import { logger } from "../utils/logger";
import type { AnthropicMessage } from "./anthropicClient";
import { generateAnthropicText, isAnthropicConfigured } from "./anthropicClient";
import type { HulaPromptContext } from "./prompts";
import { buildHulaSystemPrompt } from "./prompts";

/**
 * The Hula brain (Section 6).
 *
 * The smallest useful AI pipeline: take a linked user's recent message history,
 * ask Anthropic Claude for a short helpful reply, and return plain text. Every
 * failure path (no key, provider error, rate limit, empty history) resolves to a
 * safe fallback so the webhook never crashes and no secret is ever logged.
 *
 * Only NORMAL messages from already-linked users reach here — the connect-code
 * and unknown-sender flows stay deterministic in the webhook and never call this.
 */

/** A single stored turn, normalized for the brain (most recent last). */
export interface BrainMessage {
  role: "user" | "assistant";
  text: string;
}

/** Sent when the brain can't produce a real reply. Contains no internals. */
export const FALLBACK_REPLY =
  "I’m connected and listening. My brain is being upgraded right now.";

/** Max tokens for a reply — kept small to keep messages text-friendly. */
const MAX_REPLY_TOKENS = 600;

/**
 * Pure: turn oldest-first brain turns into a valid Anthropic message list.
 * Anthropic requires the list to start and end with a user turn. This drops
 * empty turns, trims leading/trailing assistant turns, and collapses consecutive
 * same-role turns so the shape is always valid. Returns `[]` when nothing usable
 * remains (the caller then falls back).
 */
export function toAnthropicMessages(history: BrainMessage[]): AnthropicMessage[] {
  // Drop turns with no usable text.
  const cleaned = history
    .map((m) => ({ role: m.role, text: m.text.trim() }))
    .filter((m) => m.text.length > 0);

  // Trim leading assistant turns (list must start with a user turn).
  let start = 0;
  while (start < cleaned.length && cleaned[start]?.role === "assistant") start += 1;
  // Trim trailing assistant turns (list must end with a user turn).
  let end = cleaned.length;
  while (end > start && cleaned[end - 1]?.role === "assistant") end -= 1;

  const trimmed = cleaned.slice(start, end);
  if (trimmed.length === 0) return [];

  // Collapse consecutive same-role turns into a single message.
  const result: AnthropicMessage[] = [];
  for (const turn of trimmed) {
    const last = result[result.length - 1];
    if (last && last.role === turn.role) {
      last.content = `${last.content}\n\n${turn.text}`;
    } else {
      result.push({ role: turn.role, content: turn.text });
    }
  }
  return result;
}

/** The generator dependency, injectable so tests never hit the network. */
export type TextGenerator = (params: {
  system: string;
  messages: AnthropicMessage[];
  maxTokens?: number;
}) => Promise<string>;

/**
 * Generate a short Hula reply for a normal message from a linked user.
 *
 * Returns the reply plus whether the safe fallback was used. Never throws — any
 * missing key, provider error, or empty input resolves to the fallback with a
 * safe (masked, no-secret) log line.
 *
 * `generate` is injectable purely for tests; production uses the real Anthropic
 * client by default.
 */
export async function generateHulaReply(params: {
  /** Recent conversation turns, oldest-first, ending with the user's message. */
  history: BrainMessage[];
  context?: HulaPromptContext;
  generate?: TextGenerator;
}): Promise<{ reply: string; usedFallback: boolean }> {
  const generate = params.generate ?? generateAnthropicText;
  const configured = params.generate ? true : isAnthropicConfigured();

  if (!configured) {
    logger.warn("hulaBrain.reply fallback: provider not configured");
    return { reply: FALLBACK_REPLY, usedFallback: true };
  }

  const messages = toAnthropicMessages(params.history);
  if (messages.length === 0) {
    logger.warn("hulaBrain.reply fallback: no usable message history");
    return { reply: FALLBACK_REPLY, usedFallback: true };
  }

  try {
    const system = buildHulaSystemPrompt(params.context);
    const text = await generate({ system, messages, maxTokens: MAX_REPLY_TOKENS });
    const reply = text.trim();
    if (!reply) {
      logger.warn("hulaBrain.reply fallback: empty provider reply");
      return { reply: FALLBACK_REPLY, usedFallback: true };
    }
    return { reply, usedFallback: false };
  } catch (err) {
    // Safe error only — never the key or raw provider payload.
    logger.error("hulaBrain.reply fallback: provider error", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return { reply: FALLBACK_REPLY, usedFallback: true };
  }
}
