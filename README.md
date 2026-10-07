# Brandora backend

Minimal NestJS, TypeScript, PostgreSQL, and Prisma backend foundation.

## Requirements

- Node.js 22.12+ (Node.js 24 LTS recommended) and npm.
- A running PostgreSQL server and an empty `brandora` database.

PostgreSQL is not installed or started by this project. Install it locally or use
your own PostgreSQL instance, start the server, and create the database manually:

```sql
CREATE DATABASE brandora;
```

Run this SQL through `psql` or pgAdmin while connected to an existing database.

## Setup

```powershell
npm.cmd install
Copy-Item .env.example .env
```

Edit `.env` with your actual credentials:

| Variable             | Purpose                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | Required PostgreSQL URL, e.g. `postgresql://postgres:postgres@localhost:5432/brandora?schema=public`. URL-encode special characters in credentials. |
| `PORT`               | Optional HTTP port; defaults to `3000`.                                                                                                             |
| `IMPORT_STORAGE_DIR` | Optional directory for retained workbooks; defaults to `.storage/imports`, resolved relative to the backend working directory.                      |

On macOS/Linux use `npm` instead of `npm.cmd` and `cp .env.example .env`.

Only after PostgreSQL is running and `DATABASE_URL` points to the intended database:

```powershell
npm.cmd run prisma:migrate
npm.cmd run prisma:generate
npm.cmd run start:dev
```

Checked-in SQL migrations are in `prisma/migrations`. `prisma:migrate`
applies pending migrations in development. Future model changes use
`npm.cmd run prisma:migrate -- --name descriptive_change_name`.
Prisma 7 requires client generation separately after migration changes.
Development migrations may need permission to create a shadow database.

For an existing provisioned deployment database, apply checked-in migrations with
`npm.cmd run prisma:deploy` instead of the development command.

## Catalog API

Create a `Business` record first using `npm.cmd run prisma:studio`. Supply a name;
Prisma supplies its UUID and timestamps. Copy that UUID for API requests.
There is no business HTTP API in this scope.

`POST /catalog-items` accepts:

```json
{
  "businessId": "f6bc7287-3285-4e19-a819-459c41f0a138",
  "name": "Coffee",
  "description": "Freshly roasted coffee",
  "basePrice": "49.90"
}
```

Create also accepts optional externalKey/category (nullable strings, max 200),
description (nullable string, max 5,000), attributes (nullable JSON object), and
isActive (boolean, default true). Arrays/scalar attributes return
CATALOG_ATTRIBUTES_INVALID. Same-business duplicate non-null external keys
return 409 CATALOG_EXTERNAL_KEY_CONFLICT; inactive items retain their keys.
Create and PATCH trim surrounding externalKey whitespace; empty or whitespace-only
keys become null. On PATCH, this clears the existing key. The trimmed key is limited
to 200 characters.

`basePrice` is optional/nullable and, when supplied,
is a non-negative decimal **string**, with at
most 10 integer digits and 2 decimal places; responses also serialize it as a
string (trailing zeros may be omitted), or null when no price was supplied.
A missing business returns `404`.
Invalid inputs and unknown fields return `400`.

`GET /catalog-items?businessId=<UUID>&limit=20&offset=0` returns an array of that
business's items, newest first. `businessId` is required. `limit` defaults to 20
and is capped at 100; `offset` defaults to 0 and is capped at 1,000,000. An unknown
business or empty catalog returns `[]`.

Catalog CRUD endpoints:

| Endpoint                             | Request                                                        | Success                                          |
| ------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------ |
| POST /catalog-items                  | Required businessId/name plus optional metadata                | 201 CatalogItem                                  |
| GET /catalog-items                   | businessId, optional limit/offset                              | 200 CatalogItem array, including inactive items  |
| GET /catalog-items/:catalogItemId    | Required businessId query UUID                                 | 200 scoped CatalogItem, including inactive items |
| PATCH /catalog-items/:catalogItemId  | Required businessId body UUID plus at least one editable field | 200 updated CatalogItem                          |
| DELETE /catalog-items/:catalogItemId | Required businessId query UUID                                 | 200 CatalogItem with isActive=false              |

Get One, PATCH, and DELETE scope by item ID and business ID and return
CATALOG_ITEM_NOT_FOUND when missing or in another business. DELETE is an
idempotent soft deactivation; it does not remove the row or inventory history.
PATCH preserves omitted fields and intentionally clears nullable metadata with
null. Its attributes object replaces the old object; Excel imports continue to
merge non-blank attributes and preserve blank values. Explicit isActive=true
PATCH reactivates an item; imports still do not reactivate automatically.

Catalog rejects stockQuantity, trackInventory, id, createdAt, updatedAt, and
unknown fields. Catalog CRUD does not change stock or create/delete inventory
movements; stock mutation remains owned by InventoryService and SCRUM-30.

