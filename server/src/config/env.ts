import { z } from "zod";

/**
 * Environment validation for the Hula server.
 *
 * Section 1 note: only the core runtime values are required so the server can
 * boot locally without real secrets. Everything provider-specific (Sendblue,
 * model, database, auth, billing) is declared as an optional placeholder here
 * and will become required as each section is implemented.
 */
const envSchema = z.object({
  // Core runtime
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),

  // Sendblue (channel provider) — placeholder, not wired yet
  SENDBLUE_API_KEY: z.string().optional(),
  SENDBLUE_API_SECRET: z.string().optional(),
  SENDBLUE_HULA_NUMBER: z.string().optional(),
  SENDBLUE_WEBHOOK_SIGNING_SECRET: z.string().optional(),

  // Model / AI provider — placeholder, not wired yet
  MODEL_PROVIDER_API_KEY: z.string().optional(),

  // Anthropic (Hula brain provider) — Section 6.
  // The key is OPTIONAL so the server still boots without it; when it is absent
  // the brain uses a safe fallback reply instead of crashing. The model has a
  // safe default so a missing/blank value never breaks a request.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().min(1).optional().default("claude-opus-4-8"),

  // Database (Postgres / Neon) — used by Prisma from Section 4 on.
  // DATABASE_URL is the pooled runtime connection; DIRECT_URL is the direct
  // (unpooled) connection Prisma may need for migrations. Both are optional here
  // so the server can still boot and run pure-logic tests without a database;
  // Prisma reads them from the environment directly (see prisma/schema.prisma)
  // and will fail loudly at query time if DATABASE_URL is missing.
  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional(),

  // Auth (Clerk) — placeholder, not wired yet
  CLERK_SECRET_KEY: z.string().optional(),

  // Integrations token vault (Section 10) — OPTIONAL. Only required the moment a
  // provider token is actually encrypted/decrypted (no real provider connects
  // yet, so the server boots fine without it). Must decode to a 32-byte key
  // (base64 or hex) when set; the token vault validates it lazily at use time.
  INTEGRATION_TOKEN_ENCRYPTION_KEY: z.string().optional(),

  // Google Calendar OAuth (Section 11) — all OPTIONAL. Required only when a user
  // actually starts the Google Calendar connect flow; the server boots and runs
  // without them. A missing value surfaces as a safe configuration error at
  // connect time, never a startup crash. Least-privilege READ-ONLY scopes only.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),
  GOOGLE_CALENDAR_SCOPES: z.string().optional(),

  // Gmail OAuth (Section 14) — all OPTIONAL. Gmail is a SEPARATE provider from
  // Google Calendar: it reuses the shared Google client id/secret but has its
  // OWN redirect URI (GMAIL_OAUTH_REDIRECT_URI) and its own least-privilege
  // READ-ONLY scope (gmail.readonly, overridable via GMAIL_SCOPES). Required only
  // when a user actually starts the Gmail connect flow; a missing value surfaces
  // as a safe configuration error at connect time, never a startup crash.
  GMAIL_OAUTH_REDIRECT_URI: z.string().optional(),
  GMAIL_SCOPES: z.string().optional(),

  // Google Drive OAuth (Section 23). Reuses the shared Google client id/secret,
  // but remains a separate provider connection with its own redirect URI and
  // encrypted credential. Optional at boot; validated when connect starts.
  GOOGLE_DRIVE_OAUTH_REDIRECT_URI: z.string().optional(),
  GOOGLE_DRIVE_SCOPES: z.string().optional(),

  // Todoist OAuth (Section 19) — all OPTIONAL. Todoist is its own OAuth app with
  // its own client id/secret and redirect URI (it does NOT share Google's). All
  // are required only when a user actually starts the Todoist connect flow; a
  // missing value surfaces as a safe configuration error at connect time, never a
  // startup crash. TODOIST_SCOPES overrides the catalog default and is
  // COMMA-separated, matching Todoist's own contract (not space-separated).
  TODOIST_OAUTH_CLIENT_ID: z.string().optional(),
  TODOIST_OAUTH_CLIENT_SECRET: z.string().optional(),
  TODOIST_OAUTH_REDIRECT_URI: z.string().optional(),
  TODOIST_SCOPES: z.string().optional(),

  // Asana OAuth (Section 20). Secrets remain server-side; these are optional at
  // boot and validated when a user starts a connection.
  ASANA_OAUTH_CLIENT_ID: z.string().optional(),
  ASANA_OAUTH_CLIENT_SECRET: z.string().optional(),
  ASANA_OAUTH_REDIRECT_URI: z.string().optional(),
  ASANA_SCOPES: z.string().optional(),

  // Notion public OAuth (Section 21). Validated lazily by the Notion provider so
  // local/test boot remains possible without production credentials.
  NOTION_OAUTH_CLIENT_ID: z.string().optional(),
  NOTION_OAUTH_CLIENT_SECRET: z.string().optional(),
  NOTION_OAUTH_REDIRECT_URI: z.string().url().optional(),
  NOTION_API_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().default("2026-03-11"),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_REDIRECT_URI: z.string().url().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_BOT_SCOPES: z.string().optional(),
  SLACK_USER_SCOPES: z.string().optional(),
  // Optional development-only workspace hint for Slack's OAuth `team`
  // parameter. Use the workspace ID (T…), never a workspace URL or name.
  // Leave unset for distributed multi-workspace installs.
  SLACK_DEVELOPMENT_TEAM_ID: z.string().optional(),

  // Billing — placeholder, not wired yet
  BILLING_PROVIDER_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    // Do not print values — only the names/messages of the failing keys.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
