-- Additive only. Review before applying to an approved target; no existing data is replaced.
ALTER TABLE "User" ADD COLUMN "name" VARCHAR(200);
ALTER TABLE "Business" ADD COLUMN "logoUrl" VARCHAR(1000), ADD COLUMN "logoPublicId" VARCHAR(250);
CREATE UNIQUE INDEX "Business_logoPublicId_key" ON "Business"("logoPublicId");
ALTER TABLE "BusinessSettings"
  ADD COLUMN "returnPolicy" VARCHAR(5000),
  ADD COLUMN "paymentNotes" VARCHAR(5000),
  ADD COLUMN "deliveryNotes" VARCHAR(5000),
  ADD COLUMN "deliveryFee" DECIMAL(12,2),
  ADD CONSTRAINT "BusinessSettings_deliveryFee_nonnegative" CHECK ("deliveryFee" IS NULL OR "deliveryFee" >= 0);
CREATE TABLE "BusinessFaq" (
  "id" UUID NOT NULL, "businessId" UUID NOT NULL,
  "question" VARCHAR(300) NOT NULL, "answer" VARCHAR(3000) NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0, "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessFaq_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BusinessFaq_position_nonnegative" CHECK ("position" >= 0),
  CONSTRAINT "BusinessFaq_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "BusinessFaq_businessId_position_id_idx" ON "BusinessFaq"("businessId", "position", "id");
CREATE TABLE "BusinessLogoCleanup" (
  "publicId" VARCHAR(250) NOT NULL, "businessId" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'UPLOADING', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessLogoCleanup_pkey" PRIMARY KEY ("publicId"),
  CONSTRAINT "BusinessLogoCleanup_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "BusinessLogoCleanup_businessId_status_idx" ON "BusinessLogoCleanup"("businessId", "status");