See [Catalog API examples and per-endpoint errors](docs/catalog-api.md) for the
complete Mobile request/response contract, field validation, and null semantics.

These endpoints have no authentication and are intended for local foundation
development. `businessId` is a filter and relation, not an authorization check.

## Structure and scope

- `src/prisma`: reusable `PrismaModule` and `PrismaService`, including connection lifecycle.
- `src/catalog`: controller, service, and validated request DTOs.
- `src/imports`: Excel upload controller/service and ExcelJS workbook adapter.
- `src/inventory`: internal stock changes and audit records; no public endpoints.
- `prisma/schema.prisma`: `Business`, `CatalogItem`, `ImportJob`, and `InventoryMovement` models.
- `prisma.config.ts`: Prisma CLI configuration and environment loading.
- `src/generated/prisma`: generated client, excluded from Git.

Excel analysis creates an `ImportJob` with file/sheet/header metadata and a row
count, and retains the workbook through a storage adapter. Mapping suggestions
and owner confirmation are implemented, along with row normalization and
validation, a read-only import preview/plan, and synchronous import execution.
The internal Inventory foundation is implemented. Auth, AI, Orders, WhatsApp,
Analytics, Variants, Images, and Options remain outside this scope.

## API Error Contract

Every HTTP error uses this envelope:

```typescript
{
  statusCode: number;
  code: string;
  message: string | string[];
  error: string;
}
```

`code` is the stable client/localization contract. Use it for Arabic/English
messages; do not depend on English `message` text. `message` provides developer
context and preserves DTO validation details as an array when applicable.
`error` is the general HTTP category, such as `Bad Request` or `Conflict`.

```json
{
  "statusCode": 409,
  "code": "IMPORT_NOT_READY",
  "message": "The import job must be READY before execution",
  "error": "Conflict"
}
```

Unexpected server failures return INTERNAL_SERVER_ERROR with the safe message
`An internal server error occurred`. Known safe failures retain their explicit
codes/messages. Oversized Excel uploads return HTTP 413 / EXCEL_FILE_TOO_LARGE
with `The Excel file exceeds the maximum allowed size of 10 MB.`

DTO and UUID-pipe failures use VALIDATION_ERROR. Unknown mapping types rejected
by DTO validation also use VALIDATION_ERROR; mapping service checks use the
specific MAPPING_* codes. Framework errors use status-based fallback codes.
The [complete error-code and existing-message mapping](docs/api-errors.md)
documents these codes.

Excel row-validation codes such as REQUIRED, INVALID_DECIMAL, INVALID_INTEGER,
DUPLICATE_EXTERNAL_KEY, and TEXT_TOO_LONG remain a separate contract inside
successful import responses. Neither those codes nor success response shapes
are changed by HTTP error formatting.

## Localization ownership

| Content         | Localization owner       | Rule                                                              |
| --------------- | ------------------------ | ----------------------------------------------------------------- |
| UI / API errors | Mobile                   | Localize using stable backend error codes.                        |
| Business data   | No automatic translation | Preserve the owner's original language and content.               |
| Notifications   | Backend                  | Generate text using the recipient's persisted preferred language. |
| AI replies      | AI                       | Follow the customer's language and conversational context.        |

### UI / API errors

Backend HTTP errors are not localized. `code` is the stable Mobile localization
contract; `message` remains English developer/debugging context, and `error`
remains the English HTTP category. Mobile selects Arabic or English and must not
depend on exact English message wording. Do not maintain Arabic/English copies
of API error messages in the backend.

For example, Mobile can display IMPORT_NOT_READY as
`عملية الاستيراد غير جاهزة للتنفيذ` in Arabic or
`The import is not ready for execution` in English, independently of the backend
message `The import job must be READY before execution`.

### Business data

Never automatically translate owner-entered business data. This includes business
names, catalog item names/descriptions/categories, Excel imported values,
attributes, FAQ questions/answers, policy titles/content, and any other text
entered by the owner. Store and return `تيشيرت أسود` in its original language;
do not translate it to `Black T-Shirt`. Existing documented input normalization
and validation rules still apply; they do not authorize translation.

Do not add automatic language-specific duplicates such as nameAr/nameEn unless
a future product requirement explicitly introduces business-managed multilingual
content. Do not translate stored business data to support AI responses.

### Notifications (future work)

Notification text can be generated by the backend and displayed directly, so
notification localization belongs to the backend, separately from API errors.
The future design should persist a recipient's preferredLanguage in their
profile/preferences, using a Language enum with AR and EN, rather than requiring
Mobile to send a language on every request.

Future flow: notification event -> backend checks recipient preferredLanguage
-> generates AR or EN notification text -> persists/sends the notification.
Do not use the API error localization system for notifications. Do not implement
notification localization before preference persistence exists.

### AI replies (future work)

