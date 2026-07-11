-- Section 10: integrations foundation.
--
-- ADDITIVE ONLY. This migration creates the integration foundation tables and
-- one new enum. It does NOT touch or drop any existing table, column, or data
-- (users, profiles, messages, conversations, link sessions, memories,
-- reminders, provider events all remain unchanged).

-- CreateEnum
CREATE TYPE "IntegrationConnectionStatus" AS ENUM ('disconnected', 'connected', 'expired', 'revoked', 'error');

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT,
    "providerAccountEmail" TEXT,
    "displayName" TEXT,
    "status" "IntegrationConnectionStatus" NOT NULL DEFAULT 'disconnected',
    "grantedScopes" JSONB,
    "requestedScopes" JSONB,
    "capabilities" JSONB,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_credentials" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "tokenType" TEXT NOT NULL DEFAULT 'oauth',
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scopeHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_sync_states" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "cursor" TEXT,
    "syncToken" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "status" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "resourceType" TEXT,
    "providerEventId" TEXT,
    "safeSummaryJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_action_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT,
    "provider" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestSummaryJson" JSONB,
    "resultSummaryJson" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_action_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_userId_provider_key" ON "integration_connections"("userId", "provider");

-- CreateIndex
CREATE INDEX "integration_connections_userId_status_idx" ON "integration_connections"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "integration_credentials_connectionId_key" ON "integration_credentials"("connectionId");

-- CreateIndex
CREATE INDEX "integration_sync_states_connectionId_resourceType_idx" ON "integration_sync_states"("connectionId", "resourceType");

-- CreateIndex
CREATE INDEX "integration_events_userId_provider_createdAt_idx" ON "integration_events"("userId", "provider", "createdAt");

-- CreateIndex
CREATE INDEX "integration_action_logs_userId_provider_createdAt_idx" ON "integration_action_logs"("userId", "provider", "createdAt");

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_states" ADD CONSTRAINT "integration_sync_states_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_action_logs" ADD CONSTRAINT "integration_action_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_action_logs" ADD CONSTRAINT "integration_action_logs_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
