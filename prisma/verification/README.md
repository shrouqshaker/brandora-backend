# Historical foundation SQL verification

The tools in this directory target the original Category/ProductVariant
foundation and option-uniqueness migrations under their historical physical
CatalogItem names. They are not the current release verifier, a production
cleanup procedure or permission to rewrite migration history.

Use [database design](../../docs/database.md) for the current twenty models,
SQL-only invariants and nineteen committed migrations. Use
[testing](../../docs/testing.md) for current mocked/HTTP/PostgreSQL commands,
isolation requirements and dated evidence. Counts describe the repository,
not an environment's applied schema.

## Retained tools

- `product-foundation.cjs`: creates fresh/populated/upgrade localhost fixtures;
  verifies legacy-row preservation, category/SKU/tenant/JSON checks, migration
  history, representable drift and static maintenance-script boundaries.
- `variant-options.cjs`: checks JSONB equality independent of key order,
  inactive/empty combinations, concurrent conflicts, size limits and refusal
  of a forward migration with preexisting duplicates.

These are explicit historical tools, not automatic parts of `npm test`. Review
their old-schema assumptions before any use on an isolated disposable localhost
server (historically 127.0.0.1:55439). They retain generated test databases. The
current Product migration verifier is `verification/product-domain-migrations.cjs`.

The foundation/option-uniqueness migrations are committed and immutable where
applied. Use a reviewed new forward migration for later schema changes. SQL-only
constraints require behavioral checks in addition to Prisma drift checks.

The maintenance SQL under `prisma/maintenance/` is preserved, not executed by
build/start or this documentation work. Historical table names, allowlists,
dependency/refusal guards and rollback assumptions must be reviewed separately;
do not use it on a current or production schema as an automatic cleanup step.
