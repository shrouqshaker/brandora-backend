# Brandora Android API integration guide

Contract reviewed on 2026-10-30 against application source commit
`f4b69686854ce7dff2342db14e01b250e26add6e`, including inventory/import commit
`25b056447b4e84a883275191c22e483dddf1b7a5`.

This document describes implemented backend behavior, not confirmation of a live
deployment. The local commits have not been deployed as part of this work. IDs,
tokens and timestamps in examples are illustrative; use IDs returned by your
environment. Resource examples are independent of the sequential Excel example.

## 1. Connection, authentication and selected business

Intended HTTPS base URL, subject to owner confirmation of the deployed version:

```text
https://brandora-backend-production-85ec.up.railway.app/
```

There is no `/api` prefix. Keep the trailing slash in Retrofit's base URL. Use
HTTPS on devices; do not send credentials to an unverified alternative host.
The deployed host and database version must be confirmed before integration.

For every business, product, category, variant, inventory and import request:

```http
Authorization: Bearer <accessToken>
Accept: application/json
Content-Type: application/json
```

For workbook uploads, use `multipart/form-data` with a library-generated boundary
instead of JSON Content-Type. GET and DELETE requests need no body.

An access token identifies a User/session, not a selected business. One User can
own multiple Businesses. Save the selected business UUID in app state and put it
in each scoped route. The server checks current active OWNER membership. Knowing
a business, product, variant or import UUID does not grant access. `importId`
routes resolve their Business on the server. Missing/invalid JWTs return 401;
foreign/inactive membership is normally hidden as 404 NOT_FOUND. Authenticate
first: an invalid UUID can also be hidden as 404 by the guard before DTO validation.

### Session endpoints

| Method and path | Request JSON | Success body/status |
| --- | --- | --- |
| POST `/auth/register` | `{ "email": "owner@example.com", "password": "SecurePassword123!" }` | Session below, 201 |
| POST `/auth/login` | Same fields | Session below, 200 |
| GET `/auth/me` | No body; Bearer required | `{ "id": "11111111-1111-4111-8111-111111111111", "email": "owner@example.com", "businesses": [] }` for a new user, 200 |
| POST `/auth/refresh` | `{ "refreshToken": "<opaque-refresh-token>" }` | Replacement Session, 200 |
| POST `/auth/logout` | Same refresh-token body; no Bearer required | 204, empty |
| POST `/auth/logout-all` | `{}`; Bearer required | 204, empty |
| POST `/auth/forgot-password` | `{ "email": "owner@example.com" }` | Generic message in section 11, 200, or 503 when unavailable |
| POST `/auth/reset-password` | Token/newPassword in section 11 | 204, empty |

Session JSON:

```json
{
  "user": { "id": "11111111-1111-4111-8111-111111111111", "email": "owner@example.com" },
  "accessToken": "<signed-access-token>",
  "refreshToken": "<opaque-refresh-token>",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "refreshExpiresAt": "2026-11-29T12:00:00.000Z"
}
```

GET `/auth/me` businesses contains active membership entries shaped as
`{ "id": "11111111-1111-4111-8111-111111111112", "name": "Studio Shop", "role": "OWNER" }`
after Business creation. This is not the paginated Business profile list.

Registration passwords are 12–128 UTF-16 code units with an ASCII uppercase,
lowercase and digit. Do not trim passwords. Emails are trimmed/lowercased, ASCII,
valid email syntax and at most 254 characters. Access tokens last 15 minutes;
refresh sessions expire absolutely 30 days after login. Refresh rotates the token.
Implement single-flight refresh: one refresh operation for all waiting requests,
persist both new tokens atomically, then retry eligible requests at most once.
Reusing a consumed refresh token revokes the family, including tokens just issued
to a racing refresh. After an ambiguous/lost refresh response, require login;
do not retry the old refresh token blindly. Logout/reset/revocation blocks future
protected requests. Use Keystore-backed credential storage and redact HTTP logs.

Public credential endpoints are rate limited; 429 AUTH_RATE_LIMITED and 503
AUTH_RATE_LIMIT_UNAVAILABLE carry Retry-After seconds. Respect the header. The
Railway proxy/shared-IP limitation remains an operational release concern; the
Android client cannot fix it by supplying forwarded-IP headers.

### Obtain a Business

`POST /businesses` with `{ "name": "Studio Shop" }` returns 201 and atomically
creates the current User's OWNER membership. A minimal creation response is:

```json
{
  "id": "11111111-1111-4111-8111-111111111112",
  "name": "Studio Shop",
  "description": null,
  "category": null,
  "phone": null,
  "address": null,
  "createdAt": "2026-10-30T12:00:00.000Z",
  "updatedAt": "2026-10-30T12:00:00.000Z"
}
```

`GET /businesses?limit=20&offset=0` returns `{ "pagination": ..., "items": [...] }`
with those profile objects for the current User's active OWNER memberships.
`GET /businesses/:businessId` returns one profile, 200. Existing unowned businesses
cannot be claimed by supplying an ID. Business.category is profile metadata and
is unrelated to the product Category resource.

## 2. Shared conventions and pagination

IDs are UUID strings. Dates are UTC ISO-8601 strings. JSON field names are camelCase
except the standard Android Digital Asset Links payload. Unknown body and query
fields are rejected on the documented DTO-based resource routes. Do not send
server-owned IDs, timestamps or businessId inside scoped resource bodies.

Product/Variant CRUD prices are nonnegative **decimal strings**, e.g. `"125.00"`,
with at most 10 integer digits and two decimal places. JSON numbers, signs,
exponents, grouping separators and leading-zero forms such as `"01.00"` are
rejected by those DTOs. Responses from those CRUD presenters always use two
decimal places or null. Import normalization has a separate, more permissive
input parser, but normalized price results also have two decimal places.

All paginated resource lists return this envelope; replace items with the relevant
objects from the following sections:

```json
{
  "pagination": { "limit": 20, "offset": 0, "totalCount": 0, "hasMore": false, "nextOffset": null },
  "items": []
}
```

| Reader | Default limit | Allowed range | Ordering |
| --- | --- | --- | --- |
| Business, Category, Product, Variant lists | 20 | 1–100 | createdAt DESC, id DESC |
| Variant/Business movement history | 20 | 1–100 | createdAt DESC, id DESC |
| Import job history | 20 | 1–100 | createdAt DESC, id DESC |
| Validation results / preview | 50 | 1–100 | Combined non-skipped Excel rows by rowNumber |

offset defaults to 0 and must be a nonnegative safe integer, maximum
9007199254740991. Send integer query values; use nextOffset rather than
calculating from the number of items in one response collection. End/out-of-range
pages have empty arrays, hasMore=false and nextOffset=null. Each request is a new
view of data; offset pages across multiple requests are not a frozen snapshot.
Import history count and items are separate queries and may differ briefly under
concurrent job creation.

## 3. Categories

Let `C = /businesses/:businessId/categories`. Substitute actual UUIDs; C is
notation in this guide, not a literal URL.

