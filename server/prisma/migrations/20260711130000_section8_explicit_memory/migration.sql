-- CreateEnum
CREATE TYPE "MemoryType" AS ENUM ('preference', 'fact', 'instruction', 'goal', 'project', 'routine', 'constraint');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('active', 'deleted');

-- CreateEnum
CREATE TYPE "MemoryImportance" AS ENUM ('low', 'medium', 'high');

-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "MemoryType" NOT NULL DEFAULT 'fact',
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'explicit_user_request',
    "status" "MemoryStatus" NOT NULL DEFAULT 'active',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "tags" JSONB,
    "importance" "MemoryImportance" NOT NULL DEFAULT 'medium',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memories_userId_status_idx" ON "memories"("userId", "status");

-- CreateIndex
CREATE INDEX "memories_userId_type_status_idx" ON "memories"("userId", "type", "status");

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
