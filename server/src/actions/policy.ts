import { getProvider, type ProviderId } from "../integrations/catalog";
import { evaluateActionPolicy } from "../integrations/policy";
import type { ActionDefinition } from "./registry";

/**
 * Action policy engine (Section 12).
 *
 * The single gate every action passes through before it can run. It is PURE and
 * side-effect free: given an action definition and a snapshot of the user's
 * connection state, it decides whether the action may proceed, whether it needs
 * a connection/scope, and whether it needs explicit confirmation. It calls no
 * provider, touches no token, and never executes anything.
 *
 * It layers on the Section 10 risk gate (`evaluateActionPolicy`) so the hard
 * rules stay in one place: purchases/destructive actions are blocked, and
 * writes/sends require confirmation.
 */

/** A safe snapshot of a user's connections, used to make a policy decision. */
export interface ActionPolicyContext {
  /** Provider slugs the user currently has `connected`. */
  connectedProviders: string[];
  /** Granted scopes per connected provider slug. */
  grantedScopesByProvider: Record<string, string[]>;
  /** Capabilities per connected provider slug. */
  capabilitiesByProvider: Record<string, string[]>;
  /** True only when the user has explicitly confirmed THIS action. */
  userConfirmed?: boolean;
}

/** Machine-readable block reason, safe to log. */
export type ActionBlockReason =
  | "disabled"
  | "not_implemented"
  | "needs_connection"
  | "needs_scope"
  | "needs_confirmation"
  | "not_allowed_yet";

/** The outcome of an action policy check. */
export interface ActionPolicyResult {
  allowed: boolean;
  needsConfirmation: boolean;
  needsConnection: boolean;
  needsScope: boolean;
  /** The provider slug chosen to satisfy the action, when one applies. */
  provider?: string;
  blockedReason?: ActionBlockReason;
  /** An honest, user-facing message to send when the action can't run. */
  userMessage?: string;
}

const DENY: Omit<ActionPolicyResult, "blockedReason" | "userMessage" | "provider"> = {
  allowed: false,
  needsConfirmation: false,
  needsConnection: false,
  needsScope: false,
};

/** Provider display name from the catalog, falling back to the raw slug. */
function providerDisplayName(provider: string | undefined): string {
  if (!provider) return "that app";
  return getProvider(provider)?.displayName ?? provider;
}

/**
 * Choose the provider that can satisfy an action: the first of the action's
 * `providerTypes` that the user currently has connected, else undefined. Actions
 * with no `providerTypes` need no provider connection.
 */
function chooseProvider(
  action: ActionDefinition,
  ctx: ActionPolicyContext,
): { provider?: ProviderId; requiresProvider: boolean; anyConnected: boolean } {
  if (action.providerTypes.length === 0) {
    return { requiresProvider: false, anyConnected: false };
  }
  const connected = action.providerTypes.find((p) =>
    ctx.connectedProviders.includes(p),
  );
  return {
    provider: connected,
    requiresProvider: true,
    anyConnected: connected !== undefined,
  };
}

function hasAll(granted: string[] | undefined, required: string[]): boolean {
  if (required.length === 0) return true;
  const set = new Set(granted ?? []);
  return required.every((r) => set.has(r));
}

/**
 * Decide whether an action may proceed for a user. PURE.
 *
 * Order of checks (most-fundamental first):
 *   1. enabled / implemented — an off or stubbed action can never run.
 *   2. connection — a provider action needs its provider connected.
 *   3. scopes + capabilities — the connection must actually hold them.
 *   4. risk gate — purchases/destructive blocked; writes/sends need confirmation.
 *
 * Because every write/send action is currently a stub, this returns
 * `not_implemented` for them today; the risk/confirmation logic is exercised so
 * it is ready the moment an action flips to `implemented + enabled`.
 */
export function evaluateActionForUser(
  action: ActionDefinition,
  ctx: ActionPolicyContext,
): ActionPolicyResult {
  if (!action.enabled) {
    return {
      ...DENY,
      blockedReason: "disabled",
      userMessage: action.userFacingDescription,
    };
  }
  if (!action.implemented) {
    return {
      ...DENY,
      blockedReason: "not_implemented",
      userMessage: action.userFacingDescription,
    };
  }

  const { provider, requiresProvider, anyConnected } = chooseProvider(action, ctx);

  if (requiresProvider && !anyConnected) {
    const name = providerDisplayName(action.providerTypes[0]);
    return {
      ...DENY,
      needsConnection: true,
      blockedReason: "needs_connection",
      userMessage: `You'll need to connect ${name} first for that.`,
    };
  }

  if (requiresProvider && provider) {
    const scopesOk = hasAll(ctx.grantedScopesByProvider[provider], action.requiredScopes);
    const capsOk = hasAll(
      ctx.capabilitiesByProvider[provider],
      action.requiredCapabilities,
    );
    if (!scopesOk || !capsOk) {
      return {
        ...DENY,
        provider,
        needsScope: true,
        blockedReason: "needs_scope",
        userMessage: `I don't have the right permission on your ${providerDisplayName(provider)} connection for that yet.`,
      };
    }
  }

  // Risk gate (Section 10). Provider + scope are satisfied at this point, so we
  // pass them as granted and let the ladder decide confirmation / hard blocks.
  const risk = evaluateActionPolicy({
    risk: action.riskLevel,
    providerConnected: !requiresProvider || anyConnected,
    scopeGranted: true,
    userConfirmed: ctx.userConfirmed,
  });

  if (risk.reason === "not_allowed_yet") {
    return {
      ...DENY,
      provider,
      blockedReason: "not_allowed_yet",
      userMessage: "That's not something I'm able to do.",
    };
  }

  if (risk.needsConfirmation || (action.confirmationRequired && !ctx.userConfirmed)) {
    return {
      ...DENY,
      provider,
      needsConfirmation: true,
      blockedReason: "needs_confirmation",
    };
  }

  return {
    allowed: true,
    needsConfirmation: false,
    needsConnection: false,
    needsScope: false,
    provider,
  };
}
