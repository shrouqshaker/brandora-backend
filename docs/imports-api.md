# Excel Import API for Mobile

Flow: Analyze -> Mapping -> POST Validate once -> GET Validation Results pages
-> GET Preview pages -> Execute -> GET Status to resume -> GET History later.
Processing remains synchronous. Errors use stable codes for Mobile localization;
backend messages remain English. No endpoint exposes fileKey or storage paths.
Business scoping is a database filter; authentication is not yet implemented.

## Shared pagination

All three paginated GET endpoints return:

```json
{
  "limit": 50,
  "offset": 0,
  "totalCount": 1180,
  "hasMore": true,
  "nextOffset": 50
}
```

limit is an integer 1..100, default 50 for validation-results/preview and 20
for history. offset is a non-negative safe integer (maximum 9007199254740991),
default 0. Invalid UUIDs/query values and unknown GET query parameters return
400 VALIDATION_ERROR. Final/out-of-range pages have hasMore=false and
nextOffset=null. Otherwise, request offset=nextOffset to continue. Returned
rows are page-specific; summaries/counts always cover the full import/business.

For row results, totalCount=validRows+invalidRows. Combine all non-skipped rows
in original Excel rowNumber order, page once, then split back into collections.
Skipped rows do not occupy page positions. limit applies across all arrays,
not separately to each one; offset counts eligible rows, not worksheet positions.

## Status

`GET /imports/:importId` returns 200 with the unchanged compact contract:

```json
{
  "id": "e5b31599-e582-4a36-966b-dda8389e2fb0",
  "businessId": "f6bc7287-3285-4e19-a819-459c41f0a138",
  "status": "COMPLETED_WITH_ERRORS",
  "fileName": "Products.xlsx",
  "sheetName": "Products",
  "headerRow": 3,
  "totalRows": 5,
  "validRows": 3,
  "invalidRows": 1,
  "skippedRows": 1,
  "insertedCount": 1,
  "updatedCount": 1,
  "failedCount": 1,
  "createdAt": "2026-10-09T10:00:00.000Z",
  "updatedAt": "2026-10-09T10:01:00.000Z"
}
```

No mapping, errors, or storage details are returned. sheetName/headerRow may be
null on older jobs. Missing jobs return 404 IMPORT_JOB_NOT_FOUND. Use status
for app restart, network timeout, and execute timeout recovery. Before validation,
Analyze has populated totalRows but other counters remain defaults.

## History

`GET /businesses/:businessId/imports?limit=20&offset=0` now returns an envelope
`{ pagination, items }`. items contains the same compact objects as Status.
This replaces the previous raw array response. Ordering is createdAt descending,
then id descending for equal timestamps. All queries and the database count are
business-scoped; totalCount does not come from loading all jobs into memory.
Missing business returns 404 BUSINESS_NOT_FOUND. An existing business with no
jobs returns:

```json
{
  "pagination": {
    "limit": 20,
    "offset": 0,
    "totalCount": 0,
    "hasMore": false,
    "nextOffset": null
  },
  "items": []
}
```

For a business with 57 jobs, offset=0 returns up to 20 objects with
hasMore=true/nextOffset=20; offset=20 returns the next 20 with nextOffset=40;
offset=40 returns 17 with hasMore=false/nextOffset=null. offset=100 returns
items=[] with totalCount=57, hasMore=false, nextOffset=null. History is read live;
new uploads can move offset-based pages while browsing.

## Mapping, sheets, and headers

Analyze `POST /businesses/:businessId/imports/excel/analyze` accepts multipart
file plus optional sheetName. Without sheetName it chooses the first worksheet.
Choosing another sheet requires a new Analyze request and file upload with
sheetName. headerRow is automatically detected and returned; there is no manual
headerRow input/override.

GET/PATCH `/imports/:importId/mapping` are available only in MAPPING_REQUIRED.
Confirmation saves mapping and keeps MAPPING_REQUIRED. Once validation starts,
mapping is locked. Changing mapping or correcting the file requires a new
Analyze/import job. No reset/remapping endpoint is introduced.

## Validate once