| Method/path | Request body | Success |
| --- | --- | --- |
| POST C | `{ "name": "Clothes" }` | Category object, 201 |
| GET C`?limit=20&offset=0` | None | Pagination/items of Category, 200 |
| GET C`/:categoryId` | None | Category, 200 |
| PATCH C`/:categoryId` | `{ "name": "Everyday Clothes" }` | Updated Category, 200 |
| DELETE C`/:categoryId` | None | 204, empty |

Category response:

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "businessId": "11111111-1111-4111-8111-111111111112",
  "name": "Clothes",
  "createdAt": "2026-10-30T12:01:00.000Z",
  "updatedAt": "2026-10-30T12:01:00.000Z"
}
```

name is required, trimmed, nonblank and at most 200 characters. Database uniqueness
is business-scoped, case-insensitive after whitespace normalization. Display names
preserve internal spacing/case. Duplicate names return 409 CATEGORY_NAME_CONFLICT.
DELETE physically removes an unreferenced category; any referencing Product,
including inactive Products, yields 409 CATEGORY_IN_USE. It never deletes Products.

## 4. Products

`Product` is the Android/domain name; `CatalogItem` remains the internal model.
Product IDs appear as `catalogItemId` in Variant, movement and execution JSON.

Let `P = /businesses/:businessId/products`.

| Method/path | Request body | Success |
| --- | --- | --- |
| POST P | CreateProduct below | Product object, 201 |
| GET P`?limit=20&offset=0` | None | Pagination/items of Product, 200 |
| GET P`/:productId` | None | Product, 200 |
| PATCH P`/:productId` | One or more allowed metadata fields | Updated Product, 200 |
| DELETE P`/:productId` | None | Soft-deactivate Product; 204, empty |

Example create request:

```json
{
  "name": "Studio Tee",
  "description": "Cotton crew-neck",
  "categoryId": "22222222-2222-4222-8222-222222222222",
  "basePrice": "125.00",
  "options": { "color": ["Red", "Blue"], "size": ["M", "L"] },
  "attributes": { "material": "cotton" },
  "isActive": true
}
```

| Field | Create/update semantics |
| --- | --- |
| name | Required on POST; trimmed nonblank string ≤200; optional PATCH, never null |
| description | Optional string ≤5000; null clears |
| categoryId | Optional same-business Category UUID; null clears |
| basePrice | Optional decimal string; null clears |
| options | Optional object; default `{}` on POST; replaces definitions on PATCH; never null |
| attributes | Optional object; replaces on PATCH; `{}` clears contents; never null input |
| isActive | Optional boolean; default true on POST; PATCH true reactivates only Product |

POST with nonempty options creates **zero variants**. The exact response for the
example above, before variants are added, is shaped as follows:

```json
{
  "id": "33333333-3333-4333-8333-333333333333",
  "businessId": "11111111-1111-4111-8111-111111111112",
  "name": "Studio Tee",
  "description": "Cotton crew-neck",
  "categoryId": "22222222-2222-4222-8222-222222222222",
  "externalKey": null,
  "category": null,
  "basePrice": "125.00",
  "options": { "color": ["Red", "Blue"], "size": ["M", "L"] },
  "attributes": { "material": "cotton" },
  "isActive": true,
  "createdAt": "2026-10-30T12:02:00.000Z",
  "updatedAt": "2026-10-30T12:02:00.000Z",
  "isSellable": false,
  "variants": [],
  "variantsPagination": { "limit": 20, "offset": 0, "totalCount": 0, "hasMore": false, "nextOffset": null }
}
```

GET/PATCH return the same Product fields. Product responses do not expand the
Category: look up categoryId in the Category list. `category` is the retained legacy
string and may differ from the linked Category's current name. `attributes` in
responses can be null when omitted on create or for older records.

POST `{ "name": "Plain Mug", "basePrice": "75.00" }` creates a simple Product
with options `{}` and exactly one active Default Variant atomically. Its Variant
has optionValues `{}`, sku/unitPrice/stockQuantity null, trackInventory=false,
effectivePrice `"75.00"`. Therefore this priced simple Product isSellable=true.
Default is a role, not a separate name field in the Variant response.

Product responses embed at most 20 Variants with variantsPagination. Fetch the rest
through the nested Variant list; do not assume the embedded list is complete.
isSellable means active Product plus at least one active priced Variant, including
ones outside the first page. It does **not** guarantee stock availability, reserve
stock or approve an order. DELETE retains Variants/history and does not change stock.

### Dynamic options and transitions

- Option names/values are arbitrary business-defined, trimmed, case-sensitive
  strings; no clothing-only schema exists. Preserve Unicode and internal spaces.
- Up to 10 option names, each ≤60 UTF-16 code units; each has 1–50 distinct nonblank
  values ≤100 code units. Definitions ≤16384 UTF-8 JSON bytes; allowed selections
  must fit 1500 UTF-8 JSON bytes. attributes must fit 16384 UTF-8 bytes and depth 10.
- Reserved keys `__proto__`, `constructor`, `prototype` are rejected by Product
  JSON boundary checks, including nested objects.
- Option edits must retain validity of **all** existing Variants, including inactive
  ones. Otherwise 409 PRODUCT_OPTIONS_IN_USE. No automatic deletion/rewrite exists.
- Simple → configurable fails while its `{}` Default Variant exists, even inactive.
  Configurable → simple is allowed only when retained combinations permit it; with
  zero Variants, PATCH options `{}` creates the Default Variant atomically.
- Legacy simple Products without a Variant are not silently backfilled. Explicit
  PATCH options `{}` or POST optionValues `{}` can establish the missing default.

externalKey, legacy category, stockQuantity and trackInventory are **not writable**
through Product CRUD. Imports match existing Products by externalKey, not name or
SKU. A manually created Product normally has externalKey=null, so an import with a
new code does not attach to it by name. A reserved SKU may instead invalidate that
import group. There is no import “choose existing product ID” field.

## 5. ProductVariants

Let `V = /businesses/:businessId/products/:productId/variants`.

| Method/path | Request body | Success |
| --- | --- | --- |
| POST V | Required optionValues; optional sku and unitPrice | Variant, 201 |
| GET V`?limit=20&offset=0` | None | Pagination/items of Variant, 200 |
| GET V`/:variantId` | None | Variant, 200 |
| PATCH V`/:variantId` | At least one of sku, unitPrice, optionValues, isActive | Updated Variant, 200 |
| DELETE V`/:variantId` | None | Soft-deactivate Variant; 204, empty |

POST example and response:

```json
{ "sku": "TEE-RED-M", "optionValues": { "color": "Red", "size": "M" }, "unitPrice": "135.00" }
```

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "businessId": "11111111-1111-4111-8111-111111111112",
  "catalogItemId": "33333333-3333-4333-8333-333333333333",
  "sku": "TEE-RED-M",
  "optionValues": { "color": "Red", "size": "M" },
  "unitPrice": "135.00",
  "trackInventory": false,
  "stockQuantity": null,
  "isActive": true,
  "createdAt": "2026-10-30T12:03:00.000Z",
  "updatedAt": "2026-10-30T12:03:00.000Z",
  "effectivePrice": "135.00"
}
```

