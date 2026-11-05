# Product naming and image database rollout

> 2026-11-05 update: all 13 migrations, including the gallery policy, passed
> verification on the authorized isolated Neon test branch. Production was not
> accessed or migrated. Earlier dated inspection records below remain historical.

## Inspected state (2026-11-04)

Neon project `brandora` (`hidden-night-51803603`), PostgreSQL 18, region
`aws-us-east-2`, has production branch `br-icy-brook-b4d1xlh5`, database `neondb`.
The configured local connection's endpoint was matched to that branch without
printing credentials. Its ten migrations through
`20261030000000_variant_only_inventory` are applied successfully. Historical
file contents match their applied checksums allowing for LF/CRLF line endings.
No historical migration was edited.

Production uses `CatalogItem`, `ProductVariant.catalogItemId` and
`InventoryMovement.catalogItemId`. The variant/movement composite foreign keys
enforce Business/Product/Variant ownership. Inventory is already variant-only;
the old parent stock columns are absent. Product, Variant and movement tables
were empty in the isolated branch's initial snapshot; this is an observation,
not permission to discard any production data.

Railway's successful production deployment `905e502d-cbfd-4d14-91d8-ada1ec92a672`
uses Backend commit `83a65e9fc1f3f6994a7d115d6b83d86d3dd4d08b` on `main`, which
still queries CatalogItem. Dashboard build/start remain `npm run build` and
`npm run start:prod`. No repository Railway configuration or settings were added.

## Forward migrations

1. [20261104000000_rename_catalog_item_to_product](../prisma/migrations/20261104000000_rename_catalog_item_to_product/migration.sql)
   renames the existing table, referencing columns, explicit indexes and constraints
   in place, retaining UUIDs, data and foreign-key ownership.
2. [20261104010000_add_product_images_and_color_option](../prisma/migrations/20261104010000_add_product_images_and_color_option/migration.sql)
   creates ProductImage metadata, the composite ownership FK, status/metadata
   checks and the original main/color indexes; adds legacy colorOptionName.
3. [20261105000000_product_image_main_and_gallery_policy](../prisma/migrations/20261105000000_product_image_main_and_gallery_policy/migration.sql)
   adds position, backfills ACTIVE order with the former Main first, otherwise
   createdAt/id, and replaces the old partial indexes with ACTIVE position
   uniqueness plus position 0..4 CHECK. Existing option metadata/assets survive.
   More than five ACTIVE/UPLOADING rows per Product refuses the upgrade without
   deleting anything. This migration passed the isolated Neon checks below; Production remains unchanged.

Each is a separate transaction with 10-second lock and 60-second statement
limits; the group is not atomic. The gallery migration locks ProductImage while
checking/backfilling. First two have no row backfill; the third updates positions.
None drops tables/columns, truncates or deletes data. Historical migrations retain
their existing refusal/destructive steps and must not be replayed where applied.

| Final table | Structure and ownership |
| --- | --- |
| Product | Existing metadata UUID/externalKey/options/prices; legacy optional colorOptionName; business-scoped keys |
| ProductVariant | Existing productId/businessId composite ownership; options, prices and stock unchanged |
| ProductImage | Composite Product ownership; unique publicId; nullable provider metadata, legacy option fields; status; position; timestamps |

ACTIVE positions are unique per Product in 0..4, enforcing at most five active
images and at most one Main at position 0. Backend compacts positions and derives
isMain. UPLOADING reservations count toward application capacity under the parent
Product lock; DELETE_PENDING metadata remains recoverable but is not displayed.
See [the image lifecycle](product-images.md).

Do not run old color-image writers against the gallery schema: they interpret
all optionless rows as one replaceable slot. After gallery writes, rolling back
to that code is unsafe. Use a reviewed forward repair or an explicitly approved
recovery procedure; do not blindly restore old indexes or discard gallery rows.

## Verification targets

`node verification/product-domain-migrations.cjs` creates two new random localhost
PostgreSQL databases. It verifies fresh migration history and upgrades a ten-
migration schema seeded with a real Product, tracked Variant and audit movement.
Snapshots prove IDs, externalKey, SKU, options, quantities and audit rows survive.
No existing database is reset or deleted. The Products and Variant/Inventory/
Import HTTP verifiers also create new isolated databases and check Prisma drift.

