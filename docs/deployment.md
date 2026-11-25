# Deployment and operations

This guide describes repository requirements, not a current Railway/Neon health
or deployment report. Confirm the intended service, release SHA, database history,
feature flags and provider accounts before publication. Historical Dashboard
settings and schema observations are not assumed valid today.

## Build and startup

Use Node.js satisfying `package.json` (at least 22.12) and the checked-in npm
lockfile. Prisma CLI, Nest CLI and TypeScript must be available during the build;
installing only production dependencies before compilation is insufficient.

```sh
npm ci
npm run build
npm run start:prod
```

Build runs Prisma generation followed by Nest compilation. Production startup
runs `node dist/main.js`; development uses `npm run start:dev`. Neither build nor
startup applies migrations. Preserve the configured PORT supplied by the host.
No `/health` endpoint, repository Railway configuration-as-code or Swagger route
is implemented. App Links JSON is not a database-readiness check.

Configure Railway build/start commands to match the repository after owner
verification of the service. A push can trigger auto-deployment; that behavior
and the actual tracked branch must be checked in the Dashboard, not inferred
from historical reports. No deployment setting is changed by documentation.

## Environment requirements

Create a private `.env` from [.env.example](../.env.example) for local use;
deployment values belong in the platform's secret configuration. Never publish
actual connection strings, keys, tokens or exported private environments.

| Variables                                                        | Requirement / behavior                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DATABASE_URL                                                     | Intended PostgreSQL URL; application initialization connects to this database. Confirm the target privately.                                                  |
| PORT                                                             | Host-provided port; defaults to 3000 locally, valid range 1–65535.                                                                                            |
| JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE                             | Required signing configuration; secret at least 32 UTF-8 bytes; consistent across replicas.                                                                   |
| AUTH_RATE_LIMIT_SECRET                                           | Optional separate secret, at least 32 bytes; otherwise JWT_SECRET is used for purpose-specific rate/OTP keys. Rotation affects counters and outstanding OTPs. |
| AUTH_TRUSTED_PROXY_CIDRS                                         | Empty means trust no forwarded proxy assertions. Configure only for a verified sanitizing ingress boundary.                                                   |
| AUTH_EMAIL_MODE                                                  | `disabled` in the template; recovery requires `brevo`. Legacy SMTP/Resend modes are not supported.                                                            |
| BREVO_API_KEY, BREVO_SENDER_EMAIL                                | Private Brevo API key and verified bare sender address. Required for recovery email, not normal signup/login startup.                                         |
| CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET | Required for image provider operations. Missing values do not disable ordinary Product reads.                                                                 |
| IMPORT_STORAGE_DIR                                               | Optional filesystem directory; defaults to `.storage/imports`. Requires durable storage design for retained jobs across redeploys.                            |
| AI_INTEGRATION_ENABLED                                           | Disabled unless exactly `true`; implementation is present, activation is separate.                                                                            |
| AI_BASE_URL                                                      | AI origin only; HTTPS or explicit HTTP loopback; no credentials, path, query or fragment.                                                                     |
| AI_SERVICE_TOKEN, BACKEND_SERVICE_TOKEN                          | Distinct directional service credentials, printable non-whitespace ASCII, 32–4096 characters.                                                                 |
| AI_CONTEXT_PRIVATE_KEY                                           | Backend RSA signing key, at least 2048 bits. The separate AI service receives the public key only.                                                            |
| AI_LOCAL_ENABLED                                                 | Separate local harness flag; does not register a development controller in AppModule. See the local harness guide.                                            |
| WHATSAPP_ENABLED                                                 | Disabled unless exactly `true`; enabled webhook/sending paths require the relevant settings.                                                                  |
| WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET                       | Private verification and raw-body signature secrets.                                                                                                          |
| WHATSAPP_ACCESS_TOKEN                                            | Required for real sending; dry run does not need an access token.                                                                                             |
| WHATSAPP_GRAPH_VERSION                                           | Source default `v26.0`; operators must confirm provider support for the configured version.                                                                   |
| WHATSAPP_DRY_RUN                                                 | Anything except `false` keeps outbound sending in dry run. This does not prove real delivery.                                                                 |
| REPLY_RECOVERY_SECONDS                                           | Default 30; zero/nonpositive disables the recovery timer. The pass also requires WhatsApp enabled.                                                            |

