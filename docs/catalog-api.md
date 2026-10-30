# Catalog Item CRUD (SCRUM-28 / API documentation SCRUM-16)

All endpoints scope data by businessId. Item endpoints also require catalogItemId
as a UUID. Task 3 requires a Bearer token and current active OWNER membership;
see [Authentication](auth-api.md). Business text is preserved in its original
language; surrounding name and externalKey whitespace is trimmed. Blank externalKey
strings become null, including on PATCH to clear an existing key.

## Fields and common success response

Create requires businessId (UUID) and name (string, trimmed, 1–200 characters).
PATCH requires businessId and at least one editable field. Both accept:

| Editable field | Validation / null behavior                                                               |
| -------------- | ---------------------------------------------------------------------------------------- |
| externalKey    | Optional trimmed string, max 200; nullable; blank strings become null                    |
| name           | Required on Create, optional on PATCH; never null/blank, max 200 after trimming          |
| description    | Optional string, max 5,000; nullable                                                     |
| category       | Optional string, max 200; nullable                                                       |
| basePrice      | Optional non-negative decimal string, max 10 integer digits / 2 decimal places; nullable |
| attributes     | Optional plain JSON object at the root; nullable; nested JSON is allowed                 |
| isActive       | Optional boolean; never null; Create defaults to true                                    |

stockQuantity, trackInventory, id, createdAt, updatedAt, and unknown fields are
rejected. Metadata besides name and externalKey is not automatically trimmed. Prices remain
Decimal in storage and serialize as strings, potentially omitting trailing
zeros. New items atomically create one Default Variant with null stock and
tracking disabled. Stock fields are removed from CatalogItem responses; use
Products/Variants to read inventory and the [variant inventory API](inventory-api.md)
to change it. Existing legacy rows without variants are not backfilled.

Create returns HTTP 201. Get One, PATCH, and DELETE return HTTP 200 with the same
full record shape; List returns an array of these records, without count metadata.
Relations such as inventoryMovements are not included automatically.

```json
{
  "id": "b2621a53-0797-4b1d-84f9-5f9a41697f5c",
  "businessId": "f6bc7287-3285-4e19-a819-459c41f0a138",
  "externalKey": "COFFEE-001",
  "name": "Coffee",
  "description": "Freshly roasted coffee",
  "category": "Drinks",
  "categoryId": null,
  "options": {},
  "basePrice": "49.9",
  "attributes": { "origin": "Egypt" },
  "isActive": true,
  "createdAt": "2026-10-08T10:00:00.000Z",
  "updatedAt": "2026-10-08T10:00:00.000Z"
}
```

## Create

`POST /catalog-items`

```json
{
  "businessId": "f6bc7287-3285-4e19-a819-459c41f0a138",
  "externalKey": "COFFEE-001",
  "name": "Coffee",
  "description": "Freshly roasted coffee",
  "category": "Drinks",
  "basePrice": "49.90",
  "attributes": { "origin": "Egypt" },
  "isActive": true
}
```

Success: 201 with the record above. Errors: 400 VALIDATION_ERROR, 400
CATALOG_ATTRIBUTES_INVALID, 404 BUSINESS_NOT_FOUND, 409
CATALOG_EXTERNAL_KEY_CONFLICT. Uniqueness is enforced by the database for
(businessId, externalKey); different businesses may reuse a key and multiple
null keys are allowed. Inactive rows still retain their unique keys.

## List

```text
GET /catalog-items?businessId=f6bc7287-3285-4e19-a819-459c41f0a138&limit=20&offset=0
```

Success: 200 array of records in the common shape. Active and inactive items
remain visible, ordered by createdAt DESC then id DESC. businessId is required;
limit is an integer 1–100 (default 20); offset is an integer 0–1,000,000 (default
0). An unknown business or empty catalog returns `[]`. There is no search or
active-state filtering. Errors: 400 VALIDATION_ERROR for invalid/unknown query
parameters.

## Get One

```text
GET /catalog-items/b2621a53-0797-4b1d-84f9-5f9a41697f5c?businessId=f6bc7287-3285-4e19-a819-459c41f0a138
```

Success: 200 with the common record shape, including inactive items. Errors:
400 VALIDATION_ERROR, 404 CATALOG_ITEM_NOT_FOUND. A missing item and an item in
another business both return `Catalog item not found` without disclosing
cross-business existence.

## PATCH

`PATCH /catalog-items/b2621a53-0797-4b1d-84f9-5f9a41697f5c`

```json
{
  "businessId": "f6bc7287-3285-4e19-a819-459c41f0a138",
  "name": "Premium Coffee",
  "description": null,
  "basePrice": "59.90",
  "attributes": { "roast": "dark" }
}
```

Success: 200 full updated record. Compared with the common example, name is
Premium Coffee, description is null, basePrice is `59.9`, attributes contains
only `{"roast":"dark"}`, and updatedAt advances. Other values are preserved.

Omitted fields preserve their current values. Explicit null clears externalKey,
description, category, basePrice, or attributes. attributes=null uses SQL NULL;
attributes={} replaces the old object with an empty object. Non-null attributes
**replace** the entire object; they do not merge. Supplying only businessId
returns 400 VALIDATION_ERROR. name and isActive cannot be null. Updates include
both item ID and business ID in the atomic database mutation.

Reactivation uses the same endpoint, with no separate route:

```json
{
  "businessId": "f6bc7287-3285-4e19-a819-459c41f0a138",
  "isActive": true
}
```

Errors: 400 VALIDATION_ERROR, 400 CATALOG_ATTRIBUTES_INVALID, 404
CATALOG_ITEM_NOT_FOUND, 409 CATALOG_EXTERNAL_KEY_CONFLICT.

## Soft DELETE

```text
DELETE /catalog-items/b2621a53-0797-4b1d-84f9-5f9a41697f5c?businessId=f6bc7287-3285-4e19-a819-459c41f0a138
```

Success: 200 full record with isActive=false. The row is retained and repeated
DELETE succeeds with the same inactive state; updatedAt may advance. Stock,
tracking, and InventoryMovement history remain unchanged. Errors: 400
VALIDATION_ERROR, 404 CATALOG_ITEM_NOT_FOUND.

## Error envelope and integration boundaries

```json
{
  "statusCode": 409,
  "code": "CATALOG_EXTERNAL_KEY_CONFLICT",
  "message": "A catalog item with this external key already exists in this business",
  "error": "Conflict"
}
```

Prisma P2002 maps to the safe duplicate-key 409; P2025 maps to item-not-found;
P2003 maps to BUSINESS_NOT_FOUND. Unexpected failures use the existing sanitized
500 INTERNAL_SERVER_ERROR envelope. DTO errors retain useful message arrays.

Catalog never changes stock or tracking and creates/deletes no inventory
movements. Stock mutation stays with InventoryService; see [Inventory API](inventory-api.md).
CatalogModule
does not import InventoryModule. Deactivation preserves audit links and the SKU.

Excel remains separate: it matches (businessId, externalKey), may update inactive
items without reactivating them, preserves fields for mapped blanks, and merges
non-blank attributes. Direct PATCH null intentionally clears nullable fields and
PATCH attributes intentionally replace the object. Changing a key affects future
Excel identity matching; concurrent conflicts remain governed by database
constraints and Excel's existing row transactions.