optionValues must select exactly one allowed string for every option, with no
extra/missing keys. Simple Products accept only `{}`. Object key order does not
change combination identity. SKU is trimmed, nonblank, ≤200 characters or null;
case-sensitive uniqueness is business-wide. Inactive SKUs/combinations stay reserved.

PATCH `{ "unitPrice": null }` restores inheritance from Product.basePrice;
effectivePrice = unitPrice ?? basePrice; null/null yields null. PATCH
`{ "sku": null }` clears the SKU. Omission preserves existing values. Neither
POST nor PATCH accepts stockQuantity/trackInventory. POST always creates active.

PATCH `{ "isActive": false }` or DELETE deactivates without deleting stock/history.
Withdrawing the last active Variant is allowed and makes the Product unsellable.
PATCH `{ "isActive": true }` revalidates current selections, uniqueness and active
parent status. It can fail with 409; it never changes inventory. Product reactivation
does not automatically reactivate its Variants.

## 6. Variant-only inventory

### Set absolute quantity

```http
POST /businesses/:businessId/products/:catalogItemId/variants/:variantId/inventory/adjust
```

Here catalogItemId is the Product UUID; use separate Product and Variant IDs.

```json
{ "quantity": 15 }
```

This **sets**, rather than increments, stock to 15 and enables tracking. quantity
must be a JSON integer 0–2147483647, not a string. trackInventory is optional
boolean, default true. Disable tracking explicitly with:

```json
{ "quantity": null, "trackInventory": false }
```

Disable clears current quantity but retains the audit. It conflicts while an
order deduction is unrestored. An inactive Product/Variant rejects stock writes.
No movement type, reference, delta, owner or order fields are accepted here.

Success is 201:

```json
{ "changed": true, "quantityBefore": null, "quantityAfter": 15, "quantityDelta": 15, "movementId": "55555555-5555-4555-8555-555555555555" }
```

An identical manual set returns 201 with changed=false, before/after equal,
quantityDelta=0 and movementId=null; it creates no movement. null means untracked,
not zero. A first null→0 tracking initialization is audited even with zero delta.

### Read history

| Method/path | Body | Success |
| --- | --- | --- |
| GET `/businesses/:businessId/products/:catalogItemId/variants/:variantId/inventory/movements?limit=20&offset=0` | None | Pagination/items below, 200 |
| GET `/businesses/:businessId/inventory/movements?limit=20&offset=0` | None | Same envelope across the Business, 200 |

```json
{
  "pagination": { "limit": 20, "offset": 0, "totalCount": 1, "hasMore": false, "nextOffset": null },
  "items": [{
    "id": "55555555-5555-4555-8555-555555555555",
    "catalogItemId": "33333333-3333-4333-8333-333333333333",
    "variantId": "44444444-4444-4444-8444-444444444444",
    "type": "MANUAL_ADJUSTMENT",
    "quantityBefore": null,
    "quantityAfter": 15,
    "quantityDelta": 15,
    "trackingBefore": false,
    "trackingAfter": true,
    "requestedQuantity": null,
    "referenceType": null,
    "referenceId": null,
    "createdAt": "2026-10-30T12:04:00.000Z"
  }]
}
```

Movement types: INITIAL_IMPORT, IMPORT_UPDATE, MANUAL_ADJUSTMENT, ORDER_APPROVED,
ORDER_CANCELLED. before/after can be null, delta uses zero as the null baseline;
requestedQuantity is nullable and populated for internal order movements. Movement
JSON does not include businessId; scope comes from the route. Reads remain available
after soft deletion. Stock/audit writes are atomic and parent-locked; database
constraints reject negative tracked quantities. Orders deduction/restoration are
internal caller-transaction methods, **not Android endpoints** in this upgrade.

## 7. Full Excel workflow

All nine operations below are implemented. Use a new job for each new file or
corrected upload. Do not substitute Product CRUD responses for normalized import
rows: their shapes differ.

| Step | Method and path | Request | Success |
| --- | --- | --- | --- |
| Analyze | POST `/businesses/:businessId/imports/excel/analyze` | Multipart file, optional sheetName field | 201 |
| Mapping suggestions | GET `/imports/:importId/mapping` | None | 200 |
| Confirm mapping | PATCH `/imports/:importId/mapping` | JSON mapping array | 200 |
| Validate | POST `/imports/:importId/validate` | No body required | 201 |
| Validation Results | GET `/imports/:importId/validation-results?limit=50&offset=0` | None | 200 |
| Preview | GET `/imports/:importId/preview?limit=50&offset=0` | None | 200 |
| Execute | POST `/imports/:importId/execute` | No body required | 200 |
| Status | GET `/imports/:importId` | None | 200 |
| History | GET `/businesses/:businessId/imports?limit=20&offset=0` | None | 200 |

### 7.1 Workbook and grouping rules

Example sheet named Products, header row 1; empty cells below are genuinely blank:

| Product Code | Name | SKU | Category | Price | Variant Price | Quantity | Color | Size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TEE-001 | Studio Tee | IMPORT-RED-M | Clothes | 125.00 | 135.00 | 8 | Red | M |
| TEE-001 | Studio Tee | IMPORT-BLUE-M | Clothes | 125.00 | | 12 | Blue | M |

Headers are examples, not requirements: map arbitrary source labels explicitly.
Same business + externalKey is Product identity; same Product + selected option
combination is Variant identity. SKU is a separate reservation/identifier, not
the Product grouping key and not a way to move a Variant to a new combination.
Different codes create separate Products even with the same name. Duplicate
combinations, even with different SKUs, are invalid.

Rows sharing a code must agree on name, description, category string, basePrice
and mapped product attributes. Any invalid row excludes its entire Product group.
Configurable rows require a nonblank SKU and every mapped option selection;
simple rows use a separate workbook without VARIANT_ATTRIBUTE mappings and may
omit SKU. Existing unimported combinations remain. Imports can expand allowed
values but cannot rename option keys, silently convert simple Products or
invalidate retained selections. Inactive matched Products/Variants are rejected.

Blank/unmapped metadata does not clear existing values. Nonblank attributes merge
into retained attributes; the final merged object is validated before READY.
Blank/unmapped unitPrice preserves an existing override; it cannot restore
inheritance during re-import (use Variant PATCH null). A new blank-priced Variant
has unitPrice=null. Nonblank stock is an absolute set through InventoryService;
blank/unmapped stock preserves quantity/tracking. A new blank-stock Variant is
untracked with null quantity. IMPORT_ROW references use importId:rowNumber.
Referenced imports can record a zero-delta audit even for an unchanged explicit
stock value; preview UNCHANGED does not promise no audit in that situation.

