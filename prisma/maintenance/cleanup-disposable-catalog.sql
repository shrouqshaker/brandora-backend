-- MANUAL ONLY. Not a Prisma migration. Never invoked by builds or verification.
-- Connect explicitly to a disposable DEVELOPMENT database with psql -X.
-- Review the database and UUID allowlist below. Keep application writers stopped.
-- Run with: psql -X --set=ON_ERROR_STOP=1 --dbname="<explicit-development-url>" --file="prisma/maintenance/cleanup-disposable-catalog.sql"
-- No connection string or environment file is read by this SQL script.
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_temp;

-- Replace this marker with the exact development database name after review.
DO $$
BEGIN
    IF current_database() <> 'REPLACE_WITH_REVIEWED_DEVELOPMENT_DATABASE_NAME' THEN
        RAISE EXCEPTION 'Cleanup blocked: explicitly configure the reviewed development database name';
    END IF;
END $$;

CREATE TEMP TABLE disposable_catalog_targets (
    "businessId" UUID NOT NULL,
    "catalogItemId" UUID NOT NULL,
    PRIMARY KEY ("businessId", "catalogItemId")
) ON COMMIT DROP;

-- Explicitly enumerate only reviewed disposable items; never select all items.
-- INSERT INTO disposable_catalog_targets ("businessId", "catalogItemId") VALUES
--     ('<business UUID>', '<catalog item UUID>');

LOCK TABLE "CatalogItem", "InventoryMovement" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM disposable_catalog_targets) THEN
        RAISE EXCEPTION 'Cleanup blocked: the explicit item allowlist is empty';
    END IF;
    IF EXISTS (
        SELECT 1 FROM disposable_catalog_targets t
        LEFT JOIN "CatalogItem" i ON i.id = t."catalogItemId" AND i."businessId" = t."businessId"
        WHERE i.id IS NULL
    ) THEN
        RAISE EXCEPTION 'Cleanup blocked: an item is missing or belongs to another business';
    END IF;
    -- Fail if future foreign keys could cascade changes into other tables.
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE contype = 'f'
          AND confrelid IN ('"CatalogItem"'::regclass, '"InventoryMovement"'::regclass)
          AND confdeltype NOT IN ('a', 'r')
    ) THEN
        RAISE EXCEPTION 'Cleanup blocked: dependent foreign keys could cascade changes';
    END IF;
END $$;

SELECT current_database() AS database_name,
       (SELECT count(*) FROM disposable_catalog_targets) AS selected_items,
       (SELECT count(*) FROM "InventoryMovement" m
        JOIN disposable_catalog_targets t ON t."catalogItemId" = m."catalogItemId") AS related_movements;

-- Delete by the actual parent link, including any legacy tenant-inconsistent
-- movement rows. The parent item/business pair was checked above.
DELETE FROM "InventoryMovement" m
USING disposable_catalog_targets t
WHERE m."catalogItemId" = t."catalogItemId";

DELETE FROM "CatalogItem" i
USING disposable_catalog_targets t
WHERE i.id = t."catalogItemId" AND i."businessId" = t."businessId";

-- Existing ProductVariant or other restrictive references block the parent
-- delete and roll back the transaction. Do not remove those safeguards.

-- Review the counts first. Default to rolling back every deletion.
-- To apply the reviewed allowlist manually, replace this final ROLLBACK with COMMIT.
ROLLBACK;
