-- CreateEnum
CREATE TYPE "ReminderSource" AS ENUM ('explicit_user_request', 'future_calendar', 'future_integration');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('scheduled', 'sent', 'cancelled', 'failed');

-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "ReminderSource" NOT NULL DEFAULT 'explicit_user_request',
    "channel" TEXT NOT NULL DEFAULT 'imessage',
    "provider" TEXT NOT NULL DEFAULT 'sendblue',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "originalText" TEXT,
    "status" "ReminderStatus" NOT NULL DEFAULT 'scheduled',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT,
    "recurrenceRule" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "maxSends" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "failureReason" TEXT,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reminders_userId_status_idx" ON "reminders"("userId", "status");

-- CreateIndex
CREATE INDEX "reminders_status_nextRunAt_idx" ON "reminders"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "reminders_status_dueAt_idx" ON "reminders"("status", "dueAt");

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
