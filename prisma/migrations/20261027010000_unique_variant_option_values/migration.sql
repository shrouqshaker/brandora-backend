-- Forward-only: do not edit the already verified foundation migration.
-- JSONB comparison ignores object key order, including nested objects.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- Prevent writers from adding duplicates between preflight and index creation.
LOCK TABLE "ProductVariant" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "ProductVariant"
        GROUP BY "businessId", "catalogItemId", "optionValues"
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'Variant option uniqueness migration blocked: duplicate option combinations exist; resolve them explicitly before retrying';
    END IF;
END $$;

-- A unique B-tree index is Prisma's representation of @@unique. It arbitrates
-- concurrent inserts and updates, including NULL SKUs and inactive variants.
-- Oversized JSONB index entries fail safely; never fall back to an unprotected write.
CREATE UNIQUE INDEX "ProductVariant_parent_optionValues_key"
    ON "ProductVariant" ("businessId", "catalogItemId", "optionValues");

COMMIT;
