# API guide

Brandora's client-facing API is the Backend authority for owner operations.
There is no `/api` prefix. Confirm an environment's HTTPS base URL and deployed
release with its owner; this repository does not certify the live host/schema.
Swagger is not implemented yet and has no available URL. The detailed contracts
below remain authoritative human references alongside current source/tests.

## Authentication boundaries

The registered inventory is 67 endpoints: 57 JWT-protected, one separately guarded
internal AI endpoint and nine public-policy endpoints. Protected resource calls
require `Authorization: Bearer <accessToken>` and current active OWNER membership
where scoped. User/session identity routes are not business selection grants.

The nine public-policy routes are:

- POST `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`,
  `/auth/forgot-password`, `/auth/reset-password` (with existing Auth rate guards).
- GET `/.well-known/assetlinks.json`.
- GET and POST `/webhooks/whatsapp` (verification secret/raw-body signature).

POST `/internal/ai/data` requires the distinct BACKEND_SERVICE_TOKEN plus signed
X-AI-Context through AiInternalGuard; it is not an anonymous read API or an owner
JWT operation. The separate development runner's `/dev/ai/respond` is not one of
AppModule's routes. See [authentication](authentication.md) and
[AI integration](ai-integration.md).

## Detailed API contracts

These documents are retained until accepted Swagger coverage replaces their
schemas/examples. They are reference material, while the maintained guides own
policies and multi-endpoint workflows.

| Area                            | Registered routes | Detailed reference                                                               |
| ------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| Authentication                  | 8                 | [Auth API](auth-api.md)                                                          |
| Businesses, settings, hours     | 8                 | [Business API](business-api.md)                                                  |
| Categories                      | 5                 | [Products/Categories](products-api.md#categories)                                |
| Products                        | 5                 | [Products](products-api.md#products)                                             |
| Variants                        | 5                 | [Variants](products-api.md#variants)                                             |
| Product images                  | 5                 | [Images](product-images.md)                                                      |
| Inventory                       | 3                 | [Inventory](inventory-api.md)                                                    |
| Excel imports/history           | 9                 | [Imports](imports-api.md)                                                        |
| Customers                       | 2                 | [Customers](conversations-api.md#customers)                                      |
| Conversations/messages          | 5                 | [Conversations](conversations-api.md)                                            |
| Orders                          | 5                 | [Orders](orders-api.md)                                                          |
| WhatsApp connection/webhooks    | 4                 | [WhatsApp](whatsapp-api.md)                                                      |
| App Links                       | 1                 | [Android association](android-app-links.md)                                      |
| Owner AI trigger/internal tools | 2                 | [AI integration](ai-integration.md) and [cross-service contract](ai-contract.md) |

## Shared conventions

Use IDs returned by the selected environment. UUIDs in examples are synthetic;
resource names/UUIDs are not authorization. Tenant queries include businessId
and the required parent scope. Global guard rejection can precede DTO validation,
so missing/foreign Business membership is normally 404 NOT_FOUND rather than a
resource-specific validation response.

DTO validation transforms supported inputs and rejects unknown fields. Most
metadata requests are JSON; `.xlsx`/image upload endpoints are multipart. Let the
HTTP library generate boundaries. Product image upload accepts either one file
or repeated files, not both. Webhook signatures require the original raw body.

Prices serialize as decimal strings with two fractional digits or null. PATCH
omission preserves a value; explicit null has field-specific meaning. Arbitrary
options/attributes and preview changes are JSON structures, not fixed color/size
DTOs. Product/Variant price inheritance, legacy wire aliases and inactive-record
behavior are described in [business rules](business-rules.md).

Responses have endpoint-specific shapes: a resource, an array, items/pagination,
an import summary/row result, or an empty 204. Do not impose a universal data
wrapper. Order creation can return 201 for new or 200 for existing source identity.
Image deletion returns metadata/cleanup status rather than an empty 204.

## Pagination

Resource lists use limit/offset/totalCount/hasMore/nextOffset and default to 20.
Import preview/validation readers default to 50. Limit is 1–100; offset is a
nonnegative safe integer. Follow returned nextOffset and handle out-of-range
empty pages. Internal AI JSON arguments require numbers, not numeric strings.

Count/page consistency is operation-specific. Products, Categories, Business
lists and Inventory history use repeatable-read snapshots; do not generalize
this to every list. Product responses embed only the first twenty Variants with
their own pagination. Optional Product categoryId filtering affects both count
and items. Import row pages combine collections before splitting their arrays;
execution arrays are complete and unpaginated. See [imports](excel-import-flow.md).

## Errors and retry decisions

HTTP failures use statusCode/code/message/error. message may be a string or
string array. Code is stable application semantics; error is the HTTP status
phrase. Intentional public-safe application errors retain their message; unknown
server failures are sanitized. See [the full code guide](api-errors.md).

Respect Retry-After on Auth 429/temporary rate-store failures. Do not blindly
replay upload, execution or order actions after timeouts. Read persisted job/order
state and apply the operation's documented idempotency/recovery behavior. A failed
response does not prove that prior import groups or an order commit rolled back.

## Localization ownership

Android localizes API errors by stable ErrorCode. Backend HTTP messages remain
English developer context; do not infer code from message wording. Preserve
owner-entered Business/Product/category text and stored customer messages without
automatic translation or normalization beyond the specific field rules.
Customer-facing AI/WhatsApp replies have a separate content contract; HTTP error
codes are not a notification or reply-localization system. No new AR/EN error
copies, notification service or translation API is introduced.

## Swagger transition

Swagger must preserve all registered paths, auth boundaries, statuses, validation,
multipart alternatives, nullability, decimal strings, dynamic JSON/union values,
compatibility aliases, errors/headers and verified examples before old contracts
are retired. Its URL and access policy are a separate implementation decision.
After acceptance, this guide links to that reference; Markdown continues to own
architecture, workflows, integration policies, deployment and testing.
