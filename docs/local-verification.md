# Local verification evidence

Results below are local observations on 2026-11-04. They are not production
acceptance, live Groq verification or email-delivery confirmation.

## Integration verification before documentation cleanup

| Layer                     | Actual result                                                  | Scope                                                                       |
| ------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Backend build             | npm run build, exit 0                                          | Prisma client generation and Nest compilation                               |
| Backend full suite        | 26 suites / 758 tests passed; native Business runner 16 passed | Mocked persistence and maintained regressions                               |
| AI focused suites         | 737 passed, one dependency deprecation warning                 | Mocked transports, canonical/security/history/rules checks                  |
| Two-service HTTP          | 71 assertions passed                                           | Real loopback NestJS, FastAPI and fresh local PostgreSQL; rules mode        |
| Postman collection replay | 13 requests passed                                             | Exact collection requests sent by Node; Postman GUI/pm runtime not executed |

The HTTP check verified variant overrides (Black/L 275.00, quantity 7),
base-price fallback (Black/M 250.00, quantity 0), White/L 290.00, untracked
quantity null, tenant isolation, signed-body integrity, expiry, wrong-direction
credentials and revoked fixture ownership. Missing history returned clarification.
No real customer/conversation/message persistence or provider request was used.

The 46-route inventory contained 38 owner-JWT-protected routes, one separately
service-guarded internal AI route and seven anonymous routes, with zero mismatches.
Those historical counts describe the local application at that point; the separate development
runner is not registered in AppModule.

The later Product naming / Cloudinary work adds three owner-only image routes:
the current inventory is 51 routes, 43 owner-JWT-protected, one separately
service-guarded internal AI route and seven anonymous routes. See
[current domain verification](product-domain-verification.md) for that work's
build, test, PostgreSQL and isolated Neon results.

## Repeatable checks and their limits

- `npm test` runs maintained Backend regressions and builds first.
- `node verification/controller-route-inventory.cjs` checks compiled policy metadata.
- `node verification/ai-cross-contract.cjs --ai-dir ../brandora-ai --python <python>`
  runs a synthetic, offline cross-repository contract check without SQL or a provider.
- `node verification/replay-ai-postman.cjs` replays the maintained collection
  against already running local services.
- `node verification/ai-local-http.cjs --ai-dir ../brandora-ai --python <python>`
  starts its own two local services with a new disposable database.
- AI pytest commands are in its `docs/LOCAL_BACKEND_POSTMAN.md`.

`<python>` is an installed interpreter or virtual-environment executable. No
ignored snapshot or machine-specific interpreter path is required.
Cross-contract checks use synthetic identities/transport and do not substitute
for the separate real HTTP layer. Rules results do not establish live Groq.
Full end-to-end tests need not be repeated for documentation-only cleanup.

## Documentation cleanup verification

On 2026-11-04, TypeScript no-emit validation passed. Four focused Backend suites
passed all 115 tests. Three focused AI suites passed 366 tests, with the same
dependency deprecation warning. The relocated offline cross-contract check passed
without network or database access. Full two-service HTTP/database tests were not
repeated because no application execution dependency changed; Python test tooling
and active local configuration were preserved.
