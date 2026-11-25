# Maintained verification entry point

Use [testing and verification](../docs/testing.md) for the command matrix,
fixture lifecycle, safety boundaries and dated evidence.

```sh
npm test
npm run test:businesses
```

Both commands build first. Jest discovers maintained suites under this directory;
persistence/providers are mocked, and the native Business runner is invoked by
its adapter. Real PostgreSQL commands are separate and require an explicitly
disposable local server. No report or source under `.tmp/` is an execution input.

After building, `node verification/controller-route-inventory.cjs` verifies the
compiled route policies without connecting to a database. The current source
and compiled inventory, migration/model counts and historical results are recorded
with their scope in [testing](../docs/testing.md#route-policy-and-source-inventory).
Do not present a historical run as a new result.

The framework configuration, maintained regression files, HTTP verifiers,
fixtures and local tools remain unchanged by documentation consolidation.
