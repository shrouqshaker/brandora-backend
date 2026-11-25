# Business and domain rules

All owner-facing operations require the current authenticated membership and
scope described in [authentication](authentication.md). These are implemented
Backend rules, not evidence of deployed configuration, Android UI or provider
acceptance. Detailed [API contracts](api-guide.md#detailed-api-contracts) remain
available until Swagger replacement is verified.

## Businesses and categories

Business creation atomically creates default settings and the creator's OWNER
membership. Profile.category is a free-text business description, separate from
the product Category model. Settings are preferences; accepting online payment
does not implement a payment gateway, delivery service or reservation system.
Missing settings read as defaults without a write.

Working-hours updates require exactly seven distinct weekdays in one
transaction. Open days require HH:mm opening/closing times with closing later
on the same day. Closed times are null/omitted. Reads preserve stored schedules;
no timezone conversion, overnight period or holiday calendar is implemented.

Categories are business-scoped. CRUD trims names for storage, preserving internal
whitespace and case. Uniqueness compares whitespace-normalized names
case-insensitively; owner text is not translated. A referenced
Category cannot be deleted (CATEGORY_IN_USE). Creation/listing reuse the exported
ProductAccessService without changing authorization or transaction boundaries.

## Products and variants

Product is metadata; ProductVariant owns stock. Public `/catalog-items` routes
are removed without redirects. Current storage uses Product/productId. The
`catalogItemId` response alias intentionally remains equal to productId on
Variants, movements and relevant import rows; it is not a second identity.

Product externalKey is a trimmed, case-sensitive, business-unique nullable import
grouping code, not a Variant SKU. Assign it before matching a manually created
Product through an import. Names and UUIDs are not import fallback matches.

A simple Product has empty option definitions and receives a default `{}`
Variant on creation. A configurable Product starts without Variants; clients
create valid selections explicitly. There is no automatic Cartesian expansion.
Legacy simple records without a Variant require the existing explicit repair
path, not a fabricated Variant ID.

Definitions permit up to ten option keys, 1–50 values per key, trimmed names up
to 60 characters and values up to 100. Comparisons are case-sensitive; definitions
are at most 16,384 UTF-8 JSON bytes and every selection must fit 1,500 bytes.
Each Variant selects exactly one declared value for every key. JSON key order
does not create a new combination. Inactive combinations and non-null SKUs remain
reserved; SKU is unique across the Business, not merely one Product.

Option edits validate all existing Variants, including inactive ones. Do not
silently remove/rename selections or infer a simple/configurable conversion.
Attributes are bounded JSON objects (16,384 UTF-8 bytes, at most ten nesting
levels), not arbitrary provider or internal fields.

## Pricing, reads and lifecycle

Prices are nonnegative decimal strings with at most ten integer and two
fractional digits; responses use two decimal places or null. A Variant's
effectivePrice is `unitPrice ?? basePrice`; zero is a price. Explicit null clears
an override to restore inheritance, while omitted PATCH fields preserve values.
Product PATCH and import blanks do not have identical semantics.

Product responses embed at most twenty Variants plus variantsPagination. Do not
assume the embedded array is complete. Active images are ordered separately.
Owner lists include active and inactive records. The optional categoryId UUID
filter scopes both page items and totalCount to the same Business/Category;
omission includes uncategorized Products. Foreign/nonexistent Categories return
the scoped not-found contract.

Product deletion is soft and preserves Variants/images. Reactivating a Product
does not reactivate its Variants. The last active Variant may be deactivated;
isSellable requires an active Product and a priced active Variant. It is not a
stock-availability or reservation guarantee. There is no public hard purge.

## Product images

One Main Image and up to four Gallery Images occupy compact positions 0..4.
The first activated image becomes Main; uploading appends rather than replaces.
Set Main/reorder preserve relative order as specified; deleting Main promotes
the first remaining image. Images do not follow Variant/color selection.
colorOptionName and optionName/optionValue in responses are legacy metadata.

Uploads accept JPEG/PNG/WebP MIME and magic bytes, at most 5 MiB per file and
five files per batch. Do not mix the single `file` and repeated `files` multipart
forms. Every file is checked before reservation. ACTIVE and UPLOADING count
toward the five-image application limit under the scoped Product lock.

Reservation, activation/order and deletion use short database transactions;
no lock is held over provider HTTPS. A batch activates atomically and awaits
started siblings before compensation. Only confirmed new reservations may be
destroyed after failure; an ambiguous commit must not destroy possibly ACTIVE
assets. DELETE hides/reorders metadata before remote cleanup. cleanupPending
means retry the same scoped DELETE, not that the metadata transaction rolled back.
Fresh uploads have a two-minute safety interval. See [image contracts](product-images.md).

## Inventory and imports

Manual adjustments set absolute stock and enable tracking by default. Disabling
tracking explicitly requires null quantity and conflicts with outstanding order
deductions. Tracked quantity is a nonnegative 32-bit integer; untracked is null.
An identical manual set is a no-op; null-to-zero initialization is still audited.

Stock and its movement commit together under the parent Product lock. Audit
failure rolls stock back. Operation references prevent reapplying the same
deduction/restoration with conflicting identities or quantities. Inactive writes
are rejected; history and valid restoration remain available after soft deletion.
Clients cannot supply arbitrary movement types, deltas or order credentials.

### Internal stock interface

InventoryModule exports InventoryService. Internal order callers use
`deductForOrder(tx, scope, quantity, orderLineId)` and
`restoreForOrder(tx, scope, quantity, orderLineId)`, where scope contains
businessId, productId and the Variant id. Both return changed, quantityBefore,
quantityAfter, quantityDelta and movementId. Use a positive integer quantity and
a stable per-line reference (1–200 characters), not one order ID for all lines.
Repeating an identical operation returns its original movement with changed=false;
changing its Variant/quantity conflicts. A restored line cannot be deducted anew
using the same lifecycle ID.

The caller supplies the Prisma transaction and includes its state transition and
all stock operations in it; there is no nested transaction or in-memory dedup
cache. Acquire multi-product locks in sorted Product-ID order and line locks in
stable line-ID order. Exceptions must escape to roll back; any deadlock/serialization
retry must repeat the entire caller transaction with the same identities.
Untracked deductions retain null stock but still write an idempotency movement.
Restoration needs the matching deduction and is permitted after soft deletion.
Outstanding fulfilled deductions still block tracking changes; no automatic
order-finalization/reconciliation policy is implemented.

Manual/import callers use `setQuantity(scope, quantity, movementType, reference?,
tx?, tracking?)` with MANUAL_ADJUSTMENT, INITIAL_IMPORT or IMPORT_UPDATE, not order
types. Tracking defaults true; disable requires null. Imports use IMPORT_ROW and
`importId:rowNumber` references, recording referenced operations even when the
quantity is unchanged. This internal interface is not an extra public endpoint.

Import stock cells are absolute sets through InventoryService. Blank/unmapped
stock preserves existing stock/tracking; a new Variant without stock starts
untracked. A new job with explicit quantities can overwrite later stock on
purpose. Preview is advisory, not a reservation. See [the import workflow](excel-import-flow.md).

## Customers, conversations and messages

Customer phone identity is normalized international digits, unique per Business.
There is one rolling conversation per Business/Customer/channel; WHATSAPP is
the current channel. A new customer message reopens a closed conversation.
Message and customer identities never authorize cross-business access.

Inbox order uses lastMessageAt descending (nulls last), then id, not updatedAt.
Message writes move activity/customer-message times forward transactionally.
The owner can reply and disable/re-enable AI. Owner takeover and automatic
handoff leave the AI silent until re-enabled. PURCHASE_INTENT sets an alert;
it does not create an order or deduct stock. An appropriate owner-created order
clears the alert.

Stored/sent message limits use Unicode code points, not UTF-16 length: 4,096
for message text and 2,000 for customer text sent to AI. Longer customer messages
remain stored but hand off instead of entering the model. AI replies beyond the
outbound limit are truncated with an ellipsis and truncation metadata. History
turns beyond the AI content limit use null text.

## Implemented Orders

The owner creates an order from a scoped CUSTOMER message with 1–50 distinct
Variant lines and quantities 1–100. Product names, selected options and prices
are copied from the database. Currency is currently EGP. Unique sourceMessageId
makes repeated creation return the existing order (200 rather than new 201).
Creation can mark LOW_STOCK for review but does not reserve/deduct inventory.

Approval rechecks scoped active Product/Variant state, price and stock under
locks. A changed price returns ORDER_PRICE_CHANGED; explicit acceptCurrentPrices
permits updating snapshots/totals to the checked current prices. Stock and
PENDING_APPROVAL-to-IN_PROGRESS status commit together; races cannot oversell.
Rejection moves a pending order to CANCELLED without a stock deduction.

Customer notification follows the order commit. A FAILED/PENDING notification
does not undo approval/rejection. WhatsApp's 24-hour free-text window still
applies. The COMPLETED enum and inventory restoration interface are not public
complete/post-approval-cancel endpoints. No AI write tool creates or approves
orders. See [Orders](orders-api.md) and [AI integration](ai-integration.md).
