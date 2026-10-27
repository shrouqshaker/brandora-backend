# Maintained regression suite

`controller-route-inventory.spec.cjs` runs automatically in `npm test` after its
pretest build. It discovers compiled controllers directly under `dist/`, verifies
every route against the reviewed authorization policy, and restricts public
routes to the six rate-limited Auth operations. It reads no temporary reports or
archived code. For a standalone inventory after building, run
`node verification/controller-route-inventory.cjs`.

`npm run test:auth-hardening:postgres` also uses that maintained inventory to send
anonymous HTTP requests to all 42 protected endpoints through the real global
guard. It verifies persistent rate-limit counters by closing the first database
connection/provider and enforcing the same quota through a fresh replacement.
These checks use the verifier's newly created random local database, never a
database name passed from a previous run. Import output uses the OS temporary
directory; no input or report under `.tmp/` is required. The original concurrent,
expiry and unavailable-store assertions remain enabled.

Security hardening adds `auth-hardening.spec.ts` for shared-store quotas, proxy
boundaries, fail-closed behavior, reset validation, SMTP configuration and ExcelJS
UUID compatibility. The original Auth assertions remain and now use session-backed
JWT fixtures. Route coverage is 48 endpoints: 42 protected and six public
credential/token operations. No general business endpoint became public.

`npm run test:auth-hardening:postgres` creates a fresh isolated local database on
127.0.0.1:55439 and two independent Nest/Prisma instances. It verifies one-use
refresh/reset races, replay family revocation, immediate access invalidation,
multiple devices, ten-slot/1,000-history bounds, password replacement, controlled
email failures/readiness and account-independent responses, real shared limiter
quotas, expiry, capacity and outage isolation, compressed-request handling and
migration status/drift. Its reset mailer is controlled in memory and no SMTP
message is sent. TTL fixtures are advanced only in that new disposable database;
there is no production bypass or data cleanup. The database is retained.

Task 3 adds `auth.spec.ts` for request validation, JWT verification, deny-by-default
policies, current membership checks and rate limiting. Existing isolated feature
tests remain feature regressions; the error-contract harness explicitly simulates
an authorized guard and the native Business harness supplies a test identity.
Production has no bypass. The real AppModule and global guard run unmodified in
`npm run test:auth:postgres`, including all owner route denial pairs, registration,
multi-business ownership, revocation, rollback and migration drift. Signing keys
are generated randomly for each test run. No test uses production configuration.

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

Task 2 adds `product-policy.spec.ts` (business-defined options, byte bounds, DTOs
and transaction failures) and `product-crud-http.spec.ts` (new routes, scoped IDs,
request boundaries and existing error envelopes). These import current source
directly, and the older regression suites remain enabled.

For real Task 2 database/HTTP checks, run `npm run test:products:postgres` with
isolated local PostgreSQL on 127.0.0.1:55439. It deploys the checked-in migrations
to a new disposable database, tests all new CRUD routes and actual competing
writes, and retains the database.
Lifecycle checks cover explicit PATCH activation/deactivation, inactive parents,
stale options, atomic activation conflicts, concurrent reactivation, last-active
withdrawal and unchanged stock/movement snapshots. Its default-variant rollback
probe uses a fixture-specific trigger in that database and removes only that trigger/function
after the assertion. It never runs the maintenance cleanup script or accesses
Neon. See [Products API](../docs/products-api.md) for the API/lifecycle contract.

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
