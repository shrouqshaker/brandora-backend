# Excel Import handoff for Yasmina — Android

**Contract reviewed: current local Backend, 2026-11-04. Not a production release.**
The Product refactor and images passed local PostgreSQL and isolated Neon-branch
checks in the preceding implementation task. The inspected Railway deployment
still uses the older physical CatalogItem schema. The physical Product rename
requires a coordinated database/Backend release. Do not assume this document's
new fields or image routes are available on the public Railway URL.

Use this guide for Android implementation against an explicitly agreed local
test Backend with a disposable database. No production access or migration is
needed to follow this document. Live Cloudinary upload and Android image display
remain unverified. See [release evidence](product-domain-verification.md) and
[database release gate](product-domain-database-rollout.md).

## 1. Connection, ownership and endpoint map

Set `baseUrl` per environment. Paths below are relative to it. Every endpoint in
this guide requires `Authorization: Bearer <owner-access-token>` and active OWNER
membership of the Business. Use the normal login/refresh flow; never embed owner
credentials in source. Send `Accept: application/json`. JSON writes use
`Content-Type: application/json`; multipart analyze uses the HTTP client's
generated boundary, **not** a manually written Content-Type header.

All path IDs are UUIDs. `businessId` comes from the authenticated owner's selected
Business. After analysis, use the returned `importJobId` as `importId` everywhere
else. `/imports/:importId/...` has no Business path parameter: the Backend resolves
the Business from the job and enforces membership. Do not invent a businessId
query/body override. Missing/invalid authentication returns 401; another owner's
job/Business/Product/Variant returns 404 rather than exposing it.

These are **all nine existing Import endpoints**:

| Step | Method and exact path | Success | Input |
| --- | --- | --- | --- |
| Analyze/upload | `POST /businesses/:businessId/imports/excel/analyze` | 201 | Multipart `file`, optional `sheetName` |
| Suggest/read mapping | `GET /imports/:importId/mapping` | 200 | None |
| Confirm mapping | `PATCH /imports/:importId/mapping` | 200 | JSON `mapping` array |
| Validate | `POST /imports/:importId/validate` | 201 | No body required; `{}` accepted |
| Stored validation page | `GET /imports/:importId/validation-results` | 200 | Optional `limit`, `offset` query |
| Current preview | `GET /imports/:importId/preview` | 200 | Optional `limit`, `offset` query |
| Execute once | `POST /imports/:importId/execute` | 200 | No body required; `{}` accepted |
| Job status/counters | `GET /imports/:importId` | 200 | None |
| Business import history | `GET /businesses/:businessId/imports` | 200 | Optional `limit`, `offset` query |

No separate worksheet-update, header-row-update, execution-result retrieval,
retry/resume, cancel, delete-job or downloadable error-report endpoint exists.
Do not construct one from status enum names.

## 2. Workbook and identity rules

One nonblank Excel data row represents **one Variant**, not necessarily a separate
Product. Row numbers in responses are the original 1-based Excel row positions.

| Identity | Meaning |
| --- | --- |
| Product `id` | Backend UUID; used in Products routes, not taken from Excel |
| `externalKey` | Stable, trimmed, case-sensitive Product grouping code from Excel; unique per Business, including inactive Products |
| Variant `id` | Backend UUID; used in Variant/inventory routes |
| `sku` | Optional identifier for a simple Variant; required for every configurable Excel Variant; reserved per Business, including inactive Variants |

Existing Product matching is **Business + externalKey**. Existing Variant matching
is **Product + exact normalized optionValues combination**; it is not SKU-only
matching. Changing SKU cannot retarget a row to a different Product/combination.

Both Products DTOs and Excel validate externalKey with a maximum of **200 Unicode
code points after trimming**. An emoji outside the BMP counts as one code point;
combining marks count separately. There is no Unicode NFC normalization or case
folding. Android's `String.length` counts UTF-16 units; use
`key.codePointCount(0, key.length)` for an equivalent precheck. The server remains
authoritative. Preserve leading zeroes in identifiers by using Excel text cells.

### Fields the mapper actually supports

| Mapping type/target | Meaning and requirements |
| --- | --- |
| STANDARD `externalKey` | Required mapped column and nonblank value on every nonempty row |
| STANDARD `name` | Required mapped column and nonblank value on every nonempty row, including updates |
| STANDARD `description`, `category`, `basePrice` | Optional Product metadata |
| ATTRIBUTE `<safe_key>` | Optional Product attributes; same metadata must agree across rows of a Product |
| STANDARD `sku`, `unitPrice`, `stockQuantity` | Variant SKU, override price, absolute stock quantity |
| VARIANT_ATTRIBUTE `<exact option name>` | Actual selected Variant option, e.g. Color, Size, Binding; requires a nonblank selection and SKU on every configurable row |
| IGNORE / UNMAPPED | No imported value; `target` must be explicit JSON null |

The complete STANDARD target list is `sku`, `unitPrice`, `name`, `externalKey`,
`description`, `category`, `basePrice`, `stockQuantity`. Do not map `categoryId`,
`productId`, `variantId`, `trackInventory`, `isActive`, `colorOptionName`, image
URLs or Cloudinary IDs as STANDARD fields. An UNMAPPED column is ignored during
validation; it is not automatically a row error. Make the choice explicit in UI
so useful columns are not silently missed.

Price cells normalize to decimal **strings with two places**. Use nonnegative
plain numbers with at most two decimal places and value below 10,000,000,000;
zero is valid. Currency symbols, comma grouping and scientific notation are
invalid. Quantity must be an integer from 0 to 2,147,483,647. Blank becomes null;
it is not zero. Names/SKUs/category text are limited to 200 UTF-16 units by the
current Excel validator; description to 5000. Only externalKey uses the shared
200-code-point rule. Do not generalize it to all fields.

### Option shapes