Categories resolve case-insensitively after whitespace normalization, scoped to
the Business. Validation/preview do not create them. Execution reuses or creates
the Category atomically with the group and assigns categoryId. Blank category
preserves the current string/relation. Import Category text and Category CRUD
display names may retain different formatting.

### 7.2 Analyze

Send one `.xlsx` file in the multipart field `file`, maximum 10 MiB. `.xls` and CSV
are unsupported. Optional multipart text field `sheetName` is 1–31 characters;
omit it to choose the first worksheet. Only one file and one text field are allowed.
Do not send headerRow. Header detection is heuristic within the first 50 rows;
clean up ambiguous title/header layouts and re-upload when necessary.

Retrofit request construction (read bytes/stream through Android's content resolver;
do not assume a document URI is a filesystem path):

```kotlin
@Multipart
@POST("businesses/{businessId}/imports/excel/analyze")
suspend fun analyze(
    @Path("businessId") businessId: String,
    @Part file: MultipartBody.Part,
    @Part("sheetName") sheetName: RequestBody? = null
): AnalyzeResponse
// MultipartBody.Part.createFormData("file", "products.xlsx", workbookRequestBody)
// Let OkHttp generate the multipart Content-Type boundary.
```

Response 201 for the two-row sheet:

```json
{
  "importJobId": "66666666-6666-4666-8666-666666666666",
  "status": "MAPPING_REQUIRED",
  "sheetNames": ["Products"],
  "selectedSheetName": "Products",
  "headerRow": 1,
  "headers": ["Product Code", "Name", "SKU", "Category", "Price", "Variant Price", "Quantity", "Color", "Size"],
  "sampleRows": [
    { "rowNumber": 2, "values": ["TEE-001", "Studio Tee", "IMPORT-RED-M", "Clothes", "125.00", "135.00", 8, "Red", "M"] },
    { "rowNumber": 3, "values": ["TEE-001", "Studio Tee", "IMPORT-BLUE-M", "Clothes", "125.00", null, 12, "Blue", "M"] }
  ],
  "totalRows": 2
}
```

Prices in this example are text cells; numeric Excel cells may be numbers in
sampleRows. Values can be strings, numbers, booleans or null. Sample rows include
at most five non-empty rows. Analyze counts non-empty mapped-width data rows;
validation counts physical rows including skipped blank rows, so totalRows can
change between stages. rowNumber is the worksheet's original one-based position.

### 7.3 Suggestions and confirmed mapping

GET mapping returns `{ importId, status, columns, mapping }`. For a workbook with
only Product Code, Name and arbitrary Configuration headers, an unconfirmed
response is:

```json
{
  "importId": "66666666-6666-4666-8666-666666666666",
  "status": "MAPPING_REQUIRED",
  "columns": [
    { "sourceColumn": "Product Code", "sourceColumnIndex": 1, "samples": ["TEE-001"], "suggestedType": "STANDARD", "suggestedTarget": "externalKey", "displayLabel": "Product Code (groups variants)" },
    { "sourceColumn": "Name", "sourceColumnIndex": 2, "samples": ["Studio Tee"], "suggestedType": "STANDARD", "suggestedTarget": "name", "displayLabel": "Product Name" },
    { "sourceColumn": "Configuration", "sourceColumnIndex": 3, "samples": ["Red", "Blue"], "suggestedType": "UNMAPPED", "suggestedTarget": null, "displayLabel": null }
  ],
  "mapping": null
}
```

That is an independent three-column illustration; the nine-column sheet returns
nine column objects using the same schema. Suggestions do not save mapping.
Unknown or ambiguous headers stay UNMAPPED. Always let the user confirm mappings.

| type | target |
| --- | --- |
| STANDARD | One of externalKey, name, sku, description, category, basePrice, unitPrice, stockQuantity |
| ATTRIBUTE | Safe product attribute key matching `^[a-z][a-z0-9_]{0,63}$` |
| VARIANT_ATTRIBUTE | Trimmed business-defined option name, 1–60 code units; e.g. color or Pack size |
| IGNORE / UNMAPPED | Explicit JSON null |

Do not map stockQuantity into ATTRIBUTE and expect stock writes. Do not map SKU
to externalKey for a configurable Product. Each standard target is mapped at most
once. Custom targets must be unique within their mapping type; reserved technical
keys are rejected. sourceColumn is the exact analyzed header. sourceColumnIndex
is one-based and is required to disambiguate duplicate or blank headers. With an
index, the header text must still match. Unspecified columns are stored UNMAPPED.

PATCH request for the nine-column sheet:

```json
{
  "mapping": [
    { "sourceColumn": "Product Code", "sourceColumnIndex": 1, "type": "STANDARD", "target": "externalKey" },
    { "sourceColumn": "Name", "sourceColumnIndex": 2, "type": "STANDARD", "target": "name" },
    { "sourceColumn": "SKU", "sourceColumnIndex": 3, "type": "STANDARD", "target": "sku" },
    { "sourceColumn": "Category", "sourceColumnIndex": 4, "type": "STANDARD", "target": "category" },
    { "sourceColumn": "Price", "sourceColumnIndex": 5, "type": "STANDARD", "target": "basePrice" },
    { "sourceColumn": "Variant Price", "sourceColumnIndex": 6, "type": "STANDARD", "target": "unitPrice" },
    { "sourceColumn": "Quantity", "sourceColumnIndex": 7, "type": "STANDARD", "target": "stockQuantity" },
    { "sourceColumn": "Color", "sourceColumnIndex": 8, "type": "VARIANT_ATTRIBUTE", "target": "color" },
    { "sourceColumn": "Size", "sourceColumnIndex": 9, "type": "VARIANT_ATTRIBUTE", "target": "size" }
  ]
}
```

Response 200 has exactly `importId`, `status: "MAPPING_REQUIRED"`, and `mapping`
containing the complete saved array above (including any filled UNMAPPED columns).
Both name and externalKey must be mapped. Mapping can be reconfirmed only while
MAPPING_REQUIRED. It becomes locked once validation starts. The mapping suggestion
GET also requires MAPPING_REQUIRED; do not use it after READY as a history reader.

### 7.4 Validate and read validation results

POST validate with no body or `{}`. Response 201:

```json
{
  "importId": "66666666-6666-4666-8666-666666666666",
  "status": "READY",
  "summary": { "totalRows": 2, "validRows": 2, "invalidRows": 0, "skippedRows": 0 }
}
```

READY means validation finished, not that every row is valid. No Product, Variant,
Category or inventory is written. Validation stores a results snapshot, checks
current scoped identities/reservations and merged attributes. It cannot reserve
the database against later edits. Revalidating the same job returns 409.

GET validation-results with `limit=1&offset=0` returns 200:

