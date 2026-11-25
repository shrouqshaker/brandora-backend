# Testing and verification

Use the maintained repository tools, not deleted temporary copies. This guide
separates mocked persistence, real PostgreSQL, local two-service tests and live
provider acceptance. No historical result below authorizes production operations.

## Maintained mocked checks

```sh
npm test
npm run test:businesses
```

`npm test` builds first (`prisma generate && nest build`), then runs Jest with
`jest.config.cjs`. Discovery is limited to `verification/`; the current inventory
contains 37 maintained `.spec.ts`/`.spec.cjs` files. The native Business HTTP
runner is invoked by a Jest adapter; its subtest count is distinct from Jest's
adapter count. `test:businesses` runs that native runner directly after building.

These HTTP/unit suites use real controllers, DTOs and selected module graphs
with mocked persistence/providers. `verification/setup.cjs` supplies a synthetic
localhost URL and random signing configuration. Some harnesses simulate an
authorized identity; guard-specific tests exercise the real guard. This is not
evidence of real PostgreSQL locking, deployed proxy provenance, mail delivery or
cloud assets. No suite needs a historical `.tmp` snapshot.

Focused runs can use the existing Jest script, for example:

```sh
npm test -- --runTestsByPath verification/regressions/execution.spec.ts
npm test -- --runTestsByPath verification/regressions/products-api.spec.ts
```

Coverage includes Auth/OTP/rate limits, business settings/hours, access-service
reuse, category filtering, Product/Variant lifecycle, image compensation,
inventory transactions, all import stages, message conflicts/lengths, AI tools
and WhatsApp boundaries. Existing assertions against removed Catalog routes
verify 404 behavior; they do not restore that API.

## Route policy and source inventory

After an appropriate build:

```sh
node verification/controller-route-inventory.cjs
```

This reads controller metadata from `dist/`, verifies guards/policies and rejects
duplicate or unexpected route counts. It does not start the application or
connect to a database. At the 2026-11-25 documentation baseline, source and
compiled metadata both describe 67 endpoints: 57 JWT-protected, one separately
guarded internal AI endpoint and nine public-policy endpoints. The compiled
tool reports 58 protected including internal AI, nine public and zero mismatches.
There are 19 committed migration directories and 20 Prisma models. These are
repository inventories, not deployment or full-test results.

## Real PostgreSQL verification

Use a dedicated disposable localhost PostgreSQL server/role permitted to create
test databases. Review the selected script and target before running it. Never
point verification at production, a tunnel, a shared data database or a remote
provider. Localhost checks cannot prove that an operator-owned server is disposable.