| Product | Excel VARIANT_ATTRIBUTE mappings | Selected row / accumulated Product options |
| --- | --- | --- |
| No options | None | `{}` selection, one default Variant; SKU optional |
| Color only | `Color` | `{"Color":"Black"}` / `{"Color":["Black","White"]}` |
| Size only | `Size` | `{"Size":"M"}` / `{"Size":["M","L"]}` |
| Color + Size | `Color`, `Size` | `{"Color":"Black","Size":"M"}` |
| Custom options | e.g. `Binding`, `Edition` | Exact configured keys, same rules |

Names/values are trimmed and case-sensitive. `Color` and `color` are different
keys. For an existing manual Product, the mapping targets must match its option
names exactly. One selected value is required for every option; absent
combinations are not generated as a Cartesian product. No Color/Size dimension
is mandatory. At most ten option names, fifty values per option, trimmed names
up to 60 and values up to 100 UTF-16 units are allowed. Definitions are bounded
to 16 KiB UTF-8 JSON and every possible selection to 1500 UTF-8 JSON bytes.

Repeating externalKey across different variants is expected. Repeating the same
externalKey and option combination is invalid even if SKU differs. One simple
Product cannot occupy two `{}` rows. Duplicate nonblank SKUs anywhere in the
workbook are invalid. Product metadata (name, description, category, basePrice,
attributes) must agree across all rows sharing a code; Variant price/stock/SKU
may differ. An invalid row invalidates its entire Product group, not other groups.

## 3. Guided example: select, analyze and map

The examples use illustrative UUIDs/timestamps, but actual field names, status
codes and JSON shapes. They are not captured production responses. `I` denotes
import `70000000-0000-4000-8000-000000000001`, `B` Business
`10000000-0000-4000-8000-000000000001`, and `P` Product
`20000000-0000-4000-8000-000000000001`. Use returned values at runtime.

Choose `shirts.xlsx`, worksheet `Products`:

| Excel row | Product Code | Name | SKU | Price | Quantity | Color | Size | Category |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | TEE-001 | Cotton T-shirt | TEE-B-M | 200 | 5 | Black | M | Clothes |
| 3 | TEE-001 | Cotton T-shirt | TEE-B-L | 200 | 3 | Black | L | Clothes |

### 3.1 POST analyze

`POST /businesses/:businessId/imports/excel/analyze`, owner headers + multipart:

- `file`: actual `.xlsx` bytes and original filename; exactly one file.
- `sheetName`: optional, exact worksheet name, string length 1–31.
- No other form fields. Maximum **10 MiB = 10,485,760 bytes**.

Android: select a document URI, check the size if available, stream it as a file
part, show uploading/analyzing, then retain the returned job/worksheet/header data.
Extension is checked case-insensitively, ZIP signature and readable workbook are
checked. `.xls`, CSV and renamed non-Excel files are not accepted.

201 example:

```json
{
  "importJobId": "70000000-0000-4000-8000-000000000001",
  "status": "MAPPING_REQUIRED",
  "sheetNames": ["Products", "Notes"],
  "selectedSheetName": "Products",
  "headerRow": 1,
  "headers": ["Product Code", "Name", "SKU", "Price", "Quantity", "Color", "Size", "Category"],
  "sampleRows": [
    { "rowNumber": 2, "values": ["TEE-001", "Cotton T-shirt", "TEE-B-M", 200, 5, "Black", "M", "Clothes"] },
    { "rowNumber": 3, "values": ["TEE-001", "Cotton T-shirt", "TEE-B-L", 200, 3, "Black", "L", "Clothes"] }
  ],
  "totalRows": 2
}
```

Without sheetName, the first worksheet is selected. Show `sheetNames`; to choose
a different one, **upload the same file again with that sheetName**. This creates
a new job; switch the UI to its new importJobId. There is no existing-job sheet
switch endpoint. Android cannot override headerRow; Backend detects a header in
the first 50 rows, preferring a row with at least two text cells and falling back
to the first populated row. Samples contain at most five rows. Analysis totalRows
counts populated rows, while validation counts physical rows after the header,
including skipped blanks; do not require these totals to be identical.

Important failures: 413 EXCEL_FILE_TOO_LARGE; 400 EXCEL_FILE_REQUIRED,
EXCEL_FILE_UNSUPPORTED, EXCEL_FILE_INVALID, EXCEL_FILE_UNREADABLE,
EXCEL_SHEET_NOT_FOUND or EXCEL_HEADER_NOT_FOUND. Let the user correct/reselect
the file/worksheet; these are HTTP failures, not row-validation results.

### 3.2 GET mapping suggestions

`GET /imports/:importId/mapping`, owner headers, no query/body. 200 example:

```json
{
  "importId": "70000000-0000-4000-8000-000000000001",
  "status": "MAPPING_REQUIRED",
  "columns": [
    { "sourceColumn": "Product Code", "sourceColumnIndex": 1, "samples": ["TEE-001"], "suggestedType": "STANDARD", "suggestedTarget": "externalKey", "displayLabel": "Product Code (groups variants)" },
    { "sourceColumn": "Name", "sourceColumnIndex": 2, "samples": ["Cotton T-shirt"], "suggestedType": "STANDARD", "suggestedTarget": "name", "displayLabel": "Product Name" },
    { "sourceColumn": "SKU", "sourceColumnIndex": 3, "samples": ["TEE-B-M", "TEE-B-L"], "suggestedType": "STANDARD", "suggestedTarget": "sku", "displayLabel": "Variant SKU" },
    { "sourceColumn": "Price", "sourceColumnIndex": 4, "samples": [200], "suggestedType": "STANDARD", "suggestedTarget": "basePrice", "displayLabel": "Price" },
    { "sourceColumn": "Quantity", "sourceColumnIndex": 5, "samples": [5, 3], "suggestedType": "STANDARD", "suggestedTarget": "stockQuantity", "displayLabel": "Available Quantity" },
    { "sourceColumn": "Color", "sourceColumnIndex": 6, "samples": ["Black"], "suggestedType": "UNMAPPED", "suggestedTarget": null, "displayLabel": null },
    { "sourceColumn": "Size", "sourceColumnIndex": 7, "samples": ["M", "L"], "suggestedType": "UNMAPPED", "suggestedTarget": null, "displayLabel": null },
    { "sourceColumn": "Category", "sourceColumnIndex": 8, "samples": ["Clothes"], "suggestedType": "STANDARD", "suggestedTarget": "category", "displayLabel": "Category" }
  ],
  "mapping": null
}
```

