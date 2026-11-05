-- Coordinated-release migration: the old Backend queries CatalogItem.
-- Run only after old application instances have stopped. No rows are rewritten.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE "CatalogItem" RENAME TO "Product";
ALTER TABLE "ProductVariant" RENAME COLUMN "catalogItemId" TO "productId";
ALTER TABLE "InventoryMovement" RENAME COLUMN "catalogItemId" TO "productId";
ALTER TABLE "Product" RENAME CONSTRAINT "CatalogItem_pkey" TO "Product_pkey";
ALTER TABLE "Product" RENAME CONSTRAINT "CatalogItem_businessId_fkey" TO "Product_businessId_fkey";
ALTER TABLE "Product" RENAME CONSTRAINT "CatalogItem_businessId_categoryId_fkey" TO "Product_businessId_categoryId_fkey";
ALTER TABLE "Product" RENAME CONSTRAINT "CatalogItem_options_object_check" TO "Product_options_object_check";
ALTER TABLE "ProductVariant" RENAME CONSTRAINT "ProductVariant_businessId_catalogItemId_fkey" TO "ProductVariant_businessId_productId_fkey";
ALTER TABLE "InventoryMovement" RENAME CONSTRAINT "InventoryMovement_businessId_catalogItemId_fkey" TO "InventoryMovement_businessId_productId_fkey";
ALTER TABLE "InventoryMovement" RENAME CONSTRAINT "InventoryMovement_businessId_catalogItemId_variantId_fkey" TO "InventoryMovement_businessId_productId_variantId_fkey";
ALTER INDEX "CatalogItem_businessId_externalKey_key" RENAME TO "Product_businessId_externalKey_key";
ALTER INDEX "CatalogItem_businessId_id_key" RENAME TO "Product_businessId_id_key";
ALTER INDEX "CatalogItem_businessId_categoryId_idx" RENAME TO "Product_businessId_categoryId_idx";
ALTER INDEX "CatalogItem_businessId_idx" RENAME TO "Product_businessId_idx";
ALTER INDEX "CatalogItem_businessId_isActive_idx" RENAME TO "Product_businessId_isActive_idx";
ALTER INDEX "CatalogItem_businessId_createdAt_idx" RENAME TO "Product_businessId_createdAt_idx";
ALTER INDEX "ProductVariant_businessId_catalogItemId_id_key" RENAME TO "ProductVariant_businessId_productId_id_key";
ALTER INDEX "ProductVariant_catalogItemId_idx" RENAME TO "ProductVariant_productId_idx";
ALTER INDEX "ProductVariant_businessId_catalogItemId_idx" RENAME TO "ProductVariant_businessId_productId_idx";
ALTER INDEX "InventoryMovement_catalogItemId_createdAt_idx" RENAME TO "InventoryMovement_productId_createdAt_idx";
COMMIT;
