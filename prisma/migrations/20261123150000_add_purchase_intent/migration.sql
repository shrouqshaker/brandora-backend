-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "purchaseIntentAt" TIMESTAMP(3),
ADD COLUMN     "purchaseMessageId" UUID;