Suggestions are not confirmation. Color/Size require the user to choose
VARIANT_ATTRIBUTE and its exact target name; they are not automatically selected.
Ambiguous duplicate STANDARD suggestions become UNMAPPED. Each column has up to
three distinct populated samples drawn from analysis samples. After confirmation,
`mapping` is the saved array rather than null.

### 3.3 PATCH confirmed mapping

`PATCH /imports/:importId/mapping`, owner headers + JSON:

```json
{
  "mapping": [
    { "sourceColumn": "Product Code", "sourceColumnIndex": 1, "type": "STANDARD", "target": "externalKey" },
    { "sourceColumn": "Name", "sourceColumnIndex": 2, "type": "STANDARD", "target": "name" },
    { "sourceColumn": "SKU", "sourceColumnIndex": 3, "type": "STANDARD", "target": "sku" },
    { "sourceColumn": "Price", "sourceColumnIndex": 4, "type": "STANDARD", "target": "basePrice" },
    { "sourceColumn": "Quantity", "sourceColumnIndex": 5, "type": "STANDARD", "target": "stockQuantity" },
    { "sourceColumn": "Color", "sourceColumnIndex": 6, "type": "VARIANT_ATTRIBUTE", "target": "Color" },
    { "sourceColumn": "Size", "sourceColumnIndex": 7, "type": "VARIANT_ATTRIBUTE", "target": "Size" },
    { "sourceColumn": "Category", "sourceColumnIndex": 8, "type": "STANDARD", "target": "category" }
  ]
}
```

200 response:

```json
{
  "importId": "70000000-0000-4000-8000-000000000001",
  "status": "MAPPING_REQUIRED",
  "mapping": [
    { "sourceColumn": "Product Code", "sourceColumnIndex": 1, "type": "STANDARD", "target": "externalKey" },
    { "sourceColumn": "Name", "sourceColumnIndex": 2, "type": "STANDARD", "target": "name" },
    { "sourceColumn": "SKU", "sourceColumnIndex": 3, "type": "STANDARD", "target": "sku" },
    { "sourceColumn": "Price", "sourceColumnIndex": 4, "type": "STANDARD", "target": "basePrice" },
    { "sourceColumn": "Quantity", "sourceColumnIndex": 5, "type": "STANDARD", "target": "stockQuantity" },
    { "sourceColumn": "Color", "sourceColumnIndex": 6, "type": "VARIANT_ATTRIBUTE", "target": "Color" },
    { "sourceColumn": "Size", "sourceColumnIndex": 7, "type": "VARIANT_ATTRIBUTE", "target": "Size" },
    { "sourceColumn": "Category", "sourceColumnIndex": 8, "type": "STANDARD", "target": "category" }
  ]
}
```

Confirmation does **not** advance the job to READY; validate next.

Always send sourceColumnIndex, a 1-based integer, and the exact returned header.
It disambiguates blank/duplicate headers. A source may appear once; each STANDARD
target once; each custom target once within its type. ATTRIBUTE targets must
match `[a-z][a-z0-9_]{0,63}`; VARIANT_ATTRIBUTE targets use trimmed names of 1–60
characters. `constructor`, `prototype`, `__proto__` are reserved. The mapping array
has 1–16384 entries; omitted columns are saved UNMAPPED/null. IGNORE must use
`"target": null`, not omit it. Required mappings are name and externalKey.

400 mapping errors identify bad source/target or duplicates; keep the mapping
screen open and correct it. Both mapping endpoints require MAPPING_REQUIRED;
409 IMPORT_NOT_AWAITING_MAPPING / IMPORT_MAPPING_CHANGED mean refresh job status.
Missing saved workbook gives 409 IMPORT_WORKBOOK_UNAVAILABLE; read failure gives
500 IMPORT_WORKBOOK_READ_FAILED. There is no remapping after validation starts.

## 4. Validate and page through results

### 4.1 POST validate

`POST /imports/:importId/validate`, owner headers; no body or JSON `{}`. It awaits
validation synchronously and returns **201**, not a queued worker ID:

```json
{
  "importId": "70000000-0000-4000-8000-000000000001",
  "status": "READY",
  "summary": { "totalRows": 2, "validRows": 2, "invalidRows": 0, "skippedRows": 0 }
}
```

Job transitions MAPPING_REQUIRED → VALIDATING → READY. READY also occurs with
invalid rows or zero valid rows: inspect summary, not just HTTP/status. A failed
validation operation returns 500 IMPORT_VALIDATION_FAILED and attempts FAILED.
409 IMPORT_MAPPING_REQUIRED, IMPORT_NOT_AWAITING_VALIDATION or
IMPORT_VALIDATION_ALREADY_STARTED are state/claim failures, not bad Excel rows.

Android should display counts, fetch results, and permit preview/execution only
after the user reviews invalid groups. Disabling Execute when validRows=0 is a UI
policy; Backend does not enforce that restriction. To repair a workbook/mapping
after validation, create a new analyze job; there is no reset-to-mapping endpoint.

### 4.2 GET validation results

`GET /imports/:importId/validation-results?limit=1&offset=0`, owner headers, no body:

