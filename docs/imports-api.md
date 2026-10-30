# Excel Products and Variants Import API

Flow: Analyze → Mapping → Validate → Validation Results → Preview → Execute →
Status/History. Processing remains synchronous. All routes require a Bearer JWT
and current active OWNER membership. `/imports/:importId` routes resolve the
job's business in the global guard; knowing an import UUID grants no access.
Error bodies remain `{ statusCode, code, error, message }`. File keys, paths and
database errors are never returned.

## Workbook identity and grouping

One row means one variant. `externalKey` is a required, trimmed, case-sensitive
product grouping code, max 200 characters, unique per business. It is not the
variant SKU. Name is required, trimmed, max 200. All rows sharing a code must
agree on name, description, category, basePrice and mapped product attributes,
including blanks; one conflicting/invalid row rejects its entire product group.

SKU is a separate optional standard field for simple products, required on every
configurable variant. It is trimmed and case-sensitive, max 200, unique per
business including inactive variants. The stable variant identity is the product
code plus the exact option combination (JSON key order does not matter). An
existing SKU cannot move to another product or combination. A mapped nonblank
unreserved SKU can rename the same combination; omission/blank preserves its SKU.
Names alone are never used to find existing products.
For a Product created without an externalKey, assign its unique grouping code
through the existing scoped `PATCH /catalog-items/:id` metadata API before an
import update. Otherwise the new code inserts a new product; UUIDs and names
are not fallback matches. Format product-code and SKU cells as Excel text to
preserve leading zeroes.

For selected options, map a column as `VARIANT_ATTRIBUTE` with the option name as
target. This now creates real Product.options and Variant.optionValues, rather
than inert metadata. Arbitrary business-specific names of 1–60 trimmed characters
are supported, including spaces, case and Unicode; reserved prototype keys are
rejected. Every mapped option requires a nonblank value on every row. Numeric or
boolean cells become strings. Definitions are the selected values observed in
the product group. Product policy limits apply: max 10 keys, 50 values per key,
100 characters per value and existing JSON byte bounds.

No option columns means a simple product with a single `{}` Default Variant.
Duplicate product/option combinations and duplicate SKUs anywhere in the workbook
are invalid; all affected groups are excluded. A configurable import can extend
the allowed values of existing options while retaining unimported definitions and
variants. It cannot rename/remove option keys, convert a simple product, rewrite
existing combinations, or reactivate inactive products/variants. Perform reviewed
Product/Variant lifecycle changes separately.

### Example workbook

| Product Code | Name  | SKU          | Category | Price | Variant Price | Quantity | Color | Size |
| ------------ | ----- | ------------ | -------- | ----- | ------------- | -------- | ----- | ---- |
| SHIRT        | Shirt | SHIRT-RED-M  | Clothes  | 20.00 | 22.00         | 8        | Red   | M    |
| SHIRT        | Shirt | SHIRT-BLUE-M | Clothes  | 20.00 |               | 12       | Blue  | M    |

Map Product Code→externalKey, Name→name, SKU→sku, Category→category,
Price→basePrice, Variant Price→unitPrice, Quantity→stockQuantity as STANDARD;
map Color/Size as VARIANT_ATTRIBUTE targets `color`/`size` (or the desired names).
This creates one product, two variants, one scoped category and two stock audits.
Blank variant price inherits basePrice on create and preserves unitPrice on update.

For a simple product use a separate workbook without option columns:

| Product Code | Name | SKU   | Price | Quantity |
| ------------ | ---- | ----- | ----- | -------- |
| TEA          | Tea  | TEA-1 | 5.00  | 4        |

Prices must be nonnegative decimal values with at most two fractional digits and
ten integer digits; no separators, currency signs or rounding. Quantities are
integers 0–2147483647. Mapped blank or unmapped stock never changes existing stock
or tracking. Nonblank stock goes exclusively through InventoryService, enabling
tracking and recording INITIAL_IMPORT/IMPORT_UPDATE. New variants without stock
start untracked/null. Imports never disable tracking.

Category names normalize whitespace and compare case-insensitively within the
business. An existing scoped Category is reused; otherwise it is created in the
group transaction and assigned to categoryId. The incoming trimmed category text
is also retained in the legacy category field. Blank category preserves an
existing category; imports do not accept foreign Category UUID references.
ATTRIBUTE columns merge nonblank values into product attributes and preserve
unmapped values. These retain safe lowercase attribute-key rules.

