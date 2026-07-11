-- Section 11: Google Calendar read-only MVP — additive OAuth state table.
--
-- Adds a short-lived, single-use OAuth authorization-attempt table used for CSRF
-- protection (state) and to carry the PKCE code verifier between the connect and
-- callback requests. This migration is purely ADDITIVE: no existing table, row,
-- or column is dropped or altered. It stores NO tokens (those live encrypted in
-- integration_credentials).

-- CreateEnum
CREATE TYPE "OAuthStateStatus" AS ENUM ('pending', 'consumed', 'expired');

-- CreateTable
CREATE TABLE "integration_oauth_states" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "codeVerifier" TEXT,
    "redirectUri" TEXT NOT NULL,
    "scopes" JSONB,
    "status" "OAuthStateStatus" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_oauth_states_state_key" ON "integration_oauth_states"("state");

-- CreateIndex
CREATE INDEX "integration_oauth_states_userId_provider_status_idx" ON "integration_oauth_states"("userId", "provider", "status");

-- AddForeignKey
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
