# Orders API

**State:** ready on a local backend; not deployed. Owner token required on every
route (`@AuthScope('params')`); another owner's business or order is 404.

## Why the owner creates the order (for now)

The AI service is read-only today: Malak's `/v2/ai/respond` always returns
`orderCandidate: null`, and `src/ai` rejects any candidate. So the flow is:

```text
customer writes -> AI answers (intent PURCHASE_INTENT -> owner is notified)
 -> owner opens the chat and makes the order from that customer message
 -> PENDING_APPROVAL -> approve (stock is taken) or reject -> customer is told on WhatsApp
```

The body is the E0-3 order candidate without its AI-only fields, so when the AI
may send candidates later the same `OrdersService.create` validates them.

## Lifecycle

| Status             | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `PENDING_APPROVAL` | Made; stock not taken yet                                        |
| `IN_PROGRESS`      | Approved; stock taken in the same transaction (InventoryService) |
| `COMPLETED`        | Delivered (after Phase 1)                                        |
| `CANCELLED`        | Rejected before approval (cancel after approval: after Phase 1)  |

`requiresReview` + `reviewReason` (`LOW_STOCK`) are warnings, not statuses.

## Routes

| Method | Path                                                    | Body                                        |
| ------ | ------------------------------------------------------- | ------------------------------------------- |
| POST   | `/businesses/:businessId/orders`                        | `{ sourceMessageId, items[], notes? }`      |
| GET    | `/businesses/:businessId/orders?status=&limit=&offset=` | –                                           |
| GET    | `/businesses/:businessId/orders/:orderId`               | –                                           |
| POST   | `/businesses/:businessId/orders/:orderId/approve`       | –                                           |
| POST   | `/businesses/:businessId/orders/:orderId/reject`        | `{ "reason"? }` (max 500, sent to customer) |

Create body: `sourceMessageId` is a CUSTOMER message of this business; `items`
1-50 lines of `{ productId, variantId, quantity 1-100 }`, each variant once.
Names, options and prices are copied from the database (snapshot). **201** =
made now, **200** = this message already has an order (the same order is
returned, so a double tap is safe).

```json
{
  "id": "6f1c…",
  "status": "PENDING_APPROVAL",
  "currency": "EGP",
  "subtotal": "500.00",
  "total": "500.00",
  "requiresReview": false,
  "reviewReason": null,
  "customer": { "id": "…", "phone": "201000000001", "name": "Mona" },
  "items": [
    {
      "productName": "تيشيرت كحلي",
      "selectedOptions": {},
      "unitPrice": "250.00",
      "quantity": 2,
      "lineTotal": "500.00"
    }
  ]
}
```

Approve and reject answer the order plus `customerNotification`: `SENT`,
`PENDING` (Meta was busy; it is tried again within about 3 minutes) or `FAILED`
(Meta refused, for example after the 24-hour window). The decision is never
undone because of the message.

Errors: `400 VALIDATION_ERROR`, `404 MESSAGE_NOT_FOUND`, `404 PRODUCT_NOT_FOUND`,
`404 VARIANT_NOT_FOUND`, `404 ORDER_NOT_FOUND`, `409 ORDER_ITEM_UNAVAILABLE`,
`409 ORDER_NOT_PENDING`, `409 INVENTORY_INSUFFICIENT_STOCK` (approve: nothing
changes, the order stays pending), `409 INVENTORY_INACTIVE`.

## Tests

`npm run test:whatsapp:postgres` tests 11-13: database prices, one order per
message, LOW_STOCK, other owner 404, two approvals at once (one 200, one 409,
stock taken once), all-or-nothing approve, reject with reason, confirmation text.
