# Task 1: schema-only product foundation

Migration: `20261027000000_add_product_variants_categories`.
Forward migration: `20261027010000_unique_variant_option_values`.

## Final scope

The migration adds Category, ProductVariant, nullable CatalogItem.categoryId,
CatalogItem.options with default `{}`, indexes, and database constraints. It does
not insert, backfill, delete, or reset application data. Category and ProductVariant
start empty; existing CatalogItem.categoryId values start null. The old category
string, price, stock, tracking, externalKey, attributes, active state, timestamps,
and every existing unique constraint remain intact. Business.category continues
to represent the business profile. No default-variant UUID convention is imposed.

Existing CatalogItem and InventoryMovement test records may be removed separately
after review using the manual maintenance script. No application modules are
removed or modified, including CatalogService, InventoryService, and Excel Import.
Business, BusinessSettings, WorkingHour (working hours), and ImportJob are untouched.
Customer, Conversation, and Message models are not present in the current Prisma
schema; neither artifact targets tables for those domains.

## Schema and SQL invariants

- Composite Category `(businessId, id)` and CatalogItem `(businessId, id)` tenant
  keys support composite foreign keys. Categories and variant parents must belong
  to the same business on both inserts and updates. Restrictive foreign keys
  protect referenced parents against deletion and tenant reassignment.
- Category names are unique per business after collapsing PostgreSQL
  `[[:space:]]` runs to one ASCII space, trimming, and applying `lower` using the
  database collation. Blank names are rejected. Display text is preserved.
  Unicode normalization and accent folding are not performed.
- Variant SKUs are case-sensitive and unique per business for non-null values;
  multiple nulls are allowed. Inactive variants keep their reserved SKU. Business,
  parent, and business-scoped SKU lookups have indexes.
- Variant option combinations are unique per business/product using JSONB
  equality. Object key order does not affect uniqueness. Inactive variants retain
  their combinations and `{}` reserves the default combination. The forward
  migration checks existing data and aborts on duplicates without deleting rows.
