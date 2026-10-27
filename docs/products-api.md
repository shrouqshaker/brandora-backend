# Categories, Products and ProductVariants (Task 2)

These APIs use Task 1's Category, CatalogItem and ProductVariant models. No schema
or migration changes are required. The legacy `/catalog-items`, Inventory and
Excel Import APIs are unchanged. `businessId` scoping is not authentication or
authorization: callers can currently supply business IDs. Authentication remains
a separate task; do not expose these routes as authenticated tenant access.

The lifecycle rules below cover soft deletion and explicit reactivation without
introducing stock or order workflows.

## Routes and responses

All IDs in paths must be UUIDs. POST returns 201, GET and PATCH return 200,
and DELETE returns 204 with no body. Unknown body/query fields are rejected.

| Resource   | Collection                                             | Item                  |
| ---------- | ------------------------------------------------------ | --------------------- |
| Categories | `/businesses/:businessId/categories`                   | append `/:categoryId` |
| Products   | `/businesses/:businessId/products`                     | append `/:productId`  |
| Variants   | `/businesses/:businessId/products/:productId/variants` | append `/:variantId`  |

Each collection supports POST and GET; each item supports GET, PATCH and DELETE.
GET lists return `{ pagination, items }`. Pagination contains limit, offset,
totalCount, hasMore and nextOffset, using the existing shared format. limit is
1..100 (default 20); offset is 0..Number.MAX_SAFE_INTEGER (default 0). An offset
past the end returns an empty page. Order is createdAt DESC, id DESC. Active and
inactive records are included. Counts and rows use one repeatable-read snapshot.
Unknown business IDs on collection lists return BUSINESS_NOT_FOUND. Mismatched
item IDs return a scoped 404, without fetching another tenant's record.

## Categories

POST and PATCH accept exactly `{ "name": "General Goods" }`: required string,
trimmed, nonblank, maximum 200 characters. PATCH must supply the name. Database
uniqueness follows Task 1's lowercased, whitespace-collapsed name within the
business; display names preserve internal whitespace and case. Business.category
remains a separate business-profile field.

Responses contain Category id, businessId, name, createdAt and updatedAt.
DELETE physically removes an unreferenced Category. A reference from any product,
including an inactive product, produces 409 CATEGORY_IN_USE. The foreign key also
protects concurrent reference/delete races. No products are deleted or detached.

## Products

POST requires name; PATCH supports partial updates with at least one field:

| Field       | Input and update behavior                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| name        | Trimmed nonblank string, max 200; cannot be null                                                                                |
| description | Optional string, max 5000; null clears                                                                                          |
| categoryId  | Optional UUID from the same business; null clears                                                                               |
| basePrice   | Optional nonnegative decimal string, up to 10 integer digits / 2 decimals; null clears                                          |
| options     | Optional object (default `{}` on POST); cannot be null; replaces definitions                                                    |
| attributes  | Optional JSON object, max 16384 UTF-8 bytes and nesting depth 10; cannot be null; replaces the object; `{}` clears its contents |
| isActive    | Optional boolean; default true on POST; PATCH can reactivate a product                                                          |

Numbers, exponents, signs, currency/grouping separators, and excess precision
are rejected for prices. Responses use fixed two-decimal strings or null, including
zero prices. No JavaScript floating-point arithmetic is used for money.

externalKey, legacy category, stockQuantity, trackInventory, IDs and timestamps
are not writable through this API. Existing externalKey/category/stock/tracking
fields are preserved by metadata updates and deletion. `category` in responses
is the legacy category string, not the current name of the linked Category.

Example:

```json
{
  "name": "Custom Product",
  "categoryId": null,
  "basePrice": "125.00",
  "options": { "Configuration": ["Standard", "Plus"] },
  "attributes": { "details": { "notes": "Business-defined metadata" } }
}
```