```json
{
  "importId": "66666666-6666-4666-8666-666666666666",
  "status": "READY",
  "summary": { "totalRows": 2, "validRows": 2, "invalidRows": 0, "skippedRows": 0 },
  "pagination": { "limit": 1, "offset": 0, "totalCount": 2, "hasMore": true, "nextOffset": 1 },
  "validRows": [{
    "rowNumber": 2,
    "data": {
      "externalKey": "TEE-001", "name": "Studio Tee", "sku": "IMPORT-RED-M",
      "category": "Clothes", "basePrice": "125.00", "unitPrice": "135.00", "stockQuantity": 8,
      "variantAttributes": { "color": "Red", "size": "M" },
      "options": { "color": ["Red", "Blue"], "size": ["M"] }
    }
  }],
  "invalidRows": []
}
```

Unmapped normalized fields can be **absent**, not null. A mapped blank standard
field becomes null. data.attributes/data.variantAttributes are present only when
mapped. Normalized options are group definitions, not the selected combination.
Numeric option cells become selected strings. Physical blank rows are skipped.

validRows and invalidRows share one page sorted by rowNumber. At most limit rows
are returned **across both arrays**, not per array. Summary counts cover the entire
workbook; totalCount excludes skipped rows. Results read the stored validation
snapshot; preview rebuilds current state, so the two may differ after DB edits.
Results are readable in READY, IMPORTING, COMPLETED, COMPLETED_WITH_ERRORS, FAILED
or CANCELLED when a valid snapshot exists. There is no cancel endpoint here.

### 7.5 Preview

GET preview is READY-only. It rebuilds workbook/database state, makes no writes and
is advisory. Initial preview for the nine-column sheet, `limit=1&offset=0`:

```json
{
  "importId": "66666666-6666-4666-8666-666666666666",
  "status": "READY",
  "summary": { "totalRows": 2, "validRows": 2, "invalidRows": 0, "skippedRows": 0, "willInsert": 2, "willUpdate": 0, "unchanged": 0 },
  "pagination": { "limit": 1, "offset": 0, "totalCount": 2, "hasMore": true, "nextOffset": 1 },
  "inserts": [{
    "rowNumber": 2, "externalKey": "TEE-001", "variantAttributes": { "color": "Red", "size": "M" },
    "action": "INSERT",
    "data": {
      "externalKey": "TEE-001", "name": "Studio Tee", "sku": "IMPORT-RED-M",
      "category": "Clothes", "basePrice": "125.00", "unitPrice": "135.00", "stockQuantity": 8,
      "variantAttributes": { "color": "Red", "size": "M" },
      "options": { "color": ["Red", "Blue"], "size": ["M"] }
    }
  }],
  "updates": [], "unchanged": [], "invalidRows": []
}
```

Actual action values are exactly **INSERT**, **UPDATE**, **UNCHANGED**. There is no
SKIP/CREATE action. INSERT means a new Variant row, possibly under an existing
Product; its preview does not guarantee a catalogItemId or variantId. Both IDs
are provided after execution. Runtime INSERT.data currently includes
variantAttributes even though an internal TypeScript type omits it; decode JSON
as actually returned and allow absent optional fields.

UPDATE rows have rowNumber, externalKey, optional variantAttributes, action,
catalogItemId, variantId and changes. UNCHANGED rows have the same identity fields
and action but no changes/data. Example rows from a subsequent preview:

```json
{
  "rowNumber": 2,
  "externalKey": "TEE-001",
  "variantAttributes": { "color": "Red", "size": "M" },
  "variantId": "99999999-9999-4999-8999-999999999999",
  "action": "UPDATE",
  "catalogItemId": "88888888-8888-4888-8888-888888888888",
  "changes": {
    "unitPrice": { "from": "135.00", "to": "140.00" },
    "categoryId": { "from": null, "to": { "create": "Seasonal Clothes" } }
  }
}
```

```json
{
  "rowNumber": 3,
  "externalKey": "TEE-001",
  "variantAttributes": { "color": "Blue", "size": "M" },
  "variantId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "action": "UNCHANGED",
  "catalogItemId": "88888888-8888-4888-8888-888888888888"
}
```

These are independent examples, not two rows claiming conflicting product metadata
in one workbook. The complete response wraps rows in the appropriate arrays and
uses the same summary/pagination envelope as the initial preview.

`changes` maps field names to `{ from, to }` with arbitrary JSON values. Examples:
price = string/null, stockQuantity = integer/null, attributes/options = objects.
For **categoryId** specifically:

| Position | Actual representation |
| --- | --- |
| from | Existing UUID string or null |
| to, existing matching Category | UUID string |
| to, Category to be created during execution | `{ "create": "Normalized category name" }` |

The `{create: name}` value is a proposal, never a persistent Category ID and never
a request body for Product PATCH. Re-read the Product after execution for its
actual UUID. Preview can repair a wrong categoryId even if legacy category text is
unchanged. Category creation/repair is not limited to legacy-string changes.

Counts describe Variant rows, not distinct Products: two INSERT rows in this
example create one Product and two Variants. Product metadata changes may be
reported on multiple rows. Pages combine inserts/updates/unchanged/invalidRows;
never sum only one page to derive the workbook-wide summary.

### 7.6 Execute

POST execute with no body or `{}`, READY-only; this is a synchronous operation.
Do not automatically retry after network timeout. Response 200 for the example:

```json
{
  "importId": "66666666-6666-4666-8666-666666666666",
  "status": "COMPLETED",
  "summary": {
    "totalRows": 2, "validRows": 2, "invalidRows": 0, "skippedRows": 0,
    "insertedCount": 2, "updatedCount": 0, "failedCount": 0, "unchangedCount": 0
  },
  "inserted": [
    { "rowNumber": 2, "externalKey": "TEE-001", "catalogItemId": "88888888-8888-4888-8888-888888888888", "variantId": "99999999-9999-4999-8999-999999999999" },
    { "rowNumber": 3, "externalKey": "TEE-001", "catalogItemId": "88888888-8888-4888-8888-888888888888", "variantId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
  ],
  "updated": [], "unchanged": [], "failedRows": [], "invalidRows": []
}
```

Executed rows have **no action field**; inserted/updated/unchanged array membership
conveys the result. updated and unchanged use the same four-field row shape.
Execution arrays are complete and **not paginated**. No complete Product/Variant
or generated categoryId is returned: use GET Product and GET Variants afterward.
The red Variant has stock 8/unitPrice 135.00; blue has stock 12/unitPrice null,
effectivePrice 125.00. Both share one new Product and category relationship.

Each Product group commits Category, Product, Variants, stock and audit together,
or rolls them all back. Other groups can succeed. Execution rechecks current data
under locks; preview is not a reservation. Definitely aborted serialization
conflicts receive bounded server retries; unknown commit outcomes are not replayed.

COMPLETED means no invalid/failed rows. COMPLETED_WITH_ERRORS can still be HTTP 200
and have successful rows: inspect both invalidRows and failedRows. Job/infrastructure
failures return 500 IMPORT_EXECUTION_FAILED and attempt to persist FAILED; earlier
groups may have committed. A 500/timeout is not proof that nothing happened.

