import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton.
 *
 * Section 4 introduces the first real database connection. The client is
 * created lazily (on first use) so that merely importing a module that touches
 * the database does not open a connection or require `DATABASE_URL` — this keeps
 * the pure-logic tests and local boot working without a live database.
 *
 * In development, `tsx watch` reloads modules on change; caching the client on
 * `globalThis` avoids exhausting connections by re-instantiating on every reload.
 *
 * This must only ever run on the backend. Never import it from the Expo app.
 */
const globalForPrisma = globalThis as unknown as {
  __hulaPrisma?: PrismaClient;
};

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.__hulaPrisma) {
    globalForPrisma.__hulaPrisma = new PrismaClient();
  }
  return globalForPrisma.__hulaPrisma;
}
