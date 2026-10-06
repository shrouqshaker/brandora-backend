-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('INITIAL_IMPORT', 'IMPORT_UPDATE', 'MANUAL_ADJUSTMENT', 'ORDER_APPROVED', 'ORDER_CANCELLED');

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "catalogItemId" UUID NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "quantityBefore" INTEGER,
    "quantityAfter" INTEGER NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "referenceType" VARCHAR(50),
    "referenceId" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryMovement_businessId_createdAt_idx" ON "InventoryMovement"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_catalogItemId_createdAt_idx" ON "InventoryMovement"("catalogItemId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_businessId_referenceType_referenceId_idx" ON "InventoryMovement"("businessId", "referenceType", "referenceId");

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