### 7.7 Status, history and re-import

GET status returns this compact object (200):

```json
{
  "id": "66666666-6666-4666-8666-666666666666",
  "businessId": "11111111-1111-4111-8111-111111111112",
  "status": "COMPLETED",
  "fileName": "products.xlsx",
  "sheetName": "Products",
  "headerRow": 1,
  "totalRows": 2, "validRows": 2, "invalidRows": 0, "skippedRows": 0,
  "insertedCount": 2, "updatedCount": 0, "failedCount": 0,
  "createdAt": "2026-10-30T12:10:00.000Z",
  "updatedAt": "2026-10-30T12:11:00.000Z"
}
```

Note `id`, not importId. No unchangedCount, sourceType, mapping, fileKey, full row
errors or execution result arrays are exposed here. Sheet metadata can be nullable
for historical jobs. GET history returns `{ pagination, items }`, where each item
is exactly this status shape, not a row result.

UI states: MAPPING_REQUIRED → VALIDATING → READY → IMPORTING → COMPLETED or
COMPLETED_WITH_ERRORS; validation/execution failures can end FAILED. The enum also
contains UPLOADED and CANCELLED for existing/historical states; this workflow does
not expose upload-only or cancel/retry/resume endpoints. Poll GET status after
starting work or after losing the response. A crashed process can leave IMPORTING
with stale counters; there is no durable worker/takeover. Do not offer a button that
blindly resubmits execute or rewrites job state.

Completed/failed jobs cannot be executed again. A second execute returns 409.
Correct errors and **upload a new job**; run the full workflow again. Keep product
codes, option names/selected values and SKUs stable. Existing matching rows update
instead of duplicating Products/Variants. For metadata-only re-import, blank stock
cells or map stock IGNORE; otherwise explicit absolute quantities overwrite stock
changes made since the last upload. Unchanged metadata with blank stock leaves
Product/Variant timestamps untouched. There is no file-hash deduplication.

## 8. Errors and Android recovery

Standard non-2xx envelope:

```json
{ "statusCode": 409, "code": "VARIANT_SKU_CONFLICT", "message": "SKU is already assigned in this business", "error": "Conflict" }
```

The message text above is illustrative; branch on code/status, not prose. message
is either a string or array of strings (especially DTO validation):

```json
{ "statusCode": 400, "code": "VALIDATION_ERROR", "message": ["name must be a string"], "error": "Bad Request" }
```

| HTTP/code examples | Android handling |
| --- | --- |
| 400 VALIDATION_ERROR / VARIANT_OPTIONS_INVALID | Correct body, unknown fields, UUID/query or option selections |
| 401 UNAUTHORIZED / INVALID_CREDENTIALS / AUTH_REFRESH_INVALID | Single-flight refresh where appropriate, otherwise login; incorrect credentials are not a refresh trigger |
| 404 NOT_FOUND / BUSINESS_NOT_FOUND / CATEGORY_NOT_FOUND / PRODUCT_NOT_FOUND / VARIANT_NOT_FOUND | Resource missing, wrong parent or no active ownership; do not infer another tenant's existence |
| 409 CATEGORY_NAME_CONFLICT / CATEGORY_IN_USE | Refresh categories or choose a different name |
| 409 VARIANT_SKU_CONFLICT / VARIANT_OPTIONS_CONFLICT | Reservation exists, including inactive rows; offer reactivation/edit instead of duplicate creation |
| 409 PRODUCT_OPTIONS_IN_USE / PRODUCT_INACTIVE / PRODUCT_WRITE_CONFLICT | Refresh definitions/lifecycle and resolve conflict; do not silently delete variants |
| 409 INVENTORY_INACTIVE / INVENTORY_CONFLICT / INVENTORY_INSUFFICIENT_STOCK | Re-read stock/lifecycle; insufficient-stock order checks are internal, not a new Orders endpoint |
| 400 EXCEL_FILE_REQUIRED / EXCEL_FILE_UNSUPPORTED / EXCEL_FILE_INVALID / EXCEL_FILE_UNREADABLE / EXCEL_SHEET_NOT_FOUND | Correct upload/sheet and retry with a new file when necessary |
| 413 EXCEL_FILE_TOO_LARGE | Reject file above 10 MiB before upload |
| 409 IMPORT_NOT_AWAITING_MAPPING / IMPORT_MAPPING_CHANGED / IMPORT_NOT_AWAITING_VALIDATION / IMPORT_NOT_READY / IMPORT_EXECUTION_ALREADY_STARTED | Fetch status; do not blindly replay a write |
| 409 IMPORT_WORKBOOK_UNAVAILABLE / IMPORT_VALIDATION_RESULTS_UNAVAILABLE | Retained file/snapshot missing or obsolete; create a new job |
| 500 IMPORT_WORKBOOK_READ_FAILED / IMPORT_VALIDATION_FAILED / IMPORT_EXECUTION_FAILED | Inspect status; earlier groups may exist; surface safe error and avoid duplicate writes |
| 429 AUTH_RATE_LIMITED / 503 AUTH_RATE_LIMIT_UNAVAILABLE | Respect Retry-After; avoid parallel retry storms |

Mapping errors generally use MAPPING_* codes for missing name mappings,
unknown/ambiguous source columns, duplicate targets and invalid custom keys.
A missing externalKey mapping specifically returns 400 VALIDATION_ERROR, not a
MAPPING_* code. Treat 400 mapping failures as user-correctable. Unexpected failures
use sanitized 500
INTERNAL_SERVER_ERROR. Do not display SQL, stack traces or log credential payloads.

Row-level failures are **inside successful HTTP responses**, not this envelope.
An invalid row has exactly rowNumber and an errors array:

```json
{ "rowNumber": 3, "errors": [{ "field": "sku", "code": "DUPLICATE_SKU", "message": "SKU occurs more than once in this workbook" }] }
```

Relevant row codes include REQUIRED, TEXT_TOO_LONG, REQUIRED_OPTION, INVALID_DECIMAL,
INVALID_INTEGER, INVALID_OPTIONS, DUPLICATE_SKU, DUPLICATE_COMBINATION,
CONFLICTING_PRODUCT_ROWS, PRODUCT_GROUP_INVALID, PRODUCT_INACTIVE, VARIANT_INACTIVE,
SKU_RESERVED, OPTIONS_CONFLICT and MERGED_ATTRIBUTES_INVALID. Show rowNumber,
field and message; retain code for localization. A group can be rejected because
another row with the same Product code is invalid.

Runtime failedRows use a different shape:

```json
{ "rowNumber": 3, "code": "EXECUTION_CONFLICT", "message": "Product group conflicts with current data; no row in this group was applied" }
```

Other runtime group errors use ROW_EXECUTION_FAILED. validRows in the validation
summary are validation-passing rows; runtime failedRows are counted separately by
failedCount, so successful inserted/updated/unchanged may total less than validRows.
Persist the execute response if the UI needs detailed execution failures later:
compact status/history do not expose them, and validation-results is the earlier
snapshot rather than an execution-errors endpoint.