| Command                                           | Isolation and lifecycle                                                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:products:postgres`                  | Builds and creates a random database on 127.0.0.1:55439; real Product HTTP/tenant/lifecycle assertions; retains its database.                                                                                    |
| `npm run test:auth:postgres`                      | Builds and creates a random database on 127.0.0.1:55439; real session/ownership/rollback checks; retains its database.                                                                                           |
| `npm run test:auth-hardening:postgres`            | Builds and creates a random database on 127.0.0.1:55439; quotas, proxy behavior, session/reset races, outage isolation and drift; retains its database.                                                          |
| `npm run test:variant-inventory:postgres`         | Builds and runs native tests on a random localhost database; real stock/order-method/import/image metadata constraints and races; retains the database.                                                          |
| `npm run test:conversations:postgres`             | Builds; reads TEST_POSTGRES_URL or the server from private `.env`, rejects nonlocal URLs, creates random test databases; cleans up afterward unless KEEP_TEST_DB=1.                                              |
| `npm run test:whatsapp:postgres`                  | Builds; uses the same loopback target requirement and random fixture database; signed webhooks, fake AI, dry-run/controlled sending, orders and recovery; optional KEEP_TEST_DB retention.                       |
| `node verification/product-domain-migrations.cjs` | After building/generation as needed, creates fresh and populated-upgrade databases on localhost; verifies current checked-in migrations and the three naming/image migrations separately; retains the databases. |

The script's admin connection creates a new named fixture; it does not grant
permission to erase unrelated databases. Conversation/WhatsApp verifiers can
drop only their own generated targets as part of their documented lifecycle.
Review KEEP_TEST_DB before running; do not turn test cleanup into production
maintenance. Current migrations contain refusal guards and historical destructive
steps that are appropriate only for the specifically reviewed target.

Historical foundation tools under `prisma/verification/` target the earlier
physical schema. They are separate explicit commands, not current release
acceptance. Their SQL checks cover normalized names, JSONB equality, tenant FKs,
null/inactive SKUs, index-size bounds and guarded upgrades. See
[their entry point](../prisma/verification/README.md). Preserve SQL-only indexes
and CHECKs; a Prisma diff alone is insufficient.

## Development fixtures and integration tools

The seed refuses nonlocal DATABASE_URL values, but it creates demo businesses
without OWNER memberships. A successful seed does not authorize a logged-in User
to read those businesses. Do not invent an ownership grant or use production
SQL to make a demonstration work. Create an owned Business through the API and
use reviewed local message fixtures, or use the separately controlled AI setup.

[Local AI testing](ai-local-testing.md) documents `dev/ai-local-setup.cjs`, the
loopback runner, offline contract check and the thirteen-request AI collection.
The runner is not AppModule. It uses disposable owned fixtures and synthetic
conversation context. Its success is not acceptance of the real WhatsApp path.
Keep `docs/ai-local-testing.md` at its maintained path: tooling and the collection
reference it. Do not rerun setup just to recreate deleted historical copies.

The [conversation collection](postman/brandora-conversations.postman_collection.json)
contains eleven focused owner API requests. The
[AI collection](../postman/brandora-ai-local.postman_collection.json) targets the
separate development runner. Collection variables are templates; do not share
exports containing actual tokens, passwords or private environment values.

For real provider acceptance, separately approve disposable email recipients,
images, Meta numbers and AI requests. Verify inbox/CDN/device/model behavior;
API acceptance, fake transports and dry run are different layers. Never record
credentials, customer content or OTPs in evidence.

## Historical evidence

These are preserved observations from prior reports, not tests executed by the
documentation overhaul. Counts differ because they describe different snapshots.
Old deployment identities, fixture database names and commit manifests are not
needed to reproduce the maintained commands.

| Recorded snapshot                            | Reported result and limits                                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-27 foundation                        | Isolated fresh/populated/duplicate-option upgrade checks; preserved legacy rows/stock and SQL constraints. Historical physical names, not current release acceptance.                                                                       |
| 2026-11-04 local integration                 | Backend 26 suites/758 tests and 16 native Business checks; separate AI focused 737 tests; rules-mode two-service HTTP 71 assertions; 13 collection requests replayed by Node, not Postman GUI.                                              |
| 2026-11-04 documentation-focused checks      | TypeScript no-emit; four Backend suites/115 tests; three AI suites/366 tests; offline cross-contract check. Full two-service tests were not rerun for that edit.                                                                            |
| 2026-11-04 Product/image report              | Backend 28 suites/809 tests plus 16 native checks; Product verifier 154 HTTP assertions; Variant/Inventory verifier 22 tests/197 HTTP assertions; two fresh/upgrade migration scenarios. Cloudinary mocked.                                 |
| 2026-11-04 isolated provider-database branch | Twelve migration/checksum checks, scoped Product/Variant/Inventory operations, image metadata and two image-preserving imports with a mock image provider. No live asset acceptance.                                                        |
| 2026-11-05 gallery policy                    | Thirteen migrations and 161 real PostgreSQL/application assertions on an authorized isolated branch; backfill/refusal, tenant/uniqueness/concurrency checks and two imports. Cloudinary/workbook storage mocked; not production acceptance. |
| 2026-11-23 AI delivery report                | 35 Backend suites/929 tests; WhatsApp PostgreSQL 39/39; Conversations PostgreSQL 10/10. The report's cases covered webhook repeats, approval races, purchase alerts, handoff and recovery with controlled providers.                        |
| Owner-reported later refactoring baseline    | 37 suites/1,005 regression tests and 16 native Business checks; later Prisma investigation reported 201 focused tests. Not re-executed or independently recounted here.                                                                     |

Historical dependency remediation aligned Prisma packages at 7.10.1 and reported
zero findings in its then-current full/production audits. That result expires
with the snapshot; it is not a current security certification. Preserve the
reviewed lockfile/overrides, including the Effect transitive fix, and revalidate
dependencies in a separately approved release check. Do not use force-upgrade
commands as a substitute for compatibility review.

The reviewed package overrides retain multer 2.5.0 under platform-express,
ExcelJS's uuid 11.1.1, and Effect 3.22.1 under @prisma/config. These are recorded
compatibility decisions, not a recommendation to change packages during a docs
edit. A release security check should use the committed lockfile, fresh full and
production audits, resolved-tree checks and appropriate regressions; a past clean
audit or an installed Swagger dependency does not certify today's vulnerability
state or implement an API documentation route.

## Documentation acceptance

Check source/controller policies, model/FK and SQL-only constraints, ErrorCode
coverage, variable names, package/tool commands, JSON syntax, Mermaid diagrams,
relative file targets and heading anchors. Check that retired-document links have
new destinations and that protected source/tests/configuration remain unchanged.
`git diff --check` complements these checks; it does not verify API semantics.
Live infrastructure and full test results must always identify their actual run,
date and scope rather than reusing historical counts as current results.
