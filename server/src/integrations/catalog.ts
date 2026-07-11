/**
 * Provider registry / catalog (Section 10).
 *
 * The single source of truth for which external providers Hula knows about and
 * their metadata — display name, category, auth style, default least-privilege
 * scopes, and the capabilities they will eventually unlock. This is METADATA
 * ONLY: no OAuth URLs are generated, no network calls happen, and nothing here
 * touches provider tokens. Real connect/OAuth flows are added in later sections.
 *
 * NOTE: this is deliberately separate from the legacy `registry.ts` (a Section 1
 * placeholder for agent-tool registration). This file is the Section 10 provider
 * catalog the `/v1/me/integrations/catalog` endpoint serves.
 */

/** Stable provider slugs. Used as the `provider` value on DB rows. */
export type ProviderId =
  | "google_calendar"
  | "gmail"
  | "zoom"
  | "notion"
  | "asana"
  | "slack"
  | "nylas"
  | "generic";

/** How a provider groups in the app's future integrations UI. */
export type ProviderCategory =
  | "calendar"
  | "email"
  | "meetings"
  | "productivity"
  | "communication"
  | "aggregator"
  | "generic";

/**
 * Whether a provider is merely planned, a wireable (but inert) stub, or actually
 * wired for READ-ONLY access (Section 11 — Google Calendar is the first).
 */
export type ProviderStatus = "planned" | "available_stub" | "available_readonly";

/** How a provider authenticates (no flow is implemented yet). */
export type ProviderAuthType = "oauth2" | "api_key" | "partner" | "none";

/** A single provider's static metadata. No secrets, no tokens, no URLs. */
export interface ProviderCatalogEntry {
  provider: ProviderId;
  displayName: string;
  category: ProviderCategory;
  status: ProviderStatus;
  authType: ProviderAuthType;
  /** Least-privilege default scopes we intend to request (not yet requested). */
  defaultScopes: string[];
  /** Capability slugs this provider will unlock once connected. */
  capabilities: string[];
  /** Short human note about the provider's current state / intent. */
  notes: string;
}

/**
 * The provider catalog. Ordered roughly by how soon we intend to build each.
 * `defaultScopes` are least-privilege placeholders documenting intent — nothing
 * requests them yet.
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    provider: "google_calendar",
    displayName: "Google Calendar",
    category: "calendar",
    status: "available_readonly",
    authType: "oauth2",
    // Least-privilege READ-ONLY. `calendar.readonly` covers listing calendars and
    // reading events. NO write scope is requested — Hula cannot create/edit/delete.
    defaultScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    capabilities: ["read_calendar_events", "list_calendars"],
    notes:
      "First live integration (Section 11). Read-only OAuth (Authorization Code + PKCE). No event writes.",
  },
  {
    provider: "gmail",
    displayName: "Gmail",
    category: "email",
    status: "planned",
    authType: "oauth2",
    defaultScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    capabilities: ["email.read", "email.draft", "email.send"],
    notes: "Read-first. Drafting/sending gated behind explicit user confirmation later.",
  },
  {
    provider: "zoom",
    displayName: "Zoom",
    category: "meetings",
    status: "planned",
    authType: "oauth2",
    defaultScopes: ["meeting:read"],
    capabilities: ["meetings.read", "meetings.create"],
    notes: "Meeting read/create planned.",
  },
  {
    provider: "notion",
    displayName: "Notion",
    category: "productivity",
    status: "planned",
    authType: "oauth2",
    defaultScopes: ["read_content"],
    capabilities: ["docs.read", "docs.write"],
    notes: "Workspace read/write planned.",
  },
  {
    provider: "asana",
    displayName: "Asana",
    category: "productivity",
    status: "planned",
    authType: "oauth2",
    defaultScopes: ["tasks:read"],
    capabilities: ["tasks.read", "tasks.write"],
    notes: "Task read/write planned.",
  },
  {
    provider: "slack",
    displayName: "Slack",
    category: "communication",
    status: "planned",
    authType: "oauth2",
    defaultScopes: ["channels:read"],
    capabilities: ["messages.read", "messages.send"],
    notes: "Read-first. Sending gated behind explicit confirmation later.",
  },
  {
    provider: "nylas",
    displayName: "Nylas",
    category: "aggregator",
    status: "planned",
    authType: "oauth2",
    defaultScopes: [],
    capabilities: ["calendar.read", "email.read", "contacts.read"],
    notes: "Aggregator option to reach calendar/email across many providers at once.",
  },
  {
    provider: "generic",
    displayName: "Generic",
    category: "generic",
    status: "available_stub",
    authType: "none",
    defaultScopes: [],
    capabilities: [],
    notes: "Internal test/stub provider. Never shown to real users; used by tests.",
  },
] as const;

/** Fast lookup by slug. */
const BY_ID = new Map<string, ProviderCatalogEntry>(
  PROVIDER_CATALOG.map((entry) => [entry.provider, entry]),
);

/** Return the full provider catalog (metadata only). */
export function listIntegrationCatalog(): readonly ProviderCatalogEntry[] {
  return PROVIDER_CATALOG;
}

/** Look up one provider's metadata, or undefined if the slug is unknown. */
export function getProvider(provider: string): ProviderCatalogEntry | undefined {
  return BY_ID.get(provider);
}

/** Whether a string is a known provider slug in the catalog. */
export function isKnownProvider(provider: string): provider is ProviderId {
  return BY_ID.has(provider);
}
