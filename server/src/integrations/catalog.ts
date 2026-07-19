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
  | "todoist"
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
    // Section 15: request BOTH the read-only scope (list calendars) AND the
    // write scope (`calendar.events`) so a newly connected user can have Hula
    // create/update/delete events on their behalf. `calendar.events` also grants
    // event reads, so the read path keeps working. A connection made before this
    // change holds only `calendar.readonly` and must be reconnected to write.
    defaultScopes: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    capabilities: ["read_calendar_events", "list_calendars", "write_calendar_events"],
    notes:
      "Live integration. Read (Section 11) + create/update/delete events (Section 15) via OAuth (Authorization Code + PKCE). Writes require the calendar.events scope.",
  },
  {
    provider: "gmail",
    displayName: "Gmail",
    category: "email",
    status: "available_readonly",
    authType: "oauth2",
    // Section 16: the READ-ONLY scope (list/read metadata) PLUS the least-privilege
    // WRITE scope `gmail.compose` (create/update/delete drafts + send).
    //
    // Section 17 adds `gmail.modify`, required by messages.modify/trash/untrash —
    // Google's per-method reference does NOT accept `gmail.compose` for those. It is
    // ADDED, never a replacement: readonly and compose still back search, drafts,
    // and sending, so a user who declines `gmail.modify` keeps every earlier
    // capability and only message management refuses (with a reconnect message).
    //
    // `https://mail.google.com/` is deliberately NOT requested: it additionally
    // grants permanent deletion bypassing the trash, which Hula does not implement.
    defaultScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    capabilities: ["email.read", "email.draft", "email.send", "email.modify"],
    notes:
      "Live integration. Read (Section 14) + draft/send (Section 16) + search, draft lifecycle, and message management (Section 17) via OAuth (Authorization Code + PKCE). Drafting/sending requires gmail.compose; marking/starring/archiving/trashing requires gmail.modify. Every send, draft deletion, and trash needs explicit confirmation.",
  },
  {
    provider: "todoist",
    displayName: "Todoist",
    category: "productivity",
    status: "available_readonly",
    authType: "oauth2",
    // Section 19. Todoist scopes are COARSE and COMMA-separated (unlike Google's
    // space-separated, per-method scopes) — the exact names come from the current
    // official v1 documentation:
    //
    //   data:read       read-only access to application data
    //   data:read_write read AND write (implies data:read; backs the whole normal
    //                   task lifecycle: create/update/reschedule/complete/reopen)
    //   data:delete     delete application data (task deletion ONLY)
    //   project:delete  delete PROJECTS — deliberately NOT requested. Hula never
    //                   deletes a project, so asking for it would be strictly
    //                   more access than the product needs.
    //
    // `data:read` is NOT requested alongside `data:read_write` because the latter
    // already implies it; listing both would only widen the consent screen text.
    //
    // `data:delete` is requested but treated as OPTIONAL at runtime: a user who
    // grants read_write and declines delete keeps a fully working integration and
    // only task deletion refuses. See `capabilitiesFromScopes` in ./oauth.
    defaultScopes: ["data:read_write", "data:delete"],
    capabilities: ["tasks.read", "tasks.write", "tasks.delete"],
    notes:
      "Live integration. Read (today/overdue/upcoming/project/label/priority/completed) plus the " +
      "full task lifecycle — create, update, reschedule, move, relabel, complete, reopen, delete — " +
      "via OAuth against the official API v1. Deletion and any bulk action require explicit " +
      "confirmation; single reversible task actions do not. Deletion needs data:delete, which is " +
      "optional: without it every other capability still works.",
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
    status: "available_readonly",
    authType: "oauth2",
    defaultScopes: ["content:read", "content:write", "comments:read", "comments:write", "user:read"],
    capabilities: ["content.read", "content.write", "users.read", "comments.read", "comments.write", "files.read", "files.write"],
    notes: "Live Notion integration using API 2026-03-11. Reads accessible pages, blocks, users, comments, databases and data sources; safely creates and edits pages, records, blocks, comments and data-source schemas. Shared, destructive and externally visible changes require confirmation. Access remains limited to content shared with the connection.",
  },
  {
    provider: "asana",
    displayName: "Asana",
    category: "productivity",
    status: "available_readonly",
    authType: "oauth2",
    defaultScopes: [
      "attachments:read", "attachments:write", "custom_fields:read", "goals:read",
      "portfolios:read", "portfolios:write", "projects:read", "projects:write",
      "projects:delete", "stories:read", "stories:write", "tags:read",
      "tasks:read", "tasks:write", "tasks:delete",
      "teams:read", "time_tracking_entries:read", "users:read", "workspaces:read",
    ],
    capabilities: [
      "work.read", "tasks.read", "tasks.write", "tasks.delete", "projects.read",
      "projects.write", "projects.delete", "collaboration.read", "collaboration.write",
      "attachments.read", "attachments.write", "custom_fields.read", "portfolios.read",
      "portfolios.write", "goals.read", "tags.read", "teams.read",
      "time_tracking.read", "users.read", "workspaces.read",
    ],
    notes: "Live Asana integration. Goal and time-entry access is read-only. Empty section discovery, generic memberships, project briefs/statuses, portfolio deletion, goal mutation, and time-entry mutation are refused because Hula's selected named scopes do not authorise those endpoints.",
  },
  {
    provider: "slack",
    displayName: "Slack",
    category: "communication",
    status: "available_readonly",
    authType: "oauth2",
    defaultScopes: ["channels:read","channels:history","groups:read","groups:history","groups:write","im:read","im:history","im:write","mpim:read","mpim:history","chat:write","users:read","users.profile:read","users:read.email","files:read","files:write","reactions:read","reactions:write","pins:read","pins:write","bookmarks:read","bookmarks:write","channels:manage","channels:join","team:read","emoji:read","usergroups:read","usergroups:write","app_mentions:read"],
    capabilities: ["slack.read","slack.messages.write","slack.channels.manage","slack.reactions.write","slack.pins.write","slack.bookmarks.write","slack.usergroups.write","slack.search"],
    notes: "Live Slack OAuth integration. Reads accessible workspace content and safely manages messages, channels, reactions, pins, bookmarks and user groups. File metadata is readable; file upload and deletion are not exposed through messaging. Search and channel-thread replies require separately granted user scopes. Every external or shared change asks first.",
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
