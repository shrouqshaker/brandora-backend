# Inventory API (SCRUM-30)

Inventory supports absolute quantity adjustment and read-only movement history.
All path parameters are UUIDs. Business scoping filters data; authentication is
not implemented in this milestone. Catalog CRUD still rejects stock writes.

## Manual adjustment

`POST /businesses/:businessId/catalog-items/:catalogItemId/inventory/adjust`

Body (JSON):

```json
{ "quantity": 15 }
```

quantity is required and must be a JSON number, integer 0..2147483647. Zero is
valid. Numeric strings, negative/fractional/null values, missing quantity, and
unknown fields are rejected. There is no reason/note field in the existing
schema and none is added for this MVP; do not send reason or note. Clients cannot
choose movement type, references, business identity in the body, or tracking state.

Success: 201 with the existing QuantityChangeResult:

```json
{
  "changed": true,
  "quantityBefore": 10,
  "quantityAfter": 15,
  "quantityDelta": 5,
  "movementId": "f6bc7287-3285-4e19-a819-459c41f0a138"
}
```

This sets quantity to 15, rather than adding 15. The controller calls
InventoryService.setQuantity with MANUAL_ADJUSTMENT and no reference. It does not
perform its own stock mutation. The service reads the current scoped quantity,
conditionally updates it if it has not changed, and creates InventoryMovement
within one Prisma transaction. Failure of either write rolls back both.

Unchanged quantity is a successful no-op, also 201:

```json
{
  "changed": false,
  "quantityBefore": 15,
  "quantityAfter": 15,
  "quantityDelta": 0,
  "movementId": null
}
```

Unknown initial stock is null. Delta uses zero as its baseline, retaining null
in quantityBefore. null -> 0 creates a movement with delta=0; known 0 -> 0 does
not create a movement. A decrease may have a negative delta, but target stock
cannot be negative. These are application invariants; the current database schema
has no non-negative CHECK constraint. No schema change is introduced here.

Manual adjustment changes quantity only. It preserves trackInventory/isActive,
including for untracked/inactive items. It does not enable tracking, reactivate
items, or alter catalog metadata. Excel still enables tracking when it supplies
non-null stock and routes stock through InventoryService with INITIAL_IMPORT or
IMPORT_UPDATE. Unmapped/blank Excel stock still leaves quantity/tracking unchanged.

## Item movement history

`GET /businesses/:businessId/catalog-items/:catalogItemId/inventory/movements?limit=20&offset=0`

The item must belong to the path business. Missing items and items in another
business both return 404 CATALOG_ITEM_NOT_FOUND. Inactive items remain readable.

Success: 200:

```json
{
  "pagination": {
    "limit": 20,
    "offset": 0,
    "totalCount": 1,
    "hasMore": false,
    "nextOffset": null
  },
  "items": [
    {
      "id": "f6bc7287-3285-4e19-a819-459c41f0a138",
      "catalogItemId": "b2621a53-0797-4b1d-84f9-5f9a41697f5c",
      "type": "MANUAL_ADJUSTMENT",
      "quantityBefore": 10,
      "quantityAfter": 15,
      "quantityDelta": 5,
      "referenceType": null,
      "referenceId": null,
      "createdAt": "2026-10-09T10:00:00.000Z"
    }
  ]
}
```

These are the actual model field names. No previousQuantity/newQuantity aliases,
reason/note, embedded catalog data, or storage details are invented. References
are nullable opaque audit source type/ID strings; Excel uses IMPORT_JOB and its
import ID. All movement types are listed, not only manual adjustments.

## Business movement history

`GET /businesses/:businessId/inventory/movements?limit=20&offset=0`

Returns the same envelope and movement fields across all items in that business.
The database count and page query are business-scoped. Missing business returns
404 BUSINESS_NOT_FOUND. This uses the existing schema/indexes; no denormalization
or model change is needed.

## Pagination

Both history endpoints share the same helper/validation as Import pagination:

- limit defaults to 20 and must be an integer 1..100.
- offset defaults to 0 and must be a non-negative safe integer, at most 9007199254740991.
- Unknown query parameters are rejected.
- totalCount comes from Prisma count across the full scoped history; the page
  query fetches only limit records using skip/take.
- Ordering is createdAt DESC, then id DESC for equal timestamps.
- hasMore is true when rows remain beyond the requested page; nextOffset is
  offset+limit when true, otherwise null.
- Empty history and out-of-range pages return empty items with the global count.

An existing business/item with no movements returns:

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

For 45 movements with limit=20, offsets 0/20/40 return 20/20/5 objects;
nextOffset is 20/40/null. Offset 100 returns no objects, totalCount=45,
hasMore=false and nextOffset=null. History is live rather than a locked snapshot;
new movements can shift offset pages between requests.

## Errors and Postman

Errors use the existing statusCode/code/message/error envelope. No Inventory
error code is added in this milestone:

| HTTP | Code                   | Meaning                                                    |
| ---- | ---------------------- | ---------------------------------------------------------- |
| 400  | VALIDATION_ERROR       | Invalid DTO, UUID, or history query                        |
| 404  | CATALOG_ITEM_NOT_FOUND | Missing/cross-business item                                |
| 404  | BUSINESS_NOT_FOUND     | Missing business for business-wide history                 |
| 409  | INVENTORY_CONFLICT     | Quantity changed before the conditional stock write        |
| 500  | INTERNAL_SERVER_ERROR  | Unexpected database/audit failure; internal details hidden |

If adjustment conflicts, refresh current catalog quantity before deciding whether
to retry an absolute target; there is no automatic retry or client-supplied stock
version. Existing internal InventoryService validation codes remain unchanged.

In Postman, start the backend, use existing Business/CatalogItem UUIDs, and POST
to the adjustment URL with Body -> raw -> JSON and the quantity payload. Expect
201, then GET the item/business movement URLs to inspect the audit. POST the same
quantity again and confirm changed=false with no additional movement. Use query
limit/offset to browse pages. All writes remain through InventoryService; Orders,
tracking toggles, images, variants, and stock reservation workflows are outside
this milestone.
