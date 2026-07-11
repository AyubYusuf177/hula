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
