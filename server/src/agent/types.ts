import type { MessageContent } from "../channels/types";
import type { UserProfile } from "../users/types";

/**
 * Agent (the Hula "brain") types.
 *
 * Channel-agnostic: the agent receives normalized content plus context and
 * decides how to respond and which tools/actions to invoke. Section 1 defines
 * the shapes only — no model calls, no tool execution.
 */

/** Everything the agent needs to reason about a single turn. */
export interface AgentContext {
  clerkUserId: string;
  profile?: UserProfile;
  conversationId: string;
  /** The user's latest inbound content, already normalized. */
  input: MessageContent;
  /** Recent turns for short-term memory (most recent last). */
  history?: MessageContent[];
}

/** A tool the agent can call (integrations, reminders, actions, etc.). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON-schema-ish parameter description. Placeholder for Section 1. */
  parameters: Record<string, unknown>;
  /** Whether invoking this tool requires user approval first. */
  requiresApproval: boolean;
}

/** The agent's decision for a turn. */
export interface AgentResult {
  /** Content to send back to the user, if any. */
  reply?: MessageContent;
  /** Tool calls the agent wants to make. */
  toolCalls?: {
    toolName: string;
    arguments: Record<string, unknown>;
  }[];
}
