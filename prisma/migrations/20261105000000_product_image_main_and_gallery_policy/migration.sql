BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE "ProductImage" IN ACCESS EXCLUSIVE MODE;
-- Preserve every asset/metadata row. Never silently discard excess images.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ProductImage" WHERE "status" IN ('ACTIVE', 'UPLOADING')
    GROUP BY "productId" HAVING count(*) > 5
  ) THEN
    RAISE EXCEPTION 'Product image policy upgrade requires reconciliation: a product has more than five active or uploading images';
  END IF;
END;
$$;
ALTER TABLE "ProductImage" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
-- Keep the former main first; otherwise promote the oldest existing image.
-- Legacy option fields are retained as metadata, no longer associations.
WITH ranked AS (
  SELECT "id", (row_number() OVER (
    PARTITION BY "productId"
    ORDER BY ("optionName" IS NOT NULL), "createdAt", "id"
  ) - 1)::integer AS "position"
  FROM "ProductImage" WHERE "status" = 'ACTIVE'
)
UPDATE "ProductImage" AS image SET "position" = ranked."position"
FROM ranked WHERE image."id" = ranked."id";
DROP INDEX "ProductImage_active_main_key";
DROP INDEX "ProductImage_active_color_key";
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_position_check"
  CHECK ("position" BETWEEN 0 AND 4);
-- At most five ACTIVE slots, with at most one Main Image (position 0).
CREATE UNIQUE INDEX "ProductImage_active_position_key"
  ON "ProductImage"("productId", "position") WHERE "status" = 'ACTIVE';
COMMIT;
