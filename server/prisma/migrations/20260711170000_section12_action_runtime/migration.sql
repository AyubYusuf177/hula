-- Section 12: agentic action runtime — additive proposal + execution ledger.
--
-- Adds the typed action runtime's two tables (action_proposals,
-- action_executions) and their enums. This migration is purely ADDITIVE: no
-- existing table, row, or column is dropped or altered. Both tables store only
-- sanitised summaries — NO tokens and NO raw provider payloads.

-- CreateEnum
CREATE TYPE "ActionProposalStatus" AS ENUM ('proposed', 'confirmed', 'rejected', 'expired', 'executed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ActionExecutionStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'blocked');

-- CreateTable
CREATE TABLE "action_proposals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT,
    "actionId" TEXT NOT NULL,
    "status" "ActionProposalStatus" NOT NULL DEFAULT 'proposed',
    "riskLevel" TEXT NOT NULL,
    "confirmationRequired" BOOLEAN NOT NULL DEFAULT true,
    "inputJson" JSONB,
    "previewText" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "action_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_executions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "proposalId" TEXT,
    "provider" TEXT,
    "actionId" TEXT NOT NULL,
    "status" "ActionExecutionStatus" NOT NULL DEFAULT 'pending',
    "requestSummaryJson" JSONB,
    "resultSummaryJson" JSONB,
    "errorMessage" TEXT,
    "providerRequestId" TEXT,
    "providerResourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "action_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "action_proposals_userId_status_idx" ON "action_proposals"("userId", "status");

-- CreateIndex
CREATE INDEX "action_proposals_status_expiresAt_idx" ON "action_proposals"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "action_executions_userId_createdAt_idx" ON "action_executions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "action_executions_proposalId_idx" ON "action_executions"("proposalId");

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "action_proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