External AI-service environment names and budgets are separately owned. See the
[negotiated contract](ai-contract.md) and [Backend integration](ai-integration.md).
Do not copy local harness credentials or loopback fixture URLs into production.

## Database and Neon

There are 19 committed migration directories, not necessarily 19 applied
migrations in any environment. Review the actual target's schema/history,
checksums, guards, backup/recovery procedure and compatibility with all writers.
Only an explicitly approved operator should run migration deployment there:

```sh
npm run prisma:deploy
```

For a fresh disposable local database, review its URL first; use
`npm run prisma:validate`, `npm run prisma:generate` and the checked-in deployment
command. Do not use production migrate dev/reset/db push or cleanup SQL to force
compatibility. The historical parent-stock removal and physical Product rename
can require a coordinated maintenance window. Applied migrations are immutable.
See [database strategy](database.md#migration-strategy).

No Neon branch identity, compute size, pooling configuration or current schema
is certified here. Confirm the intended connection and permissions privately.
Plan locks/timeouts and a tested recovery path. Never overlap old physical-name
readers or obsolete color-image writers with incompatible migrations.

## Providers and persistence

- **Brevo:** verify the sender/domain and API permission in the intended account.
  API acceptance is not inbox delivery. Recovery is synchronous, with an
  eight-second provider deadline and an 8.5-second minimum configured response.
  Test delivery, expiry, reuse rejection and session invalidation separately.
- **Cloudinary:** Backend-only signed HTTPS transport; public product-image URLs
  are viewable by anyone possessing the URL. Each operation has a 30-second
  deadline and 64-KiB JSON response limit. Check upload/delete/CDN/device behavior
  separately from mocked tests. Review retained UPLOADING/DELETE_PENDING state
  before any manual reconciliation; never destroy possibly ACTIVE assets blindly.
- **WhatsApp:** confirm the Meta app/number, signature secrets, subscription and
  approved live-send mode. The 24-hour free-text window and ambiguous-send failure
  behavior remain application limits; media download/templates are not implemented.
- **AI:** the persistent adapter exists. Enablement requires approved credentials,
  contract alignment and end-to-end acceptance, not a claim that the adapter is
  unavailable. Real model behavior is outside mocked transport results.
- **Imports:** local workbook/snapshot files are retained and have no general
  automatic TTL. Ephemeral filesystems or multiple instances without shared
  storage can make a retained job unreadable. No persistent volume/object store,
  durable queue or automatic execution takeover is provisioned by this project.

Review HTTP body/time budgets for synchronous imports and image batches. Do not
configure arbitrary retries of upload/execute/order actions after ambiguous
responses; inspect persisted status first. Provider notification failures do not
undo an already committed order or image metadata transition.

## Release acceptance and owner decisions

Verify the actual ingress trust boundary, deployed release/schema, signing
configuration, Android release certificate and external provider behavior. Empty
proxy trust resists header spoofing but can aggregate users behind a shared peer;
it is not proof of Railway per-client quota attribution.

The [historical ingress analysis](railway-proxy-security.md) and
[Product rollout report](product-domain-database-rollout.md) remain for owner
review, not as current infrastructure facts or executable release authorization.
Two historical local-only migration planning/cleanup files were owner-deleted
without executing their SQL. Do not recreate them or add cleanup to build/start.

No live provider, database, Railway or Neon change is authorized by this guide.
Use [testing](testing.md) for isolated verification commands and their limits.
