# Android integration

Android calls the Backend owner API; it does not hold database, Cloudinary,
Brevo, Meta or AI service credentials. The Backend owns prices, stock, membership
and order transitions. Backend implementation does not prove Android UI completion
or a deployed release. Confirm the intended HTTPS base URL/release before use.

This is the maintained workflow guide. The
[detailed Android reference](android-integration-guide.md),
[import handoff](android-excel-import-handoff.md),
[conversation handoff](android-conversations-handoff.md) and
[App Links reference](android-app-links.md) remain available until Swagger
coverage is accepted. They will be consolidated only after their unique contracts
have verified replacements; no Android implementation is changed here.

## Connection, sessions and selected Business

There is no `/api` prefix. Retrofit needs a trailing slash in its agreed base URL.
Use HTTPS on devices; the emulator's explicit local test address is a separate
development choice, not a production fallback. Apply Bearer access tokens to
protected routes. The nine public-policy routes are not all ordinary Android
operations: WhatsApp webhooks belong to Meta and retain signature checks.

Keep refresh single-flight so concurrent requests do not replay a rotated token.
Respect Retry-After for 429/temporary Auth failures. Store tokens using the
client's approved private storage, never logs/analytics or shared collection
exports. Clear account caches and selected business when logging out or switching
accounts. Logout-all/reset invalidate old sessions; do not loop refresh forever.

The selected Business comes from the authenticated user's accessible businesses;
it is app state, not a trusted role/business claim in the JWT. Every scoped ID
must come from that Business. A foreign business or malformed scoped identity
can be hidden as 404 by the guard before request validation. Knowing a UUID
does not establish access.

## Serialization and pagination

- Prices are decimal strings or null, not binary floating-point JSON numbers.
  Keep effectivePrice separate from unitPrice/basePrice.
- Distinguish absent PATCH fields from explicit null. A nullable DTO serialized
  with all default nulls can accidentally clear data. Build requests by presence.
- Arbitrary attributes/options and preview changes require JSON-object/element
  types. Product categoryId is nullable UUID text; a preview category target can
  be a UUID, null or a create object.
- Decode validation message arrays as well as strings. Localize stable error
  codes in Android; preserve owner-entered names/descriptions and stored messages.
- Pagination is limit/offset/totalCount/hasMore/nextOffset. Resource defaults are
  usually 20; import row readers default to 50. Follow the returned nextOffset.
  Product embeds only the first twenty Variants, even when the Product page is
  complete. Lists do not share one universal transaction-consistency guarantee.
- Empty 204 responses must not be decoded as JSON. Endpoint wrappers differ;
  there is no universal data envelope.
- Password bounds count UTF-16 code units, while message limits count Unicode
  code points. Kotlin String.length alone is not the message-length rule.

The retained catalogItemId alias equals productId on applicable Variant,
movement and import rows. Keep compatibility while adopting productId; Product
and ProductImage do not gain a catalogItemId field.

## Business, catalog and images

### Account and Business settings screens

After login, call `GET /auth/me` or page `GET /businesses` to restore server-owned
Businesses. Select the only Business automatically, or show an explicit chooser
when there are several. Business Create is for an actually empty account, not a
device without a cached Business UUID.

- **My account:** name/email from `GET /auth/me`; edit name using `PATCH /auth/me`.
  Email is read-only, and there is no personal photo. For password changes call
  `POST /auth/change-password` with currentPassword/newPassword; validate repeated
  new password on-device. On 204, clear sessions and return to Login. Retain the
  existing OTP recovery flow for forgotten passwords. Existing logout/logout-all
  endpoints should be connected to the corresponding account actions.
- **Business settings:** existing profile GET/PATCH for name, description,
  category, phone and address. Use settings GET/PATCH for payment/delivery flags,
  nullable returnPolicy/paymentNotes/deliveryNotes/deliveryFee. Keep price strings
  exact; null is unspecified, not zero. Use the existing seven-day hours editor.
  FAQs use the scoped CRUD/pagination routes documented in the Business API.
  Store logo uses multipart PUT `.../logo` with one file; DELETE removes it;
  profile GET exposes nullable logoUrl. Handle cleanupPending without claiming a
  successful saved logo failed. Keep existing WhatsApp connection management
  separate from ordinary contact-phone editing.

