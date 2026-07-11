/**
 * Future action policy foundation (Section 10).
 *
 * This defines HOW Hula will be allowed to act on a connected provider — it is a
 * pure decision layer, with NO real action execution behind it yet. The intent
 * is to make high-impact actions impossible-by-default and to force explicit
 * user consent before Hula ever writes/sends on someone's behalf.
 *
 * Nothing here performs an action, calls a provider, or touches tokens.
 */

/** Risk levels, from safest to most dangerous. */
export type ActionRisk =
  | "read"
  | "draft"
  | "write"
  | "send"
  | "purchase"
  | "destructive";

/** Ordered risk ladder (index = severity). */
export const ACTION_RISK_LEVELS: readonly ActionRisk[] = [
  "read",
  "draft",
  "write",
  "send",
  "purchase",
  "destructive",
] as const;

/** The inputs a policy decision is made from. */
export interface ActionPolicyInput {
  risk: ActionRisk;
  /** Is the provider currently connected for this user? */
  providerConnected: boolean;
  /** Does the connection actually hold the scope this action needs? */
  scopeGranted: boolean;
  /** Has the user explicitly confirmed THIS action (not just connected)? */
  userConfirmed?: boolean;
}

/** The outcome of a policy check. */
export interface ActionPolicyDecision {
  allowed: boolean;
  /** Machine-readable reason, safe to log. */
  reason:
    | "ok"
    | "not_connected"
    | "scope_not_granted"
    | "requires_confirmation"
    | "not_allowed_yet";
  /** True when the only thing missing is explicit user confirmation. */
  needsConfirmation: boolean;
}

/** Risks that require an explicit per-action user confirmation (once enabled). */
const CONFIRM_REQUIRED: ReadonlySet<ActionRisk> = new Set([
  "write",
  "send",
]);

/** Risks that are categorically NOT permitted in this foundation. */
const HARD_BLOCKED: ReadonlySet<ActionRisk> = new Set([
  "purchase",
  "destructive",
]);

/**
 * Decide whether an action may proceed. PURE and side-effect free.
 *
 * Rules (foundation):
 *   - Reads run only if the provider is connected AND the scope is granted.
 *   - Drafts follow the same connected + scope rule (they don't leave Hula).
 *   - Writes/sends additionally require an explicit user confirmation.
 *   - Purchases and destructive actions are never allowed yet.
 *
 * Because no provider can actually be connected yet, this currently denies
 * everything in practice — it exists so real actions plug into one clear gate.
 */
export function evaluateActionPolicy(
  input: ActionPolicyInput,
): ActionPolicyDecision {
  if (HARD_BLOCKED.has(input.risk)) {
    return { allowed: false, reason: "not_allowed_yet", needsConfirmation: false };
  }

  if (!input.providerConnected) {
    return { allowed: false, reason: "not_connected", needsConfirmation: false };
  }

  if (!input.scopeGranted) {
    return { allowed: false, reason: "scope_not_granted", needsConfirmation: false };
  }

  if (CONFIRM_REQUIRED.has(input.risk) && !input.userConfirmed) {
    return {
      allowed: false,
      reason: "requires_confirmation",
      needsConfirmation: true,
    };
  }

  return { allowed: true, reason: "ok", needsConfirmation: false };
}
