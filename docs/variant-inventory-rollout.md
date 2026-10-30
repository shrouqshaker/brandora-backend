# Variant-only inventory rollout and Orders integration

This branch starts at `57937297ec27cbbd1b427e88b16da2dc0a8106b0` on main.
It does not merge `feature/customers-conversations`, modify Orders, or contact
another developer. Shared-schema coordination still requires team review of
this document and the migration before either branch is merged.
Read-only comparison with remote Yomna commit `0e92d6b` found Customer,
Conversation and Message additions referencing Business; that snapshot has no
ProductVariant/InventoryMovement references. Its schema and AppModule edits
still share files with this branch. No Yomna code or branch was changed/included.

## Final schema

`CatalogItem` remains the product metadata model. Its `stockQuantity` and
`trackInventory` columns are removed. `ProductVariant` owns those fields:
untracked means `(false, null)`; tracked means `(true, integer >= 0)`.
Simple products have one `{}` Default Variant, including new legacy Catalog
creates. Existing products without variants are not silently backfilled.
Configurable variants keep independent stock. Stock and tracking are forbidden
in Product, Variant and Catalog metadata requests.

Every movement has required `businessId`, `catalogItemId` and `variantId`.
Composite foreign keys prove the variant belongs to that product and business.
Movements retain references on soft deletion and cannot cascade-delete history.
Audit rows contain nullable before/after quantities, tracking before/after,
delta, reference, and optional requested order quantity. SQL CHECKs enforce
valid states and arithmetic. Delta uses zero for an untracked null baseline.
The operation unique key prevents replay per business/variant/type/reference;
a SQL-only partial index also reserves each ORDER_LINE per business/type across
variants. SQL-only checks/indexes must remain in migration verification.

## Orders team interface (no Orders implementation)

Inject `InventoryService` from the exported `InventoryModule`.

```ts
type VariantScope = { businessId: string; catalogItemId: string; id: string };

inventory.deductForOrder(tx, scope, quantity, orderLineId);
inventory.restoreForOrder(tx, scope, quantity, orderLineId);
```

Both return `QuantityChangeResult`: `changed`, `quantityBefore`, `quantityAfter`,
`quantityDelta`, `movementId`. Use a positive integer and a stable line identifier
(1–200 characters). Do not use only the order ID when an order has multiple
lines. One line reserves one variant and one quantity. References are scoped to
the business. Repeating the same operation returns its original movement with
`changed: false`; changing quantity or variant conflicts. A restored line cannot
be deducted again with that ID; a new order lifecycle needs a new line ID.

The caller must pass a Prisma transaction and commit its order-state transition
and all stock operations in that transaction. Exceptions must escape the
callback to roll everything back; do not swallow a PostgreSQL error inside an
aborted transaction. For multi-product orders acquire product locks in sorted
product-ID order and line locks in stable line-ID order. On deadlock or Prisma
serialization failure retry the _entire_ caller transaction with the same IDs.
There is no nested transaction or in-memory idempotency cache.

All writers lock the scoped parent product before reading/writing variant stock.
Tracked deductions cannot oversell. Untracked deductions leave quantity null but
still persist an order movement so a later retry cannot deduct again. Restoration
requires the original matching deduction; it is allowed after soft deletion.
Changing tracking is blocked while any order deduction remains unrestored.
Completed fulfilled lines currently remain outstanding for this rule; adding an
order-finalization/reconciliation policy is an explicit future Orders contract,
not a hidden stock write in this upgrade. Absolute manual/import adjustments of
the same tracking mode remain possible and audited.

Manual/import changes use:

```ts
inventory.setQuantity(scope, quantity, movementType, reference?, tx?, tracking?);
```

Only `MANUAL_ADJUSTMENT`, `INITIAL_IMPORT` and `IMPORT_UPDATE` are accepted here.
Tracking defaults true. Explicit disable requires null. Stock cannot be set on
an inactive product or variant; history remains readable. References require both
type and ID. Imports use `(IMPORT_ROW, importId:rowNumber)`. A no-op manual set
does not write; referenced imports record their operation even when unchanged.

## Migration approval and cleanup gate