```json
{
  "importId": "70000000-0000-4000-8000-000000000001",
  "status": "READY",
  "summary": { "totalRows": 2, "validRows": 2, "invalidRows": 0, "skippedRows": 0 },
  "pagination": { "limit": 1, "offset": 0, "totalCount": 2, "hasMore": true, "nextOffset": 1 },
  "validRows": [
    { "rowNumber": 2, "data": { "externalKey": "TEE-001", "name": "Cotton T-shirt", "sku": "TEE-B-M", "basePrice": "200.00", "stockQuantity": 5, "variantAttributes": { "Color": "Black", "Size": "M" }, "category": "Clothes", "options": { "Color": ["Black"], "Size": ["M", "L"] } } }
  ],
  "invalidRows": []
}
```

Next call uses offset=1 and returns row 3 with hasMore=false/nextOffset=null.
Defaults for validation/preview: limit=50, offset=0. Limit range 1–100; offset is
an integer 0–Number.MAX_SAFE_INTEGER. Malformed query returns 400 VALIDATION_ERROR.

Pagination is **one page across valid + invalid rows**, sorted by Excel rowNumber.
Do not page the two arrays separately, use rowNumber as offset, or infer completion
from one empty array. `totalCount = validRows + invalidRows`, excluding skipped
blanks; summary counts describe the entire workbook. Out-of-range offset yields
empty arrays and hasMore=false. Always follow returned nextOffset.

For example, a different workbook with one nonempty BAD-1 row missing its name
can return 201 READY with validRows=0/invalidRows=1. Its results contain:

```json
{
  "rowNumber": 2,
  "errors": [
    { "field": "name", "code": "REQUIRED", "message": "name is required; product code is the stable product identity" }
  ]
}
```

That is an item in `invalidRows`, not an HTTP error envelope. Other otherwise
valid rows of that same Product group receive PRODUCT_GROUP_INVALID. Original
specific errors remain on the offending rows. Do not import part of that group.

Stored results are snapshots, available after successful validation in READY,
IMPORTING, COMPLETED, COMPLETED_WITH_ERRORS and, if a snapshot exists, FAILED or
CANCELLED. These enums do not imply a public cancel API. Missing/legacy snapshot
returns 409 IMPORT_VALIDATION_RESULTS_UNAVAILABLE; corrupt/unreadable results may
return 500 INTERNAL_SERVER_ERROR. Stored results need not reflect changes made
to Products after validation; preview/execution recheck current database state.

## 5. Preview and execute

### 5.1 GET current preview

`GET /imports/:importId/preview?limit=50&offset=0`, owner headers, no body. Requires
READY. Rebuilds validation/planning against the retained workbook and current
database; it makes no Product/Category/inventory writes. Same pagination rules
as results, now across inserts + updates + unchanged + invalidRows.

200 example for the two new variants (notice both rows create **one** Product):

```json
{
  "importId": "70000000-0000-4000-8000-000000000001",
  "status": "READY",
  "summary": { "totalRows": 2, "validRows": 2, "invalidRows": 0, "skippedRows": 0, "willInsert": 2, "willUpdate": 0, "unchanged": 0 },
  "pagination": { "limit": 50, "offset": 0, "totalCount": 2, "hasMore": false, "nextOffset": null },
  "inserts": [
    { "rowNumber": 2, "externalKey": "TEE-001", "variantAttributes": { "Color": "Black", "Size": "M" }, "action": "INSERT", "data": { "externalKey": "TEE-001", "name": "Cotton T-shirt", "sku": "TEE-B-M", "basePrice": "200.00", "stockQuantity": 5, "variantAttributes": { "Color": "Black", "Size": "M" }, "category": "Clothes", "options": { "Color": ["Black"], "Size": ["M", "L"] } } },
    { "rowNumber": 3, "externalKey": "TEE-001", "variantAttributes": { "Color": "Black", "Size": "L" }, "action": "INSERT", "data": { "externalKey": "TEE-001", "name": "Cotton T-shirt", "sku": "TEE-B-L", "basePrice": "200.00", "stockQuantity": 3, "variantAttributes": { "Color": "Black", "Size": "L" }, "category": "Clothes", "options": { "Color": ["Black"], "Size": ["M", "L"] } } }
  ],
  "updates": [],
  "unchanged": [],
  "invalidRows": []
}
```

Counts are Variant rows. INSERT can also mean a new Variant of an existing
Product; it does not guarantee a new Product. Its identity may lack productId /
catalogItemId and variantId until execution. Existing variants use UPDATE or
UNCHANGED with productId, equal catalogItemId alias, variantId and option identity.
UPDATE additionally has `changes` keyed by field, each `{ "from": ..., "to": ... }`.
For example, changing stock 5→8 yields `"stockQuantity":{"from":5,"to":8}`;
an unresolved new category can use `"categoryId":{"from":null,"to":{"create":"Clothes"}}`.
Treat from/to as JSON values, not only strings. There is no separate warnings array.

Show the proposed changes and invalid groups before enabling the one-time Execute
action. Preview is advisory, not a reservation or a guarantee: concurrent edits
can still cause execution conflicts. Errors: 409 IMPORT_NOT_READY /
IMPORT_WORKBOOK_UNAVAILABLE; 500 IMPORT_WORKBOOK_READ_FAILED; common auth/404.

### 5.2 POST execute exactly once

`POST /imports/:importId/execute`, owner headers; no body or JSON `{}`. Requires
READY, atomically claims IMPORTING and completes synchronously. **200** example:

```json
{
  "importId": "70000000-0000-4000-8000-000000000001",
  "status": "COMPLETED",
  "summary": { "totalRows": 2, "validRows": 2, "invalidRows": 0, "skippedRows": 0, "insertedCount": 2, "updatedCount": 0, "failedCount": 0, "unchangedCount": 0 },
  "inserted": [
    { "rowNumber": 2, "externalKey": "TEE-001", "productId": "20000000-0000-4000-8000-000000000001", "catalogItemId": "20000000-0000-4000-8000-000000000001", "variantId": "30000000-0000-4000-8000-000000000001" },
    { "rowNumber": 3, "externalKey": "TEE-001", "productId": "20000000-0000-4000-8000-000000000001", "catalogItemId": "20000000-0000-4000-8000-000000000001", "variantId": "40000000-0000-4000-8000-000000000001" }
  ],
  "updated": [],
  "unchanged": [],
  "failedRows": [],
  "invalidRows": []
}
```

