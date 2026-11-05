# Brandora Backend

NestJS API for owner-managed businesses, products, variants, inventory and Excel
imports. The Backend owns authorization and data.

## Stack

TypeScript / NestJS, Prisma, PostgreSQL and Brevo HTTPS. Node.js >=22.12 is
required; compiled application modules use CommonJS.

## Implemented features

- JWT authentication, rotating sessions and business OWNER authorization.
- Business profiles, settings, working hours and categories.
- Canonical Products CRUD, dynamic variants and variant-level inventory.
- Excel analysis, mapping, validation, preview and execution.
- Brevo email OTP recovery with HMAC-protected, expiring single-use codes.

## Local setup

```sh
npm ci
```

Create a private `.env` from `.env.example` if one does not already exist.
Configure a local `DATABASE_URL` and the JWT settings in the
[local setup guide](docs/local-development.md). Keep secrets out of Git and
review database compatibility before applying existing migrations.

```sh
npm run build
npm run start:dev
```

Use `npm run start:prod` for the compiled application. Existing Railway Dashboard
build/start settings remain authoritative; see the
[release checklist](docs/railway-release-readiness.md).

## Verification

```sh
npm test
```

See [verification commands](verification/README.md) for isolated database tests
and [domain verification history](docs/product-domain-verification.md) for their scope and limits.

## Release scope

This release contains Product/Variant/Inventory/Excel Import, Cloudinary and
OTP-only Brevo recovery. AI integration is excluded; no AI routes or providers
are included. Orders and permanent Excel storage remain deferred.
See [image setup](docs/product-images.md).

## Documentation

- [Authentication and recovery](docs/auth-api.md)
- [Business API](docs/business-api.md)
- [Products and variants](docs/products-api.md)
- [Inventory](docs/inventory-api.md) / [Excel imports](docs/imports-api.md)
- [Railway proxy security](docs/railway-proxy-security.md)
- [Shared error contract](docs/api-errors.md)
