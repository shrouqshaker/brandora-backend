-- Deliberately refuses legacy inventory rather than deleting or guessing history.
-- See docs/variant-inventory-rollout.md. Cleanup requires separate owner approval.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE "CatalogItem", "ProductVariant", "InventoryMovement" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "InventoryMovement") OR
     EXISTS (SELECT 1 FROM "CatalogItem" WHERE "stockQuantity" IS NOT NULL OR "trackInventory") THEN
    RAISE EXCEPTION 'Legacy inventory present. Stop and obtain approval for scoped cleanup or explicit data conversion; no records were changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "ProductVariant" WHERE
      ("trackInventory" AND ("stockQuantity" IS NULL OR "stockQuantity" < 0)) OR
      (NOT "trackInventory" AND "stockQuantity" IS NOT NULL)) THEN
    RAISE EXCEPTION 'Variant inventory requires reconciliation before migration';
  END IF;
END $$;

ALTER TABLE "CatalogItem" DROP COLUMN "stockQuantity", DROP COLUMN "trackInventory";
CREATE UNIQUE INDEX "ProductVariant_businessId_catalogItemId_id_key" ON "ProductVariant"("businessId", "catalogItemId", "id");
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_inventory_check"
  CHECK (("trackInventory" AND "stockQuantity" IS NOT NULL AND "stockQuantity" >= 0)
      OR (NOT "trackInventory" AND "stockQuantity" IS NULL));

ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_catalogItemId_fkey";
ALTER TABLE "InventoryMovement"
  ADD COLUMN "variantId" UUID NOT NULL,
  ADD COLUMN "trackingBefore" BOOLEAN NOT NULL,
  ADD COLUMN "trackingAfter" BOOLEAN NOT NULL,
  ADD COLUMN "requestedQuantity" INTEGER,
  ALTER COLUMN "quantityAfter" DROP NOT NULL;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_businessId_catalogItemId_fkey"
  FOREIGN KEY ("businessId", "catalogItemId") REFERENCES "CatalogItem"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_businessId_catalogItemId_variantId_fkey"
  FOREIGN KEY ("businessId", "catalogItemId", "variantId") REFERENCES "ProductVariant"("businessId", "catalogItemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_quantities_check" CHECK (
  (("trackingBefore" AND "quantityBefore" IS NOT NULL AND "quantityBefore" >= 0) OR (NOT "trackingBefore" AND "quantityBefore" IS NULL)) AND
  (("trackingAfter" AND "quantityAfter" IS NOT NULL AND "quantityAfter" >= 0) OR (NOT "trackingAfter" AND "quantityAfter" IS NULL)) AND
  "quantityDelta"::bigint = coalesce("quantityAfter", 0)::bigint - coalesce("quantityBefore", 0)::bigint);
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_reference_check" CHECK (
  ("referenceType" IS NULL AND "referenceId" IS NULL) OR
  ("referenceType" IS NOT NULL AND "referenceId" IS NOT NULL AND btrim("referenceType") <> '' AND btrim("referenceId") <> ''));
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_order_check" CHECK (
  ("type" IN ('ORDER_APPROVED', 'ORDER_CANCELLED') AND "requestedQuantity" IS NOT NULL AND "requestedQuantity" > 0 AND "referenceType" IS NOT NULL AND "referenceType" = 'ORDER_LINE' AND "referenceId" IS NOT NULL AND "trackingBefore" = "trackingAfter" AND
    "quantityDelta" = CASE WHEN NOT "trackingAfter" THEN 0 WHEN "type" = 'ORDER_APPROVED' THEN -"requestedQuantity" ELSE "requestedQuantity" END) OR
  ("type" NOT IN ('ORDER_APPROVED', 'ORDER_CANCELLED') AND "requestedQuantity" IS NULL));
CREATE INDEX "InventoryMovement_businessId_variantId_createdAt_idx" ON "InventoryMovement"("businessId", "variantId", "createdAt");
CREATE UNIQUE INDEX "InventoryMovement_operation_key" ON "InventoryMovement"("businessId", "variantId", "type", "referenceType", "referenceId");
-- An order-line cannot be reassigned to another variant by a duplicate request.
CREATE UNIQUE INDEX "InventoryMovement_order_line_key" ON "InventoryMovement"("businessId", "referenceId", "type") WHERE "referenceType" = 'ORDER_LINE';
COMMIT;