## Endpoints and success contracts

1. `POST /businesses/:businessId/imports/excel/analyze` (201): multipart `file`
   `.xlsx`, optional sheetName. Returns `{ importJobId, status, sheetNames,
selectedSheetName, headerRow, headers, sampleRows, totalRows }`. Existing file
   validation and 10-MB limit remain. Header detection and first-sheet defaults
   are unchanged; choose another sheet with a new upload. No manual headerRow.
2. `GET /imports/:importId/mapping` (200): `{ importId, status, columns, mapping }`.
   Suggestions distinguish SKU from product code; custom option mappings remain
   explicit. Suggestions are advisory.
3. `PATCH /imports/:importId/mapping` (200): `{ mapping: [...] }`, returning
   `{ importId, status, mapping }`. Must map both name and externalKey. Each entry
   uses sourceColumn, optional sourceColumnIndex, type and target. For duplicate
   or blank headers supply its one-based index. Types STANDARD, ATTRIBUTE,
   VARIANT_ATTRIBUTE, IGNORE, UNMAPPED remain; ignored/unmapped targets are null.
   Confirmation keeps MAPPING_REQUIRED; validation locks mapping afterward.

```json
{
  "mapping": [
    {
      "sourceColumn": "Product Code",
      "sourceColumnIndex": 1,
      "type": "STANDARD",
      "target": "externalKey"
    },
    {
      "sourceColumn": "Name",
      "sourceColumnIndex": 2,
      "type": "STANDARD",
      "target": "name"
    },
    {
      "sourceColumn": "SKU",
      "sourceColumnIndex": 3,
      "type": "STANDARD",
      "target": "sku"
    },
    {
      "sourceColumn": "Color",
      "sourceColumnIndex": 8,
      "type": "VARIANT_ATTRIBUTE",
      "target": "color"
    }
  ]
}
```

4. `POST /imports/:importId/validate` (201): no upload/body required. Returns
   `{ importId, status: "READY", summary: { totalRows, validRows, invalidRows,
skippedRows } }`. Validates the entire workbook and reads current scoped
   product/variant/SKU state. Does not write products or stock. READY can contain
   invalid groups; inspect results. Repeating validation returns 409.
5. `GET /imports/:importId/validation-results?limit=50&offset=0` (200):
   `{ importId, status, summary, pagination, validRows, invalidRows }`. Reads the
   retained validation snapshot without rerunning processing. Valid rows include
   `rowNumber`, `data` with sku/unitPrice/options/variantAttributes as mapped;
   invalid rows include `rowNumber`, `errors: [{ field, code, message }]`.
6. `GET /imports/:importId/preview?limit=50&offset=0` (200), READY only:
   `{ importId, status, summary, pagination, inserts, updates, unchanged,
invalidRows }`. Summary adds willInsert, willUpdate, unchanged. Actions count
   **variant rows**, not distinct products. Existing actions include catalogItemId
   and variantId; UPDATE changes describe product and variant differences.
   Rebuilds the full workbook, checks current DB conflicts and makes no writes.
   Preview is advisory: execution repeats checks under locks.
7. `POST /imports/:importId/execute` (200), READY only:
   `{ importId, status, summary, inserted, updated, unchanged, failedRows,
invalidRows }`. Executed rows include `{ rowNumber, externalKey, catalogItemId,
variantId }`. Summary adds insertedCount, updatedCount, failedCount,
   unchangedCount. Failed rows include rowNumber/code/message. These arrays are
   the complete execution result; they are not paginated.
8. `GET /imports/:importId` (200): compact persisted status/counters and timestamps,
   unchanged response contract; excludes mapping, full errors and file storage.
9. `GET /businesses/:businessId/imports?limit=20&offset=0` (200):
   `{ pagination, items }`, items use the same compact Status shape. Orders by
   createdAt descending then id descending; no storage paths or private errors.

## Pagination

GET validation-results/preview/history retain `{ limit, offset, totalCount,
hasMore, nextOffset }`. Limit range 1–100; defaults 50 for row readers, 20 for
history. Offset is a nonnegative safe integer. Unknown query fields and invalid
UUIDs return 400 VALIDATION_ERROR. Final/out-of-range pages have hasMore false,
nextOffset null and empty arrays as appropriate.