New migration: `20261030000000_variant_only_inventory` (the tenth migration).
Previous migration files are unchanged. It locks the three affected inventory
tables, with a 10-second lock timeout and 60-second statement timeout. It refuses
to run if any legacy movement exists, any CatalogItem contains legacy stock or
tracking, or any variant has inconsistent tracking/quantity. The checks and DDL
are in one transaction. It does not delete records or backfill guessed history.
If `migrate deploy` hits this preflight, Prisma records a failed migration even
though the SQL transaction rolls back. Do not repeatedly rerun deploy. First
verify rollback, unchanged counts and the legacy schema, approve and perform the
necessary reconciliation, then separately approve marking that failed attempt
rolled back with `npx prisma migrate resolve --rolled-back
20261030000000_variant_only_inventory` before retrying deploy. Never mark it
applied to bypass a failed guard or skip its SQL.

Do not deploy this application version before the migration: old code expects
removed columns and new code requires new movement columns. Coordinate a write
freeze/maintenance window; rolling old code back after this migration is not
compatible without database recovery.

The following counts are an owner-run, read-only approval inventory. No production
counts were obtained during implementation:

```sql
BEGIN READ ONLY;
SELECT count(*) AS products FROM "CatalogItem";
SELECT count(*) AS variants FROM "ProductVariant";
SELECT count(*) AS movements FROM "InventoryMovement";
SELECT count(*) AS import_jobs FROM "ImportJob";
SELECT count(*) AS categories FROM "Category";
SELECT count(*) AS legacy_stock_rows FROM "CatalogItem"
 WHERE "stockQuantity" IS NOT NULL OR "trackInventory";
SELECT count(*) AS inconsistent_variants FROM "ProductVariant"
 WHERE ("trackInventory" AND ("stockQuantity" IS NULL OR "stockQuantity" < 0))
 OR (NOT "trackInventory" AND "stockQuantity" IS NOT NULL);
ROLLBACK;
```

After seeing counts, the owner must explicitly approve a list of test business
IDs and affected product/variant/movement/import-job IDs and counts. Save a
verified recoverable database backup/restore point and export counts first.
Confirm the production branch identity and use a rotated credential given the
earlier exposure; no production identity/credential/recovery checks were performed
as part of this local implementation.
Inspect foreign keys again: if Yomna's Orders or other records reference these
products, stop and coordinate; never cascade or delete unrelated records.

Proposed cleanup, **not executed and not bundled into the migration**: under an
approved business/record allowlist, delete only disposable movements, then
variants, then CatalogItems and ImportJobs; optionally remove now-unused approved
test Categories. Confirm exact per-table counts before COMMIT; ROLLBACK on any
mismatch. Keep Users, BusinessMembers, AuthSessions, PasswordResetToken,
AuthRateBucket, Businesses, BusinessSettings, WorkingHours and every unrelated
record. Do not reset the database. Do not auto-delete uploaded workbook files.
The local Excel storage implementation is unchanged and remains ephemeral on
Railway without a volume/object store.

If any product/variant/history is to be retained, design and approve an explicit
stock/history conversion instead of using the disposable-data cleanup plan.

Only after cleanup/conversion approval, backup verification, and a clean preflight:

```sh
# Owner injects the verified target DATABASE_URL privately. Never paste it in logs.
npm run prisma:deploy
npx prisma migrate status
```

Verify ten successful migrations/checksums, SQL CHECKs, partial uniqueness,
composite FKs, scoped data counts and application smoke tests before reopening
writes. Production execution and Railway deployment are separate approvals.
Recovery requires the approved restore procedure/restore point; code rollback
alone does not restore removed columns or cleaned test rows.

## Local verification

Use the existing isolated PostgreSQL listener on `127.0.0.1:55439`, role
`postgres`, then run `npm run test:variant-inventory:postgres`.
The maintained verifier creates a random new database; it never reads `.env`
for its target. It first verifies refusal to discard a legacy quantity, then
reconciles that local fixture, applies the migration, and compares preserved
identity/business/import fixtures. Tests cover real HTTP/auth, orders,
concurrency, rollback, grouped Excel workflow, partial failure, CHECKs, FKs,
SQL-only indexes and Prisma drift. Disposable databases and OS temporary workbooks
are retained for inspection. No production cleanup script runs.

