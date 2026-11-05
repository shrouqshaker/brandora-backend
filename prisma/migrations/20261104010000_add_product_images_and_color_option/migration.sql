BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE "Product" ADD COLUMN "colorOptionName" VARCHAR(60);
ALTER TABLE "Product" ADD CONSTRAINT "Product_color_option_check" CHECK (
  "colorOptionName" IS NULL OR
  (btrim("colorOptionName") <> '' AND coalesce(jsonb_typeof(options -> "colorOptionName") = 'array', false)
    AND options ? "colorOptionName"));
CREATE TABLE "ProductImage" (
  "id" UUID NOT NULL,
  "businessId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "publicId" VARCHAR(250) NOT NULL,
  "secureUrl" VARCHAR(1000),
  "optionName" VARCHAR(60),
  "optionValue" VARCHAR(100),
  "status" VARCHAR(20) NOT NULL DEFAULT 'UPLOADING',
  "width" INTEGER,
  "height" INTEGER,
  "bytes" INTEGER,
  "format" VARCHAR(10),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductImage_businessId_productId_fkey" FOREIGN KEY ("businessId", "productId")
    REFERENCES "Product"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProductImage_status_check" CHECK ("status" IN ('UPLOADING','ACTIVE','DELETE_PENDING')),
  CONSTRAINT "ProductImage_slot_check" CHECK (
    ("optionName" IS NULL AND "optionValue" IS NULL) OR
    ("optionName" IS NOT NULL AND "optionValue" IS NOT NULL AND btrim("optionName") <> '' AND btrim("optionValue") <> '')),
  CONSTRAINT "ProductImage_active_metadata_check" CHECK ("status" <> 'ACTIVE' OR
    ("secureUrl" IS NOT NULL AND "secureUrl" LIKE 'https://res.cloudinary.com/%'
      AND "width" IS NOT NULL AND "width" > 0 AND "height" IS NOT NULL AND "height" > 0
      AND "bytes" IS NOT NULL AND "bytes" > 0 AND "format" IS NOT NULL AND "format" IN ('jpg','png','webp')))
);
CREATE UNIQUE INDEX "ProductImage_publicId_key" ON "ProductImage"("publicId");
CREATE INDEX "ProductImage_businessId_productId_status_idx" ON "ProductImage"("businessId","productId","status");
CREATE UNIQUE INDEX "ProductImage_active_main_key" ON "ProductImage"("productId")
  WHERE "status" = 'ACTIVE' AND "optionName" IS NULL;
CREATE UNIQUE INDEX "ProductImage_active_color_key" ON "ProductImage"("productId","optionName","optionValue")
  WHERE "status" = 'ACTIVE' AND "optionName" IS NOT NULL;
COMMIT;
