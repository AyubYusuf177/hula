import type { ToolDefinition } from "../agent/types";

/**
 * Integration placeholder types.
 *
 * Integrations connect the user's external apps/data sources (calendar, email,
 * etc.) and expose tools the agent can call. Section 1: types + registry shape
 * only — no OAuth, no live connections.
 */
export type IntegrationStatus =
  | "available"
  | "connected"
  | "error"
  | "disconnected";

/** A connectable integration a user can enable. */
export interface Integration {
  /** Stable slug, e.g. "google_calendar". */
  key: string;
  displayName: string;
  description: string;
  status: IntegrationStatus;
  /** Tools this integration contributes to the agent when connected. */
  tools: ToolDefinition[];
}

/** A user's connection to an integration (placeholder — no tokens stored). */
export interface UserIntegration {
  id: string;
  clerkUserId: string;
  integrationKey: string;
  status: IntegrationStatus;
  connectedAt?: string; // ISO 8601
}