Row pages combine valid and invalid non-skipped Excel rows in rowNumber order,
page once, then split into collections. Limit applies across the collections,
not individually. Counts/summary always cover the full workbook. Pagination is
not a way to execute only selected rows.

## Transactions, repeat execution and partial failures

READY→IMPORTING is claimed atomically; only one request executes a job. Execution
uses serializable transactions per product group, with an advisory identity lock
for first insertion and the same parent-first lock as Product/Inventory writers.
Category, product, all variants, stock and movements for that group commit or roll
back together. A rejected group does not leave partial variants or stock. Other
groups can succeed. Uniqueness races fail safely rather than duplicate identities.

COMPLETED means no invalid/failed rows. Otherwise successful processing ends
COMPLETED_WITH_ERRORS. Infrastructure/workbook/job-level failures end FAILED when
the database can persist that state. Earlier committed groups remain. Counters
are row-based. HTTP failure is not evidence that nothing committed; GET Status
after a timeout before taking action.

Completed/failed jobs cannot be replayed or remapped. Use a new corrected upload;
stable codes/combinations update existing identities instead of duplicating them.
Explicit stock cells are absolute sets and can intentionally replace later stock
when submitted in a _new_ job. Blank stock is the safe choice for metadata-only
reimports. Per-job row references prevent duplicate stock writes for that same
operation. A forced process exit can leave IMPORTING with stale counters: there
is no durable worker or automatic takeover. Investigate committed records/audits
before approving a new import; never blindly switch an old job back to READY.

Correct workbook/mapping errors with a new job. Scoped database row errors
include `MERGED_ATTRIBUTES_INVALID`, `PRODUCT_INACTIVE`, `VARIANT_INACTIVE`,
`SKU_RESERVED`, `OPTIONS_CONFLICT`. Workbook errors include `DUPLICATE_SKU`,
`DUPLICATE_COMBINATION`, `CONFLICTING_PRODUCT_ROWS`, `PRODUCT_GROUP_INVALID`.
These errors identify excluded product groups.
Runtime conflicts use EXECUTION_CONFLICT; other group failures use
ROW_EXECUTION_FAILED. Infrastructure details remain private.

## Android changes and rollout

Keep all existing route names and pagination envelopes. Separate product code
and SKU UI fields; require product code, and SKU for configurable rows. Render
option definitions/selections as real variants. Allow repeated product codes,
show group-wide errors, use variantId in execution/preview models, interpret
counts as variant rows, and never assume a blank stock cell means zero.
Reconfirm or replace pre-upgrade mappings/jobs; no promise is made that old inert
variant mappings can be executed with their previous meaning.
New validation snapshots use internal version 2. Version 1 snapshots return
409 IMPORT_VALIDATION_RESULTS_UNAVAILABLE; they are not presented as real variant
validation results. Create a new upload/mapping rather than interpreting an old
snapshot as the upgraded contract.

Local filesystem storage is unchanged and remains temporary on Railway without
a durable volume/object store. Missing files/snapshots yield safe errors; this
upgrade does not make import storage production-durable. See the separate
[migration and scoped cleanup approval plan](variant-inventory-rollout.md).

## Import audit clarifications

Validation checks the final merged product attributes, including retained keys,
against the 16384 UTF-8 byte and nesting limits before READY. Invalid product
groups remain excluded from preview and execution.

Category resolution uses the same business-scoped PostgreSQL normalization in
validation, preview and execution. An UPDATE can repair categoryId even when the
legacy category string is unchanged. changes.categoryId.to is an existing UUID
or { "create": "Normalized category name" } when execution must create it;
Android must handle this object as a proposed creation, not a UUID. Reads never
create categories. Blank categories preserve the current relation.

Preview uses one repeatable-read database snapshot. Execution rechecks each
group under serializable locks. Definitely aborted serialization conflicts are
retried at most three attempts with new transactions; unknown commit/network
failures are never blindly replayed. Unchanged metadata with blank stock does
not touch product or variant updatedAt. Explicit stock retains its audit rules.

Analyze totalRows counts non-empty data rows; validation totalRows includes
physical blank data rows and reports those separately in skippedRows. Automatic
header detection is heuristic; ambiguous layouts need a clean header row and a
new upload. Mixed simple/configurable products use separate workbooks.