## 9. Kotlin DTO and serialization guidance

Use String for UUIDs and wire decimal amounts, Long for offsets/row counts, Int?
for quantities, and String or a configured Instant serializer for dates. Convert
decimal strings to BigDecimal for calculations/display; never use Float/Double
for prices. Inventory null must not default to 0. Keep server strings such as
status/error code forward-compatible rather than crashing on unknown enum values.

Illustrative kotlinx.serialization DTOs (imports are included; adapt package and
your existing date/Retrofit converter configuration):

```kotlin
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable
data class Pagination(
    val limit: Int, val offset: Long, val totalCount: Long,
    val hasMore: Boolean, val nextOffset: Long? = null
)
@Serializable
data class Page<T>(val pagination: Pagination, val items: List<T>)

@Serializable
data class VariantDto(
    val id: String, val businessId: String, val catalogItemId: String,
    val sku: String? = null,
    val optionValues: Map<String, String>,
    val unitPrice: String? = null, val effectivePrice: String? = null,
    val trackInventory: Boolean, val stockQuantity: Int? = null,
    val isActive: Boolean, val createdAt: String, val updatedAt: String
)
@Serializable
data class ProductDto(
    val id: String, val businessId: String, val name: String,
    val description: String? = null, val categoryId: String? = null,
    val externalKey: String? = null, val category: String? = null,
    val basePrice: String? = null,
    val options: Map<String, List<String>>,
    val attributes: JsonObject? = null,
    val isActive: Boolean, val createdAt: String, val updatedAt: String,
    val isSellable: Boolean, val variants: List<VariantDto>,
    val variantsPagination: Pagination
)
@Serializable
data class FieldChange(val from: JsonElement, val to: JsonElement)
@Serializable
data class PreviewRow(
    val rowNumber: Long, val externalKey: String? = null, val action: String,
    val catalogItemId: String? = null, val variantId: String? = null,
    val variantAttributes: JsonObject? = null,
    val data: JsonObject? = null,
    val changes: Map<String, FieldChange>? = null
)
@Serializable
data class ExecutedRow(
    val rowNumber: Long, val externalKey: String? = null,
    val catalogItemId: String, val variantId: String
)
@Serializable
data class RowError(val field: String, val code: String, val message: String)
@Serializable
data class InvalidRow(val rowNumber: Long, val errors: List<RowError>)
@Serializable
data class FailedRow(val rowNumber: Long, val code: String, val message: String)
@Serializable
data class ApiError(
    val statusCode: Int, val code: String,
    val message: JsonElement, val error: String
)

val responseJson = Json { ignoreUnknownKeys = true }

// Never decode categoryId changes as String alone.
fun categoryTarget(change: FieldChange): Pair<String?, String?> = when (val v = change.to) {
    is JsonObject -> null to v["create"]?.jsonPrimitive?.contentOrNull
    is JsonPrimitive -> v.contentOrNull to null
    else -> null to null
}
```

Use JsonElement for arbitrary attributes, Excel sample values, normalized-row
objects and change values. A category relation on ProductDto is String?, whereas
a preview category change is JsonElement. Do not reuse one DTO for both.
Create separate wrappers matching every endpoint's arrays and summary; there is
no universal `{ data: ... }` envelope. Analyze uses importJobId; processing uses
importId; compact job status uses id. Do not conflate these response models.

PATCH requires distinguishing omission from explicit null. Avoid serializing a
nullable request DTO with every field defaulting to null. Build a JsonObject or
use a field-presence wrapper/custom serializer so untouched fields are omitted.
For example, this explicitly clears Variant price inheritance override only:

```kotlin
val restoreInheritedPrice = buildJsonObject { put("unitPrice", JsonNull) }
val mappingIgnore = buildJsonObject {
    put("sourceColumn", "Notes")
    put("sourceColumnIndex", 10)
    put("type", "IGNORE")
    put("target", JsonNull) // Required null, not an omitted property.
}
```

Do not double-quote JsonNull or send decimal values as numeric JsonPrimitive.
For 204 endpoints use Retrofit Response<Unit>/Unit handling; do not deserialize
a JSON object. For multipart, let the client set the boundary. Keep upload/execute
requests out of generic automatic retry interceptors. Response decoding may ignore
unknown fields; request encoding must still whitelist supported fields.

## 10. Breaking changes and Android migration checklist

- [ ] Remove Product/Catalog stockQuantity and trackInventory read/write assumptions.
  Read quantity/tracking from each Variant, including the `{}` Default Variant.
- [ ] Replace removed `/businesses/:businessId/catalog-items/:catalogItemId/inventory/adjust`
  and `/inventory/movements` item routes with the nested Product/Variant routes.
  There is no compatibility alias; old item routes return 404.
- [ ] Update movement DTOs: variantId, trackingBefore/After, requestedQuantity;
  quantityAfter is now nullable. Delta may be 0 even for an audited transition.
- [ ] Render dynamic option names/values; do not hardcode color/size. Handle empty
  configured Variant lists and paginate beyond embedded Product variants.
- [ ] Treat stock edits as absolute sets. Never calculate order deductions by
  calling manual adjustment from Android; Orders requires server transactions.
- [ ] Separate Product code (externalKey) from Variant SKU in import mapping/UI.
  Allow repeated Product codes and reject duplicate combinations instead.
- [ ] Require product name/code mappings, and SKU/all options on configurable rows.
  Show Product-group errors together; prevent a “READY means all valid” assumption.
- [ ] Decode preview action values and dynamic changes, including `{create: name}`;
  do not use that object as a Category UUID.
- [ ] Keep preview and executed-row DTOs separate. Count Variant rows, not Products.
- [ ] Use one combined pagination offset for row arrays; summary is workbook-wide.
- [ ] Preserve blank-stock semantics. Explicit 0 enables tracked zero stock;
  blank does not mean zero, deletion, or disabling tracking.
- [ ] Use a new job for corrected/repeated imports. Reuse stable identities and
  investigate status after timeouts instead of replaying execute.
- [ ] Replace pre-upgrade jobs/mappings as necessary. Old validation snapshot
  version 1 returns 409 IMPORT_VALIDATION_RESULTS_UNAVAILABLE; it is not converted.
- [ ] Apply Bearer/Business selection to every resource call; single-flight refresh;
  clear account-specific caches and selected business when logging out.
- [ ] Disable token/body/reset-link logging; configure App Links below.

Legacy `/catalog-items` metadata CRUD still exists but is not interchangeable
with Product CRUD response models: it returns raw metadata, no embedded Variant
page/effectivePrice/isSellable, and its Decimal serialization may omit trailing
zeros. New Catalog creates now create a Default Variant. Prefer the Product API
for the Android product screens described here.

## 11. Android App Links and password reset

Implemented public association endpoint:

```http
GET /.well-known/assetlinks.json
```

