# Maintained regression suite

Product naming/image migrations: `node verification/product-domain-migrations.cjs`
checks fresh and ten-migration upgrades in new localhost databases, including
data-preserving table/column renames. `product-images.spec.ts` mocks signed
Cloudinary HTTPS, validates files/configuration/timeouts and compensation.
`variant-inventory-import-postgres.cjs` also tests real owner-scoped image HTTP,
partial uniqueness, tenant FKs, rollback and image-preserving re-import with a
controlled provider. No real Cloudinary upload is authorized by these tests.
See [the current database rollout](../docs/product-domain-database-rollout.md).

Variant-only inventory/import upgrade: `npm run test:variant-inventory:postgres`
builds current source and runs `variant-inventory-import-postgres.cjs` with Node's
test runner. It uses a random new PostgreSQL database on 127.0.0.1:55439, never
the environment's production URL. It checks the legacy-data migration refusal,
identity/business/session/import fixture preservation, actual JWT-protected HTTP,
tracked/untracked stock, racing order deductions, idempotency, rollback, full
Excel workflow, SQL CHECKs/composite FKs/partial uniqueness and drift. No real email or
production cleanup runs. See [rollout and Orders contract](../docs/variant-inventory-rollout.md).

The official inventory, row validation, preview, validation, execution and planner
suites now target the new variant-only contract. Obsolete product-level stock,
inert variant metadata and unkeyed import assertions were replaced in place;
the Jest discovery configuration is unchanged.
Existing Auth and Products PostgreSQL verifiers also deploy all ten migrations;
their stock fixtures/routes now use variant inventory. The foundation's historical
SQL verifier remains a Task 1 baseline tool, not the final-schema verifier.

`regressions/auth-proxy.spec.ts` tests direct forged headers, explicit trusted
and untrusted socket peers, right-to-left forwarding chains, malformed selected
addresses, repeated X-Real-IP, IPv6 canonicalization and shared-peer aggregation.
Run it with `npm test -- --runTestsByPath verification/regressions/auth-proxy.spec.ts`.
These peers are simulated; they do not prove Railway ingress provenance.
The PostgreSQL hardening verifier additionally sends 12 concurrent requests over
real local sockets to two application instances, rotating forged/repeated XFF
and X-Real-IP headers. Ten reach validation and two receive 429 with Retry-After;
all use the same socket-IP quota. Existing database concurrency, expiry,
reconnection and unavailable-store checks remain enabled.
See [Railway security review](../docs/railway-proxy-security.md) before deployment.

Brevo configuration checks live in `regressions/brevo-api.spec.ts` and run in
`npm test`. For the focused suite, run
`npm test -- --runTestsByPath verification/regressions/brevo-api.spec.ts`.
HTTPS is mocked: API acceptance, provider/network errors, invalid configuration,
OTP-only email bodies, 8-second header/body timeouts and sanitized failure
responses are tested without sending email. Setup and the owner-only live-email procedure are
documented in [Authentication](../docs/auth-api.md).

The Brevo suite also verifies synchronous delivery outcomes, HMAC-protected 15-minute
reset persistence, failure consumption and the same generic response with an
8.5-second minimum for known/unknown accounts on success, provider errors and
timeouts. Fake timers verify response timing without real email or database access.

`controller-route-inventory.spec.cjs` runs automatically in `npm test` after its
pretest build. It discovers compiled controllers directly under `dist/`, verifies
every route against the reviewed authorization policy. Anonymous routes are the
six rate-limited Auth operations and public App Links. It reads no temporary reports or
archived code. For a standalone inventory after building, run
`node verification/controller-route-inventory.cjs`.

`npm run test:auth-hardening:postgres` also uses that maintained inventory to send
anonymous HTTP requests to all 42 owner-JWT-protected endpoints through the real
global guard. The PostgreSQL verifier also checks persistent
rate-limit counters by closing the first database
connection/provider and enforcing the same quota through a fresh replacement.
These checks use the verifier's newly created random local database, never a
database name passed from a previous run. Import output uses the OS temporary
directory; no input or report under `.tmp/` is required. The original concurrent,
expiry and unavailable-store assertions remain enabled.

Security hardening adds `auth-hardening.spec.ts` for shared-store quotas, proxy
boundaries, fail-closed behavior, reset validation, Brevo configuration and ExcelJS
UUID compatibility. The original Auth assertions remain and now use session-backed
JWT fixtures. Current non-AI inventory is 49 endpoints: 42 owner-JWT-protected endpoints
and seven anonymous endpoints (six Auth
operations and public App Links). No general business endpoint became public.

`npm run test:auth-hardening:postgres` creates a fresh isolated local database on
127.0.0.1:55439 and two independent Nest/Prisma instances. It verifies one-use
refresh/reset races, replay family revocation, immediate access invalidation,
multiple devices, ten-slot/1,000-history bounds, password replacement, controlled
email failures/readiness and account-independent responses, real shared limiter
quotas, expiry, capacity and outage isolation, compressed-request handling and
migration status/drift. Its reset mailer is controlled in memory and no real email
is sent. TTL fixtures are advanced only in that new disposable database;
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

Coverage includes canonical Products CRUD, tenant scoping, validation and retained
import identities; Inventory adjustment, no-op behavior, transactions, audit history and
error handling; Excel analysis, mapping, row normalization/validation, preview,
execution, import status/history, storage, and the shared HTTP error contract.
Business settings and working-hours regressions are included as well.

Task 2 adds `product-policy.spec.ts` (business-defined options, byte bounds, DTOs
and transaction failures) and `product-crud-http.spec.ts` (new routes, scoped IDs,
request boundaries and existing error envelopes). These import current source
directly. The obsolete Catalog suites have been removed; `products-api.spec.ts`
covers retired-route 404s through AppModule, current metadata, scoped reads and
writes, Arabic text, fixed-price formatting, soft deletion and retained import
identity/stock. The existing real PostgreSQL checks cover competing writes.

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

OTP-only recovery adds `regressions/password-reset-otp.spec.ts`. Reset JSON is
email/otp/newPassword; legacy token bodies are rejected. Tests cover leading zeros,
account/key binding and shared five-attempt account limits across instances/IPs.
The PostgreSQL hardening script has been updated for OTP but its old link-mode
execution results do not validate this new contract.

Main/Gallery policy checks are maintained in product-images.spec.ts. They cover
real HTTP guards/DTOs, five slots, batch rejection, serialized application races,
Main changes, promotion, ordering and provider/DB failure compensation. A dedicated
authorized Neon test-branch run passed all 13 migrations and 161 real PostgreSQL/
application assertions, including concurrent Main changes, five-slot reservation
races and two real Excel executions preserving images. Cloudinary was mocked.
The separate localhost verifiers were not rerun; no Production or live external
asset/OTP verification is claimed.

Customers/conversations/messages: `npm run test:conversations:postgres` builds
current source and runs `conversations-postgres.cjs` with Node's test runner on
a new random database on a localhost PostgreSQL server (`TEST_POSTGRES_URL`, or
the server in `.env` `DATABASE_URL`; anything else is refused). It upgrades from
the main schema with Prisma while preserving existing rows, then checks drift,
composite tenant keys in SQL, two-owner isolation over real JWT HTTP, dev-endpoint
idempotency and races, forward-only conversation times and inbox order,
forward-only delivery statuses, validation and the seed guard. The database is
dropped afterwards unless `KEEP_TEST_DB=1`. See [the API](../docs/conversations-api.md).
