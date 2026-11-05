# Backend local development

Use Node.js >=22.12, npm and an isolated local PostgreSQL database. Install the
checked-in dependency versions with `npm ci`. TypeScript uses Node16 resolution
and CommonJS output; `npm run build` generates Prisma Client and compiles NestJS.

## Environment and database

Create `.env` from `.env.example` only if a private file does not already exist.
Set DATABASE_URL to the intended local database. Configure JWT_SECRET, JWT_ISSUER
and JWT_AUDIENCE as described in [Authentication](auth-api.md); missing signing
configuration prevents startup. Preserve existing private settings.

Before applying migrations to an existing database, review its schema and data:

```sh
npx prisma validate
npx prisma migrate status
```

After reviewing the target and approving initialization, `npm run prisma:deploy`
applies checked-in migrations. Do not reset a database containing valuable data.
No command here grants permission for production operations.

```sh
npm run build
npm run start:dev
```

The default port is 3000. `npm run start:prod` runs the compiled application.
For development, `npm run prisma:generate` is also available.

## Business and domain APIs

Register or log in, then use the returned access token for owner routes.
`POST /businesses` returns HTTP 201 and creates default settings with OWNER
membership. See the [Business API](business-api.md) for request examples and
profile/settings/hours contracts; ownership is never granted by a supplied ID.

[Products](products-api.md) is the canonical product CRUD API. Variants own
inventory; stock mutation belongs to [Inventory](inventory-api.md), not metadata
updates. [Excel imports](imports-api.md) retain business-scoped externalKey
matching. Orders, payments and stock reservations remain separate work.
Working hours currently exclude overnight periods, holiday exceptions and timezones.

## Files and verification

Uploads and validation results use `.storage/imports` or IMPORT_STORAGE_DIR.
Permanent Excel storage is deferred; a filesystem path is not a persistence
guarantee across redeploys. Product images use Cloudinary; see
[setup and image limits](product-images.md). Image recognition is not implemented.

`npm test` builds and runs maintained mocked regressions. The optional
`test:products:postgres`, `test:auth:postgres`, `test:auth-hardening:postgres` and
`test:variant-inventory:postgres` scripts use fresh disposable local databases;
see [verification](../verification/README.md) for exact prerequisites.
The historical product-foundation SQL verifier targets an earlier schema.

AI integration is excluded from this release; no local AI runner is packaged.
Read the [Railway release checklist](railway-release-readiness.md) and
[proxy security review](railway-proxy-security.md) before publication.