Results are **not paginated**. Save this response in Android's job UI state for
the detailed completion screen. updated/unchanged use the same executed-row shape.
failedRows entries have rowNumber/code/message; invalidRows have rowNumber/errors
as above. COMPLETED_WITH_ERRORS is a successful HTTP 200 containing invalid rows
and/or failed groups, not a total rollback. Failed rows use EXECUTION_CONFLICT or
ROW_EXECUTION_FAILED. A whole Product group rolls back atomically; independent
groups may already be committed. Only executable rows are applied.

409 IMPORT_NOT_READY covers a sequential repeat/non-READY job;
IMPORT_EXECUTION_ALREADY_STARTED covers a competing claim. There is no client
idempotency-key API. Disable double taps and never automatically replay execute
after a lost HTTP response. A fatal failure returns 500 IMPORT_EXECUTION_FAILED,
attempts FAILED and can leave earlier groups committed. Refresh job and Products
before deciding whether to create a new import.

## 6. Status/history and recovery after a lost response

### 6.1 GET one job

`GET /imports/:importId`, owner headers, no body/query. 200 example:

```json
{
  "id": "70000000-0000-4000-8000-000000000001",
  "businessId": "10000000-0000-4000-8000-000000000001",
  "status": "COMPLETED",
  "fileName": "shirts.xlsx",
  "sheetName": "Products",
  "headerRow": 1,
  "totalRows": 2,
  "validRows": 2,
  "invalidRows": 0,
  "skippedRows": 0,
  "insertedCount": 2,
  "updatedCount": 0,
  "failedCount": 0,
  "createdAt": "2026-11-04T12:00:00.000Z",
  "updatedAt": "2026-11-04T12:00:05.000Z"
}
```

This exposes **no mapping, error details, workbook key, execution arrays or
unchangedCount**. It is status/counter recovery, not a stored execute response.
Use it after validation/execute network failure or app recreation. If VALIDATING
or IMPORTING persists, show pending/unknown and retry the GET with bounded
backoff. There is no advertised progress percentage, restart/resume endpoint or
guaranteed recovery of a process interrupted mid-operation; escalate stuck jobs.
Do not use another POST as a status check.

### 6.2 GET Business history

`GET /businesses/:businessId/imports?limit=20&offset=0`, owner headers, no body.
Defaults limit=20, offset=0; same numeric ranges as other pages. Order is
createdAt DESC, id DESC. 200 example:

```json
{
  "pagination": { "limit": 20, "offset": 0, "totalCount": 1, "hasMore": false, "nextOffset": null },
  "items": [
    {
      "id": "70000000-0000-4000-8000-000000000001",
      "businessId": "10000000-0000-4000-8000-000000000001",
      "status": "COMPLETED",
      "fileName": "shirts.xlsx",
      "sheetName": "Products",
      "headerRow": 1,
      "totalRows": 2,
      "validRows": 2,
      "invalidRows": 0,
      "skippedRows": 0,
      "insertedCount": 2,
      "updatedCount": 0,
      "failedCount": 0,
      "createdAt": "2026-11-04T12:00:00.000Z",
      "updatedAt": "2026-11-04T12:00:05.000Z"
    }
  ]
}
```

`items` contains the full job object shown in 6.1, without additional fields.
An empty history returns `items: []`, totalCount=0, hasMore=false, nextOffset=null.
Use history to reopen jobs for the currently selected Business, not to recover
per-row execute arrays. Both reads support common 401/404; list query errors use
400 VALIDATION_ERROR. The global owner guard normally hides a missing/foreign
resource as 404 NOT_FOUND before the service runs. Service-level disappearance
can instead use IMPORT_JOB_NOT_FOUND or BUSINESS_NOT_FOUND; handle both.

## 7. Retrieve imported Products and Variants

Use **Products API**, not removed `/catalog-items` endpoints or aliases.
The internal Prisma model/table is Product and FK fields are productId after
migration. Android must use public responses, not assume database renaming removes
compatibility fields. Product's own ID is `id`; Variant, inventory movement,
preview UPDATE/UNCHANGED and executed rows expose productId **and** equal
catalogItemId. Product root and ProductImage metadata do not gain that alias.

All reads below use owner headers, no body, 200 success. Path UUIDs must stay
within the selected Business; common 401/404 apply.

| Read | Path and input | Response |
| --- | --- | --- |
| Product detail | `GET /businesses/:businessId/products/:productId` | Full Product object below |
| Product list | `GET /businesses/:businessId/products?limit=20&offset=0` | `{ "pagination": ..., "items": [Product] }` |
| All variants, paginated | `GET /businesses/:businessId/products/:productId/variants?limit=20&offset=0` | `{ "pagination": ..., "items": [Variant] }` |
| One variant | `GET /businesses/:businessId/products/:productId/variants/:variantId` | Full Variant object matching an embedded entry below |

Product/list/variant-list pages default to 20, support limit 1–100 and offset
0–Number.MAX_SAFE_INTEGER, and order createdAt DESC/id DESC. In the example with
one Product, Product-list pagination is the pagination object in 6.2. For its two Variants,
variant-list pagination is `{ "limit":20,"offset":0,"totalCount":2,"hasMore":false,"nextOffset":null }`.
The page `items` is the corresponding objects, not IDs or Import rows.

Product detail example (illustrative timestamps; newer Variant first):

