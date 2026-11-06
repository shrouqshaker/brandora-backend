# Product domain and Cloudinary execution report — 2026-11-04

## Result and scope

The Backend implementation, local migrations and isolated Neon application tests
are complete. Production schema and deployment remain unchanged. This is ready
for a controlled code review; publishing it requires a coordinated database and
Backend release, not an ordinary rolling deployment against the existing schema.

Existing staged/unstaged/untracked work was preserved. The Git index hash is
unchanged. Historical migrations, Auth/Resend source, shared externalKey Unicode
validation and held production-cleanup files retain their original bytes. No
separate FastAPI files were modified. No file was staged, committed or pushed.

## Product logic and naming

Product contains metadata, externalKey, category, base price, attributes and
arbitrary options. A simple Product gets its one empty-option Variant; Color,
Size or other options are optional. Variant combinations and SKUs retain their
existing scoped uniqueness, including inactive rows. Effective price uses the
variant override or base price, preserving zero correctly. Inventory and its
audit movements belong to Variants: untracked is null, tracked stock is an
integer including zero. Existing atomic writes and tenant scopes remain.

The audit did not justify redesigning those established rules. Current CRUD and
inventory/import regressions pass. Internal Prisma types, relation names,
delegates, raw SQL locks, service scopes, import planning and fixtures now use
Product/productId. Business.products and Category.products replace their old
relation fields. The old HTTP Catalog API stays removed. Existing wire
catalogItemId fields remain equal aliases of the added productId fields, allowing
Android and the current FastAPI parser to keep working.

The two forward migrations are
`20261104000000_rename_catalog_item_to_product` and
`20261104010000_add_product_images_and_color_option`.
Their exact SQL, inspected production identity, final table structure,
dependencies, compatibility gate and rollback plan are in
[the database rollout](product-domain-database-rollout.md). No existing migration
was rewritten and no new migration drops/truncates existing tables or columns.

## Images, import and clients

Owner-only POST/GET/DELETE image routes live below
`/businesses/:businessId/products/:productId/images`. ProductImage stores scoped
Cloudinary metadata, unique active main/color slots and recoverable upload/delete
states. Cloudinary HTTPS is signed server-side; uploads validate ownership, file
size/type and the configured existing color option. The old image survives until
replacement activation commits. Failed remote deletion remains explicitly
retryable; failed activation is compensated without deleting a possibly committed
active asset. There is no queue or worker.

Re-import keeps externalKey identity, variants and image rows/URLs/timestamps.
Omitted stock is preserved and supplied stock remains absolute. Import extends
values without deleting absent colors or images. Product option changes that
invalidate saved color images fail with PRODUCT_OPTIONS_IN_USE until explicit
image deletion/reconciliation. The maximum externalKey remains 200 Unicode code
points; normalizing/uniqueness semantics and the 10 MiB Excel limit are unchanged.

Android can use the main image or selected-color image with main-image fallback.
Read-only AI tools pass approved metadata through without image-write tools.
The current FastAPI contract accepts the new Backend responses; consuming image
fields requires Malak's separate future typed-schema work. Conversation activation
and live-model tests remain separate. See [image API and recovery](product-images.md).

## Actual verification

| Command / target | Final result |
| --- | --- |
| `npm run prisma:validate` | Exit 0 |
| `npm run prisma:generate` | Exit 0; Prisma 7.10.1 |
| `npm run build` | Exit 0 |
| `npm test` | Exit 0; **28 suites, 809 Jest tests passed**, no failed/skipped tests; embedded native Business runner **16 passed** |
| `node verification/product-crud-postgres.cjs` | Exit 0; **154 real HTTP assertions** plus DB assertions |
| `node --test verification/variant-inventory-import-postgres.cjs` | Exit 0; **22 tests, 197 real HTTP assertions** plus DB assertions |
| `node verification/product-domain-migrations.cjs` | Exit 0; **2 scenarios** (fresh / populated ten-migration upgrade), all **12 migrations** applied; seeded IDs/data/stock/audit preserved |
| `node verification/controller-route-inventory.cjs` | Exit 0; **49 routes**, 41 owner-JWT routes + 1 service-guarded AI route + 7 public; **0 mismatches** |
| `node verification/ai-cross-contract.cjs --ai-dir ../brandora-ai --python <local-python>` | Exit 0; current AI checkout accepts signed request and Product presenter including new fields; Backend accepts E0 response; tampered body/wrong-direction credential rejected; **0 network/provider requests** |
| `git diff --check`, `git diff --cached --check` | Exit 0 |

Local migration runs created fresh random databases only. Final retained targets:
`brandora_product_fresh_83b65942d18d4228b3d3eeca70b56852`,
`brandora_product_upgrade_018630a49a1347d09e86ea57ac7e6229`.
The final Variant/Inventory/Import/image verifier retained
`brandora_variant_inventory_3ad480a5bce34e02a8049177e9df228e`.
The Product CRUD verifier retained
`brandora_task2_b3f9669038e245cf8763588e5902096d`.
The historical foundation-only verifier and standalone long-running Auth
PostgreSQL verifiers were not rerun; current Auth regressions ran in npm test.