AI owns conversational language and wording and should follow the customer's
language/context: `عندكم مقاس XL؟` receives an Arabic response, while
`Do you have this in XL?` receives an English response. These replies are separate
from API error localization. The backend supplies trusted business context/data,
validates structured AI outputs, and enforces business rules; the AI handles
response wording and conversational language without altering stored business
data.

These are architectural ownership rules only. Notifications, language preference
persistence, and AI features are not implemented in this milestone.

## Excel analysis milestone

`POST /businesses/:businessId/imports/excel/analyze` accepts multipart form data:

| Field       | Type | Required | Purpose                                        |
| ----------- | ---- | -------- | ---------------------------------------------- |
| `file`      | File | Yes      | One `.xlsx` workbook, up to 10 MiB.            |
| `sheetName` | Text | No       | Exact sheet name; defaults to the first sheet. |

The business must already exist. Extension and workbook contents are checked;
the client-supplied MIME type alone is not trusted. Multer receives the upload
in memory within the 10 MiB limit, then the service saves it to backend storage
and reads it through the storage abstraction for ExcelJS analysis.

`ImportFileStorage` exposes `save`, `read`, and `delete`; Nest currently binds it
to `LocalImportFileStorage`. A future object storage adapter can implement that
contract without changing the analysis flow. Local files use generated UUID
names rather than owner-supplied filenames and are not served as public assets.
PostgreSQL stores only the opaque `ImportJob.fileKey`, never workbook bytes.

Successful analysis retains the workbook and creates a `MAPPING_REQUIRED` job
with its file key, original filename, sheet, header row, and total row count.
The key stays internal; later stages can load the job and call
`storage.read(job.fileKey)` without requiring another upload. Reading, analysis,
or job creation failures delete the saved file and do not create a job. Partial
write failures also remove the incomplete file. Cleanup errors are logged.

The default `.storage/` directory is ignored by Git. Keep the storage directory
stable across restarts; container deployments need a persistent volume. Changing
or deleting the directory makes retained jobs' workbooks unavailable. There is
no automatic expiry or crash-recovery sweep yet: successful workbooks stay until
explicitly removed, and a process crash between saving and creating the job can
leave an orphan file. Use a private backend directory, not a public/static folder.

The lifecycle schema change adds nullable `ImportJob.fileKey String?`, allowing
existing jobs to remain without a file reference. Earlier jobs cannot recover
uploads that were never stored. Migration
`20261005202258_add_import_job_file_key` adds this column and has been applied
to the local development database. Other environments must apply the checked-in
migration before using this updated endpoint.

The detector searches the first 50 rows, skipping blank rows and preferring the
first row with at least two textual cells; it falls back to the first non-empty
row. This is a simple heuristic, so unusual titles/layouts can be misidentified.
`headerRow` and sample `rowNumber` values are one-based Excel row numbers.
The response contains up to five non-empty rows after the header (fewer when the
sheet contains fewer rows). Values align positionally with `headers`, preserving
blank/duplicate headers. Dates are ISO strings; formulas use stored results and
are not recalculated. Cells beyond the header's column range are not sampled.

Example `201 Created` response:

```json
{
  "importJobId": "e5b31599-e582-4a36-966b-dda8389e2fb0",
  "status": "MAPPING_REQUIRED",
  "sheetNames": ["Products", "Archived"],
  "selectedSheetName": "Products",
  "headerRow": 3,
  "headers": ["Name", "Price"],
  "sampleRows": [
    { "rowNumber": 4, "values": ["Coffee", 49.9] },
    { "rowNumber": 5, "values": ["Tea", 25] },
    { "rowNumber": 6, "values": ["Cocoa", 35] }
  ],
  "totalRows": 3
}
```

The job waits at `MAPPING_REQUIRED` for owner mapping confirmation. Only
successful analysis creates a job; malformed workbooks do not. No catalog rows
are created or updated. Analysis leaves mapping/errors/counters for later stages
at their schema defaults.

To test in Postman:

1. With the `fileKey` migration applied and `.env` configured, run
   `npm.cmd run prisma:generate` and `npm.cmd run start:dev`.
2. Obtain an existing Business UUID (or create a Business in Prisma Studio).
3. Send a POST request to
   `http://localhost:3000/businesses/<business UUID>/imports/excel/analyze`.
4. Choose **Body → form-data**, add key `file`, switch its type to **File**,
   and select an `.xlsx` workbook. Optionally add `sheetName` as **Text**.
5. Let Postman set the multipart Content-Type and boundary automatically.
6. Expect `201` with status `MAPPING_REQUIRED`, analysis, and job ID. Check
   ImportJob in Prisma Studio: `fileKey` should reference a retained workbook
   under `IMPORT_STORAGE_DIR`. CatalogItem data should be unchanged.

Missing/invalid files, empty sheets, unknown sheet names, and invalid UUIDs
return `400`; unknown businesses return `404`; oversized files return `413`.

## Excel mapping milestone

Both mapping endpoints reuse the retained workbook and its saved sheet/header
row. No new upload is needed. They require status `MAPPING_REQUIRED` and do not
write catalog data, normalize or validate rows, or execute imports.