```json
{
  "id": "20000000-0000-4000-8000-000000000001",
  "businessId": "10000000-0000-4000-8000-000000000001",
  "name": "Cotton T-shirt",
  "description": null,
  "categoryId": "50000000-0000-4000-8000-000000000001",
  "externalKey": "TEE-001",
  "category": "Clothes",
  "basePrice": "200.00",
  "options": { "Color": ["Black"], "Size": ["M", "L"] },
  "colorOptionName": null,
  "images": [],
  "attributes": {},
  "isActive": true,
  "createdAt": "2026-11-04T12:00:04.000Z",
  "updatedAt": "2026-11-04T12:00:04.000Z",
  "isSellable": true,
  "variants": [
    { "id": "40000000-0000-4000-8000-000000000001", "businessId": "10000000-0000-4000-8000-000000000001", "productId": "20000000-0000-4000-8000-000000000001", "catalogItemId": "20000000-0000-4000-8000-000000000001", "sku": "TEE-B-L", "optionValues": { "Color": "Black", "Size": "L" }, "unitPrice": null, "effectivePrice": "200.00", "trackInventory": true, "stockQuantity": 3, "isActive": true, "createdAt": "2026-11-04T12:00:04.002Z", "updatedAt": "2026-11-04T12:00:04.003Z" },
    { "id": "30000000-0000-4000-8000-000000000001", "businessId": "10000000-0000-4000-8000-000000000001", "productId": "20000000-0000-4000-8000-000000000001", "catalogItemId": "20000000-0000-4000-8000-000000000001", "sku": "TEE-B-M", "optionValues": { "Color": "Black", "Size": "M" }, "unitPrice": null, "effectivePrice": "200.00", "trackInventory": true, "stockQuantity": 5, "isActive": true, "createdAt": "2026-11-04T12:00:04.000Z", "updatedAt": "2026-11-04T12:00:04.001Z" }
  ],
  "variantsPagination": { "limit": 20, "offset": 0, "totalCount": 2, "hasMore": false, "nextOffset": null }
}
```

Product responses embed only the first 20 Variants; follow variantsPagination and
the separate Variant-list route for the complete set. Deduplicate Product IDs
from executed rows before fetching detail. The Product list has no externalKey
search query; do not invent `?externalKey=` filtering. After a lost execute
response, paginate Products and match their externalKey client-side if necessary.
Inactive records are included, not silently removed.

Product has no stockQuantity/trackInventory. Variant effectivePrice is
unitPrice override or Product basePrice, or null if neither exists. Preserve
decimal strings in Android's decimal handling. Untracked stock is null, not zero;
tracked zero means out of recorded stock. isSellable indicates an active Product
with a priced active Variant, not that every Variant is in stock.

## 8. Re-import and manual edits

| Situation | Actual result |
| --- | --- |
| Same Business + externalKey | Update that Product; a matching key in another Business is independent |
| Same exact option combination | Update/reuse that Variant ID; SKU is not the lookup identity |
| New combination under same option names | Create a Variant and extend allowed values; no duplicate Product |
| Missing existing Product/Variant/color from workbook | Retain it; import does not delete absent data |
| New/renamed option name or simple ↔ configurable conversion | Reject OPTIONS_CONFLICT; use reviewed Product CRUD instead |
| Blank/unmapped quantity on existing Variant | Preserve stock/tracking; new Variant stays untracked with null stock |
| Explicit quantity, including 0 | Set absolute tracked quantity, never add a delta; write existing inventory audit rules |
| Nonblank basePrice/unitPrice | Update supplied price; Variant override takes precedence |
| Blank/unmapped prices, description or category | Preserve existing value; not a clear-to-null operation |
| Nonblank name/metadata in Excel | Can overwrite manual edits; inspect preview |
| Product attributes | Merge nonnull mapped values; preserve unrelated/manual keys; conflicting/oversized merged data rejects the group |
| Inactive matching Product/Variant or reserved SKU elsewhere | Reject PRODUCT_INACTIVE / VARIANT_INACTIVE / SKU_RESERVED; do not silently reactivate/reassign |

Repeat execution of the **same job** is rejected. A **new job** with the same
file/identities can produce UNCHANGED rows without duplicates; database state and
supplied quantities/prices determine the current plan. Re-importing an explicit
quantity overwrites intervening manual stock edits. A blank configurable SKU is
invalid, even when an existing matching Variant already has a SKU. For a simple
Variant, blank SKU preserves its existing SKU. Import cannot clear an existing
price/SKU/category just by leaving a cell blank.

## 9. Categories and images

### Categories are implemented, not inferred from the schema

Actual owner-scoped routes exist at `/businesses/:businessId/categories`:

| Method | Path suffix | Request | Success |
| --- | --- | --- | --- |
| POST | none | JSON `{"name":"Clothes"}` | 201 Category |
| GET | none | Query limit/offset, default 20/0 | 200 pagination + items |
| GET | `/:categoryId` | No body | 200 Category |
| PATCH | `/:categoryId` | JSON `{"name":"Clothing"}` | 200 renamed Category |
| DELETE | `/:categoryId` | No body | 204, no response body |

All use the same owner/JSON headers and UUID validation. A Category object is:

```json
{ "id":"50000000-0000-4000-8000-000000000001", "businessId":"10000000-0000-4000-8000-000000000001", "name":"Clothes", "createdAt":"2026-11-04T12:00:04.000Z", "updatedAt":"2026-11-04T12:00:04.000Z" }
```

The list uses the same pagination/items envelope as Products, with Category
objects. Name is trimmed, nonblank and at most 200 characters; normalized name
uniqueness is Business-scoped, case/whitespace normalized in PostgreSQL.
409 CATEGORY_NAME_CONFLICT means reuse/rename; 409 CATEGORY_IN_USE means a
referenced Category cannot be deleted (including references from inactive
Products); missing/foreign Category returns 404 CATEGORY_NOT_FOUND.

