// New localhost databases only. No .env, remote URL, reset or existing-db deletion.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const root = path.resolve(__dirname, '..');
const migrations = fs
  .readdirSync(path.join(root, 'prisma/migrations'))
  .filter((n) =>
    fs.existsSync(path.join(root, 'prisma/migrations', n, 'migration.sql')),
  )
  .sort();
const pending = migrations.filter(
  (n) => n.startsWith('20261104') || n.startsWith('20261105'),
);
assert.equal(pending.length, 3);
for (const name of pending) {
  const sql = fs.readFileSync(
    path.join(root, 'prisma/migrations', name, 'migration.sql'),
    'utf8',
  );
  assert.doesNotMatch(
    sql,
    /\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i,
  );
}
const local = { host: '127.0.0.1', port: 55439, user: 'postgres' };
async function main() {
  const admin = new Client({ ...local, database: 'postgres' });
  await admin.connect();
  try {
    for (const mode of ['fresh', 'upgrade']) {
      const database = `brandora_product_${mode}_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE "${database}"`);
      const sql = new Client({ ...local, database });
      await sql.connect();
      try {
        let snapshot;
        if (mode === 'upgrade') {
          await sql.query(`CREATE TABLE "_prisma_migrations" (
            id VARCHAR(36) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, finished_at TIMESTAMPTZ,
            migration_name VARCHAR(255) NOT NULL, logs TEXT, rolled_back_at TIMESTAMPTZ,
            started_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_steps_count INTEGER NOT NULL DEFAULT 0)`);
          for (const name of migrations.filter((n) => !pending.includes(n))) {
            const body = fs.readFileSync(
              path.join(root, 'prisma/migrations', name, 'migration.sql'),
              'utf8',
            );
            await sql.query(body);
            await sql.query(
              'INSERT INTO _prisma_migrations(id,checksum,migration_name,finished_at,applied_steps_count) VALUES ($1,$2,$3,now(),1)',
              [
                randomUUID(),
                createHash('sha256').update(body).digest('hex'),
                name,
              ],
            );
          }
          const business = randomUUID(),
            product = randomUUID(),
            variant = randomUUID();
          await sql.query(
            'INSERT INTO "Business"(id,name,"updatedAt") VALUES ($1,\'Preserved\',now())',
            [business],
          );
          await sql.query(
            'INSERT INTO "CatalogItem"(id,"businessId",name,"externalKey",options,"updatedAt") VALUES ($1,$2,\'Preserved product\',\'preserve-external-key\',\'{"Color":["Black"],"Size":["M"]}\',now())',
            [product, business],
          );
          await sql.query(
            'INSERT INTO "ProductVariant"(id,"businessId","catalogItemId",sku,"optionValues","trackInventory","stockQuantity","updatedAt") VALUES ($1,$2,$3,\'PRESERVED-SKU\',\'{"Color":"Black","Size":"M"}\',true,7,now())',
            [variant, business, product],
          );
          await sql.query(
            'INSERT INTO "InventoryMovement"(id,"businessId","catalogItemId","variantId",type,"quantityBefore","quantityAfter","quantityDelta","trackingBefore","trackingAfter") VALUES ($1,$2,$3,$4,\'INITIAL_IMPORT\',NULL,7,7,false,true)',
            [randomUUID(), business, product, variant],
          );
          snapshot = {};
          for (const table of [
            'Business',
            'CatalogItem',
            'ProductVariant',
            'InventoryMovement',
          ])
            snapshot[table] = (
              await sql.query(
                `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`,
              )
            ).rows;
        }
        const result = spawnSync(
          process.execPath,
          ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
          {
            cwd: root,
            env: {
              ...process.env,
              DATABASE_URL: `postgresql://postgres@127.0.0.1:55439/${database}`,
            },
            encoding: 'utf8',
            timeout: 90000,
          },
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(
          (
            await sql.query(
              'SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
            )
          ).rows[0].n,
          migrations.length,
        );
        assert.equal(
          (await sql.query(`SELECT to_regclass('public."CatalogItem"') AS old`))
            .rows[0].old,
          null,
        );
        assert.equal(
          (await sql.query(`SELECT count(*)::int AS n FROM "ProductImage"`))
            .rows[0].n,
          0,
        );
        if (snapshot) {
          for (const [table, before] of Object.entries(snapshot)) {
            const after = (
              await sql.query(
                `SELECT to_jsonb(t) AS row FROM "${table === 'CatalogItem' ? 'Product' : table}" t ORDER BY id`,
              )
            ).rows;
            for (const entry of after) {
              if (table === 'CatalogItem') delete entry.row.colorOptionName;
              if ('productId' in entry.row) {
                entry.row.catalogItemId = entry.row.productId;
                delete entry.row.productId;
              }
            }
            assert.deepEqual(
              after,
              before,
              `${table} data must survive rename`,
            );
          }
        }
        assert.equal(
          (
            await sql.query(
              `SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated`,
            )
          ).rows[0].n,
          0,
        );
        console.log(
          `PASS ${mode}: ${migrations.length} migrations, ${pending.length} new non-destructive migrations; ${snapshot ? 'all seeded rows/IDs/stock/history preserved' : 'fresh schema verified'}. Database ${database}`,
        );
      } finally {
        await sql.end();
      }
    }
  } finally {
    await admin.end();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