`GET /imports/:importId/mapping` returns suggestions, up to three distinct sample
values per column from the analysis samples, and the currently saved mapping
(null before confirmation):

```json
{
  "importId": "e5b31599-e582-4a36-966b-dda8389e2fb0",
  "status": "MAPPING_REQUIRED",
  "columns": [
    {
      "sourceColumn": "Item Name",
      "sourceColumnIndex": 1,
      "samples": ["T-Shirt", "Hoodie"],
      "suggestedType": "STANDARD",
      "suggestedTarget": "name",
      "displayLabel": "Product Name"
    },
    {
      "sourceColumn": "Fabric",
      "sourceColumnIndex": 2,
      "samples": ["Cotton", "Linen"],
      "suggestedType": "UNMAPPED",
      "suggestedTarget": null,
      "displayLabel": null
    },
    {
      "sourceColumn": "Notes",
      "sourceColumnIndex": 3,
      "samples": ["Summer", "Winter"],
      "suggestedType": "UNMAPPED",
      "suggestedTarget": null,
      "displayLabel": null
    }
  ],
  "mapping": null
}
```

The alias list is explicit. Header comparisons ignore case and trim/collapse
whitespace; there is no fuzzy matching or AI, and cell values are unchanged.
Unknown headers remain UNMAPPED. If multiple columns match the same standard
target, all competing suggestions remain UNMAPPED until the owner chooses.

| Internal target | Display label      | English aliases                                                                                                                                 | Arabic aliases                                                                            |
| --------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `name`          | Product Name       | name, item, product, item name, product name, item_name, product_name                                                                           | الاسم، اسم المنتج، اسم الصنف، اسم السلعة، المنتج                                          |
| `externalKey`   | Product Code / SKU | externalkey, external key, external_key, sku, sku code, product sku, item code, product code, item_code, product_code                           | كود المنتج، كود الصنف، رمز المنتج، رمز الصنف، كود sku، رمز sku                            |
| `description`   | Description        | description, item description, product description, item_description, product_description                                                       | الوصف، وصف، وصف المنتج، وصف الصنف، تفاصيل المنتج                                          |
| `category`      | Category           | category, item category, product category, item_category, product_category                                                                      | الفئة، فئة، التصنيف، تصنيف، فئة المنتج، تصنيف المنتج، قسم المنتج                          |
| `basePrice`     | Price              | baseprice, base price, base_price, price, unit price, sale price, selling price, retail price, sale_price, selling_price                        | السعر، سعر، سعر المنتج، سعر الصنف، سعر البيع، سعر الوحدة، السعر الأساسي، السعر الاساسي    |
| `stockQuantity` | Available Quantity | stockquantity, stock quantity, stock_quantity, stock qty, inventory quantity, stock on hand, quantity, qty, available quantity, available stock | الكمية، كمية، الكمية المتاحة، كمية متاحة، كمية الصنف، المخزون، كمية المخزون، رصيد المخزون |

These are exact normalized aliases; punctuation, spelling, and Arabic letter
forms are not automatically rewritten. `Sale Price`, `Quantity`, and `SKU Code`
are supported aliases for `basePrice`, `stockQuantity`, and `externalKey`, respectively.
Explicit underscore spellings above are
aliases, while `product-name` and `sku-code` are not. Generic `code`, `value`,
`الصنف`, and `الرصيد` remain UNMAPPED, as do `cost price`, `order quantity`,
`سعر التكلفة`, and `الكمية المطلوبة`. If both `Price` and `Sale Price` occur in
one sheet, both remain UNMAPPED because they compete for the same target.
Labels are for display only; confirmation uses the internal target values.

`PATCH /imports/:importId/mapping` accepts JSON:

```json
{
  "mapping": [
    { "sourceColumn": "Item Name", "type": "STANDARD", "target": "name" },
    { "sourceColumn": "Fabric", "type": "ATTRIBUTE", "target": "material" },
    { "sourceColumn": "Notes", "type": "IGNORE", "target": null }
  ]
}
```

Example `200 OK` confirmation response:

```json
{
  "importId": "e5b31599-e582-4a36-966b-dda8389e2fb0",
  "status": "MAPPING_REQUIRED",
  "mapping": [
    {
      "sourceColumn": "Item Name",
      "sourceColumnIndex": 1,
      "type": "STANDARD",
      "target": "name"
    },
    {
      "sourceColumn": "Fabric",
      "sourceColumnIndex": 2,
      "type": "ATTRIBUTE",
      "target": "material"
    },
    {
      "sourceColumn": "Notes",
      "sourceColumnIndex": 3,
      "type": "IGNORE",
      "target": null
    }
  ]
}
```

Confirmation rules (mapping structure only, not catalog row validation):