Product CRUD accepts optional nullable categoryId; omission preserves it on
update, null clears it. Excel instead maps **category name**, never categoryId.
Validation/preview resolve normalized names read-only; execution reuses or creates
the Category and links categoryId transactionally. Blank/unmapped category
preserves an existing relation. Product's legacy category text is not writable
through Product metadata CRUD and may differ from the renamed Category's name;
Android should resolve categoryId against Categories for the current display name.

### Images are a separate workflow

Excel never uploads or replaces images. After import, use owner-only Product
image management described in [Product images](product-images.md). Existing
ProductImage rows/URLs survive re-import, price updates and stock updates.
The gallery has at most five images per Product across every Variant: one Main
at position 0 (isMain=true) and up to four additional images. Color/Size/Weight
are not required; never switch images automatically when a Variant is selected.
The first upload becomes Main. Reordering/Set Main are explicit owner actions;
deleting Main promotes the first remaining image in saved order. Empty gallery
uses the standard placeholder. Stop sending optionName/optionValue or configuring
colorOptionName for image handling. Legacy colorOptionName is metadata only.

Upload one multipart file, or repeated files parts for an atomic batch. The Backend
rejects the whole batch if it exceeds free slots. Every file remains JPEG/PNG/WebP
and at most 5 MiB. PATCH the image collection with every active imageIds entry in
desired order, or PATCH /images/:imageId with {isMain:true}. Refresh the returned
order after changes/deletion. Cloudinary credentials remain server-side.

Excel never reorders, deletes or relabels images. Existing image rows and order
survive re-import, product/price changes and stock updates. Variant option
compatibility is validated separately. Real Cloudinary/Android verification
remains a separately approved release test; mocked tests do not prove delivery.

## 10. Error handling reference for Android

HTTP-level errors use this existing envelope (message may also be a string array):

```json
{
  "statusCode": 409,
  "code": "IMPORT_NOT_READY",
  "message": "The import job must be READY before execution",
  "error": "Conflict"
}
```

Keep stable codes in logs/UI models; translate by code, never parse English
messages. Suggested Arabic labels below are Android text, not Backend messages.

| HTTP / codes | Suggested Arabic/action |
| --- | --- |
| 401 UNAUTHORIZED; auth-session failures | «انتهت الجلسة، سجّلي الدخول مجددًا»; use existing refresh handling |
| 404 NOT_FOUND, IMPORT_JOB_NOT_FOUND, BUSINESS_NOT_FOUND, PRODUCT_NOT_FOUND, VARIANT_NOT_FOUND | «العنصر غير موجود أو غير متاح لهذا النشاط»; check selected Business/IDs |
| 400 EXCEL_FILE_REQUIRED | «اختاري ملف Excel أولًا» |
| 413 EXCEL_FILE_TOO_LARGE | «حجم الملف أكبر من 10 ميبيبايت» |
| 400 EXCEL_FILE_UNSUPPORTED | «الصيغة المطلوبة هي ‎.xlsx» |
| 400 EXCEL_FILE_INVALID, EXCEL_FILE_UNREADABLE | «ملف Excel غير صالح أو غير قابل للقراءة» |
| 400 EXCEL_SHEET_NOT_FOUND, EXCEL_HEADER_NOT_FOUND | «راجعي ورقة العمل وصف العناوين»; select/reupload |
| 400 VALIDATION_ERROR | «راجعي البيانات أو الحقول المطلوبة»; includes missing externalKey mapping, DTO/query errors |
| 400 MAPPING_SOURCE_INVALID, MAPPING_SOURCE_DUPLICATE | «راجعي الأعمدة المختارة؛ لا تكرري العمود» |
| 400 MAPPING_STANDARD_TARGET_INVALID, MAPPING_STANDARD_TARGET_DUPLICATE | «حقل الاستيراد غير صالح أو مكرر» |
| 400 MAPPING_ATTRIBUTE_TARGET_INVALID, MAPPING_ATTRIBUTE_TARGET_DUPLICATE | «اسم الخاصية غير صالح أو مكرر» |
| 400 MAPPING_TARGET_MUST_BE_NULL, MAPPING_TYPE_INVALID, MAPPING_NAME_REQUIRED | «راجعي نوع الربط وحقل اسم المنتج» |
| 409 IMPORT_NOT_AWAITING_MAPPING, IMPORT_MAPPING_CHANGED | «تغيّرت حالة الملف؛ حدّثي الحالة قبل تعديل الربط» |
| 409 IMPORT_MAPPING_REQUIRED | «أكّدي ربط الأعمدة أولًا» |
| 409 IMPORT_NOT_AWAITING_VALIDATION, IMPORT_VALIDATION_ALREADY_STARTED | «التحقق بدأ بالفعل أو حالة الملف تغيّرت»; refresh GET status |
| 409 IMPORT_VALIDATION_RESULTS_UNAVAILABLE | «نتائج التحقق غير متاحة؛ قد تحتاجين إعادة رفع الملف» |
| 409 IMPORT_WORKBOOK_UNAVAILABLE | «الملف المحفوظ غير متاح؛ أعيدي الرفع» |
| 409 IMPORT_NOT_READY, IMPORT_EXECUTION_ALREADY_STARTED | «الاستيراد غير جاهز أو بدأ بالفعل»; never replay blindly |
| 500 IMPORT_WORKBOOK_READ_FAILED, IMPORT_VALIDATION_FAILED, IMPORT_EXECUTION_FAILED, INTERNAL_SERVER_ERROR | «تعذّر إكمال العملية؛ حدّثي الحالة قبل المحاولة مجددًا»; earlier execute groups may have committed |

These are **row codes inside successful results**, not their own HTTP statuses:

