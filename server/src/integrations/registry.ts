import type { Integration } from "./types";

/**
 * Integration registry.
 *
 * Section 1: an empty, typed registry. Real integrations register their
 * metadata + tools here once implemented. No integrations are wired yet.
 */
const integrations = new Map<string, Integration>();

export function registerIntegration(integration: Integration): void {
  integrations.set(integration.key, integration);
}

export function getIntegration(key: string): Integration | undefined {
  return integrations.get(key);
}

export function listIntegrations(): Integration[] {
  return Array.from(integrations.values());
}