- `mapping` must be a non-empty array of objects; unknown properties are rejected.
- Each entry identifies an existing header by its exact `sourceColumn` text.
  Optional `sourceColumnIndex` is a one-based integer identifying the physical
  Excel column and must match the supplied header. Duplicate/blank headers
  require this index, so two same-named columns can be treated independently.
- A physical source column cannot occur twice; each STANDARD target can occur
  only once, and STANDARD `name` is required.
- Types are STANDARD, ATTRIBUTE, VARIANT_ATTRIBUTE, IGNORE, and UNMAPPED.
  STANDARD targets must be one of the six fields listed above.
- ATTRIBUTE/VARIANT_ATTRIBUTE targets are user-defined lowercase keys matching
  `[a-z][a-z0-9_]{0,63}` (e.g. `material`, `color`, `size`). Reserved object keys
  such as `constructor`, `prototype`, and `__proto__` are rejected. A custom key
  cannot repeat within the same mapping type.
- IGNORE and UNMAPPED require explicit `target: null`. Omitted columns are saved
  as UNMAPPED. Confirmation replaces the complete previous mapping, so send all
  decisions you intend to retain.

Mappings are stored as the response's ordered array in `ImportJob.mapping`
(JSONB). Suggestions remain separate from saved owner choices. ATTRIBUTE and
VARIANT_ATTRIBUTE only store intent here; no attributes, variants, or catalog
records are created. Confirmation keeps `MAPPING_REQUIRED`, changing no import
counters/errors. The Validation endpoint transitions to `VALIDATING` only when
it claims the job for processing.

Missing imports return `404`; invalid payloads/targets/UUIDs return `400`.
Jobs outside MAPPING_REQUIRED, old jobs missing file metadata, or missing retained
files return `409`. Other storage read failures return a generic `500` without
storage keys or filesystem paths. GET and PATCH never expose `fileKey`.

In Postman, reuse the `importJobId` from analysis for GET, then PATCH the same
URL with **Body -> raw -> JSON** and the confirmed mapping. GET again to inspect
the saved mapping. No multipart body is needed for these endpoints.

## Excel normalization and row validation

Send `POST /imports/:importId/validate` with no file or JSON body, after mapping
confirmation. Validation reads the retained workbook and persisted sheet/header
row and mapping. It processes all data rows, rather than only analysis samples.
No CatalogItem writes, preview/planning, or import execution occur.

The endpoint requires MAPPING_REQUIRED and a non-empty confirmed mapping, then
atomically claims the job as VALIDATING. It reloads the latest mapping after
claiming, accounting for a confirmation that won immediately before the claim.
Further mapping changes and concurrent validation requests return `409`.

Successful processing sets READY even when some or all rows are invalid.
Workbook/storage/mapping-integrity/processing failures set FAILED and return a
generic `500`, retaining the workbook for diagnosis. Missing imports return
`404`; invalid UUIDs return `400`; wrong lifecycle state or missing confirmation
returns `409` before claiming the job. READY/FAILED jobs cannot be validated again
through this endpoint.

Normalization rules:

- Trim surrounding string whitespace; blank strings become null. Preserve
  internal whitespace, casing, newlines, and wording.
- STANDARD text fields become strings (numeric/boolean Excel scalars use their
  string representation). ATTRIBUTE and VARIANT_ATTRIBUTE go into separate
  objects and retain scalar string/number/boolean/null types.
- IGNORE and UNMAPPED columns never enter normalized data. Unmapped target fields
  are absent; mapped blank cells are explicit null; mapped values are present.
  Future updates must treat a mapped null as **do not overwrite**, not clearing
  the stored value. Attribute keys follow the same absent/null/value semantics.
- Price accepts ordinary ASCII decimal literals, optional leading `+`, and
  leading-dot fractions such as `.50`. It becomes an exact two-decimal string
  through Prisma Decimal (`29.9` becomes `"29.90"`), without rounding. Currency
  symbols, grouping separators, decimal commas, exponent strings, and negative
  signs are rejected; no localized-number guessing occurs. Excel numeric cells
  have already been decoded by ExcelJS, but normalized price storage is a string.
- Quantity accepts non-negative integer literals or whole-number numeric Excel
  values, including zero. Fractional/decimal strings such as `"10.0"` are rejected;
  a numeric cell decoded as `10` is accepted. Blank optional price/quantity cells
  become null.

Row rules and error codes:

- Name is required after trimming (`REQUIRED`).
- Price, if present, must have at most two fractional places and be below
  `10000000000`, fitting Decimal(12,2) (`INVALID_DECIMAL`).
- Quantity, if present, must be an integer from 0 to 2147483647, fitting
  PostgreSQL INTEGER (`INVALID_INTEGER`).
- Supplied external keys are trimmed strings; blanks become null. Name,
  externalKey, and category are limited to 200 characters, matching the schema
  (`TEXT_TOO_LONG`).