- New `options` and `optionValues` fields must be non-null JSON objects.
- The normalized category expression index and CHECK constraints are maintained
  in SQL because Prisma cannot express them. They are tested behaviorally;
  Prisma schema diff additionally verifies the representable schema, including
  composite relations and unique constraints. Preserve the SQL-only constraints
  when reviewing future generated migrations. See the
  [PostgreSQL expression-index documentation](https://www.postgresql.org/docs/17/indexes-expressional.html)
  and [Prisma index documentation](https://www.prisma.io/docs/orm/prisma-schema/data-model/indexes).

## Separate manual test-data cleanup

Review `prisma/maintenance/cleanup-disposable-catalog.sql`. It is outside the
migrations directory and is never invoked by migration deployment, builds,
application startup, or the verifier. It has not been executed.

It requires an exact development database name and an explicit allowlist of
`(businessId, catalogItemId)` UUID pairs. Empty allowlists and mismatched tenants
fail before deletion. It deletes only the selected items' InventoryMovement rows,
then those CatalogItem rows, in one transaction. Other items, businesses, settings,
working hours, import jobs, categories, variants, and customer/conversation/message
tables are not deletion targets. No database-wide deletion or reset is included.
It refuses incoming foreign keys with cascading or field-changing delete actions;
restrictive dependencies, including existing ProductVariants, block item deletion
and roll back the transaction rather than deleting additional domains.

Before any manual run, stop development writers, inspect the exact connection,
database name and UUID allowlist, and review existing database triggers as well as
foreign keys if your development schema differs from the repository. The script
prints selected row counts and defaults to ROLLBACK. Only after reviewing the
allowlist and counts should an operator explicitly change the final ROLLBACK to
COMMIT for a later manual run. No production run is authorized by this task.
This psql-specific script uses ON_ERROR_STOP so any error aborts the run and rolls
back the open transaction when psql disconnects. Do not use Prisma migrate/db
execute to invoke it.

## Upcoming module upgrades

The current importer and catalog create path still create CatalogItems without
variants or category links. No database trigger or automatic synchronization is
added here. The Import Upgrade must create or ensure a default variant within
the same row transaction as the parent import, use a stable non-null retry identity
independent of nullable SKU, resolve normalized business-scoped categories safely
under concurrency, and define how stock stays consistent for every writer.
Keep unitPrice null when inheritance from basePrice is intended. Normal catalog
creation needs the same policy in its separate upgrade. These are future design
requirements, not implemented behavior in Task 1.

CatalogService currently returns full Prisma records. Deploying a regenerated
client therefore adds categoryId/options to catalog responses automatically.
Preserving the exact prior response shape requires a separate application
projection change before client rollout; this task leaves response code unchanged.

## Verification

Use isolated local PostgreSQL on `127.0.0.1:55439`, with a `postgres` user able to
create development databases. The verifier ignores the configured Neon URL and
overrides DATABASE_URL in every Prisma subprocess. It creates three random local
development databases and retains them afterward; no database is dropped or reset.
The cleanup script is inspected statically only and is never executed.

`npm test` builds the current application, then runs Jest with `jest.config.cjs`.
Jest discovers maintained `verification/**/*.spec.cjs` adapters and the restored
`verification/regressions/*.spec.ts` Catalog, Inventory, Excel Import, Business,
and shared-error suites. See `verification/README.md` for coverage and obsolete
cases that were intentionally not restored. The business
adapter invokes the unchanged `verification/businesses.test.cjs` through Node's
native test runner and fails Jest if that subprocess fails. Node subtest counts
are reported separately from Jest's adapter count. Temporary `.tmp` copies,
the local `brandora-author-fix` checkout, and archived suites are excluded.
The PostgreSQL verifier is a separate, explicit command, never an automatic part
of `npm test`. Keep its local database cluster, raw logs, and generated review
reports under ignored `.tmp/`; these are not deliverables for a future commit.

The installed option-combination constraint is documented separately in
`variant-option-uniqueness.md`. It is represented in the Prisma schema and
installed by a separate forward migration; the foundation SQL is unchanged.

```powershell
node prisma/verification/product-foundation.cjs
node node_modules/prisma/build/index.js validate
node node_modules/prisma/build/index.js generate
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Checks cover fresh deployment, deployment over eight existing catalog items
across two businesses, unchanged legacy records and stock, inventory history,
businesses/settings/working hours/import jobs, empty Category/ProductVariant
tables after migration, null categoryId and empty-object options defaults,
concurrent normalized-category and SKU uniqueness, null and inactive SKUs,
tenant isolation on inserts and updates, restrictive parent deletion, JSON-object
checks, field lengths, the existing externalKey constraint, repeat deployment,
migration status, and Prisma schema drift. The manual cleanup script receives
static checks for its two allowed DELETE targets and absence of reset operations;
its runtime behavior is not claimed as tested.

Additional checks in `variant-options.cjs` cover reordered/nested/numeric-equivalent
JSONB combinations, empty objects, inactive combinations, parent/tenant reuse,
concurrent insert and update conflicts, oversized index entries, and atomic
forward-migration failure on duplicate preexisting data. The third disposable
database verifies upgrading a populated ProductVariant table; fixtures are
explicitly changed for the successful retry without deleting data. Live Prisma
schema diffs must be empty after fresh deployment and after that upgrade.

## Migration deployment boundary

Only disposable local development databases are used for verification. No Neon
database is contacted or modified. The new migration is transactional with a
10-second lock acquisition timeout. CatalogItem indexes and ALTER TABLE require
locks; assess deployment timing separately. Keep all older migrations unchanged.
The revised migration is pending/uncommitted; do not replace it on any environment
where an earlier version has already been applied—use a new forward migration
there. No commit, push, production cleanup, or production deployment is included.
