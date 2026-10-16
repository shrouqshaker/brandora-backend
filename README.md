# Brandora Backend

NestJS API for business profiles, catalog items, Excel imports, and inventory.
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
npm run test:businesses
```

This builds the application and checks business HTTP routes, input validation,
and settings defaults using a test double for Prisma. It does not connect to or
modify a real PostgreSQL database; database integration must be checked separately.

TypeScript uses `Node16` module resolution and output. The package remains
CommonJS, so compiled application files remain CommonJS.

## API documentation

- [Business profiles, settings, and working hours](docs/business-api.md)
- [Catalog](docs/catalog-api.md)
- [Excel imports](docs/imports-api.md)
- [Inventory](docs/inventory-api.md)
- [Error contract](docs/api-errors.md)

## Current limits

Authentication and business ownership checks are not implemented. Working hours
do not support overnight opening, holiday exceptions, or timezones. Orders,
payments, stock reservations, images, and product variants require separate work.
