/**
 * Action approval placeholder types.
 *
 * Sensitive or irreversible actions the agent wants to take are gated behind an
 * explicit user approval. Section 1: types only — no approval routing, no
 * execution.
 */
export type ActionApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

export interface ActionApproval {
  id: string;
  clerkUserId: string;
  conversationId?: string;
  /** The tool/action the agent wants to run. */
  toolName: string;
  /** Arguments the agent proposes to run the action with. */
  arguments: Record<string, unknown>;
  /** Human-readable summary shown to the user for approval. */
  summary: string;
  status: ActionApprovalStatus;
  createdAt: string; // ISO 8601
  resolvedAt?: string; // ISO 8601
  expiresAt?: string; // ISO 8601
}