No option names, values or categories are hardcoded. Option names and values are
trimmed at the boundaries and case-sensitive. Internal whitespace, accents and
Unicode composition are preserved and compared exactly. Duplicate keys/values
after trimming are rejected. Raw duplicate JSON keys cannot be detected after
native JSON parsing: the parser keeps the last value. This API does not claim
to detect that unobservable input. The technical JSON keys `__proto__`,
`prototype` and `constructor` (including trimmed spellings) are reserved at any
nesting level. New endpoints reject them before Nest's existing validation pipe
can strip them silently. Other option names remain business-defined. Legacy
route validation is unchanged.

Options have at most 10 keys, names of at most 60 JavaScript string code units,
and 1..50 nonblank string values per key, each at most 100 code units. The JSON
definition must fit 16384 UTF-8 bytes. Every possible selected combination must
fit 1500 UTF-8 JSON bytes, measured with escaping included. This conservatively
bounds JSONB index entries on standard PostgreSQL 8 KiB pages. A definition that
allows an oversized selection is rejected before any product is written.

POST with omitted/empty options atomically creates the product and exactly one
default Variant with null SKU/price/quantity, `{}` optionValues,
trackInventory=false and isActive=true. POST with nonempty options creates no
variants; combinations are added explicitly. Product creation rolls back if
default-variant creation fails.

GET one and each list item return product metadata, a first page of at most 20
variants, and `variantsPagination`. Use the nested Variant list with its returned
offset to fetch more. Each Variant includes `effectivePrice = unitPrice ??
basePrice`. Null/null yields null. Product `isSellable` means metadata eligibility:
active product with at least one active, priced variant, including variants outside
the embedded first page. It is not an inventory availability or order-approval
guarantee. No quantities, reservations or tracking states are inferred or changed.
Bulk product reads use bounded relation pages and a grouped eligibility query,
not a query per product.

### Option edits and transitions

Before accepting changed options, validate **all** existing variants, including
inactive ones. Invalidating any combination returns 409 PRODUCT_OPTIONS_IN_USE;
nothing is deleted, rewritten or partially updated. Expanding allowed values is
permitted if every existing combination stays valid.

- Simple to configurable: rejected while the existing `{}` default variant exists,
  even if it is inactive. No implicit conversion or purge workflow is provided.
- Configurable to simple: allowed when there are zero variants; creates the default
  variant atomically. Nonempty existing combinations prevent the change.
- A legacy simple product without variants can acquire its default through an
  explicit PATCH with `options: {}` or POST of the `{}` variant combination.

All new Product writes and Variant writes take a tenant-scoped PostgreSQL
`SELECT ... FOR UPDATE` lock on the same parent CatalogItem before validating or
mutating. Variant creation/PATCH and option edits therefore cannot race into an
invalid definition/combination state. External direct SQL writers must follow the
same protocol for option-definition semantics; tenant and uniqueness constraints
remain independently enforced by the database.

Product DELETE soft-deactivates only the product. Variants, legacy stock, inventory
movements and import jobs remain intact. Repeated deletion succeeds. Reactivating
the product through PATCH does not reactivate any inactive variants.

## Variants

POST accepts sku, required optionValues, and unitPrice. PATCH also accepts
isActive (a boolean), with at least one field supplied. Omitted fields preserve their values;
sku=null clears the SKU, unitPrice=null restores price inheritance. Inventory
fields remain read-only. POST always creates an active variant.

sku is a trimmed, nonblank string up to 200 characters, or null/omitted. Its
case-sensitive uniqueness is business-wide, including inactive variants. Multiple
null SKUs are allowed, but option combinations must still be distinct.

optionValues must be an object with exactly one selected string for every parent
option, no missing/unknown keys, and a value from each corresponding allowed list.
The same trimming/case rules apply to definitions and selections. Different JSON
key orders are equivalent under the Task 1 database unique index. Inactive
combinations and SKUs remain reserved. A simple product accepts only `{}`.

