# Variant Inventory API

Inventory belongs only to ProductVariant. CatalogItem is product metadata and no
longer has `stockQuantity` or `trackInventory`. Every simple product created by
Products or Catalog has a Default Variant with `optionValues: {}`. Resolve its
UUID through Products/Variants; do not send a product UUID as a variant UUID.
Configurable products have separate inventory for each valid selection.

Every route requires a Bearer JWT and current active OWNER membership for the
path business. All IDs are validated UUIDs, and the variant must belong to that
product and business. Missing/foreign variants return 404 `VARIANT_NOT_FOUND`;
foreign business ownership is rejected by the global guard before the service.
Error bodies remain `{ statusCode, code, error, message }`.

## Set stock or tracking

`POST /businesses/:businessId/products/:catalogItemId/variants/:variantId/inventory/adjust`

```json
{ "quantity": 15 }
```

Sets the absolute quantity to 15 and enables tracking. `quantity` is a required
JSON integer from 0 through 2147483647. Numeric strings, null, fractional and
negative values are invalid when tracking is enabled. Optional `trackInventory`
is boolean and defaults true. Unknown fields are rejected. Clients cannot choose
movement type, reference, delta, business identity or order credentials.

To explicitly disable tracking:

```json
{ "quantity": null, "trackInventory": false }
```

This clears the tracked quantity with an audit; the previous quantity remains in
history. It conflicts while an order deduction remains unrestored. An inactive
product or variant returns 409 `INVENTORY_INACTIVE`; reactivate it first. Reads
and order restorations remain possible after soft deletion.

Success is 201:

```json
{
  "changed": true,
  "quantityBefore": 10,
  "quantityAfter": 15,
  "quantityDelta": 5,
  "movementId": "f6bc7287-3285-4e19-a819-459c41f0a138"
}
```

Before/after are nullable for untracked states. Delta uses zero for a null
baseline. A first null-to-zero initialization is audited even with delta 0.
An identical manual quantity and tracking state returns `changed: false`,
delta 0, and `movementId: null`, without another write.

InventoryService locks the scoped parent product, reads the current variant,
updates stock, and creates a `MANUAL_ADJUSTMENT` movement in one transaction.
Competing stock/lifecycle writes serialize on this lock. Audit failure rolls
back stock. Database CHECKs enforce nonnegative tracked stock and audit arithmetic.

## Variant history

`GET /businesses/:businessId/products/:catalogItemId/variants/:variantId/inventory/movements?limit=20&offset=0`

## Business history

`GET /businesses/:businessId/inventory/movements?limit=20&offset=0`

Both return 200 and `{ pagination, items }`. Pagination retains `limit`,
`offset`, `totalCount`, `hasMore`, `nextOffset`. Limit defaults 20, range 1–100;
offset is a nonnegative safe integer. Unknown query parameters are rejected.
Items are ordered by createdAt descending, then id descending. Count and page
are read in one repeatable-read snapshot. Inactive records retain history.

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
      "variantId": "9b7851f1-15ac-4ca3-a705-97e723825336",
      "type": "MANUAL_ADJUSTMENT",
      "quantityBefore": null,
      "quantityAfter": 15,
      "quantityDelta": 15,
      "trackingBefore": false,
      "trackingAfter": true,
      "requestedQuantity": null,
      "referenceType": null,
      "referenceId": null,
      "createdAt": "2026-10-29T10:00:00.000Z"
    }
  ]
}
```

Supported types are INITIAL_IMPORT, IMPORT_UPDATE, MANUAL_ADJUSTMENT,
ORDER_APPROVED, ORDER_CANCELLED. Order types are internal transaction methods,
not public stock-setting inputs. See the [Orders interface and rollout gate](variant-inventory-rollout.md).

## Android breaking changes

The two `/catalog-items/:catalogItemId/inventory/...` endpoints are removed and
return 404; there is no product-level stock compatibility alias. Use the new
product/variant path and retain both IDs. Read stock from variants only. Movement
items add variantId, trackingBefore, trackingAfter and requestedQuantity;
quantityAfter is now nullable. Update Kotlin response models accordingly.

Quantity errors return 400 `INVENTORY_QUANTITY_INVALID` internally or
`VALIDATION_ERROR` at the DTO boundary. Inactive writes, reference reuse,
outstanding tracking changes and insufficient order stock return 409 with
`INVENTORY_INACTIVE`, `INVENTORY_CONFLICT`, or `INVENTORY_INSUFFICIENT_STOCK`.
No API here implements Orders or deletes inventory history.
