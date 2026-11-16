/*
  Warnings:

  - A unique constraint covering the columns `[replyToMessageId]` on the table `Message` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "replyToMessageId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "Message_replyToMessageId_key" ON "Message"("replyToMessageId");