Responses include id, businessId, catalogItemId (the Product ID), sku, optionValues,
unitPrice, effectivePrice, trackInventory, stockQuantity, isActive and timestamps.
Parent business/product scoping is checked for every operation, including reads.
Creation or explicit reactivation under an inactive product returns PRODUCT_INACTIVE.
Existing inactive products/variants remain readable; metadata-only PATCH preserves
their state. PATCH with isActive=true validates business/parent ownership, active
parent status and the proposed (or existing) selection against current parent
options under the same parent-row lock used for option edits. SKU and combination
conflicts roll back the entire patch, including activation. Repeated activation
is allowed after the same checks. State-only PATCH with isActive=false can also
withdraw a variant with stale legacy options; patches that include metadata or
selections still validate the resulting selection.

Variant DELETE soft-deactivates only the variant and is repeatable. No historical
reference or quantity is removed. PATCH with isActive=false has the same state
effect. Deactivating the last active variant is deliberately allowed and makes
the product ineligible for sale. Reactivate the same variant with PATCH
isActive=true; a replacement with its reserved combination or SKU is rejected.
Reads never recreate default variants. Inactive defaults still prevent an unsafe
simple-to-configurable transition; no variant is deleted or rewritten automatically.
None of these lifecycle operations changes stock or creates inventory movements.

## Errors

Use the existing `{ statusCode, code, message, error }` error envelope. Known
conflicts do not expose Prisma/SQL diagnostics.

| Code                     | HTTP | Meaning                                                                      |
| ------------------------ | ---- | ---------------------------------------------------------------------------- |
| VALIDATION_ERROR         | 400  | DTO, JSON shape/size or product definition validation                        |
| VARIANT_OPTIONS_INVALID  | 400  | Invalid/missing selected combination                                         |
| BUSINESS_NOT_FOUND       | 404  | Business missing for create/list                                             |
| CATEGORY_NOT_FOUND       | 404  | Category missing, removed concurrently or tenant mismatch                    |
| PRODUCT_NOT_FOUND        | 404  | Parent product missing or tenant mismatch                                    |
| VARIANT_NOT_FOUND        | 404  | Variant missing or mismatched parent/business                                |
| CATEGORY_NAME_CONFLICT   | 409  | Database normalized name conflict                                            |
| CATEGORY_IN_USE          | 409  | Referenced category, including inactive products                             |
| PRODUCT_OPTIONS_IN_USE   | 409  | Option edit invalidates an existing variant                                  |
| PRODUCT_INACTIVE         | 409  | Cannot create or reactivate a variant under an inactive product              |
| VARIANT_SKU_CONFLICT     | 409  | SKU reserved in this business                                                |
| VARIANT_OPTIONS_CONFLICT | 409  | Combination reserved for this product                                        |
| PRODUCT_WRITE_CONFLICT   | 409  | Transaction contention or interactive-transaction timeout; refresh and retry |

Unexpected errors retain the existing sanitized 500 response. There is no new
authentication scheme, stock adjustment flow, order API or import upgrade here.
The unchanged Excel importer may still create legacy CatalogItems without variants;
automatic import-to-variant handling remains the separate Import Upgrade.

## Verification

`npm test` builds the app and runs all maintained regressions, including dynamic
option/DTO policy and new HTTP boundary suites. Existing Catalog, Inventory and
Excel Import tests remain enabled.

`npm run test:products:postgres` runs real routes against a newly created,
local-only disposable PostgreSQL database on 127.0.0.1:55439. It overrides the
environment URL before loading the application and never accesses Neon. It retains
the database, runs no cleanup script, and tests all CRUD routes, tenant mismatches,
pagination, prices, soft deletion, legacy preservation, atomic default-write
rollback through a disposable fault-injection trigger, and actual competing option,
SKU, category-reference and variant writes. The probe removes only its own trigger
and function after the assertion. Task 1's foundation verifier remains a separate explicit
command and its migration files are unchanged.
