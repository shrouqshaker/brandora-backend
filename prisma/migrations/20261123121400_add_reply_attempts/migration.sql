-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "aiAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "aiClaimedAt" TIMESTAMP(3),
ADD COLUMN     "nextSendAt" TIMESTAMP(3),
ADD COLUMN     "sendAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sendClaimedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Message_status_createdAt_idx" ON "Message"("status", "createdAt");