| Row code | Suggested Arabic/action |
| --- | --- |
| REQUIRED | «حقل مطلوب غير موجود»; check field=name/externalKey/sku |
| TEXT_TOO_LONG | «النص أطول من الحد المسموح» |
| INVALID_DECIMAL, INVALID_INTEGER | «راجعي تنسيق السعر أو الكمية» |
| REQUIRED_OPTION, INVALID_OPTIONS | «اختاري قيمة صحيحة لكل خاصية للمتغير» |
| DUPLICATE_SKU | «كود المتغير مكرر داخل الملف» |
| DUPLICATE_COMBINATION | «نفس مجموعة خيارات المتغير مكررة» |
| CONFLICTING_PRODUCT_ROWS | «بيانات المنتج مختلفة بين صفوف نفس الكود» |
| PRODUCT_GROUP_INVALID | «لن تُستورد هذه المجموعة بسبب خطأ في صف آخر» |
| OPTIONS_CONFLICT | «خيارات الملف لا تتوافق مع خيارات المنتج الحالي» |
| SKU_RESERVED | «كود المتغير مستخدم بالفعل في هذا النشاط» |
| PRODUCT_INACTIVE, VARIANT_INACTIVE | «فعّلي المنتج أو المتغير أولًا» |
| MERGED_ATTRIBUTES_INVALID | «الخصائص المدمجة تتجاوز الحدود المسموحة» |
| EXECUTION_CONFLICT | «تغيّرت البيانات أو حدث تعارض؛ راجعي المجموعة» |
| ROW_EXECUTION_FAILED | «تعذّر استيراد المجموعة ولم تُطبَّق صفوفها» |

Three UI outcomes must stay distinct: non-2xx is an HTTP operation failure;
201 READY with invalidRows is completed validation with rejected groups; READY
with validRows>0 means executable groups exist, subject to preview/current-state
rechecks. Likewise 200 COMPLETED_WITH_ERRORS is partial execution, not total success.

## 11. Android implementation checklist and known gaps

1. Maintain environment/baseUrl, active Business and authenticated session. Confirm
   the new Backend release before connecting these screens to a public URL.
2. File picker → upload/analyze loading state. Retain URI permission for worksheet
   reupload where supported; save importId, sheetNames, selectedSheetName, headers,
   samples, headerRow. Do not store/forward private workbook storage keys.
3. Worksheet selection → reupload if different → column-mapping screen. Show
   required externalKey/name and configurable-SKU rules. Preserve exact option keys.
4. Confirm PATCH mapping → POST validate once. Disable repeated submissions while
   awaiting the response; on uncertainty refresh GET job instead of resubmitting.
5. Display full summary and page results using returned nextOffset. Associate
   row/field/code with editable workbook feedback; a new upload is needed to fix
   a validated job. Keep user-selected mapping locally as a convenience, but
   reconfirm it against each new job's returned columns.
6. GET preview while READY; show inserts/updates/unchanged/invalid groups and
   JSON from/to changes. Counts refer to Variant rows. Explicitly confirm that
   imported prices/quantities can overwrite manual edits.
7. Execute once and retain the detailed response. Show complete vs partial result,
   original row numbers, group failures and deduplicated Product navigation.
8. On timeout/restart, GET job/history with bounded backoff; do not assume rollback
   or replay a POST. If details were lost, only counters + validation snapshot +
   current Product reads can be recovered through current APIs. Stuck IMPORTING
   or VALIDATING needs support; no recovery endpoint exists.
9. Fetch Product detail and paginated Variants; keep both currently returned
   productId/catalogItemId compatibility fields in DTOs. Display null vs zero
   stock and string/null prices correctly. Category selection and image upload
   are separate owner workflows.
10. Translate stable HTTP/row codes above and keep a generic fallback for unknown
    codes. Do not log bearer tokens, private files or cloud credentials.

Known limits: no persisted detailed execute-result API, no public resume/cancel,
no existing-job worksheet/header update, no externalKey search API, and local
workbook/snapshot files are not guaranteed durable across Railway redeploys.
A job row may survive after its required files disappear. Do not promise resumable
imports or complete row-error recovery from history. These are confirmed contract
gaps, not endpoints to invent in Android. See [Import API](imports-api.md) for
additional Backend context and [Products](products-api.md) for metadata CRUD.

Safe acceptance: use an agreed local Backend plus a **new disposable local DB**
prepared by its owner, not Neon/Railway production. Test simple/Color/Size/custom
options, required SKU, Unicode boundaries, duplicate combinations, pagination,
mixed invalid groups, same-key re-import, omitted/zero stock, stale preview,
foreign-Business access and lost execute response. Images use mocked Cloudinary
until a separate live test is approved. Do not point new code at an old-schema
local fixture without an explicitly approved disposable-target upgrade.

## 12. Source/verification basis

Reviewed current Import controllers/DTOs, MappingService, ValidationService,
PreviewService, ExecutionService, RowNormalizer/RowValidator, import planning,
variant-import-policy, pagination, Excel adapter/storage, Products/Variants
presenter/controllers, Categories controllers/service, shared externalKey
validation, and the current Product/image schema and migrations.

Regression evidence is maintained in row-validation, mapping, validation,
preview, import-planner, execution, import-jobs, products-api,
product-policy and Product/Inventory/PostgreSQL import/image tests. Pagination
cases are included in the validation/preview/job suites. Prior
implementation verification is linked above and is not a claim that this
documentation task reran production or database checks. This task changes only
this Markdown guide; no API behavior, client code, schema or deployment changes.

Documentation-task verification: the ten focused Import/Products suites passed
**297 tests, 0 failures** (Jest invoked directly with `--runTestsByPath`, without
the npm pretest build). All **14 JSON examples** parsed successfully; the sample
workbook's normalized rows, invalid-row example, mapping suggestions and INSERT
preview were compared against actual local Backend implementations and matched.
All 30 referenced IMPORT_/MAPPING_/EXCEL_ codes exist; relative links resolve.
No database, migration, provider, Neon or Railway operation was run for this guide.
