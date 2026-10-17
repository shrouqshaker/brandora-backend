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
| Existing catalog attributes must be a JSON object before merging mapped attributes                               | `CATALOG_ATTRIBUTES_INVALID`         |
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
| Catalog item not found in this business                                                                          | `CATALOG_ITEM_NOT_FOUND`             |
| Customer not found in this business                                                                              | `CUSTOMER_NOT_FOUND`                 |
| Conversation not found in this business                                                                          | `CONVERSATION_NOT_FOUND`             |
| phone must be an international number with 8 to 15 digits, e.g. 201000000001                                     | `INVALID_PHONE_NUMBER`               |
| externalMessageId already belongs to another business                                                            | `EXTERNAL_MESSAGE_ID_CONFLICT`       |
| Stock changed concurrently; retry the operation                                                                  | `INVENTORY_CONFLICT`                 |

Validation-results reads:

Validation-results reads return `409 IMPORT_VALIDATION_RESULTS_UNAVAILABLE`
when validation has not completed successfully or the stored snapshot is missing.
The English message is `Stored validation results are not available for this import job`.
Snapshot corruption/read failures return a safe `500 INTERNAL_SERVER_ERROR`.
History, Preview, and validation-results pagination errors use `VALIDATION_ERROR`.

Catalog CRUD additions:

| Message                                                               | Code                            |
| --------------------------------------------------------------------- | ------------------------------- |
| Catalog item not found                                                | `CATALOG_ITEM_NOT_FOUND`        |
| A catalog item with this external key already exists in this business | `CATALOG_EXTERNAL_KEY_CONFLICT` |
| Catalog attributes must be a JSON object or null                      | `CATALOG_ATTRIBUTES_INVALID`    |
| At least one editable catalog field must be supplied                  | `VALIDATION_ERROR`              |

Catalog attributes shape failures return 400; the existing import merge guard
still returns 409 with CATALOG_ATTRIBUTES_INVALID for legacy non-object data.
See [Catalog CRUD examples](catalog-api.md) for endpoint contracts.

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