Backend additions require the reviewed migration before deploying their code.
They do not implement Android screens or modify the separate AI. See
[Business settings/policies/logo](business-api.md#policies-faqs-and-store-logo-2026-11-27-implementation)
and [Account contract](auth-api.md#account-screen-additions-2026-11-27).

Business settings are preferences, not payment/delivery implementations.
Working-hours PUT supplies all seven unique days; closed times are null/omitted,
open times are same-day HH:mm with no timezone/overnight support.

Choose same-business categoryId when editing Product metadata. Product listing
supports optional categoryId filtering; omission includes uncategorized Products.
Render business-defined options dynamically, not fixed Color/Size fields.
Simple Products have a default `{}` Variant; configurable Products may have none
until explicit selections are created. Use the actual Variant ID for stock.

Inactive records remain visible to the owner and retain identities. Product
reactivation does not reactivate Variants. isSellable does not reserve stock.
Manual stock is an absolute set; Android must not emulate order deductions by
calling inventory adjustment.

Images are Product Main/Gallery images, not Variant/color selectors. The first
ordered image is Main; apply returned ordering after Set Main/reorder and refresh
after deletion/promotion. Use a placeholder for no images. Upload either file or
1–5 repeated files parts, never both; let the library set the multipart boundary.
Files are JPEG/PNG/WebP, at most 10 MB (10,000,000 bytes) each and five occupied slots per Product.
cleanupPending retains recoverable metadata; retry the same scoped DELETE.
Do not assume every failed upload rolled back a possibly committed asset.

## Excel flow and recovery

Follow [the import workflow](excel-import-flow.md), with these UI requirements:

1. Upload `.xlsx` with an optional sheet name; changing sheet requires a new
   upload. Distinguish Product code, Variant SKU and option columns. Preserve
   leading zeroes by formatting code/SKU cells as Excel text.
2. Suggestions need confirmation. Duplicate/blank headers use one-based source
   indexes. IGNORE/UNMAPPED targets are explicit null.
3. READY can contain invalid Product groups. Validation results are a saved
   snapshot; preview checks current state and may differ.
4. Page the combined valid/invalid row sequence once; summary is workbook-wide.
   An INSERT preview row may lack generated IDs. Do not reuse execution DTOs as
   preview DTOs.
5. Execute once. After timeout, inspect compact job status/history before retry
   decisions. A failed response can follow already committed groups. Completed/
   failed jobs need a new corrected upload, not replay or a status reset.
6. Blank stock preserves existing stock/tracking; zero explicitly tracks zero.
   Blank import prices preserve overrides on update; Variant PATCH null clears
   an override. Counts are Variant rows, not distinct Products.

Do not add upload/execute/order operations to a generic automatic retry interceptor.
There is no durable import queue, cancel API or crash-resume endpoint.

## Customers, chat and Orders

Customer and conversation reads are scoped to the selected Business. Inbox order
uses lastMessageAt, not updatedAt. Message pages are newest-first; reverse for
display without changing API pagination. A customer message reopens a closed chat.
Respect aiEnabled/handoffReason/handoffAt and show the owner's takeover state.

The owner can reply and toggle AI. Free-text sending uses the 24-hour customer
message window; FAILED/PENDING/SENT are distinct outcomes. A 200 webhook response
or a persisted message does not prove customer delivery. Media download and
templates beyond that window are not implemented.

PURCHASE_INTENT is an alert, not an order. Use its persisted source message for
owner creation, then show the Backend's order snapshot/review state. Repeated
creation can return the existing order. Approval rechecks prices/activity/stock;
on ORDER_PRICE_CHANGED, obtain explicit owner consent before acceptCurrentPrices.
Stock moves only with successful approval. Notification failure does not undo the
order. See [Orders](orders-api.md). Actual Android screen readiness is unverified.

Android must not call the separate AI or internal read-tool endpoint. The Backend
also exposes an owner-authorized persisted-message AI trigger; its presence is
not a requirement to add a direct AI workflow to the app.

## Password recovery and App Links

Forgot Password requests an email OTP. Keep email in screen state and the code
as an eight-digit string with leading zeroes. Submit it with newPassword; there
is no separate verify-only endpoint or reset session. Generic 200 does not prove
inbox receipt. After successful empty 204, return to normal login; old sessions
are invalid. Codes/passwords do not belong in links, logs or analytics.

`GET /.well-known/assetlinks.json` still publishes the existing development
association. It is not OTP verification, health or provider readiness. Release/
Play signing and the matching manifest/domain require separately approved
certificate verification. No browser reset UI or GET reset-password handler is
implemented. The exact development fingerprint remains in
[the App Links contract](android-app-links.md).

See [authentication](authentication.md), [API navigation](api-guide.md) and
[errors](api-errors.md) for the retained wire contracts.