- Every occurrence of a duplicated non-null, trimmed external key is invalid
  (`DUPLICATE_EXTERNAL_KEY`), including the first occurrence and rows with other
  errors. Comparison is exact and case-sensitive; blank keys do not conflict.
- Fully blank/whitespace-only Excel rows are skipped. Non-empty rows that fail
  validation are invalid, including rows containing only ignored/unmapped data.

`totalRows` counts physical rows from headerRow + 1 through the loaded sheet's
last row, including gaps/blank rows. It equals validRows + invalidRows +
skippedRows. Row numbers are original one-based Excel positions.

Example `201 Created` response:

```json
{
  "importId": "e5b31599-e582-4a36-966b-dda8389e2fb0",
  "status": "READY",
  "summary": {
    "totalRows": 3,
    "validRows": 1,
    "invalidRows": 1,
    "skippedRows": 1
  },
  "validRows": [
    {
      "rowNumber": 4,
      "data": {
        "externalKey": "SKU-001",
        "name": "T-Shirt",
        "description": null,
        "basePrice": "299.99",
        "stockQuantity": 10,
        "attributes": { "material": "Cotton" },
        "variantAttributes": { "size": "XL" }
      }
    }
  ],
  "invalidRows": [
    {
      "rowNumber": 6,
      "errors": [
        {
          "field": "basePrice",
          "code": "INVALID_DECIMAL",
          "message": "Price must be a non-negative number with at most 2 decimal places and at most 10 integer digits"
        }
      ]
    }
  ]
}
```

The response's omitted category field means category was not mapped; explicit
`description: null` means it was mapped but blank, so later updates must preserve
the existing description. The mapping remains saved unchanged.

ImportJob stores the four summary counters and JSONB errors as
`{ summary, rows: invalidRows }`. It does not store the valid normalized dataset.
Preview rebuilds that dataset from the retained workbook + confirmed mapping
using the same row normalizer/validator. Storage keys are never returned.
Variant attributes remain metadata only; no Variant models or records exist.

Processing is synchronous and returns all valid rows/error details for the MVP.
There is no background worker, retry/reset endpoint, or automatic recovery of
VALIDATING jobs after a process crash. If PostgreSQL is unavailable when a failure
occurs, marking FAILED may also fail; that error is logged and the job may remain
VALIDATING until recovery. No recovery stage is implemented here.

## Excel preview / import planning

Send `GET /imports/:importId/preview` with no body after validation has completed.
Only READY jobs can be previewed. The endpoint reopens the retained workbook,
uses the saved sheet/header row and complete confirmed mapping, and reuses the
row normalizer/validator. It does not use the five analysis samples or a cached
valid dataset. Invalid and skipped rows never participate in catalog operations.

Identity is exactly `(businessId, externalKey)`, using trimmed, case-sensitive,
non-null external keys. Rows without a key are always INSERT candidates; names
are never used to match products. Catalog lookups are scoped by businessId and
batched in groups of up to 1,000 unique valid keys. Invalid/duplicate keys are not
looked up, and no catalog query is needed when all valid rows are unkeyed.

Actions:

- INSERT: no matching item exists in that business, or the row has no key.
  `data` contains normalized mapped standard values and non-blank attributes.
- UPDATE: a matching item has actual differences in supported mapped values.
  `changes` contains only changed fields, each with `from` and `to` values.
- UNCHANGED: a matching item has no catalog changes. Variant metadata alone does
  not make an UPDATE.

Update rules:

- Only mapped STANDARD fields participate. Absent (unmapped) fields and mapped
  null/blank cells do not overwrite existing values. Zero is a value, not blank.
- Compare price as an exact two-decimal string, matching normalized price data;
  equivalent Decimal representations do not produce a false update.
- Merge non-blank ATTRIBUTE values into the existing attributes object, retaining
  blank-mapped keys, unmapped keys, and nested values. Attribute changes show the
  full object before/after the proposed merge. Existing null attributes can
  receive new keys. Existing non-object JSON attributes cause `409` when a merge
  would be needed, to avoid silently losing legacy data.
- `variantAttributes` are row-level preview metadata, separate from insert data
  and update changes. No variants are created or updated.
- isActive, trackInventory, missing products, and stock history are untouched.
  Inactive matches are eligible for ordinary field changes but are not reactivated.
  Missing catalog products are not deleted/deactivated.
- stockQuantity can appear in insert data/update changes as a proposal only.
  Execution removes it from ordinary catalog writes and uses
  InventoryService, so every stock change has an InventoryMovement audit record.

Example `200 OK` response:

