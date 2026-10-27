-- Additive foundation: preserve all legacy catalog, inventory, and import data.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE "CatalogItem"
    ADD COLUMN "categoryId" UUID,
    ADD COLUMN "options" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "catalogItemId" UUID NOT NULL,
    "sku" VARCHAR(200),
    "optionValues" JSONB NOT NULL DEFAULT '{}',
    "unitPrice" DECIMAL(12,2),
    "trackInventory" BOOLEAN NOT NULL DEFAULT false,
    "stockQuantity" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Category_businessId_idx" ON "Category"("businessId");
CREATE UNIQUE INDEX "Category_businessId_id_key" ON "Category"("businessId", "id");
CREATE INDEX "ProductVariant_businessId_idx" ON "ProductVariant"("businessId");
CREATE INDEX "ProductVariant_catalogItemId_idx" ON "ProductVariant"("catalogItemId");
CREATE INDEX "ProductVariant_businessId_catalogItemId_idx" ON "ProductVariant"("businessId", "catalogItemId");
-- PostgreSQL's default NULL-distinct behavior allows multiple absent SKUs.
-- Inactive variants retain their unique SKU; no cascade deletes are introduced.
CREATE UNIQUE INDEX "ProductVariant_businessId_sku_key" ON "ProductVariant"("businessId", "sku");
CREATE INDEX "CatalogItem_businessId_categoryId_idx" ON "CatalogItem"("businessId", "categoryId");
CREATE UNIQUE INDEX "CatalogItem_businessId_id_key" ON "CatalogItem"("businessId", "id");

ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_businessId_categoryId_fkey"
    FOREIGN KEY ("businessId", "categoryId") REFERENCES "Category"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Category" ADD CONSTRAINT "Category_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_businessId_catalogItemId_fkey"
    FOREIGN KEY ("businessId", "catalogItemId") REFERENCES "CatalogItem"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- SQL-only invariants: Prisma cannot express expression indexes or CHECKs.
-- Normalize whitespace runs to one space, trim, then lowercase using DB collation.
CREATE UNIQUE INDEX "Category_businessId_normalized_name_key"
    ON "Category" ("businessId", lower(btrim(regexp_replace("name", '[[:space:]]+', ' ', 'g'))));
ALTER TABLE "Category" ADD CONSTRAINT "Category_name_nonblank_check"
    CHECK (btrim(regexp_replace("name", '[[:space:]]+', ' ', 'g')) <> '');
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_options_object_check"
    CHECK (jsonb_typeof("options") = 'object');
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_optionValues_object_check"
    CHECK (jsonb_typeof("optionValues") = 'object');

COMMIT;
