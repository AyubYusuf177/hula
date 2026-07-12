import assert from "node:assert/strict";

/**
 * Offline tests for provider-scoped integration disconnect (Integrations V2).
 *
 * These verify the ONE invariant the app relies on: disconnecting Gmail must
 * never touch Calendar and vice-versa, credentials for the disconnected provider
 * are cleared, and a later reconnect still works. No real database: a tiny fake
 * Prisma client is injected via the lazy `globalThis.__hulaPrisma` singleton that
 * `getPrisma()` reads, so `disconnectIntegrationConnection` /
 * `upsertIntegrationConnection` run against an in-memory store. Run with `npm test`.
 */

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): void | Promise<void> {
  const done = () => {
    passed += 1;
    console.log(`  ok - ${name}`);
  };
  const r = fn();
  return r instanceof Promise ? r.then(done) : done();
}

interface ConnRow {
  id: string;
  userId: string;
  provider: string;
  status: string;
  displayName: string | null;
  providerAccountId: string | null;
  providerAccountEmail: string | null;
  grantedScopes: string[];
  requestedScopes: string[];
  capabilities: string[];
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  lastSyncedAt: Date | null;
  updatedAt: Date;
}

/** A minimal in-memory Prisma double covering only what disconnect/upsert use. */
function makeFakePrisma() {
  const connections: ConnRow[] = [];
  /** connectionId → present credential (a set models "has token material"). */
  const credentials = new Set<string>();
  let seq = 0;

  function findConn(userId: string, provider: string): ConnRow | undefined {
    return connections.find((c) => c.userId === userId && c.provider === provider);
  }

  const client = {
    integrationConnection: {
      findUnique({ where }: { where: { userId_provider: { userId: string; provider: string } } }) {
        return Promise.resolve(
          findConn(where.userId_provider.userId, where.userId_provider.provider) ?? null,
        );
      },
      update({ where, data }: { where: { id: string }; data: Partial<ConnRow> }) {
        const row = connections.find((c) => c.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return Promise.resolve(row);
      },
      upsert({
        where,
        create,
        update,
      }: {
        where: { userId_provider: { userId: string; provider: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) {
        const { userId, provider } = where.userId_provider;
        const existing = findConn(userId, provider);
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return Promise.resolve(existing);
        }
        seq += 1;
        const row: ConnRow = {
          id: `conn-${seq}`,
          userId,
          provider,
          status: "disconnected",
          displayName: null,
          providerAccountId: null,
          providerAccountEmail: null,
          grantedScopes: [],
          requestedScopes: [],
          capabilities: [],
          connectedAt: null,
          disconnectedAt: null,
          lastSyncedAt: null,
          updatedAt: new Date(),
          ...(create as Partial<ConnRow>),
        };
        connections.push(row);
        return Promise.resolve(row);
      },
    },
    integrationCredential: {
      deleteMany({ where }: { where: { connectionId: string } }) {
        const had = credentials.delete(where.connectionId);
        return Promise.resolve({ count: had ? 1 : 0 });
      },
    },
    // Test-only helpers (not part of Prisma) for seeding + assertions.
    __seedConnected(userId: string, provider: string): string {
      seq += 1;
      const id = `conn-${seq}`;
      connections.push({
        id,
        userId,
        provider,
        status: "connected",
        displayName: provider,
        providerAccountId: null,
        providerAccountEmail: `${provider}@example.com`,
        grantedScopes: ["scope.readonly"],
        requestedScopes: ["scope.readonly"],
        capabilities: [],
        connectedAt: new Date(),
        disconnectedAt: null,
        lastSyncedAt: null,
        updatedAt: new Date(),
      });
      credentials.add(id);
      return id;
    },
    __conn(userId: string, provider: string) {
      return findConn(userId, provider);
    },
    __hasCredential(connectionId: string) {
      return credentials.has(connectionId);
    },
  };

  return client;
}

// Install the fake BEFORE importing the module under test, so getPrisma() never
// instantiates a real PrismaClient.
const fake = makeFakePrisma();
(globalThis as unknown as { __hulaPrisma?: unknown }).__hulaPrisma = fake;

const USER = "user-1";

async function run() {
  const { disconnectIntegrationConnection, upsertIntegrationConnection } = await import(
    "../src/integrations/connections"
  );

  const gmailId = fake.__seedConnected(USER, "gmail");
  const calId = fake.__seedConnected(USER, "google_calendar");

  await check("disconnect gmail clears ONLY gmail (calendar untouched)", async () => {
    const changed = await disconnectIntegrationConnection(USER, "gmail");
    assert.equal(changed, true);

    const gmail = fake.__conn(USER, "gmail");
    assert.equal(gmail?.status, "disconnected");
    assert.equal(gmail?.connectedAt, null);
    assert.equal(fake.__hasCredential(gmailId), false, "gmail credential removed");

    const cal = fake.__conn(USER, "google_calendar");
    assert.equal(cal?.status, "connected", "calendar must stay connected");
    assert.equal(fake.__hasCredential(calId), true, "calendar credential preserved");
  });

  await check("disconnect calendar clears ONLY calendar (gmail untouched)", async () => {
    // Reconnect gmail first so we can prove calendar-disconnect leaves it alone.
    await upsertIntegrationConnection(USER, { provider: "gmail", status: "connected" });
    const gmailReId = fake.__conn(USER, "gmail")?.id as string;

    const changed = await disconnectIntegrationConnection(USER, "google_calendar");
    assert.equal(changed, true);

    const cal = fake.__conn(USER, "google_calendar");
    assert.equal(cal?.status, "disconnected");
    assert.equal(fake.__hasCredential(calId), false, "calendar credential removed");

    const gmail = fake.__conn(USER, "gmail");
    assert.equal(gmail?.status, "connected", "gmail must stay connected");
    assert.equal(gmailReId, gmail?.id, "reused the same gmail row");
  });

  await check("reconnect after disconnect is possible (upsert → connected)", async () => {
    const view = await upsertIntegrationConnection(USER, {
      provider: "google_calendar",
      status: "connected",
      providerAccountEmail: "me@example.com",
    });
    assert.equal(view.status, "connected");
    assert.notEqual(view.connectedAt, null);
    assert.equal(fake.__conn(USER, "google_calendar")?.status, "connected");
  });

  await check("disconnect with no connection row is a no-op (idempotent)", async () => {
    const changed = await disconnectIntegrationConnection("nobody", "gmail");
    assert.equal(changed, false);
  });

  console.log(`\nAll ${passed} integration disconnect (Integrations V2) tests passed.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
