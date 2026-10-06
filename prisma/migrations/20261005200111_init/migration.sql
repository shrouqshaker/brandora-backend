/*
  Warnings:

  - The values [PENDING,PROCESSING] on the enum `ImportJobStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `price` on the `CatalogItem` table. All the data in the column will be lost.
  - You are about to drop the column `errorMessage` on the `ImportJob` table. All the data in the column will be lost.
  - You are about to drop the column `source` on the `ImportJob` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[businessId,externalKey]` on the table `CatalogItem` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `fileName` to the `ImportJob` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ImportSourceType" AS ENUM ('EXCEL');

-- AlterEnum
BEGIN;
CREATE TYPE "ImportJobStatus_new" AS ENUM ('UPLOADED', 'ANALYZING', 'MAPPING_REQUIRED', 'VALIDATING', 'READY', 'IMPORTING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED');
ALTER TABLE "public"."ImportJob" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ImportJob" ALTER COLUMN "status" TYPE "ImportJobStatus_new" USING ("status"::text::"ImportJobStatus_new");
ALTER TYPE "ImportJobStatus" RENAME TO "ImportJobStatus_old";
ALTER TYPE "ImportJobStatus_new" RENAME TO "ImportJobStatus";
DROP TYPE "public"."ImportJobStatus_old";
ALTER TABLE "ImportJob" ALTER COLUMN "status" SET DEFAULT 'UPLOADED';
COMMIT;

-- AlterTable
ALTER TABLE "CatalogItem" DROP COLUMN "price",
ADD COLUMN     "attributes" JSONB,
ADD COLUMN     "basePrice" DECIMAL(12,2),
ADD COLUMN     "category" VARCHAR(200),
ADD COLUMN     "externalKey" VARCHAR(200),
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "stockQuantity" INTEGER,
ADD COLUMN     "trackInventory" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ImportJob" DROP COLUMN "errorMessage",
DROP COLUMN "source",
ADD COLUMN     "errors" JSONB,
ADD COLUMN     "failedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fileName" TEXT NOT NULL,
ADD COLUMN     "headerRow" INTEGER,
ADD COLUMN     "insertedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "invalidRows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mapping" JSONB,
ADD COLUMN     "sheetName" TEXT,
ADD COLUMN     "skippedRows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sourceType" "ImportSourceType" NOT NULL DEFAULT 'EXCEL',
ADD COLUMN     "totalRows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "validRows" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "status" SET DEFAULT 'UPLOADED';

-- CreateIndex
CREATE INDEX "CatalogItem_businessId_idx" ON "CatalogItem"("businessId");

-- CreateIndex
CREATE INDEX "CatalogItem_businessId_isActive_idx" ON "CatalogItem"("businessId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogItem_businessId_externalKey_key" ON "CatalogItem"("businessId", "externalKey");

-- CreateIndex
CREATE INDEX "ImportJob_businessId_idx" ON "ImportJob"("businessId");

-- CreateIndex
CREATE INDEX "ImportJob_businessId_status_idx" ON "ImportJob"("businessId", "status");
