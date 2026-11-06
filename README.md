# Brandora Backend

NestJS API for owner-managed businesses, products, variants, inventory and Excel
imports. The Backend owns authorization and data; the FastAPI AI service lives
in a separate repository and is deployed independently by Malak.

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
and [recorded results](docs/local-verification.md) for their scope and limits.

## AI integration status

The local loopback harness supports independent synthetic messages against real
local product data. Production integration remains disabled until authorized
conversation persistence and end-to-end acceptance are ready. Live Groq and
production email delivery require separate verification. Product images use
Cloudinary with server-side credentials; see [image setup](docs/product-images.md).
Image recognition, Orders and permanent Excel file storage remain deferred.

## Documentation

- [Authentication and recovery](docs/auth-api.md)
- [Business API](docs/business-api.md)
- [Products and variants](docs/products-api.md)
- [Inventory](docs/inventory-api.md) / [Excel imports](docs/imports-api.md)
- [AI security and contracts](docs/ai-integration.md)
- [Local AI / Postman testing](docs/ai-local-testing.md)
- [Railway proxy security](docs/railway-proxy-security.md)
- [Shared error contract](docs/api-errors.md)