`npm test` continues to discover all 23 maintained Jest suites. Product-level
inventory endpoints, inert variant-attribute imports, unkeyed import insertion,
and duplicate-product-code rejection are obsolete contracts. Their suites are
updated to variant scope, real options, stable grouping and product-group
atomicity; no obsolete tests are moved to archives or excluded by configuration.

## Implementation review inventory (2026-10-29)

Final local verification: Prisma validate and generation/build passed;
`npm test` passed all 23 suites and 673 tests, with 0 failures, plus the native
Business adapter's 16 tests. The variant inventory/import PostgreSQL verifier
passed 20 tests and 129 HTTP assertions. Auth, Auth Hardening and Products
PostgreSQL verifiers passed 145, 201 and 155 HTTP assertions respectively, plus
their database assertions. All final command exit codes were 0. Controller
inventory: 48 routes, 42 protected, 6 public, 0 policy mismatches. The local
databases reported ten applied migrations and no representable Prisma drift;
SQL-only CHECKs/partial uniqueness were exercised separately. `git diff --check`
passed. Test-fixture failure logs are intentional; there were no final failures.
No Neon/Railway access, production cleanup, commit, push, merge or deployment
occurred. Production row counts and recovery readiness remain unverified.

The 40 intended changed files are listed below. The pre-existing
`docs/business-api.md` heading edit is preserved separately and excluded. No files
are staged. Generated output, environment files and temporary reports are excluded.

```text
docs/api-errors.md
docs/catalog-api.md
docs/imports-api.md
docs/inventory-api.md
docs/products-api.md
package.json
prisma/schema.prisma
src/catalog/catalog.service.ts
src/common/errors/error-code.ts
src/imports/execution.service.ts
src/imports/mapping-fields.ts
src/imports/mapping.service.ts
src/imports/preview.service.ts
src/imports/preview/import-planner.ts
src/imports/preview/preview.types.ts
src/imports/validation.service.ts
src/imports/validation/row-normalizer.ts
src/imports/validation/row-validator.ts
src/imports/validation/row.types.ts
src/imports/validation/saved-mapping.ts
src/inventory/dto/adjust-inventory.dto.ts
src/inventory/inventory.controller.ts
src/inventory/inventory.service.ts
verification/README.md
verification/auth-postgres.cjs
verification/product-crud-postgres.cjs
verification/regressions/catalog-crud.spec.ts
verification/regressions/error-contract.spec.ts
verification/regressions/execution.spec.ts
verification/regressions/import-planner.spec.ts
verification/regressions/inventory-api.spec.ts
verification/regressions/inventory.spec.ts
verification/regressions/mapping.spec.ts
verification/regressions/preview.spec.ts
verification/regressions/row-validation.spec.ts
verification/regressions/validation.spec.ts
docs/variant-inventory-rollout.md
prisma/migrations/20261030000000_variant_only_inventory/migration.sql
src/imports/variant-import-policy.ts
verification/variant-inventory-import-postgres.cjs
```

## Completed Excel workflow audit

Retained the existing analyze/mapping/validate/results/preview/execute/history
workflow, dynamic option grouping, stable identities, variant-only stock and
parent-first atomic InventoryService writes. Added maintained regressions for
categoryId repair, normalized category reuse, merged attribute rejection and
valid merges, missing-code grouping collisions, no-op metadata timestamps,
concurrent category creation, bounded serialization retries, and importId-based
anonymous/foreign-owner denial across all import readers and writers.

Preview now shares a repeatable-read context with validation rules; execution
rechecks the same rules inside each product-group transaction. Category creation
uses the existing database uniqueness constraint. PostgreSQL SQLSTATE 40001 is
recognized through Prisma raw-query adapter metadata as a definitely aborted
transaction; only such failures and P2034 receive bounded retries. Network
failures are not replayed. No additional schema or migration edits were needed
for these audit fixes. See imports-api.md for Android category preview values.