```json
{
  "importId": "e5b31599-e582-4a36-966b-dda8389e2fb0",
  "status": "READY",
  "summary": {
    "totalRows": 5,
    "validRows": 3,
    "invalidRows": 1,
    "skippedRows": 1,
    "willInsert": 1,
    "willUpdate": 1,
    "unchanged": 1
  },
  "inserts": [
    {
      "rowNumber": 4,
      "action": "INSERT",
      "externalKey": "SKU-001",
      "data": {
        "externalKey": "SKU-001",
        "name": "T-Shirt",
        "basePrice": "299.99"
      },
      "variantAttributes": { "size": "XL" }
    }
  ],
  "updates": [
    {
      "rowNumber": 5,
      "action": "UPDATE",
      "catalogItemId": "a2e3f480-2d80-4c33-92e8-9ef96cad8345",
      "externalKey": "SKU-002",
      "changes": {
        "name": { "from": "Old Name", "to": "New Name" },
        "basePrice": { "from": "249.99", "to": "299.99" }
      }
    }
  ],
  "unchanged": [
    {
      "rowNumber": 6,
      "action": "UNCHANGED",
      "catalogItemId": "c037b8d0-bdc1-483b-9b21-702f68c840de",
      "externalKey": "SKU-003"
    }
  ],
  "invalidRows": [
    {
      "rowNumber": 8,
      "errors": [
        {
          "field": "name",
          "code": "REQUIRED",
          "message": "Product name is required"
        }
      ]
    }
  ]
}
```

`willInsert + willUpdate + unchanged` equals validRows. Row numbers remain Excel
row positions. Invalid row errors are rebuilt through the same validator, not
converted to operations. Storage keys are never returned.

Preview performs no writes, deletes, or file cleanup and does not change job
status/counters/errors. It stays READY, including when preview fails. Missing jobs
return `404`; invalid UUIDs return `400`; wrong status, missing retained metadata,
missing files, or non-object attributes that cannot be safely merged return `409`.
Other reconstruction/storage/system failures return a generic `500`.

In Postman, use the existing import UUID in the preview URL and send a GET after
the validation response is READY. Repeating preview rebuilds the plan against the
current catalog. No file upload or confirmed mapping payload is needed.

The plan is advisory and is not persisted or locked: catalog changes after a
preview can change the plan. Execution rechecks identity and changes inside each
row transaction. Preview itself performs no writes.

## Inventory foundation

`InventoryModule` exports `InventoryService` for internal callers. It exposes no
manual inventory HTTP endpoint and does not implement Orders,
variants, queues, or background workers. The `InventoryMovement` model links
Business and CatalogItem and records movement type, stock before/after/delta,
optional reference type/ID, and creation time. Delete restrictions preserve audit
links. Indexes support business/item history and reference searches.

Movement types are INITIAL_IMPORT, IMPORT_UPDATE, MANUAL_ADJUSTMENT,
ORDER_APPROVED, and ORDER_CANCELLED. These enum values describe future audit
sources; they do not implement those workflows. References are optional opaque
strings rather than relations to Orders or ImportJob.

Internal operation:

```typescript
await inventory.setQuantity(
  { id: catalogItemId, businessId },
  targetQuantity,
  InventoryMovementType.IMPORT_UPDATE,
  { type: 'IMPORT_JOB', id: importJobId },
  transaction, // optional caller-owned Prisma TransactionClient
);
```

The target must be an integer from 0 to 2147483647. Reference types are trimmed
strings of 1 to 50 characters; supplied IDs are trimmed strings of 1 to 200
characters. An omitted reference/ID is stored as null.

The service reads current stock scoped by item ID and business ID rather than
trusting a caller's stale item snapshot. If quantity is unchanged, it writes
neither stock nor a movement. Otherwise it conditionally updates the quantity
only if the previously read stock still matches, then creates the audit record
in the same Prisma transaction. A concurrent change raises a conflict; callers
may retry the complete operation. Failed stock/audit writes roll back together.

Existing stock is nullable: an initial assignment records quantityBefore = null
and calculates delta using zero as its baseline. Even null -> 0 is a recorded
initialization; known 0 -> 0 is a no-op. Later movements use the actual prior
integer quantity. Negative deltas are valid when stock decreases; target stock
cannot be negative.

Without a supplied transaction, the service opens one. With a caller-owned
transaction, it reuses that transaction without nesting. Callers must let errors
abort the surrounding transaction instead of swallowing them and committing.
This allows item creation/tracking changes and stock/audit writes to be
one atomic operation.

The Excel execution rule is:

- A non-null normalized stockQuantity, including zero, requires trackInventory
  to be true. Execution enables tracking within the same transaction
  and route the quantity through InventoryService.
- Unmapped stock or a mapped blank/null cell must leave stockQuantity and
  trackInventory unchanged.
- InventoryService itself changes quantity only; it does not toggle tracking,
  reactivate items, or alter ordinary catalog fields.

Migration `20261006075041_add_inventory_movement` creates the movement table,
movement type enum, indexes, and foreign keys. It has been applied to the local
development database. Apply pending migrations with `npm.cmd run prisma:deploy`
when setting up another database before calling InventoryService. Existing
preview behavior is unchanged.

## Excel import execution

Send `POST /imports/:importId/execute` with no body or file upload. In Postman,
use the import UUID from analysis and run mapping confirmation and validation
first. Preview is optional. Successful execution returns `200 OK`.

