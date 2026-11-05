# Product images

Images are managed by the authenticated Business OWNER through the Backend.
There is no anonymous image-management or customer image-list endpoint.
Cloudinary files use public HTTPS CDN URLs: possession of a URL permits viewing
that file; these are product photos, not private documents.

## Configuration and uploads

Supply `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET`
privately to the Backend. The example values are empty. No credentials or upload
signatures are returned to Android. Unconfigured uploads fail with 503
`PRODUCT_IMAGE_UNAVAILABLE`; existing Product reads remain available.

The Backend uses Cloudinary's [signed HTTPS Upload API](https://cloudinary.com/documentation/image_upload_api_reference)
and [SHA-256 parameter signatures](https://cloudinary.com/documentation/authentication_signatures).
Each remote operation has a 30-second header/body timeout, rejects redirects and
bounds response JSON to 64 KiB. Provider failures are sanitized. No real cloud
upload is part of automated verification.

For P = /businesses/:businessId/products/:productId:

| Operation | Contract |
| --- | --- |
| POST P/images | Multipart one file; 201 image metadata plus cleanupPending |
| POST P/images | Alternatively 1-5 repeated files parts; 201 { items, cleanupPending }. Never mix file and files. |
| GET P/images | 200 { items }, ACTIVE images ordered by position, createdAt, id |
| PATCH P/images/:imageId | JSON { "isMain": true }; 200 { items } in the new order |
| PATCH P/images | JSON { "imageIds": ["<all-active-ids-in-order>"] }; 200 { items }, complete permutation of 1-5 distinct UUIDs |
| DELETE P/images/:imageId | 200 { deleted: true, cleanupPending }; retry pending cleanup with the same ID |

Existing owner JWT and active membership are required. Wrong Business/Product/image
IDs return 404. Files are memory-buffered, at most 5 MiB each, matching JPEG/PNG/
WebP MIME and magic bytes. SVG, arbitrary URLs, Cloudinary IDs and image attributes
are rejected. Maximum batch buffering is five files (25 MiB). Cloudinary must
return validated image metadata, with positive dimensions and at most 25 million
pixels. Remote requests keep their 30-second deadline and 64 KiB response bound.

## One Main Image and four Gallery Images

A Product has at most five ACTIVE or in-progress images across all Variants.
Color, Size, Weight and Variant attributes are not required or used. Upload fields
optionName/optionValue are rejected. Changing a Variant never selects an image.
colorOptionName remains optional legacy Product metadata, not an image selector.

The first activated image is Main automatically. Compact positions 0..4 define
order; position 0 means isMain=true. Further uploads append, never replace an
existing image. A batch preserves file order and activates all members atomically.

PATCH one image with isMain=true moves it to the front, preserving the relative
order of others. PATCH the collection sets the complete order; its first ID
becomes Main. Stale/incomplete/duplicate lists are rejected; refresh before retry.
Deletion compacts positions and promotes the first remaining image in saved order
(position, then createdAt and UUID). If no images remain, there is no Main. A
Gallery deletion preserves Main. Main cannot be cleared while images remain.

Product responses include the same ordered images. Metadata contains id,
productId, secureUrl, position, isMain, width, height, bytes, format, createdAt and
updatedAt. Nullable optionName/optionValue are legacy metadata only; ignore them.
Cloudinary public IDs and lifecycle states remain internal. Image actions never
change Variant price, effectivePrice, options, stock or inventory behavior.

## Atomic limits and concurrency

Every reservation, activation, reorder, Main change and deletion takes the
existing Business-scoped Product FOR UPDATE lock. Reservations count ACTIVE and
UPLOADING before any provider call. Over-capacity batches fail entirely with
400 PRODUCT_IMAGE_INVALID: no new rows, provider calls or partial success. Every
file is validated before reservation. No database lock is held over HTTPS.

Every started sibling upload is awaited before compensating a failed batch.
Activation and ordering commit in one short transaction. Unique ACTIVE positions
and a database CHECK of 0..4 enforce five active slots and one optional Main.
Reorders temporarily release ACTIVE slots only inside that transaction; readers
see old or new committed order. No queue, background worker or automatic retry.

## Failure and cleanup

Only confirmed UPLOADING reservations may become DELETE_PENDING and be destroyed
after upload/activation failure. An ambiguous commit must never destroy a possibly
ACTIVE asset. Database failure before confirmed deletion does not trigger remote
deletion. Failed compensation preserves recoverable metadata and its public ID.

DELETE hides an image and promotes/compacts remaining images transactionally,
then awaits Cloudinary deletion. Remote failure returns cleanupPending=true and
keeps DELETE_PENDING; explicitly retry the same owner-scoped DELETE. Main promotion
stays committed. A fresh UPLOADING row cannot be deleted for two minutes (409
PRODUCT_WRITE_CONFLICT). Remote not-found within that interval retains metadata:
an aborted upload may still finish remotely. Pending rows do not occupy gallery
slots but may still exist externally until cleanup succeeds.

PostgreSQL and Cloudinary do not share a transaction. Crashes/timeouts can leave
external orphans. Review stale UPLOADING/DELETE_PENDING rows and provider state;
never bulk-delete or destroy an ACTIVE asset based on an HTTP failure. Logs do
not contain credentials, image content or raw provider errors.

Excel Import preserves images/order. Product option edits no longer reassign or
invalidate images; existing Variant validation stays unchanged. Soft Product
deletion preserves images for reactivation.

## Upgrade and Android handoff

The forward-only migration 20261105000000_product_image_main_and_gallery_policy
adds position, replaces main/color partial indexes with ACTIVE slot uniqueness,
and preserves all rows, assets and legacy option metadata. The former Main stays
first; otherwise the oldest existing image is promoted (createdAt then UUID).
If a Product has more than five ACTIVE or UPLOADING images, migration stops for an explicitly
approved reconciliation. It never silently deletes images. The migration passed isolated Neon verification on 2026-11-05: 13/13 migrations,
backfill/constraint checks and 161 real PostgreSQL/application assertions.
Cloudinary was mocked; Production and real assets were not tested. Old
color-image writers must not overlap this policy.

Yasmin must use isMain/position and the ordered gallery, stop changing photos on
Variant selection, and stop sending optionName/optionValue. Add Set Main, reorder
and delete actions. Batch uploads use repeated files parts. Apply the returned
ordered list after PATCH; refresh GET after DELETE to reflect promotion. Empty
items uses the normal placeholder. Provider credentials remain solely in Backend.
See [database rollout](product-domain-database-rollout.md).

Malformed JSON/DTO fields can return the existing 400 VALIDATION_ERROR contract;
capacity/content/order checks use PRODUCT_IMAGE_INVALID. No new error code was added.
