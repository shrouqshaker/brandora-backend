# Application HTTP error codes

Codes are assigned at their throw sites, never inferred from English messages.
Mobile owns API error localization using these codes; backend messages remain
English developer/debugging context. Do not add backend AR/EN error-message
copies or reuse this system for notifications or AI replies. See the
[localization ownership rules](../README.md#localization-ownership) for all
content types, including preservation of owner-entered business data.

This table covers every explicit application HTTP exception, including the
Excel upload limit. Multiple messages share a code when their semantics match.

| Existing message                                                                                                 | Stable code                          |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Business not found                                                                                               | `BUSINESS_NOT_FOUND`                 |
| An .xlsx file is required in the file field                                                                      | `EXCEL_FILE_REQUIRED`                |
| Only .xlsx files are supported                                                                                   | `EXCEL_FILE_UNSUPPORTED`             |
| The file is not a valid .xlsx workbook                                                                           | `EXCEL_FILE_INVALID`                 |
| The file is not a readable .xlsx workbook                                                                        | `EXCEL_FILE_UNREADABLE`              |
| The requested sheet does not exist or the workbook has no sheets                                                 | `EXCEL_SHEET_NOT_FOUND`              |
| The saved header row is not present in the selected sheet                                                        | `EXCEL_HEADER_NOT_FOUND`             |
| The saved header row is empty                                                                                    | `EXCEL_HEADER_NOT_FOUND`             |
| The selected sheet has no header within its first 50 rows                                                        | `EXCEL_HEADER_NOT_FOUND`             |
| Import job not found                                                                                             | `IMPORT_JOB_NOT_FOUND`               |
| The import job must be READY before execution                                                                    | `IMPORT_NOT_READY`                   |
| Execution has already started or the job status changed                                                          | `IMPORT_EXECUTION_ALREADY_STARTED`   |
| Import execution could not be completed                                                                          | `IMPORT_EXECUTION_FAILED`            |
| The Excel file exceeds the maximum allowed size of 10 MB.                                                        | `EXCEL_FILE_TOO_LARGE`               |
| sourceColumnIndex must identify the supplied sourceColumn                                                        | `MAPPING_SOURCE_INVALID`             |
| sourceColumn must match one header; duplicate or blank headers require sourceColumnIndex                         | `MAPPING_SOURCE_INVALID`             |
| A source column cannot be mapped more than once                                                                  | `MAPPING_SOURCE_DUPLICATE`           |
| Unknown standard target                                                                                          | `MAPPING_STANDARD_TARGET_INVALID`    |
| A standard target cannot be mapped more than once                                                                | `MAPPING_STANDARD_TARGET_DUPLICATE`  |
| Attribute targets must be safe lowercase keys of 1 to 64 letters, digits, or underscores, starting with a letter | `MAPPING_ATTRIBUTE_TARGET_INVALID`   |
| An attribute key cannot be mapped more than once within its type                                                 | `MAPPING_ATTRIBUTE_TARGET_DUPLICATE` |
| IGNORE and UNMAPPED targets must be null                                                                         | `MAPPING_TARGET_MUST_BE_NULL`        |
| Unknown mapping type                                                                                             | `MAPPING_TYPE_INVALID`               |
| The name standard field must be mapped before confirmation                                                       | `MAPPING_NAME_REQUIRED`              |
| The import job is no longer awaiting mapping                                                                     | `IMPORT_MAPPING_CHANGED`             |
| The import job is not awaiting mapping                                                                           | `IMPORT_NOT_AWAITING_MAPPING`        |
| The import job does not have a retained analyzed workbook                                                        | `IMPORT_WORKBOOK_UNAVAILABLE`        |
| The retained workbook is unavailable                                                                             | `IMPORT_WORKBOOK_UNAVAILABLE`        |
| Unable to read the retained workbook                                                                             | `IMPORT_WORKBOOK_READ_FAILED`        |
| The import job must be READY before preview                                                                      | `IMPORT_NOT_READY`                   |
| The import job has no retained mapped workbook                                                                   | `IMPORT_WORKBOOK_UNAVAILABLE`        |
| Unable to rebuild the import preview from the retained workbook                                                  | `IMPORT_WORKBOOK_READ_FAILED`        |
| The import job is not awaiting validation                                                                        | `IMPORT_NOT_AWAITING_VALIDATION`     |
| A confirmed mapping is required                                                                                  | `IMPORT_MAPPING_REQUIRED`            |
| Validation has already started or the job status changed                                                         | `IMPORT_VALIDATION_ALREADY_STARTED`  |
| Workbook validation could not be completed                                                                       | `IMPORT_VALIDATION_FAILED`           |
| Target quantity must be an integer between 0 and 2147483647                                                      | `INVENTORY_QUANTITY_INVALID`         |
| Unknown inventory movement type                                                                                  | `INVENTORY_MOVEMENT_TYPE_INVALID`    |
| Reference type must be 1 to 50 characters and reference ID, when supplied, 1 to 200 characters                   | `INVENTORY_REFERENCE_INVALID`        |
| Customer not found in this business                                                                              | `CUSTOMER_NOT_FOUND`                 |
| Conversation not found in this business                                                                          | `CONVERSATION_NOT_FOUND`             |
| phone must be an international number with 8 to 15 digits, e.g. 201000000001                                     | `INVALID_PHONE_NUMBER`               |
| externalMessageId already belongs to another business                                                            | `EXTERNAL_MESSAGE_ID_CONFLICT`       |
| externalMessageId already belongs to another message                                                             | `EXTERNAL_MESSAGE_ID_CONFLICT`       |
| The message could not be stored because of a concurrent change; retry the request                                | `CONFLICT`                           |
| WhatsApp integration is not available                                                                            | `WHATSAPP_UNAVAILABLE`               |
| Webhook verification failed                                                                                      | `WHATSAPP_VERIFY_TOKEN_INVALID`      |
| Invalid webhook signature                                                                                        | `WHATSAPP_SIGNATURE_INVALID`         |
| This WhatsApp number is already linked to another business                                                       | `WHATSAPP_PHONE_NUMBER_IN_USE`       |
| This business has no WhatsApp number yet                                                                         | `WHATSAPP_CONNECTION_NOT_FOUND`      |
| Stock changed concurrently; retry the operation                                                                  | `INVENTORY_CONFLICT`                 |

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

| HTTP | Code | Meaning / Android action |
| --- | --- | --- |
| 400 | `PRODUCT_IMAGE_INVALID` | Invalid file/type, forbidden attributes, more than five occupied image slots, oversized batch or invalid order; correct input or refresh gallery. |
| 413 | `PRODUCT_IMAGE_TOO_LARGE` | Image exceeds 5 MiB; reduce size. This is separate from Excel's 10 MiB limit. |
| 404 | `PRODUCT_IMAGE_NOT_FOUND` | Image does not belong to the scoped Product/Business or no longer exists. |
| 503 / 502 | `PRODUCT_IMAGE_UNAVAILABLE` | Missing provider configuration (503), or rejected/failed/timed-out provider request or invalid acceptance metadata (502). |

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

Malformed JSON retains HTTP 400 / VALIDATION_ERROR with Nest's parsing message;
an oversized JSON body retains HTTP 413 / PAYLOAD_TOO_LARGE. These are not Excel
upload errors. Non-Nest Express/http-errors preserve their HTTP status without
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
configuration failures occur before the server starts and are not HTTP responses.

Excel row codes and execution-row result codes are separate successful-response
contracts and have not been changed. No auth endpoints are introduced by the
generic 401/403 fallbacks.