Neon child `test-product-domain-cloudinary-20261104`
(`br-calm-resonance-b4fb1aqv`) passed Prisma migration status and all 12 content
checksums, actual Product/Variant/Inventory service operations, image
upload/replace/delete with a mock provider, partial uniqueness, cross-business FK
rejection, scoped reads, image-option protection and two actual Excel executions
preserving images, identity and omitted stock. A temporary fixed-test-endpoint
verifier ran these checks; it is ignored and excluded from application files.
Initial harness issues (LF/CRLF checksum comparison, regclass result casting and
missing RowNormalizer injection) were corrected before this successful run.

Production was rechecked read-only afterward: CatalogItem still exists,
Product/ProductImage do not, and only the original ten migrations are applied.
Railway still uses the inspected old deployment; no settings/variables were changed.

Cloudinary transport is mocked in all image checks. No real image was uploaded,
and cloud credentials/account readiness, CDN delivery and Android device display
are not verified. Provider/DB failure cases emit intentionally sanitized errors in
test output; all final assertions pass. An intermediate full run failed two
outdated destroy-result assertions; those assertions were corrected, and the
final complete npm test run above passed all 809 tests.

## Remaining release gates

- Approve a coordinated maintenance-window migration/deployment sequence: old
  CatalogItem readers cannot run against renamed physical tables. No production
  migration, database URL update, restart or deployment is authorized by this work.
- Configure Cloudinary variables privately and approve a disposable-image live
  smoke test; metadata tests do not prove real cloud delivery.
- Retain/review the Neon testing branch and synthetic fixtures; deleting it or
  changing its lifecycle/compute settings needs owner approval. The account did
  not permit a custom suspend interval.
- Resolve rare remote orphan/pending deletion states manually using retained
  public IDs. There is no cross-provider atomic transaction or background retry.
- Keep AI integration disabled until its existing persistence/security/real-E2E
  gates pass. Image-heavy AI pages remain subject to the existing byte cap.
- Held `docs/production-migration-preflight.md` and
  `verification/production-variant-cleanup.sql` remain untouched and unexecuted;
  they are excluded from the application release unless separately approved.

## Exact application-file changes in this task

The lists below are relative to the working tree captured before this task,
including its previous untracked files. Prior Catalog deletions and Resend staged
changes are preserved, not counted as new edits here. No additional files were deleted.

Total: **13 created, 48 modified, 0 deleted** in this task. A private comparison
against configured local credential values found no matches in these 61 files.
Cloudinary/Resend example keys remain empty, AI remains disabled by default, and
there is no Backend railway.json. The original staging area remains unchanged.

Created (13):

- docs/product-domain-database-rollout.md
- docs/product-domain-verification.md
- docs/product-images.md
- prisma/migrations/20261104000000_rename_catalog_item_to_product/migration.sql
- prisma/migrations/20261104010000_add_product_images_and_color_option/migration.sql
- src/products/images/cloudinary.service.ts
- src/products/images/product-image-upload.interceptor.ts
- src/products/images/product-image.dto.ts
- src/products/images/product-images.controller.ts
- src/products/images/product-images.service.ts
- src/products/product-image-policy.ts
- verification/product-domain-migrations.cjs
- verification/regressions/product-images.spec.ts

Modified (48):

- .env.example
- README.md
- dev/ai-local-setup.cjs
- docs/ai-integration.md
- docs/ai-local-testing.md
- docs/android-integration-guide.md
- docs/imports-api.md
- docs/inventory-api.md
- docs/local-development.md
- docs/local-verification.md
- docs/products-api.md
- docs/railway-release-readiness.md
- docs/variant-inventory-rollout.md
- prisma/schema.prisma
- prisma/verification/README.md
- src/common/errors/error-code.ts
- src/imports/execution.service.ts
- src/imports/preview/import-planner.ts
- src/imports/preview/preview.types.ts
- src/imports/variant-import-policy.ts
- src/inventory/inventory.controller.ts
- src/inventory/inventory.service.ts
- src/products/dto/product.dto.ts
- src/products/product-access.service.ts
- src/products/product-presenter.ts
- src/products/products.module.ts
- src/products/products.service.ts
- src/variants/variants.service.ts
- verification/README.md
- verification/ai-cross-contract.cjs
- verification/auth-postgres.cjs
- verification/controller-route-inventory.cjs
- verification/controller-route-inventory.spec.cjs
- verification/product-crud-postgres.cjs
- verification/regressions/ai-integration.spec.ts
- verification/regressions/auth.spec.ts
- verification/regressions/error-contract.spec.ts
- verification/regressions/execution.spec.ts
- verification/regressions/import-planner.spec.ts
- verification/regressions/imports.spec.ts
- verification/regressions/inventory-api.spec.ts
- verification/regressions/inventory.spec.ts
- verification/regressions/mapping.spec.ts
- verification/regressions/preview.spec.ts
- verification/regressions/product-policy.spec.ts
- verification/regressions/products-api.spec.ts
- verification/regressions/validation.spec.ts
- verification/variant-inventory-import-postgres.cjs