`POST /imports/:importId/validate`, with no upload/body, validates the entire
workbook, including duplicate external keys across all rows. It still persists
full counters/errors and transitions MAPPING_REQUIRED -> VALIDATING -> READY,
or FAILED on a processing failure. No Catalog/Inventory writes occur.
limit/offset have no role on POST and do not affect processing. Success is 201:

```json
{
  "importId": "e5b31599-e582-4a36-966b-dda8389e2fb0",
  "status": "READY",
  "summary": {
    "totalRows": 3,
    "validRows": 1,
    "invalidRows": 1,
    "skippedRows": 1
  }
}
```

There is no pagination or row array in this compact response. Repeating POST
after READY still returns 409; use the GET reader for pages.

## Validation Results pages

`GET /imports/:importId/validation-results?limit=1&offset=0` returns 200:

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
  "pagination": {
    "limit": 1,
    "offset": 0,
    "totalCount": 2,
    "hasMore": true,
    "nextOffset": 1
  },
  "validRows": [
    { "rowNumber": 4, "data": { "name": "Coffee", "basePrice": "49.90" } }
  ],
  "invalidRows": []
}
```

In this workbook row 5 is skipped and row 6 is invalid. offset=1 returns
validRows=[] and the invalid row 6 with its field/code/message errors;
hasMore=false/nextOffset=null. The global summary stays identical. Empty error
arrays with positive summary.invalidRows are expected when errors are off-page.

totalRows=validRows+invalidRows+skippedRows. No state mutation, Excel decoding,
normalization, validation, or catalog lookup occurs on GET. Validation writes
an immutable versioned JSON snapshot through ImportFileStorage before READY.
The existing ImportJob.fileKey locates that private sidecar; summary/invalid
errors remain in ImportJob, and normalized valid rows are not copied into
PostgreSQL. GET returns the snapshot's original counts, even after Execute
updates the job's counters/errors. No schema migration is required.

Results are readable in READY, IMPORTING, COMPLETED, COMPLETED_WITH_ERRORS,
and FAILED/CANCELLED if a successful validation snapshot exists. Missing jobs
return 404 IMPORT_JOB_NOT_FOUND. Pre-validation states, failed validation, or
missing snapshots return 409 IMPORT_VALIDATION_RESULTS_UNAVAILABLE. This also
applies to older READY jobs that never saved a snapshot; no automatic backfill
is implemented. Corrupt snapshots/storage read failures return a safe 500.

Snapshots persist across restarts in IMPORT_STORAGE_DIR and must be retained
with their workbooks. Local storage must be shared/persistent when deploying
multiple instances. No automatic expiry/recovery is added. Paging currently
loads the snapshot JSON in memory, but never reruns validation. The storage
abstraction can be implemented with object storage later.

## Preview pages

`GET /imports/:importId/preview?limit=2&offset=2` returns 200 only for READY jobs.
It revalidates the entire workbook and plans every valid row against the current
catalog before paging. Collections remain inserts, updates, unchanged, invalidRows.
No database/file writes or status changes occur. Example: row 4 INSERT, row 5
UPDATE, row 6 UNCHANGED, row 7 skipped, row 8 invalid. The second page contains
rows 6 and 8:

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
  "pagination": {
    "limit": 2,
    "offset": 2,
    "totalCount": 4,
    "hasMore": false,
    "nextOffset": null
  },
  "inserts": [],
  "updates": [],
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

summary.invalidRows=1 and this page shows that row. offset=0 shows INSERT/UPDATE
with empty unchanged/invalidRows arrays and the same summary; hasMore=true and
nextOffset=2. willInsert+willUpdate+unchanged=validRows. Preview is advisory,
recomputed on each request, and catalog edits can change action categories
between pages. It is not a locked snapshot. Pagination reduces payload size,
not workbook memory or processing time. Execute still independently processes
all rows, never just a preview page.

## Catalog contract

Create/PATCH support externalKey, category, attributes, isActive, name,
description, and basePrice. Responses include category, stockQuantity,
trackInventory, and isActive. externalKey is optional for inserts; unkeyed Excel
rows always propose inserts. Catalog CRUD cannot write stockQuantity or
trackInventory. Inventory writes belong to InventoryService with audit records.
Images and actual variants remain future scope. See [Catalog API](catalog-api.md).
