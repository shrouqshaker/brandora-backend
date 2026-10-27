# Brandora Backend

NestJS API for business profiles, categories, products/variants, catalog items,
Excel imports, and inventory.
PostgreSQL data access uses Prisma. Authentication, orders, and payment processing
are not implemented in this version.

## Local setup

Use Node.js 22.12 or newer and install the checked-in dependencies:

```sh
npm ci
```

Copy `.env.example` to `.env` and configure `DATABASE_URL` for PostgreSQL.
Keep credentials out of Git. Check an existing database before applying changes:

```sh
npx prisma validate
npx prisma migrate status
```

Apply pending checked-in migrations to a provisioned database using
`npm run prisma:deploy`. Do not reset a database containing data you need.

Build and run:

```sh
npm run build
npm run start:prod
```

For development, use `npm run prisma:generate` and `npm run start:dev`.
The default port is 3000. Uploaded files and validation results are stored in
`.storage/imports`, or the directory set by `IMPORT_STORAGE_DIR`.

## Create a business

Send `POST /businesses` with `Content-Type: application/json`:

```json
{
  "name": "Sample Bakery",
  "category": "Bakery"
}
```

The response is HTTP 201 with the generated business ID and profile. Default
settings are persisted together with the business in one nested write. Use that
ID for the existing profile, settings, working-hours, catalog, imports, and
inventory routes. No new database migration is needed for this endpoint.

## Verification

```sh
npm test
npm run test:businesses
```

These build the application and run maintained HTTP/unit regressions with mocked
persistence; `test:businesses` runs just the native business suite. For explicit
local-only database verification, start disposable PostgreSQL on 127.0.0.1:55439
and run `npm run test:products:postgres` and
`node prisma/verification/product-foundation.cjs`. They create and retain new local
databases and never read the production URL. See [verification](verification/README.md).

TypeScript uses `Node16` module resolution and output. The package remains
CommonJS, so compiled application files remain CommonJS.

## API documentation

- [Business profiles, settings, and working hours](docs/business-api.md)
- [Catalog](docs/catalog-api.md)
- [Categories, Products, and ProductVariants](docs/products-api.md)
- [Excel imports](docs/imports-api.md)
- [Inventory](docs/inventory-api.md)
- [Error contract](docs/api-errors.md)

## Current limits

Authentication and business ownership checks are not implemented. Working hours
do not support overnight opening, holiday exceptions, or timezones. Orders,
payments, stock reservations, images, variant inventory operations, and upgrading
Excel imports to create variants require separate work. Product/Variant CRUD
does not implement stock mutation or order availability.
