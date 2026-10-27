# Variant option combination uniqueness

The original foundation migration is unchanged. The separate forward migration
`20261027010000_unique_variant_option_values` installs optionValues uniqueness
before Variant CRUD is enabled. The Prisma model declares the same database index
with `@@unique([businessId, catalogItemId, optionValues], map:
"ProductVariant_parent_optionValues_key")`. No application business logic changes.

The migration creates a unique B-tree index over the actual JSONB column:

```sql
CREATE UNIQUE INDEX "ProductVariant_parent_optionValues_key"
ON "ProductVariant" ("businessId", "catalogItemId", "optionValues");
```

This compares JSONB values directly, rather than JavaScript serialization or a
text hash. PostgreSQL JSONB ignores object key order and insignificant whitespace,
including inside nested objects, and supports whole-document B-tree comparison.
See [PostgreSQL JSON types](https://www.postgresql.org/docs/17/datatype-json.html).
For a given tenant/product, `{"size":"S","color":"red"}` and
`{"color":"red","size":"S"}` therefore conflict. The unique index arbitrates
simultaneous inserts and updates; a preflight application lookup is insufficient.
Handle SQLSTATE 23505 / Prisma's unique-conflict error in the future variant API.

Both JSON fields are already non-null and checked as objects. Empty `{}` therefore
reserves one default option combination per product. Inactive variants retain
their combination, preventing duplicate historical identities; different products
and businesses can reuse it. The existing composite parent foreign key remains
required. SKU uniqueness is a separate invariant and remains in force.

Equality follows PostgreSQL JSONB semantics: numerically equivalent JSON numbers
compare equally; arrays retain order; strings and numbers remain different types.
Absent keys and keys with JSON null are different. Future API validation must
define stable option identifiers, allowed types, missing/null behavior and allowed
values consistently. Reject duplicate input keys before JSON parsing discards
them if the API needs to distinguish invalid duplicate-key input.

## Safe rollout and size limits

The forward migration is transactional and acquires a table lock with a 10-second
lock-acquisition timeout. Its preflight groups existing variants by businessId,
catalogItemId and optionValues, including inactive variants, and aborts on any
duplicate. The lock prevents writers introducing duplicates between the check
and index creation. It never updates or deletes rows. Resolve any reported
duplicates explicitly before retrying, without automatically deleting history.
Schedule the index build for an appropriate maintenance window because writes
are blocked until the transaction completes. A failure rolls back the index DDL.
After confirming rollback, use normal Prisma failed-migration recovery before
retrying. Do not edit the earlier foundation migration or bypass the constraint.

B-tree index entries have a size limit; arbitrarily large JSONB documents can
make inserts fail. The current constraint fails those writes atomically; it does
not silently omit uniqueness checks. Before exposing Variant CRUD, define
conservative payload limits and map oversized-index errors to a useful validation
response. Do not fall back to an unprotected write or hash raw JSON text. The limit is documented in
[PostgreSQL B-tree indexes](https://www.postgresql.org/docs/17/btree.html).

`product-foundation.cjs` invokes `variant-options.cjs` on isolated local PostgreSQL.
The checks cover reordered and nested keys, whitespace, numeric equivalence,
same/different parents and tenants, `{}` duplicates, inactive duplicates, insert
and update conflicts with genuinely overlapping transactions, and oversized
option payload rejection without a partial insert. A separate disposable
database verifies atomic preflight failure with existing reordered duplicates,
then successful installation after explicitly changing only a test fixture.
No cleanup script runs. Fresh and upgrade schema diffs against Prisma must both
be empty; the JSONB unique index is represented in Prisma rather than hidden as
an SQL-only constraint.
