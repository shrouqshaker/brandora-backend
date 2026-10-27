# Maintained regression suite

Run `npm test`. Its pretest builds the current application and generates Prisma
Client. Jest discovers official suites only under this directory: TypeScript
regressions in `regressions/` and the existing Node business-test adapter.
No test reads or loads source code from `.tmp`, an archived checkout, or a
generated verification report. Setup supplies a localhost-only placeholder URL;
all maintained HTTP/unit tests mock persistence and do not connect to PostgreSQL.

The restored suites were reviewed against current `src/` implementation. Imports
point directly to `../../src`, and the compatible assertions were retained. These
files are now the maintained copies; the earlier local snapshots are not executed.

Coverage includes Catalog CRUD, tenant scoping, validation and externalKey
conflicts; Inventory adjustment, no-op behavior, transactions, audit history and
error handling; Excel analysis, mapping, row normalization/validation, preview,
execution, import status/history, storage, and the shared HTTP error contract.
Business settings and working-hours regressions are included as well.

The `maintained.spec.cjs` adapter invokes `businesses.test.cjs` through its native
Node runner. Report its 16 Node tests separately from Jest's adapter test count.
`npm test` does not execute the separate PostgreSQL verifier; that remains
`node prisma/verification/product-foundation.cjs` on isolated local PostgreSQL.

## Obsolete cases intentionally not restored

- Storage: `checks writability at startup and removes the probe` and
  `reports unwritable storage without logging raw filesystem details` both call
  `LocalImportFileStorage.onModuleInit`. That method is absent from the current
  implementation, which creates the directory during save operations. The two
  assertions were not transplanted. Seven compatible storage cases remain:
  unique keys/bytes/idempotent deletion, partial-write cleanup, and five invalid
  path/key cases. No application startup behavior was added to satisfy old tests.
- `environment.spec.ts` imports the nonexistent `src/config/environment` module
  and tests a CORS configuration contract absent from the current application.
  It is obsolete for this checkout and is not part of the restored suite.
- Archived Railway preflight tests exercise deployment scripts absent from this
  checkout. They are excluded rather than copied into the maintained suite.

All `.tmp` snapshots, their relocated test copies, and `brandora-author-fix` remain
excluded. Do not count their earlier test results as maintained-suite results.