The endpoint atomically claims READY -> IMPORTING. Unknown UUIDs return 404,
malformed UUIDs return 400, and jobs outside READY or a lost concurrent claim
return 409. Completed jobs cannot be executed again.

Execution reopens the retained workbook using the saved sheet, header row, and
mapping, normalizes and validates all rows again, and rebuilds the catalog plan
from current values inside each row's serializable Prisma transaction. It never
uses an old preview. Each valid row commits independently; a failed row rolls
back and processing continues. Unique-key and serialization conflicts fail that
row with EXECUTION_CONFLICT rather than retrying over concurrent changes.

- Identity is exclusively `(businessId, externalKey)`. An absent/null key always
  creates a new item; names are never identity. Other businesses are isolated.
- Only mapped non-null standard values are written. Mapped blanks and unmapped
  fields preserve existing values. New items retain schema defaults, including
  isActive. Non-null ATTRIBUTE values merge into existing attributes; blank
  attributes preserve old values. Variant attributes are not persisted.
- Non-null stock, including zero, enables trackInventory. For a new item, the
  ordinary create leaves stock null, then InventoryService initializes it with
  INITIAL_IMPORT. Existing items use IMPORT_UPDATE. Both reference
  `{ type: 'IMPORT_JOB', id: importId }`. Catalog edits, tracking, stock, and
  movement audit share the same row transaction. Equal stock produces no audit;
  enabling tracking alone still counts as an update. Blank/unmapped stock leaves
  both stock and tracking unchanged.
- Invalid rows do not execute; blank Excel rows remain skipped. Missing products
  are never deleted/deactivated, inactive matches are never reactivated, and no
  variants, images, options, or Orders are created.

Final status is COMPLETED when all valid rows succeed and there are no invalid
rows; otherwise it is COMPLETED_WITH_ERRORS. A job-level workbook, mapping,
connection, or finalization failure sets FAILED when persistence is available.
Successful earlier row transactions remain committed even on job-level failure.
Errors contain safe messages, never database details, stack traces, storage paths,
or file keys. The retained workbook is kept for history/debugging.

Example response (row numbers are physical Excel row numbers):

```json
{
  "importId": "f6bc7287-3285-4e19-a819-459c41f0a138",
  "status": "COMPLETED",
  "summary": {
    "totalRows": 2,
    "validRows": 2,
    "invalidRows": 0,
    "skippedRows": 0,
    "insertedCount": 1,
    "updatedCount": 0,
    "failedCount": 0,
    "unchangedCount": 1
  },
  "inserted": [
    { "rowNumber": 4, "externalKey": "NEW", "catalogItemId": "uuid" }
  ],
  "updated": [],
  "unchanged": [
    { "rowNumber": 5, "externalKey": "EXISTING", "catalogItemId": "uuid" }
  ],
  "failedRows": [],
  "invalidRows": []
}
```

`totalRows`, `validRows`, `invalidRows`, and `skippedRows` reflect fresh validation.
`insertedCount` and `updatedCount` count committed rows only; `failedCount` counts
failed valid execution rows, excluding validation-invalid rows. Unchanged rows
increment neither insert nor update counters; unchangedCount is response-only.
ImportJob.errors stores validation errors under `rows`, execution errors under
`execution` (rowNumber/code/message), and a safe `job` error on system failure.
On normal completion, validRows equals insertedCount + updatedCount + failedCount

- unchangedCount. No schema changes or additional packages are required.

This MVP runs synchronously without queues or automatic recovery. A process crash
or database outage can leave a job IMPORTING, and committed catalog changes may
precede persisted final counters. Inspect the job and inventory audit before any
manual recovery; blindly resetting it to READY can duplicate items without SKUs.
Automatic retries, resumability, and file retention cleanup are future work.

## Verification and production build

Use `npm.cmd run format` to format TypeScript, JSON, and Markdown with Prettier
and the Prisma schema with Prisma's native formatter. `npm.cmd run format:check`
checks the Prettier-managed files without rewriting them. Generated files, tests,
local storage, and temporary directories are excluded. ESLint is not configured.

The following commands do not apply migrations or require a database connection:

```powershell
npm.cmd run prisma:validate
npm.cmd run prisma:generate
npm.cmd run build
```

`npm.cmd run build` generates Prisma Client before compiling the application.
The generated client is intentionally excluded from Git; generation recreates
it from the committed Prisma schema. Install development dependencies when
building, because Prisma CLI, Nest CLI, and TypeScript are required.

Automated test files and Jest configuration are intentionally excluded from
this GitHub repository. The package's test script and test dependencies support
local development, but running that script requires the local test files and
configuration; it is not part of setup or production startup.

Use `npm.cmd ci` for subsequent reproducible installs from `package-lock.json`.

After configuring and migrating the target database, run the compiled app with:

```powershell
npm.cmd run start:prod
```
