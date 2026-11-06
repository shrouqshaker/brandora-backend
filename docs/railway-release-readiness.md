# Railway release readiness

This is a preparation checklist, not a deployment report. The gallery-policy
migration passed isolated Neon verification (13/13 migrations, 161 real
PostgreSQL/application assertions); Production and real Cloudinary/OTP tests
were not performed. No live Railway
settings or deployments were changed. The later Product-domain audit inspected
production Neon schema/history read-only and tested new migrations on an isolated
Neon child branch; see [its coordinated rollout gate](product-domain-database-rollout.md).
Publication, environment changes, real email and database operations require their
respective owner approvals. Conversation integration and permanent import storage
remain deferred.

The Product/ProductImage release requires the three forward migrations
and a coordinated maintenance window because deployed code still queries
CatalogItem. Do not run production migrate/deploy as part of this checklist.

## Build and startup

The existing Railway production service uses GitHub repository
`shrouqshaker/brandora-backend`. Per the owner's previously verified Dashboard
settings, build is `npm run build` (Prisma client generation and Nest compilation)
and start is `npm run start:prod` (`node dist/main.js`). Preserve these Dashboard
settings. No repository configuration-as-code file is required or retained.
These settings were not independently rechecked against Railway in this task.

Use a supported Node version satisfying `package.json` (at least 22.12). Build
dependencies must be available during compilation. The application listens on
the supplied `PORT`; let Railway provide it rather than copying local port 3000.
There is no `/health` route in this checkout. No healthcheck path or pre-deploy
migration command is introduced by this preparation. Do not use an Auth POST
endpoint as a healthcheck or treat the App Links JSON as database readiness.

Before publishing main, the owner must confirm source repository, tracked branch,
release SHA and auto-deploy settings. A push can trigger a deployment. Existing
database compatibility must be reviewed separately before deployment. The local-only
operational files `docs/production-migration-preflight.md` and
`verification/production-variant-cleanup.sql` are outside the application release
and remain held for separate owner approval. Do not automatically run those
procedures or add migration/cleanup commands to build or start.

## Runtime variables (names only for secrets)

| Variable                                   | Required action                                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                             | Preserve the existing intended database connection privately; never substitute the local example.                                               |
| `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE` | Preserve existing signing configuration; changing it affects sessions.                                                                          |
| `AUTH_RATE_LIMIT_SECRET`                   | Preserve the existing secret, or existing JWT fallback; changing it resets rate-limit key identity.                                             |
| `AUTH_TRUSTED_PROXY_CIDRS`                 | Leave empty unless a sanitizing ingress boundary is independently verified. Do not trust arbitrary private ranges or all proxies.               |
| `AUTH_EMAIL_MODE`                          | Set `brevo` only with the approved API key, sender and URL ready; otherwise `disabled`. Legacy `smtp` and `resend` are rejected. |
| `BREVO_API_KEY`                           | Supply privately, with sending permission for the approved sender. Never paste into tickets or logs.                                            |
| `BREVO_SENDER_EMAIL` | Bare sender email verified in the intended Brevo account; authenticate its owned domain. The old SMTP_FROM setting is not a fallback. |
| `AI_INTEGRATION_ENABLED`                   | Keep `false`; default conversation persistence is unavailable.                                                                                  |
| `IMPORT_STORAGE_DIR`                       | Preserve the existing setting; no volume or storage provider is provisioned here. Local files are not a persistence guarantee across redeploys. |

`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
and `RESEND_API_KEY` are no longer
read by the new transport. They need not be changed for this release preparation.
No queue key is required. Do not copy the generated local AI secrets or loopback
URLs into production; AI enablement is deferred and credentials must be provisioned
separately when approved. Never forward owner login/JWT credentials to AI.

## Forgot Password checks

Recovery is OTP-only: Android must send email/otp/newPassword, not token.
AUTH_RESET_URL is unused. Coordinate the Android contract change before release.
The existing AUTH_RATE_LIMIT_SECRET (or JWT_SECRET fallback) must be stable
across replicas; rotating it invalidates pending codes. See [Authentication](auth-api.md).

The implementation remains synchronous: persist an email-bound HMAC of the eight-digit OTP as `PENDING`, await
Brevo HTTPS (8-second timeout including response body), then mark the matching
token `SENT` on acceptance. Delivery failures attempt to mark it `FAILED` and
consumed; if that database write also fails, a `PENDING` token still cannot be
redeemed. Known and unknown accounts return the same generic response with an
8.5-second minimum. Missing email configuration returns the same 503 before
account lookup. The floor reduces normal timing differences; unusually slow
database work can exceed it and is not a constant-time guarantee.

Tokens retain 15-minute expiry, single use and session invalidation. Brevo API
acceptance is not proof of inbox delivery. Production senders need an approved
[sender and authenticated domain](https://developers.brevo.com/docs/getting-started-with-senders-and-domains).
See [authentication](auth-api.md) for owner-only verification and the separate
real-email test plan. No credentials or provider account changes are made here.

After explicit approval for a real test, use a disposable account and confirm
provider acceptance, delivered/bounced status, actual inbox receipt, correct
Android OTP entry, successful reset, rejected code reuse and invalidated
old sessions. Use a separate request to verify expiry after 15 minutes. Never
record tokens, email bodies or passwords in reports. No real email is sent by the
automated tests.

## Remaining owner decisions

- Resolve or explicitly assess the shared-proxy rate-limit availability risk in
  [Railway proxy security](railway-proxy-security.md). Keeping proxy trust empty
  resists spoofing but can aggregate different users behind one proxy peer.
- Obtain the actual release/Play signing certificate fingerprint and verify the
  matching Android manifest/domain. The checked-in association currently contains
  a development certificate only; no certificate change is made here.
- Confirm the sending domain/key privately and separately approve the real-email
  test. Local build/test success alone does not establish delivery readiness.
- Complete schema compatibility review before approving publication. This email
  and deployment-readiness documentation adds no schema or migration.

The current checks do not claim that the live service is configured, migrated,
healthy or delivering mail. The Brevo email transport introduces no table,
migration, worker or new infrastructure. The combined Product release separately
adds ProductImage and renames CatalogItem/product foreign-key columns through the
three forward migrations; its coordinated cutover gate still applies.

Product gallery policy additionally requires `20261105000000_product_image_main_and_gallery_policy`.
It adds ordered slots 0..4, preserves image rows and refuses a Product with more
than five active or uploading images. Isolated Neon migration/backfill/constraint
and concurrency checks passed; Production cutover still needs explicit approval. Old color-image writers must not overlap
this policy. See [image policy](product-images.md).