An authorized isolated Neon child branch was created:

- Name: `test-product-domain-cloudinary-20261104`
- ID: `br-calm-resonance-b4fb1aqv`
- Parent: production `br-icy-brook-b4d1xlh5`
- Database: `neondb`

The reviewed statements and matching Prisma history entries were applied as one
transaction through the Neon connector on that child only. Test-branch Prisma
status and application checks are recorded in [verification results](product-domain-verification.md).
No production schema/data/history was changed. The branch is retained and has
no automatic deletion; any later branch cleanup requires owner approval. The
account rejected a custom suspend interval, so the test branch retains the
account's default interval with a fixed 0.25 CU compute; review its cost/lifecycle.

## Isolated gallery Neon verification (2026-11-05)

Verified project brandora, test-product-domain-cloudinary-20261104,
branch br-calm-resonance-b4fb1aqv, database neondb, with Primary/Default=false.
Only the pending gallery migration was applied through Prisma. Status is 13/13
finished migrations, matching checksums and no schema drift. Six legacy images
correctly refused migration and the probe rolled back; five-image backfill,
former-Main retention and oldest-image fallback preserved metadata.

Two local non-AI NestJS instances passed 161 real PostgreSQL/application
assertions, including physical constraints, cross-Business isolation, concurrent
Main changes and upload race results 201/400/400 for one free slot. Two real
Excel executions preserved Product/Variant identity, image metadata and order,
with expected price/stock updates. Cloudinary and workbook blob storage were
mocked. No real asset upload/deletion, Production test or live OTP flow is
implied. This targeted verifier does not claim the separate localhost verifier
scripts were rerun. The production approval/cutover gate below still applies.

## Production compatibility gate — pending owner approval

The physical rename is **not backward compatible** with the currently deployed
Backend. It cannot be applied while old instances serve requests. This work is
ready for review/testing, not an approval to migrate or deploy production.

Smallest coordinated sequence, to be performed only after separate approval:

1. Review the full release (including existing unstaged work), verify the exact
   target branch/database and all historical checksums/status, and prepare the
   tested new Backend artifact before touching production. Take an approved
   recoverable snapshot/backup and record the old deployment and migration state.
2. Schedule a maintenance window. Stop/drain every old Backend instance and any
   other CatalogItem writer. Do not deploy new readers against the old schema,
   or let Railway overlap old/new instances across the rename.
3. From a direct, private production connection, run the three forward migrations only after the new gallery migration is verified
   once using Prisma migrate deploy. Never use migrate dev/reset/db push or
   the unrelated production cleanup SQL. Stop on lock timeout or schema drift.
4. Start the tested new artifact. Keep existing Dashboard commands and database
   identity; provision Cloudinary credentials manually only if image uploads are
   approved. Missing Cloudinary settings must not block normal Product CRUD.
5. Verify schema/history, authenticated Products/Variants/Inventory, Excel
   re-import and isolation. Real Cloudinary upload/delete and Android display need
   a separately approved disposable-image smoke test. AI integration is excluded
   from this release and is not a dependency of the database cutover.

Rollback plan: before a migration commits, PostgreSQL rolls that transaction back
on failure. After the rename commits, **do not simply roll Railway back to old
code**. Keep service traffic stopped. Prefer fixing forward with a reviewed new
artifact; reverting physical names requires a separate reviewed corrective
forward migration (inverse renames preserving ProductImage and its FKs), plus
old-schema compatibility tests. Never rewrite migration history or drop image
data. A backup restore requires separate explicit approval and a write-loss
assessment. A no-maintenance rollout would require an additional bridge release
and contract coordination, not simultaneous old/new deployment of this change.

Product gallery policy additionally requires `20261105000000_product_image_main_and_gallery_policy`.
It adds ordered slots 0..4, preserves image rows and refuses a Product with more
than five active or uploading images. Isolated Neon migration/backfill/constraint
and concurrency checks passed; Production cutover still needs explicit approval. Old color-image writers must not overlap
this policy. See [image policy](product-images.md).
