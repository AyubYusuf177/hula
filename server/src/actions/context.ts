import { listUserIntegrationConnections } from "../integrations/connections";
import type { ActionPolicyContext } from "./policy";

/**
 * Build a safe policy context (Section 12) from the user's stored connections.
 *
 * Reads only the app-safe connection views (status, granted scopes, capabilities)
 * — NEVER tokens — and shapes them into the pure `ActionPolicyContext` the policy
 * engine consumes. Only `connected` providers are included, so a disconnected or
 * unhealthy connection can never satisfy an action.
 */
export async function buildActionPolicyContext(
  userId: string,
  opts: { userConfirmed?: boolean } = {},
): Promise<ActionPolicyContext> {
  const connections = await listUserIntegrationConnections(userId);

  const connectedProviders: string[] = [];
  const grantedScopesByProvider: Record<string, string[]> = {};
  const capabilitiesByProvider: Record<string, string[]> = {};

  for (const conn of connections) {
    if (conn.status !== "connected") continue;
    connectedProviders.push(conn.provider);
    grantedScopesByProvider[conn.provider] = conn.grantedScopes;
    capabilitiesByProvider[conn.provider] = conn.capabilities;
  }

  return {
    connectedProviders,
    grantedScopesByProvider,
    capabilitiesByProvider,
    userConfirmed: opts.userConfirmed,
  };
}
