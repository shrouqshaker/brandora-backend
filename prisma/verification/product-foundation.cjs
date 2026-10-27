// Uses only a disposable local database. Never reads DATABASE_URL or .env.
// Start a local PostgreSQL instance, then: node prisma/verification/product-foundation.cjs
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const {
  verifyVariantOptions,
  verifyForwardUpgrade,
} = require('./variant-options.cjs');

const root = path.resolve(__dirname, '../..');
const migration = '20261027000000_add_product_variants_categories';
const local = { host: '127.0.0.1', port: 55439, user: 'postgres' };
const database = `brandora_verify_${randomUUID().replaceAll('-', '')}`;
const url = `postgresql://postgres@127.0.0.1:55439/${database}`;
const freshDatabase = `${database}_fresh`;
let targetUrl = url;
const admin = new Client({ ...local, database: 'postgres' });
const db = new Client({ ...local, database });
const peers = [];
const createdDatabases = [];

function prisma(...args) {
  const result = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', ...args],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: targetUrl },
      encoding: 'utf8',
      timeout: 60000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

async function rejects(sql, params, code, constraint) {
  await assert.rejects(
    db.query(sql, params),
    (error) =>
      error.code === code && (!constraint || error.constraint === constraint),
  );
}

async function snapshot() {
  const result = {};
  for (const table of [
    'Business',
    'BusinessSettings',
    'WorkingHour',
    'CatalogItem',
    'InventoryMovement',
    'ImportJob',
  ]) {
    result[table] = (
      await db.query(
        `SELECT to_jsonb(t) - 'categoryId' - 'options' AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
      )
    ).rows;
  }
  return result;
}

// Hold an uncommitted insert while a second connection attempts a duplicate.
async function concurrentUnique(sql, first, second, constraint) {
  const peer = new Client({ ...local, database });
  peers.push(peer);
  await peer.connect();
  await peer.query("SET statement_timeout = '5s'");
  await db.query('BEGIN');
  let outcome;
  try {
    await db.query(sql, first);
    const pending = peer.query(sql, second).then(
      () => ({ code: 'accepted' }),
      (error) => ({ code: error.code, constraint: error.constraint }),
    );
    // Wait for PostgreSQL to confirm the peer is blocked on the first writer.
    const deadline = Date.now() + 4000;
    let blocked = false;
    while (Date.now() < deadline) {
      const { rows } = await db.query(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
        [peer.processID],
      );
      if (rows[0]?.wait_event_type === 'Lock') {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      await db.query('SELECT pg_stat_clear_snapshot()');
    }
    assert.ok(blocked, 'duplicate writer must block on unique index');
    await db.query('COMMIT');
    outcome = await pending;
  } finally {
    await db.query('ROLLBACK');
  }
  assert.equal(outcome.code, '23505');
  if (constraint) assert.equal(outcome.constraint, constraint);
}

async function main() {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${freshDatabase}"`);
  createdDatabases.push(freshDatabase);
  targetUrl = `${url}_fresh`;
  prisma('migrate', 'deploy');
  prisma('migrate', 'deploy');
  prisma('migrate', 'status');
  targetUrl = url;
  await admin.query(`CREATE DATABASE "${database}"`);
  createdDatabases.push(database);
  await db.connect();
  const migrations = fs
    .readdirSync(path.join(root, 'prisma/migrations'))
    .filter(
      (name) =>
        name < migration &&
        fs.existsSync(
          path.join(root, 'prisma/migrations', name, 'migration.sql'),
        ),
    )
    .sort();
  for (const name of migrations) {
    await db.query(
      fs.readFileSync(
        path.join(root, 'prisma/migrations', name, 'migration.sql'),
        'utf8',
      ),
    );
    prisma('migrate', 'resolve', '--applied', name);
  }

  const a = randomUUID(),
    b = randomUUID(),
    item = randomUUID(),
    other = randomUUID();
  await db.query(
    `INSERT INTO "Business" (id, name, category, "updatedAt") VALUES ($1, 'A', 'Business profile', now()), ($2, 'B', NULL, now())`,
    [a, b],
  );
  await db.query(
    `INSERT INTO "BusinessSettings" ("businessId", "acceptsCash", "updatedAt") VALUES ($1, false, now()), ($2, true, now())`,
    [a, b],
  );
  await db.query(
    `INSERT INTO "WorkingHour" (id, "businessId", "dayOfWeek", "isOpen", "opensAt", "closesAt", "updatedAt") VALUES ($1,$2,'MONDAY',true,'09:00','17:00',now())`,
    [randomUUID(), a],
  );
  await db.query(
    `INSERT INTO "CatalogItem" (id, "businessId", name, "externalKey", category, "basePrice", "trackInventory", "stockQuantity", attributes, "isActive", "updatedAt")
    VALUES ($1, $2, 'Legacy', 'EXCEL-1', '  Drinks  ', 19.95, true, 12, '{"color":"red"}', false, now()),
           ($3, $4, 'Other tenant', NULL, NULL, NULL, false, NULL, NULL, true, now())`,
    [item, a, other, b],
  );
  for (const [tenant, key, category, quantity, tracking, active] of [
    [a, null, '\tDRINKS\n', 0, false, true],
    [a, null, ' \t\n ', null, true, false],
    [a, 'SKU-CASE', null, 9, true, true],
    [b, 'EXCEL-1', 'drinks', 27, true, false],
    [b, null, '  Soft\t Drinks ', 0, false, true],
    [b, 'ARABIC', '  مشروبات  ', null, false, true],
  ]) {
    await db.query(
      `INSERT INTO "CatalogItem" (id, "businessId", name, "externalKey", category,
        "stockQuantity", "trackInventory", "isActive", "updatedAt")
       VALUES ($1,$2,'Fixture',$3,$4,$5,$6,$7,'2026-10-01T10:00:00Z')`,
      [randomUUID(), tenant, key, category, quantity, tracking, active],
    );
  }
  await db.query(
    `INSERT INTO "ImportJob" (id, "businessId", "fileName", "fileKey", status, "updatedAt") VALUES ($1, $2, 'legacy.xlsx', 'private/key', 'COMPLETED', now())`,
    [randomUUID(), a],
  );
  await db.query(
    `INSERT INTO "InventoryMovement" (id, "businessId", "catalogItemId", type, "quantityBefore", "quantityAfter", "quantityDelta", "referenceType", "referenceId") VALUES ($1, $2, $3, 'INITIAL_IMPORT', NULL, 12, 12, 'IMPORT_JOB', 'legacy')`,
    [randomUUID(), a, item],
  );
  const before = await snapshot();
  prisma('migrate', 'deploy');
  assert.deepEqual(
    await snapshot(),
    before,
    'every legacy column and row must survive',
  );
  for (const table of ['Category', 'ProductVariant']) {
    assert.equal(
      (await db.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n,
      0,
      'migration must not backfill data',
    );
  }
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM "CatalogItem" WHERE "categoryId" IS NULL AND options=\'{}\'::jsonb',
      )
    ).rows[0].n,
    before.CatalogItem.length,
  );
  const migrationSql = fs.readFileSync(
    path.join(root, 'prisma/migrations', migration, 'migration.sql'),
    'utf8',
  );
  assert.doesNotMatch(
    migrationSql,
    /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/im,
  );
  // Inspect the cleanup artifact only. It must never execute as part of verification.
  const cleanupSql = fs.readFileSync(
    path.join(root, 'prisma/maintenance/cleanup-disposable-catalog.sql'),
    'utf8',
  );
  assert.deepEqual(
    [...cleanupSql.matchAll(/DELETE\s+FROM\s+"([^"]+)"/gi)].map((m) => m[1]),
    ['InventoryMovement', 'CatalogItem'],
  );
  assert.doesNotMatch(
    cleanupSql,
    /\b(TRUNCATE|DROP\s+(TABLE|SCHEMA|DATABASE))\b/i,
  );

  const laterItem = randomUUID();
  await db.query(
    `INSERT INTO "CatalogItem" (id,"businessId",name,"updatedAt") VALUES ($1,$2,'Post-migration item',now())`,
    [laterItem, a],
  );
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM "ProductVariant" WHERE "catalogItemId"=$1',
        [laterItem],
      )
    ).rows[0].n,
    0,
    'later inserts require the upcoming Import/Catalog Upgrade; no automatic trigger',
  );

  const cat = randomUUID(),
    foreignCat = randomUUID();
  const categoryInsert =
    'INSERT INTO "Category" (id, "businessId", name, "updatedAt") VALUES ($1, $2, $3, now())';
  await db.query(categoryInsert, [cat, a, '  Test Soft\t Drinks  ']);
  await rejects(categoryInsert, [randomUUID(), a, 'test soft drinks'], '23505');
  await db.query(categoryInsert, [foreignCat, b, 'TEST SOFT DRINKS']);
  await rejects(categoryInsert, [randomUUID(), a, '\t \n'], '23514');
  await rejects(categoryInsert, [randomUUID(), a, 'x'.repeat(201)], '22001');
  await rejects(
    categoryInsert,
    [randomUUID(), randomUUID(), 'Missing business'],
    '23503',
  );
  await rejects(
    'UPDATE "CatalogItem" SET "categoryId"=$1 WHERE id=$2',
    [foreignCat, item],
    '23503',
  );
  await db.query('UPDATE "CatalogItem" SET "categoryId"=$1 WHERE id=$2', [
    cat,
    item,
  ]);
  await rejects(
    'UPDATE "Category" SET "businessId"=$1, name=\'Moved\' WHERE id=$2',
    [b, cat],
    '23503',
  );
  await rejects('DELETE FROM "Category" WHERE id=$1', [cat], '23503');
  await concurrentUnique(
    categoryInsert,
    [randomUUID(), a, ' Race\tCategory '],
    [randomUUID(), a, 'race category'],
  );

  const variant = randomUUID();
  const variantInsert =
    'INSERT INTO "ProductVariant" (id, "businessId", "catalogItemId", sku, "updatedAt") VALUES ($1,$2,$3,$4,now())';
  const variantOptionsInsert =
    'INSERT INTO "ProductVariant" (id, "businessId", "catalogItemId", sku, "optionValues", "updatedAt") VALUES ($1,$2,$3,$4,$5::jsonb,now())';
  await db.query(variantInsert, [variant, a, item, 'SKU-1']);
  assert.deepEqual(
    (
      await db.query(
        'SELECT "optionValues", "unitPrice", "trackInventory", "stockQuantity", "isActive" FROM "ProductVariant" WHERE id=$1',
        [variant],
      )
    ).rows[0],
    {
      optionValues: {},
      unitPrice: null,
      trackInventory: false,
      stockQuantity: null,
      isActive: true,
    },
  );
  await rejects(variantInsert, [randomUUID(), b, item, 'cross'], '23503');
  await rejects(variantInsert, [randomUUID(), a, other, 'cross'], '23503');
  await rejects(
    variantInsert,
    [randomUUID(), a, item, 'x'.repeat(201)],
    '22001',
  );
  await db.query(variantInsert, [randomUUID(), b, other, 'SKU-1']);
  await db.query(variantOptionsInsert, [
    randomUUID(),
    a,
    item,
    null,
    '{"size":"S"}',
  ]);
  await db.query(variantOptionsInsert, [
    randomUUID(),
    a,
    item,
    null,
    '{"size":"M"}',
  ]);
  await db.query('UPDATE "ProductVariant" SET "isActive"=false WHERE id=$1', [
    variant,
  ]);
  await rejects(
    variantOptionsInsert,
    [randomUUID(), a, item, 'SKU-1', '{"fixture":"duplicate-sku"}'],
    '23505',
    'ProductVariant_businessId_sku_key',
  );
  await rejects(
    'UPDATE "ProductVariant" SET "catalogItemId"=$1 WHERE id=$2',
    [other, variant],
    '23503',
  );
  await rejects(
    'UPDATE "CatalogItem" SET "businessId"=$1, "externalKey"=\'MOVED-KEY\' WHERE id=$2',
    [b, item],
    '23503',
  );
  await rejects('DELETE FROM "CatalogItem" WHERE id=$1', [item], '23503');
  await concurrentUnique(
    variantOptionsInsert,
    [randomUUID(), a, item, 'RACE-SKU', '{"fixture":"race-a"}'],
    [randomUUID(), a, item, 'RACE-SKU', '{"fixture":"race-b"}'],
    'ProductVariant_businessId_sku_key',
  );
  for (const invalid of ['[]', 'null', '1', '"text"']) {
    await rejects(
      'UPDATE "CatalogItem" SET options=$1::jsonb WHERE id=$2',
      [invalid, item],
      '23514',
    );
    await rejects(
      'UPDATE "ProductVariant" SET "optionValues"=$1::jsonb WHERE id=$2',
      [invalid, variant],
      '23514',
    );
  }
  await db.query(
    'UPDATE "ProductVariant" SET "unitPrice"=12.34, "stockQuantity"=0, "optionValues"=\'{"size":"priced"}\' WHERE id=$1',
    [variant],
  );
  assert.equal(
    (
      await db.query('SELECT "unitPrice" FROM "ProductVariant" WHERE id=$1', [
        variant,
      ])
    ).rows[0].unitPrice,
    '12.34',
  );
  // The unchanged Excel identity constraint remains authoritative.
  await rejects(
    'INSERT INTO "CatalogItem" (id,"businessId",name,"externalKey","updatedAt") VALUES ($1,$2,\'Duplicate\',\'EXCEL-1\',now())',
    [randomUUID(), a],
    '23505',
  );
  await verifyVariantOptions({
    db,
    a,
    b,
    item,
    other,
    laterItem,
    concurrentUnique,
  });
  prisma('migrate', 'deploy');
  prisma('migrate', 'status');
  assert.match(
    prisma(
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--script',
      '--exit-code',
    ),
    /empty migration/,
  );
  const upgradeDatabase = `${database}_upgrade`;
  await admin.query(`CREATE DATABASE "${upgradeDatabase}"`);
  createdDatabases.push(upgradeDatabase);
  const upgrade = new Client({ ...local, database: upgradeDatabase });
  try {
    await upgrade.connect();
    await verifyForwardUpgrade({ db: upgrade, root, foundation: migration });
    targetUrl = `${url}_upgrade`;
    assert.match(
      prisma(
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--script',
        '--exit-code',
      ),
      /empty migration/,
    );
  } finally {
    targetUrl = url;
    await upgrade.end();
  }
  console.log(
    'PASS: fresh and populated schema-only migrations; no category/variant backfill; existing rows, stock, inventory movements, businesses, settings, working hours and import jobs unchanged; tenant isolation; concurrent category/SKU uniqueness; JSON checks; deploy rerun; migration status; no schema drift. Cleanup script inspected only, never executed.',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled(peers.map((peer) => peer.end()));
    await db.end().catch(() => {});
    await admin.end();
    console.log(
      createdDatabases.length
        ? `Disposable verification databases retained: ${createdDatabases.join(', ')}`
        : 'No disposable verification databases were created.',
    );
  });
