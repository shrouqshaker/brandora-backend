# Application HTTP error codes

Codes are assigned at their throw sites, never inferred from English messages.
Mobile owns API error localization using these codes; backend messages remain
English developer/debugging context. Do not add backend AR/EN error-message
copies or reuse this system for notifications or AI replies. See the
[localization ownership rules](api-guide.md#localization-ownership) for all
content types, including preservation of owner-entered business data.

The tables below cover all 82 identifiers in the current ErrorCode enum. The
message table preserves representative public strings; it is not an exhaustive
list of every message variant or a mechanism for deriving codes from English.
The throw site and HTTP boundary determine status/code.

| Existing message                                                                                        | Stable code                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Business not found                                                                                      | `BUSINESS_NOT_FOUND`                 |
| An .xlsx file is required in the file field                                                             | `EXCEL_FILE_REQUIRED`                |
| Only .xlsx files are supported                                                                          | `EXCEL_FILE_UNSUPPORTED`             |
| The file is not a valid .xlsx workbook                                                                  | `EXCEL_FILE_INVALID`                 |
| The file is not a readable .xlsx workbook                                                               | `EXCEL_FILE_UNREADABLE`              |
| The requested sheet does not exist or the workbook has no sheets                                        | `EXCEL_SHEET_NOT_FOUND`              |
| The saved header row is not present in the selected sheet                                               | `EXCEL_HEADER_NOT_FOUND`             |
| The saved header row is empty                                                                           | `EXCEL_HEADER_NOT_FOUND`             |
| The selected sheet has no header within its first 50 rows                                               | `EXCEL_HEADER_NOT_FOUND`             |
| Import job not found                                                                                    | `IMPORT_JOB_NOT_FOUND`               |
| The import job must be READY before execution                                                           | `IMPORT_NOT_READY`                   |
| Execution has already started or status changed                                                         | `IMPORT_EXECUTION_ALREADY_STARTED`   |
| Import execution could not be completed                                                                 | `IMPORT_EXECUTION_FAILED`            |
| The Excel file exceeds the maximum allowed size of 10 MB.                                               | `EXCEL_FILE_TOO_LARGE`               |
| sourceColumnIndex must identify the supplied sourceColumn                                               | `MAPPING_SOURCE_INVALID`             |
| sourceColumn must match one header; duplicate or blank headers require sourceColumnIndex                | `MAPPING_SOURCE_INVALID`             |
| A source column cannot be mapped more than once                                                         | `MAPPING_SOURCE_DUPLICATE`           |
| Unknown standard target                                                                                 | `MAPPING_STANDARD_TARGET_INVALID`    |
| A standard target cannot be mapped more than once                                                       | `MAPPING_STANDARD_TARGET_DUPLICATE`  |
| Attribute targets use safe lowercase keys; variant option names use trimmed names of 1 to 60 characters | `MAPPING_ATTRIBUTE_TARGET_INVALID`   |
| An attribute key cannot be mapped more than once within its type                                        | `MAPPING_ATTRIBUTE_TARGET_DUPLICATE` |
| IGNORE and UNMAPPED targets must be null                                                                | `MAPPING_TARGET_MUST_BE_NULL`        |
| Unknown mapping type                                                                                    | `MAPPING_TYPE_INVALID`               |
| The name standard field must be mapped before confirmation                                              | `MAPPING_NAME_REQUIRED`              |
| The import job is no longer awaiting mapping                                                            | `IMPORT_MAPPING_CHANGED`             |
| The import job is not awaiting mapping                                                                  | `IMPORT_NOT_AWAITING_MAPPING`        |
| The import job does not have a retained analyzed workbook                                               | `IMPORT_WORKBOOK_UNAVAILABLE`        |
| The retained workbook is unavailable                                                                    | `IMPORT_WORKBOOK_UNAVAILABLE`        |
| Unable to read the retained workbook                                                                    | `IMPORT_WORKBOOK_READ_FAILED`        |
| The import job must be READY before preview                                                             | `IMPORT_NOT_READY`                   |
| The import job has no retained mapped workbook                                                          | `IMPORT_WORKBOOK_UNAVAILABLE`        |
| Unable to rebuild the import preview from the retained workbook                                         | `IMPORT_WORKBOOK_READ_FAILED`        |
| The import job is not awaiting validation                                                               | `IMPORT_NOT_AWAITING_VALIDATION`     |
| A confirmed mapping is required                                                                         | `IMPORT_MAPPING_REQUIRED`            |
| Validation has already started or the job status changed                                                | `IMPORT_VALIDATION_ALREADY_STARTED`  |
| Workbook validation could not be completed                                                              | `IMPORT_VALIDATION_FAILED`           |
| Quantity must be an integer between 0 and 2147483647                                                    | `INVENTORY_QUANTITY_INVALID`         |
| Use order methods for order movements                                                                   | `INVENTORY_MOVEMENT_TYPE_INVALID`    |
| A reference needs a type (1?50) and ID (1?200)                                                          | `INVENTORY_REFERENCE_INVALID`        |
| Customer not found in this business                                                                     | `CUSTOMER_NOT_FOUND`                 |
| Conversation not found in this business                                                                 | `CONVERSATION_NOT_FOUND`             |
| phone must be an international number with 8 to 15 digits, e.g. 201000000001                            | `INVALID_PHONE_NUMBER`               |
| externalMessageId already belongs to another business                                                   | `EXTERNAL_MESSAGE_ID_CONFLICT`       |
| externalMessageId already belongs to another message                                                    | `EXTERNAL_MESSAGE_ID_CONFLICT`       |
| The message could not be stored because of a concurrent change; retry the request                       | `CONFLICT`                           |
| WhatsApp integration is not available                                                                   | `WHATSAPP_UNAVAILABLE`               |
| Webhook verification failed                                                                             | `WHATSAPP_VERIFY_TOKEN_INVALID`      |
| Invalid webhook signature                                                                               | `WHATSAPP_SIGNATURE_INVALID`         |
| This WhatsApp number is already linked to another business                                              | `WHATSAPP_PHONE_NUMBER_IN_USE`       |
| This business has no WhatsApp number yet                                                                | `WHATSAPP_CONNECTION_NOT_FOUND`      |
| Customer message not found in this business                                                             | `MESSAGE_NOT_FOUND`                  |
| Each variant can appear only once in an order                                                           | `VALIDATION_ERROR`                   |
| A product in the order is inactive or has no price                                                      | `ORDER_ITEM_UNAVAILABLE`             |
| Order not found in this business                                                                        | `ORDER_NOT_FOUND`                    |
| The order is <status>, not PENDING_APPROVAL                                                             | `ORDER_NOT_PENDING`                  |
| A price changed since the order was made; approve with acceptCurrentPrices to use today's prices        | `ORDER_PRICE_CHANGED`                |
| More than 24 hours since the customer last wrote; WhatsApp only allows templates now                    | `WHATSAPP_WINDOW_CLOSED`             |
| Restore outstanding order deductions before changing tracking                                           | `INVENTORY_CONFLICT`                 |

## Response and consumer recovery

Every HTTP error uses statusCode, code, message and error. message is a string
or string array; error is the HTTP status phrase. For example:

```json
{
  "statusCode": 409,
  "code": "IMPORT_WORKBOOK_UNAVAILABLE",
  "message": "The import job has no retained mapped workbook",
  "error": "Conflict"
}
```

Execution records FAILED/counters when possible before preserving this specific 409. Unexpected execution failure uses 500 IMPORT_EXECUTION_FAILED and
`Import execution could not be completed`. Previously committed groups remain.
Do not infer rollback from the HTTP status; inspect compact job state after a
timeout. Global ownership guards can return NOT_FOUND before a domain lookup.

Auth quota failures include Retry-After; rate-store outages use a safe temporary 503. Respect that header. Reauthenticate on invalid refresh/session state and
obtain a fresh OTP after expired/replaced recovery. Do not put tokens, codes or
raw provider/database details in client logs. See [authentication](authentication.md).

## Auth, category and variant code families

These previously omitted codes are part of the same stable enum. Meanings are
semantic descriptions, not replacement public messages.

| HTTP | Code                          | Meaning                                                                     |
| ---- | ----------------------------- | --------------------------------------------------------------------------- |
| 401  | `AUTH_REFRESH_INVALID`        | Invalid/expired/revoked refresh family, replay or rotation exhaustion.      |
| 400  | `AUTH_RESET_INVALID`          | Invalid, expired, replaced, consumed or unconfirmed-delivery reset code.    |
| 503  | `AUTH_EMAIL_UNAVAILABLE`      | Recovery mail/HMAC configuration is unavailable.                            |
| 503  | `AUTH_RATE_LIMIT_UNAVAILABLE` | Shared rate-limit backend failed closed.                                    |
| 409  | `EMAIL_UNAVAILABLE`           | Registration email is already reserved.                                     |
| 401  | `INVALID_CREDENTIALS`         | Unknown account, wrong password or a concurrent login credential change.    |
| 429  | `AUTH_RATE_LIMITED`           | Request quota or password-worker capacity exhausted; honor Retry-After.     |
| 404  | `CATEGORY_NOT_FOUND`          | Missing/foreign scoped Category or a Category/Business lost during a write. |
| 409  | `CATEGORY_NAME_CONFLICT`      | Normalized name already exists in the Business.                             |
| 409  | `CATEGORY_IN_USE`             | Product references prevent Category deletion.                               |
| 409  | `PRODUCT_INACTIVE`            | Variant lifecycle write requires an active parent Product.                  |
| 409  | `VARIANT_SKU_CONFLICT`        | SKU already reserved in the Business, including inactive records.           |
| 409  | `VARIANT_OPTIONS_CONFLICT`    | Product option combination already reserved.                                |
| 400  | `VARIANT_OPTIONS_INVALID`     | Selected option object does not satisfy the Product definition.             |

## Inventory and domain details

Variant inventory adds `409 INVENTORY_INACTIVE` for stock writes/sales on inactive
records and `409 INVENTORY_INSUFFICIENT_STOCK` for insufficient tracked stock.
`INVENTORY_CONFLICT` also covers mismatched/reused operation references and tracking
changes with outstanding deductions. Missing scoped variants use
`404 VARIANT_NOT_FOUND`. Reference type and ID must now both be supplied together;
product-level stock endpoints have been removed. See [Inventory](inventory-api.md).

Validation-results reads:

Validation-results reads return `409 IMPORT_VALIDATION_RESULTS_UNAVAILABLE`
when validation has not completed successfully or the stored snapshot is missing.
The English message is `Stored validation results are not available for this import job`.
Snapshot corruption/read failures return a safe `500 INTERNAL_SERVER_ERROR`.
History, Preview, and validation-results pagination errors use `VALIDATION_ERROR`.

The legacy Catalog CRUD API and its `CATALOG_*` error codes are removed.
The [Products API](products-api.md) is the canonical metadata API. Scoped missing
products return `404 PRODUCT_NOT_FOUND`; malformed metadata and empty patches
return `400 VALIDATION_ERROR`. Import attribute merge failures remain row-level
`MERGED_ATTRIBUTES_INVALID` validation errors in the existing Excel workflow.
Products POST/PATCH return `409 PRODUCT_EXTERNAL_KEY_CONFLICT` when a trimmed
externalKey is already reserved by another product in the same business.

Product image management uses these stable codes (see [Product images](product-images.md)):

| HTTP      | Code                        | Meaning / Android action                                                                                                                          |
| --------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400       | `PRODUCT_IMAGE_INVALID`     | Invalid file/type, forbidden attributes, more than five occupied image slots, oversized batch or invalid order; correct input or refresh gallery. |
| 413       | `PRODUCT_IMAGE_TOO_LARGE`   | Image exceeds 5 MiB; reduce size. This is separate from Excel's 10 MiB limit.                                                                     |
| 404       | `PRODUCT_IMAGE_NOT_FOUND`   | Image does not belong to the scoped Product/Business or no longer exists.                                                                         |
| 503 / 502 | `PRODUCT_IMAGE_UNAVAILABLE` | Missing provider configuration (503), or rejected/failed/timed-out provider request or invalid acceptance metadata (502).                         |

Existing `404 NOT_FOUND` / `PRODUCT_NOT_FOUND` may occur at earlier ownership
checks. PRODUCT_OPTIONS_IN_USE still protects Variant option compatibility, not images.
PRODUCT_WRITE_CONFLICT can reject deletion of an upload in progress or a transaction
race. A successful delete can return `cleanupPending=true`; this is
not a separate HTTP failure and means retained metadata needs explicit cleanup retry.

Framework fallbacks (no domain-specific exception):

| Condition                                                   | Code                    |
| ----------------------------------------------------------- | ----------------------- |
| DTO validation, UUID pipes, other framework HTTP 400 errors | `VALIDATION_ERROR`      |
| HTTP 401                                                    | `UNAUTHORIZED`          |
| HTTP 403                                                    | `FORBIDDEN`             |
| Unmatched routes / framework HTTP 404                       | `NOT_FOUND`             |
| Framework HTTP 409                                          | `CONFLICT`              |
| Non-Excel framework HTTP 413                                | `PAYLOAD_TOO_LARGE`     |
| Other framework HTTP errors below 500                       | `HTTP_ERROR`            |
| Unexpected exceptions or untrusted framework server errors  | `INTERNAL_SERVER_ERROR` |

Malformed JSON retains HTTP 400 / VALIDATION_ERROR with
`The request body is not valid JSON`;
an oversized JSON body retains HTTP 413 / PAYLOAD_TOO_LARGE. These are not Excel
upload errors. Oversized-body text is `The request body exceeds the maximum allowed size`.
Non-Nest Express/http-errors preserve their HTTP status without
exposing their raw request bodies or internal messages.

DTO validation preserves message arrays. Invalid mapping types blocked by the
DTO receive VALIDATION_ERROR; the service-level defensive check uses
MAPPING_TYPE_INVALID. Known safe application server failures retain their codes
and messages. Other server errors are sanitized without leaking underlying
exception properties. The framework status is preserved (for example, 503
remains 503); its message is the generic internal-error text.

Internal saved-mapping, retained-file-key, and full-workbook parsing errors are
not HTTP domain errors themselves. Their existing service wrappers return
IMPORT_VALIDATION_FAILED, IMPORT_WORKBOOK_READ_FAILED, or IMPORT_EXECUTION_FAILED;
unwrapped unexpected failures return INTERNAL_SERVER_ERROR. Environment
startup configuration failures prevent the server from listening. Feature-specific
configuration checks can instead return HTTP errors at operation time, such as
503 AUTH_EMAIL_UNAVAILABLE or PRODUCT_IMAGE_UNAVAILABLE.

Excel row codes and execution-row result codes are separate successful-response
contracts and have not been changed. No auth endpoints are introduced by the
generic 401/403 fallbacks.