HTTP 200, Content-Type application/json, no Bearer requirement and no redirect:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.yasminhosam.brandora",
      "sha256_cert_fingerprints": ["51:F3:C3:2A:04:7C:8B:34:0B:24:28:DE:8F:80:6F:1F:31:96:EC:AB:93:04:FF:B6:C2:DE:E6:4B:73:56:08:2E"]
    }
  }
]
```

Intended owner-configured runtime reset setting, not changed by this guide:

```dotenv
AUTH_RESET_URL=https://brandora-backend-production-85ec.up.railway.app/auth/reset-password
```

Android applicationId/package: `com.yasminhosam.brandora`. Add the following filter
to the exported Activity that handles reset links:

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https"
          android:host="brandora-backend-production-85ec.up.railway.app"
          android:path="/auth/reset-password" />
</intent-filter>
```

The association currently contains only the supplied **debug** certificate. The
installed APK must match it. Release/Play signing requires a separately approved
fingerprint update. Debug keystores on different machines may differ. Domain
verification is a device/deployment step, not proven by local backend tests.

POST `/auth/forgot-password` request `{ "email": "owner@example.com" }`, response
200 when configured, equally for known/unknown email:

```json
{ "message": "If the account exists, a password reset has been requested. Check your email; delivery may be delayed or unavailable." }
```

This does not confirm delivery. Disabled/unconfigured email returns 503
AUTH_EMAIL_UNAVAILABLE without revealing account existence. SMTP delivery requires
separate approved runtime settings; hosting assetlinks.json alone does not enable it.

Mailer links append a fragment, not a query:

```text
https://brandora-backend-production-85ec.up.railway.app/auth/reset-password#token=<opaque-reset-token>
```

Handle the Activity's initial Intent and any onNewIntent delivery. Validate HTTPS,
the exact host and exact `/auth/reset-password` path before extracting the fragment.
Illustrative extraction without logging:

```kotlin
fun extractResetToken(uri: android.net.Uri): String? {
    if (uri.scheme != "https" ||
        uri.host != "brandora-backend-production-85ec.up.railway.app" ||
        uri.path != "/auth/reset-password") return null
    val fragment = uri.encodedFragment ?: return null
    val entries = fragment.split('&').map { it.split('=', limit = 2) }
        .filter { android.net.Uri.decode(it[0]) == "token" }
    if (entries.size != 1) return null
    return entries.single().getOrNull(1)?.let(android.net.Uri::decode)
        ?.takeIf { it.isNotBlank() }
}
```

The fragment is parsed locally, with no navigation or network request. It never
reaches normal HTTP access logs.
Do not copy it into a query string, WebView analytics, crash reports, external
redirects or HTTP logs. Keep it transiently in memory and clear after completion.

POST `/auth/reset-password` body:

```json
{ "token": "<opaque-reset-token-from-fragment>", "newPassword": "NewSecurePassword123!" }
```

204 empty means success: single-use token consumed, password changed, existing
sessions revoked. Clear credentials and require login with the new password.
Reset tokens expire after 15 minutes; a newer request supersedes the previous
token. Invalid/expired/consumed tokens return 400 AUTH_RESET_INVALID; malformed
token/password input can return 400 VALIDATION_ERROR. Keep POST reset behavior
separate from Android's GET link opening: **no browser reset UI or GET reset-password
handler is implemented**. Without an installed verified app there is no web fallback.

After approved deployment and installation, Android 12+ verification commands:

```sh
adb shell pm verify-app-links --re-verify com.yasminhosam.brandora
adb shell pm get-app-links com.yasminhosam.brandora
adb shell am start -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "https://brandora-backend-production-85ec.up.railway.app/auth/reset-password#token=dummy"
```

Allow time for verification and confirm the host is verified. Use a dummy token in
shell history; real reset links must be opened privately from approved test email.

## 12. Implemented versus deferred, and integration decisions

| Area | Implemented now | Not provided / requires separate approval |
| --- | --- | --- |
| Products/Categories/Variants | Scoped CRUD, dynamic options, soft lifecycle, default creation | Automatic simple/configurable conversion or Variant purge |
| Inventory | Variant stock, audited atomic manual/import writes, internal idempotent Orders interface | Android order creation, public deduction/reservation endpoints |
| Import | Complete synchronous workflow, stable identities, per-group rollback, read pagination | Durable queue, resumable execution, file-hash dedup, select-existing-Product mapping |
| Storage | Existing local file/snapshot storage | Persistent Railway volume/object storage; deliberately postponed |
| Auth | Multi-business ownership, sessions/refresh/reset and shared DB limiter | Railway ingress/client-IP problem is not solved by App Links |
| App Links | Public association JSON and existing POST reset | Deployment verification, release certificate, browser fallback and SMTP setup |

Contract details that Android must handle explicitly, rather than guessing:

1. Manual Products have no writable externalKey in Product CRUD; matching them to
   a new imported code is not an implemented workflow. Agree on creation/import
   ownership of a catalog before mixing these flows.
2. Snapshot validation and current preview can differ. READY includes invalid
   groups; preview can exclude additional groups after concurrent edits.
3. Preview INSERT means Variant insertion and may lack Product/Variant IDs. The
   categoryId change target is a UUID-or-create-object union. Generated Category
   IDs and execution failure details are not included in compact job history.
4. Analyze and validation count different row sets; summary numbers are not all
   distinct Product counts. Status lacks unchangedCount, unlike execute.
5. Price inheritance can be cleared with Variant PATCH null, but blank import
   prices preserve old overrides. Import category strings do not behave like a
   Product PATCH categoryId=null.
6. No browser fallback, crash-resume API, mixed simple/configurable workbook mode,
   or durable import storage is promised. These are limitations, not hidden endpoints.

Release coordination must apply the variant-only database migration before this
application version, with an approved maintenance/recovery plan. Existing legacy
inventory can block the migration even when considered disposable; that is an
owner deployment operation, never an Android “reset database” action.

## 13. Source references

This standalone guide is derived from the local committed controllers, DTOs and
response construction, especially:

- `src/products/product-presenter.ts`, `src/products/dto/product.dto.ts`,
  `src/categories/categories.controller.ts`, `src/variants/dto/variant.dto.ts`.
- `src/inventory/inventory.controller.ts`, `src/inventory/inventory.service.ts`.
- `src/imports/imports.controller.ts`, `imports.service.ts`, `mapping.service.ts`,
  `validation.service.ts`, `preview.service.ts`, `preview/import-planner.ts`,
  `variant-import-policy.ts`, `execution.service.ts`, and their DTOs.
- `src/auth/auth.guard.ts`, `auth.controller.ts`, `auth-sessions.service.ts`,
  `password-reset.mailer.ts`, `src/app-links.controller.ts`.
- Committed `docs/products-api.md`, `docs/inventory-api.md`, `docs/imports-api.md`,
  `docs/auth-api.md`, `docs/android-app-links.md`, and `docs/variant-inventory-rollout.md`.

No live deployment, database or Android device was accessed to author this guide.
