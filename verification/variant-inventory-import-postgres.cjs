// Fresh random localhost database only. No production URLs, cleanup, or SMTP.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { Client } = require('pg');
const request = require('supertest');
const { Workbook } = require('exceljs');
const database =
  'brandora_variant_inventory_' + randomUUID().replaceAll('-', '');
const local = { host: '127.0.0.1', port: 55439, user: 'postgres' };
const url = `postgresql://postgres@127.0.0.1:55439/${database}`;
const admin = new Client({ ...local, database: 'postgres' });
let sql,
  app,
  db,
  inventory,
  http,
  token,
  stranger,
  businessId,
  product,
  variant,
  httpChecks = 0;
const migration = '20261030000000_variant_only_inventory';
const root = path.resolve(__dirname, '..');
function prisma(...args) {
  const r = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', ...args],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      timeout: 90000,
    },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
async function call(method, route, data, status = 200, credential = token) {
  let c = http[method](route);
  if (credential) c = c.set('Authorization', 'Bearer ' + credential);
  if (data !== undefined) c = c.send(data);
  const r = await c;
  assert.equal(
    r.status,
    status,
    `${method} ${route}: ${JSON.stringify(r.body)}`,
  );
  httpChecks++;
  return r.body;
}
const inventoryPath = (p = product.id, v = variant.id) =>
  `/businesses/${businessId}/products/${p}/variants/${v}/inventory`;
const scope = () => ({ businessId, catalogItemId: product.id, id: variant.id });
const transaction = (fn) => db.$transaction(fn, { timeout: 20000 });
async function workbook(
  rows,
  configurable = false,
  ignoreStock = false,
  extraAttribute = false,
) {
  const b = new Workbook(),
    sheet = b.addWorksheet('Products');
  const headers = [
    'Product Code',
    'Name',
    'SKU',
    'Category',
    'Price',
    'Variant Price',
    'Quantity',
    ...(configurable ? ['Color', 'Size'] : []),
    ...(extraAttribute ? ['Arbitrary supplier note'] : []),
  ];
  sheet.addRows([headers, ...rows]);
  const bytes = Buffer.from(await b.xlsx.writeBuffer());
  const response = await http
    .post(`/businesses/${businessId}/imports/excel/analyze`)
    .set('Authorization', 'Bearer ' + token)
    .attach('file', bytes, 'products.xlsx');
  assert.equal(response.status, 201, JSON.stringify(response.body));
  httpChecks++;
  const id = response.body.importJobId;
  assert.ok(id);
  const targets = [
    'externalKey',
    'name',
    'sku',
    'category',
    'basePrice',
    'unitPrice',
    'stockQuantity',
    'color',
    'size',
  ];
  await call('patch', `/imports/${id}/mapping`, {
    mapping: headers.map((h, i) => ({
      sourceColumn: h,
      sourceColumnIndex: i + 1,
      type:
        extraAttribute && i === 7
          ? 'ATTRIBUTE'
          : ignoreStock && i === 6
            ? 'IGNORE'
            : i < 7
              ? 'STANDARD'
              : 'VARIANT_ATTRIBUTE',
      target:
        extraAttribute && i === 7
          ? 'supplier_note'
          : ignoreStock && i === 6
            ? null
            : targets[i],
    })),
  });
  return id;
}

before(
  async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    sql = new Client({ ...local, database });
    await sql.connect();
    // Real upgrade from nine migrations with real identity/import fixtures.
    for (const name of fs
      .readdirSync('prisma/migrations')
      .filter(
        (n) =>
          n < migration &&
          fs.existsSync(`prisma/migrations/${n}/migration.sql`),
      )
      .sort()) {
      await sql.query(
        fs.readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
      );
      prisma('migrate', 'resolve', '--applied', name);
    }
    const legacyBusiness = randomUUID(),
      legacyItem = randomUUID(),
      userId = randomUUID(),
      jobId = randomUUID();
    await sql.query(
      'INSERT INTO "Business" (id,name,"updatedAt") VALUES ($1,\'Preserved business\',now())',
      [legacyBusiness],
    );
    await sql.query(
      'INSERT INTO "BusinessSettings" ("businessId","updatedAt") VALUES ($1,now())',
      [legacyBusiness],
    );
    await sql.query(
      'INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ($1,\'fixture@example.test\',\'fixture-not-for-login\',now())',
      [userId],
    );
    await sql.query(
      'INSERT INTO "BusinessMember" (id,"userId","businessId","updatedAt") VALUES ($1,$2,$3,now())',
      [randomUUID(), userId, legacyBusiness],
    );
    await sql.query(
      'INSERT INTO "AuthSession" (id,"userId","tokenFamilyId","refreshTokenHash","expiresAt") VALUES ($1,$2,$3,$4,now()+interval \'1 day\')',
      [randomUUID(), userId, randomUUID(), randomBytes(32).toString('hex')],
    );
    await sql.query(
      'INSERT INTO "PasswordResetToken" ("userId","tokenHash","authVersion","expiresAt") VALUES ($1,$2,0,now()+interval \'1 day\')',
      [userId, randomBytes(32).toString('hex')],
    );
    await sql.query(
      'INSERT INTO "CatalogItem" (id,"businessId",name,"stockQuantity","trackInventory","updatedAt") VALUES ($1,$2,\'Legacy fixture\',3,true,now())',
      [legacyItem, legacyBusiness],
    );
    await sql.query(
      'INSERT INTO "ImportJob" (id,"businessId","fileName","updatedAt") VALUES ($1,$2,\'retained.xlsx\',now())',
      [jobId, legacyBusiness],
    );
    const pendingSql = fs.readFileSync(
      `prisma/migrations/${migration}/migration.sql`,
      'utf8',
    );
    await assert.rejects(sql.query(pendingSql), /Legacy inventory present/);
    await sql.query('ROLLBACK');
    assert.equal(
      (
        await sql.query(
          'SELECT "stockQuantity" FROM "CatalogItem" WHERE id=$1',
          [legacyItem],
        )
      ).rows[0].stockQuantity,
      3,
    );
    // Local fixture reconciliation only; no production cleanup utility runs.
    await sql.query(
      'UPDATE "CatalogItem" SET "stockQuantity"=NULL,"trackInventory"=false WHERE id=$1',
      [legacyItem],
    );
    const oldMovement = randomUUID();
    await sql.query(
      'INSERT INTO "InventoryMovement" (id,"businessId","catalogItemId",type,"quantityAfter","quantityDelta") VALUES ($1,$2,$3,\'INITIAL_IMPORT\',1,1)',
      [oldMovement, legacyBusiness, legacyItem],
    );
    await assert.rejects(sql.query(pendingSql), /Legacy inventory present/);
    await sql.query('ROLLBACK');
    assert.equal(
      (
        await sql.query(
          'SELECT count(*)::int AS n FROM "InventoryMovement" WHERE id=$1',
          [oldMovement],
        )
      ).rows[0].n,
      1,
    );
    await sql.query('DELETE FROM "InventoryMovement" WHERE id=$1', [
      oldMovement,
    ]); // only this disposable fixture
    const snapshots = {};
    for (const table of [
      'Business',
      'BusinessSettings',
      'User',
      'BusinessMember',
      'ImportJob',
      'AuthSession',
      'PasswordResetToken',
    ])
      snapshots[table] = (
        await sql.query(`SELECT * FROM "${table}" ORDER BY 1`)
      ).rows;
    prisma('migrate', 'deploy');
    for (const table of Object.keys(snapshots))
      assert.deepEqual(
        (await sql.query(`SELECT * FROM "${table}" ORDER BY 1`)).rows,
        snapshots[table],
      );
    assert.equal(
      (await sql.query('SELECT count(*)::int AS n FROM "ProductVariant"'))
        .rows[0].n,
      0,
    ); // no backfill
    assert.equal(
      (
        await sql.query(
          'SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
        )
      ).rows[0].n,
      10,
    );
    Object.assign(process.env, {
      DATABASE_URL: url,
      JWT_SECRET: randomBytes(48).toString('base64'),
      AUTH_RATE_LIMIT_SECRET: randomBytes(48).toString('base64'),
      JWT_ISSUER: 'inventory-test',
      JWT_AUDIENCE: 'android-test',
      AUTH_EMAIL_MODE: 'disabled',
      AUTH_TRUSTED_PROXY_CIDRS: '',
      IMPORT_STORAGE_DIR: path.join(tmpdir(), database),
    });
    require('reflect-metadata');
    const { Test } = require('@nestjs/testing');
    const { ValidationPipe } = require('@nestjs/common');
    const { HttpAdapterHost } = require('@nestjs/core');
    const { AppModule } = require('../dist/app.module');
    const { PrismaService } = require('../dist/prisma/prisma.service');
    const { InventoryService } = require('../dist/inventory/inventory.service');
    const {
      HttpExceptionFilter,
    } = require('../dist/common/errors/http-exception.filter');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    await app.init();
    db = app.get(PrismaService);
    inventory = app.get(InventoryService);
    http = request(app.getHttpServer());
    token = (
      await call(
        'post',
        '/auth/register',
        { email: 'owner@example.test', password: 'SecurePassword123!' },
        201,
        null,
      )
    ).accessToken;
    stranger = (
      await call(
        'post',
        '/auth/register',
        { email: 'stranger@example.test', password: 'SecurePassword123!' },
        201,
        null,
      )
    ).accessToken;
    businessId = (
      await call('post', '/businesses', { name: 'Inventory test' }, 201)
    ).id;
    product = await call(
      'post',
      `/businesses/${businessId}/products`,
      { name: 'Simple', basePrice: '10.00' },
      201,
    );
    variant = product.variants[0];
  },
  { timeout: 180000 },
);

test('default variant, one stock source, audited tracking enable/disable and no-op', async () => {
  assert.equal(variant.trackInventory, false);
  assert.equal(variant.stockQuantity, null);
  const r = await call(
    'post',
    inventoryPath() + '/adjust',
    { quantity: 10 },
    201,
  );
  assert.equal(r.quantityDelta, 10);
  assert.equal(
    (await call('post', inventoryPath() + '/adjust', { quantity: 10 }, 201))
      .changed,
    false,
  );
  const m = await call('get', inventoryPath() + '/movements');
  assert.equal(m.items.length, 1);
  assert.equal(m.items[0].variantId, variant.id);
  assert.ok(
    !Object.hasOwn(
      await db.catalogItem.findUniqueOrThrow({ where: { id: product.id } }),
      'stockQuantity',
    ),
  );
  await call(
    'post',
    inventoryPath() + '/adjust',
    { quantity: null, trackInventory: false },
    201,
  );
  assert.equal(
    (await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } }))
      .stockQuantity,
    null,
  );
  await call('post', inventoryPath() + '/adjust', { quantity: 10 }, 201);
});
test('negative/invalid stock, legacy routes, missing JWT and other owners rejected', async () => {
  for (const quantity of [-1, 1.5, 2147483648, null, '10'])
    await call('post', inventoryPath() + '/adjust', { quantity }, 400);
  await call(
    'post',
    inventoryPath() + '/adjust',
    { quantity: 0, trackInventory: false },
    400,
  );
  await call('post', inventoryPath() + '/adjust', { quantity: 3 }, 401, null);
  await call(
    'post',
    inventoryPath() + '/adjust',
    { quantity: 3 },
    404,
    stranger,
  );
  await call('get', inventoryPath() + '/movements', undefined, 404, stranger);
  await call(
    'post',
    `/businesses/${businessId}/catalog-items/${product.id}/inventory/adjust`,
    { quantity: 3 },
    404,
  );
});
test('concurrent deductions, insufficient stock, rollback and duplicate order-line protection', async () => {
  await call('post', inventoryPath() + '/adjust', { quantity: 10 }, 201);
  const outcomes = await Promise.allSettled(
    ['a', 'b'].map((id) =>
      transaction((tx) => inventory.deductForOrder(tx, scope(), 7, id)),
    ),
  );
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  assert.equal(
    (await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } }))
      .stockQuantity,
    3,
  );
  const id = outcomes[0].status === 'fulfilled' ? 'a' : 'b';
  await call(
    'post',
    inventoryPath() + '/adjust',
    { quantity: null, trackInventory: false },
    409,
  );
  await transaction((tx) => inventory.deductForOrder(tx, scope(), 7, id));
  await assert.rejects(
    transaction((tx) => inventory.deductForOrder(tx, scope(), 6, id)),
  );
  await assert.rejects(
    transaction(async (tx) => {
      await inventory.deductForOrder(tx, scope(), 1, 'rollback');
      throw new Error('rollback');
    }),
  );
  assert.equal(
    await db.inventoryMovement.count({ where: { referenceId: 'rollback' } }),
    0,
  );
  await transaction((tx) => inventory.restoreForOrder(tx, scope(), 7, id));
  await transaction((tx) => inventory.restoreForOrder(tx, scope(), 7, id));
  assert.equal(
    (await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } }))
      .stockQuantity,
    10,
  );
  await assert.rejects(
    transaction((tx) =>
      inventory.restoreForOrder(tx, scope(), 1, 'never-approved'),
    ),
  );
});
test('untracked order idempotency and restoration after soft deletion', async () => {
  await call(
    'post',
    inventoryPath() + '/adjust',
    { quantity: null, trackInventory: false },
    201,
  );
  await transaction((tx) =>
    inventory.deductForOrder(tx, scope(), 2, 'untracked'),
  );
  await transaction((tx) =>
    inventory.deductForOrder(tx, scope(), 2, 'untracked'),
  );
  await call(
    'patch',
    `/businesses/${businessId}/products/${product.id}/variants/${variant.id}`,
    { isActive: false },
  );
  await call('post', inventoryPath() + '/adjust', { quantity: 5 }, 409);
  await assert.rejects(
    transaction((tx) => inventory.deductForOrder(tx, scope(), 1, 'inactive')),
  );
  await transaction((tx) =>
    inventory.restoreForOrder(tx, scope(), 2, 'untracked'),
  );
  await call(
    'patch',
    `/businesses/${businessId}/products/${product.id}/variants/${variant.id}`,
    { isActive: true },
  );
});

test('concurrent absolute stock sets serialize with a consistent audit chain', async () => {
  await inventory.setQuantity(scope(), 10);
  const refs = [randomUUID(), randomUUID()];
  const results = await Promise.all(
    [6, 9].map((q, i) =>
      inventory.setQuantity(scope(), q, 'MANUAL_ADJUSTMENT', {
        type: 'TEST_ADJUSTMENT',
        id: refs[i],
      }),
    ),
  );
  assert.equal(results.filter((r) => r.quantityBefore === 10).length, 1);
  const first = results.find((r) => r.quantityBefore === 10),
    second = results.find((r) => r.quantityBefore !== 10);
  assert.equal(second.quantityBefore, first.quantityAfter);
  assert.equal(
    (await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } }))
      .stockQuantity,
    second.quantityAfter,
  );
  assert.equal(
    await db.inventoryMovement.count({
      where: { referenceType: 'TEST_ADJUSTMENT', referenceId: { in: refs } },
    }),
    2,
  );
});

test('simultaneous retries of one order line deduct once', async () => {
  await inventory.setQuantity(scope(), 10);
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      transaction((tx) =>
        inventory.deductForOrder(tx, scope(), 3, 'same-line-race'),
      ),
    ),
  );
  assert.equal(new Set(results.map((r) => r.movementId)).size, 1);
  assert.equal(
    (await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } }))
      .stockQuantity,
    7,
  );
  assert.equal(
    await db.inventoryMovement.count({
      where: {
        businessId,
        referenceId: 'same-line-race',
        type: 'ORDER_APPROVED',
      },
    }),
    1,
  );
  await transaction((tx) =>
    inventory.restoreForOrder(tx, scope(), 3, 'same-line-race'),
  );
});
test('order-line references cannot deduct a second variant in the same business', async () => {
  const second = await call(
    'post',
    `/businesses/${businessId}/products`,
    { name: 'Second line fixture', basePrice: '1.00' },
    201,
  );
  const secondScope = {
    businessId,
    catalogItemId: second.id,
    id: second.variants[0].id,
  };
  await inventory.setQuantity(secondScope, 10);
  // The first variant already reserved this ORDER_LINE, including after restore.
  await assert.rejects(
    transaction((tx) =>
      inventory.deductForOrder(tx, secondScope, 2, 'untracked'),
    ),
  );
  assert.equal(
    (
      await db.productVariant.findUniqueOrThrow({
        where: { id: secondScope.id },
      })
    ).stockQuantity,
    10,
  );
  await assert.rejects(
    db.inventoryMovement.create({
      data: {
        businessId,
        catalogItemId: second.id,
        variantId: secondScope.id,
        type: 'ORDER_APPROVED',
        referenceType: 'ORDER_LINE',
        referenceId: 'untracked',
        requestedQuantity: 2,
        trackingBefore: true,
        trackingAfter: true,
        quantityBefore: 10,
        quantityAfter: 8,
        quantityDelta: -2,
      },
    }),
    { code: 'P2002' },
  );
});
test('complete workbook workflow creates grouped variants, category and independent inventory', async () => {
  const id = await workbook(
    [
      ['SHIRT', 'Shirt', 'S-RED', ' Clothes ', '20.00', '22.00', 8, 'Red', 'M'],
      ['SHIRT', 'Shirt', 'S-BLUE', ' Clothes ', '20.00', null, 12, 'Blue', 'M'],
    ],
    true,
  );
  assert.equal(
    (await call('post', `/imports/${id}/validate`, {}, 201)).summary.validRows,
    2,
  );
  assert.equal(
    (await call('get', `/imports/${id}/validation-results?limit=1`)).validRows
      .length,
    1,
  );
  assert.equal(
    (await call('get', `/imports/${id}/preview`)).summary.willInsert,
    2,
  );
  const r = await call('post', `/imports/${id}/execute`, {});
  assert.equal(r.summary.insertedCount, 2);
  const p = await db.catalogItem.findUniqueOrThrow({
    where: { businessId_externalKey: { businessId, externalKey: 'SHIRT' } },
    include: { variants: true, categoryRecord: true },
  });
  assert.equal(p.categoryRecord.name, 'Clothes');
  assert.deepEqual(
    p.variants.map((v) => v.stockQuantity).sort((a, b) => a - b),
    [8, 12],
  );
  assert.equal(p.variants.length, 2);
  assert.equal(
    await db.inventoryMovement.count({ where: { catalogItemId: p.id } }),
    2,
  );
  await call('post', `/imports/${id}/execute`, {}, 409);
  await call('get', `/imports/${id}`, undefined, 200);
  await call('get', `/businesses/${businessId}/imports`, undefined, 200);
});
test('blank stock preserves quantities; repeated new jobs update stable identities without duplicates', async () => {
  const before = await db.productVariant.findFirstOrThrow({
    where: { businessId, sku: 'S-RED' },
  });
  const id = await workbook(
    [
      [
        'SHIRT',
        'Shirt',
        'S-RED',
        'clothes',
        '20.00',
        '23.00',
        null,
        'Red',
        'M',
      ],
    ],
    true,
  );
  await call('post', `/imports/${id}/validate`, {}, 201);
  const r = await call('post', `/imports/${id}/execute`, {});
  assert.equal(r.summary.updatedCount, 1);
  const after = await db.productVariant.findUniqueOrThrow({
    where: { id: before.id },
  });
  assert.equal(after.stockQuantity, before.stockQuantity);
  assert.equal(after.unitPrice.toFixed(2), '23.00');
  assert.equal(await db.category.count({ where: { businessId } }), 1);
  assert.equal(
    await db.productVariant.count({
      where: { catalogItemId: before.catalogItemId },
    }),
    2,
  );
  const unmapped = await workbook(
    [['SHIRT', 'Shirt', 'S-RED', 'Clothes', '20.00', null, 999, 'Red', 'M']],
    true,
    true,
  );
  await call('post', `/imports/${unmapped}/validate`, {}, 201);
  await call('post', `/imports/${unmapped}/execute`, {});
  assert.equal(
    (await db.productVariant.findUniqueOrThrow({ where: { id: before.id } }))
      .stockQuantity,
    before.stockQuantity,
  );
  const simple = await workbook([
    ['TEA', 'Tea', 'TEA-1', null, '5.00', null, 4],
  ]);
  await call('post', `/imports/${simple}/validate`, {}, 201);
  await call('post', `/imports/${simple}/execute`, {});
  assert.deepEqual(
    (
      await db.productVariant.findFirstOrThrow({
        where: { sku: 'TEA-1', businessId },
      })
    ).optionValues,
    {},
  );
});
test('conflicting groups, duplicate SKUs, missing codes, stale options and reserved combinations rejected', async () => {
  for (const rows of [
    [
      ['X', 'Different', 'DUP', null, '1', null, 1, 'R', 'S'],
      ['Y', 'Different', 'DUP', null, '1', null, 1, 'B', 'S'],
    ],
    [
      ['X', 'One', 'X1', null, '1', null, 1, 'R', 'S'],
      ['X', 'Two', 'X2', null, '1', null, 1, 'B', 'S'],
    ],
    [[null, 'Missing', 'M', null, '1', null, 1, 'R', 'S']],
    [['SHIRT', 'Shirt', 'S-RED', null, '20', null, 1, 'Blue', 'M']],
  ]) {
    const id = await workbook(rows, true);
    const r = await call('post', `/imports/${id}/validate`, {}, 201);
    assert.equal(r.summary.validRows, 0);
    assert.ok(r.summary.invalidRows > 0);
  }
});
test('group transaction rolls back after audit failure while independent product group succeeds', async () => {
  await sql.query(
    `CREATE FUNCTION inventory_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."referenceType"='IMPORT_ROW' AND (SELECT sku FROM "ProductVariant" WHERE id=NEW."variantId")='FAIL-B' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`,
  );
  await sql.query(
    'CREATE TRIGGER inventory_fixture_failure BEFORE INSERT ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION inventory_fixture_failure()',
  );
  try {
    const id = await workbook(
      [
        ['FAIL', 'Fails', 'FAIL-A', null, '1', null, 5, 'A', 'M'],
        ['FAIL', 'Fails', 'FAIL-B', null, '1', null, 7, 'B', 'M'],
        ['GOOD', 'Succeeds', 'GOOD-1', null, '1', null, 6, 'A', 'M'],
      ],
      true,
    );
    await call('post', `/imports/${id}/validate`, {}, 201);
    const r = await call('post', `/imports/${id}/execute`, {});
    assert.equal(r.status, 'COMPLETED_WITH_ERRORS');
    assert.equal(r.summary.failedCount, 2);
    assert.equal(r.summary.insertedCount, 1);
    assert.equal(
      await db.catalogItem.count({
        where: { businessId, externalKey: 'FAIL' },
      }),
      0,
    );
    assert.equal(
      await db.productVariant.count({
        where: { businessId, sku: { in: ['FAIL-A', 'FAIL-B'] } },
      }),
      0,
    );
  } finally {
    await sql.query(
      'DROP TRIGGER inventory_fixture_failure ON "InventoryMovement"',
    );
    await sql.query('DROP FUNCTION inventory_fixture_failure()');
  }
});

test('competing import jobs cannot duplicate product or variant identities', async () => {
  const ids = await Promise.all(
    [1, 2].map(() =>
      workbook([
        ['RACE', 'Concurrent product', 'RACE-SKU', null, '3.00', null, 5],
      ]),
    ),
  );
  for (const id of ids) await call('post', `/imports/${id}/validate`, {}, 201);
  const results = await Promise.all(
    ids.map((id) => call('post', `/imports/${id}/execute`, {})),
  );
  assert.ok(results.some((r) => r.status === 'COMPLETED'));
  assert.equal(
    await db.catalogItem.count({ where: { businessId, externalKey: 'RACE' } }),
    1,
  );
  assert.equal(
    await db.productVariant.count({ where: { businessId, sku: 'RACE-SKU' } }),
    1,
  );
  const retry = await workbook([
    ['RACE', 'Concurrent product', 'RACE-SKU', null, '3.00', null, null],
  ]);
  await call('post', `/imports/${retry}/validate`, {}, 201);
  assert.equal(
    (await call('post', `/imports/${retry}/execute`, {})).summary
      .unchangedCount,
    1,
  );
});
test('database tenant FK, stock CHECK and audit delta CHECK reject invalid writes', async () => {
  const other = await db.business.create({
    data: { name: 'Other isolated fixture' },
  });
  await assert.rejects(
    db.inventoryMovement.create({
      data: {
        businessId: other.id,
        catalogItemId: product.id,
        variantId: variant.id,
        type: 'MANUAL_ADJUSTMENT',
        trackingBefore: false,
        trackingAfter: false,
        quantityBefore: null,
        quantityAfter: null,
        quantityDelta: 0,
      },
    }),
  );
  await assert.rejects(
    db.productVariant.update({
      where: { id: variant.id },
      data: { trackInventory: true, stockQuantity: -1 },
    }),
  );
  await assert.rejects(
    db.productVariant.update({
      where: { id: variant.id },
      data: { trackInventory: false, stockQuantity: 1 },
    }),
  );
  await assert.rejects(
    db.inventoryMovement.create({
      data: {
        businessId,
        catalogItemId: product.id,
        variantId: variant.id,
        type: 'MANUAL_ADJUSTMENT',
        trackingBefore: true,
        trackingAfter: true,
        quantityBefore: 1,
        quantityAfter: 2,
        quantityDelta: 9,
      },
    }),
  );
});
test('owned business cannot address a variant belonging to another business', async () => {
  const secondBusiness = await call(
    'post',
    '/businesses',
    { name: 'Same owner, separate tenant' },
    201,
  );
  const second = await call(
    'post',
    `/businesses/${secondBusiness.id}/products`,
    { name: 'Foreign variant', basePrice: '1.00' },
    201,
  );
  await call(
    'post',
    inventoryPath(product.id, second.variants[0].id) + '/adjust',
    { quantity: 1 },
    404,
  );
  await call(
    'get',
    inventoryPath(product.id, second.variants[0].id) + '/movements',
    undefined,
    404,
  );
  assert.equal(
    (
      await db.productVariant.findUniqueOrThrow({
        where: { id: second.variants[0].id },
      })
    ).stockQuantity,
    null,
  );
});

test('category relation repair matches preview and unchanged re-import preserves timestamps', async () => {
  const correct = await db.category.create({
    data: { businessId, name: '  REVIEW   Clothes  ' },
  });
  const wrong = await db.category.create({
    data: { businessId, name: 'Review Other' },
  });
  const id = await workbook([
    [
      'CATEGORY-REPAIR',
      'Category repair',
      'CATEGORY-REPAIR',
      'Review Clothes',
      '2',
      null,
      null,
    ],
  ]);
  await call('post', '/imports/' + id + '/validate', {}, 201);
  await call('post', '/imports/' + id + '/execute', {});
  let current = await db.catalogItem.findUniqueOrThrow({
    where: {
      businessId_externalKey: { businessId, externalKey: 'CATEGORY-REPAIR' },
    },
    include: { variants: true },
  });
  await db.catalogItem.update({
    where: { id: current.id },
    data: { categoryId: wrong.id },
  });
  const repair = await workbook([
    [
      'CATEGORY-REPAIR',
      'Category repair',
      'CATEGORY-REPAIR',
      'Review Clothes',
      '2',
      null,
      null,
    ],
  ]);
  await call('post', '/imports/' + repair + '/validate', {}, 201);
  const preview = await call('get', '/imports/' + repair + '/preview');
  assert.deepEqual(preview.updates[0].changes.categoryId, {
    from: wrong.id,
    to: correct.id,
  });
  assert.equal(
    (await call('post', '/imports/' + repair + '/execute', {})).summary
      .updatedCount,
    1,
  );
  current = await db.catalogItem.findUniqueOrThrow({
    where: { id: current.id },
    include: { variants: true },
  });
  assert.equal(current.categoryId, correct.id);
  const repeat = await workbook([
    [
      'CATEGORY-REPAIR',
      'Category repair',
      'CATEGORY-REPAIR',
      'Review Clothes',
      '2',
      null,
      null,
    ],
  ]);
  await call('post', '/imports/' + repeat + '/validate', {}, 201);
  assert.equal(
    (await call('post', '/imports/' + repeat + '/execute', {})).summary
      .unchangedCount,
    1,
  );
  const after = await db.catalogItem.findUniqueOrThrow({
    where: { id: current.id },
    include: { variants: true },
  });
  assert.equal(after.updatedAt.getTime(), current.updatedAt.getTime());
  assert.equal(
    after.variants[0].updatedAt.getTime(),
    current.variants[0].updatedAt.getTime(),
  );
});
test('oversized merged attributes fail validation and preview without product writes', async () => {
  const original = await db.catalogItem.create({
    data: {
      businessId,
      externalKey: 'MERGED-SIZE',
      name: 'Merged size',
      attributes: { retained: 'a'.repeat(8500) },
      variants: { create: {} },
    },
  });
  const id = await workbook(
    [
      [
        'MERGED-SIZE',
        'Merged size',
        null,
        null,
        null,
        null,
        null,
        'b'.repeat(8500),
      ],
    ],
    false,
    false,
    true,
  );
  const validation = await call(
    'post',
    '/imports/' + id + '/validate',
    {},
    201,
  );
  assert.equal(validation.summary.invalidRows, 1);
  const preview = await call('get', '/imports/' + id + '/preview');
  assert.equal(
    preview.invalidRows[0].errors[0].code,
    'MERGED_ATTRIBUTES_INVALID',
  );
  assert.equal(preview.summary.willUpdate, 0);
  const executed = await call('post', '/imports/' + id + '/execute', {});
  assert.equal(executed.updated.length, 0);
  assert.deepEqual(
    (await db.catalogItem.findUniqueOrThrow({ where: { id: original.id } }))
      .attributes,
    original.attributes,
  );
});
test('valid mapped attributes merge with retained attributes and execute as previewed', async () => {
  const id = await workbook([['MERGED-SIZE', 'Merged size', null, null, null, null, null, 'safe note']], false, false, true);
  assert.equal((await call('post', '/imports/'+id+'/validate', {}, 201)).summary.validRows, 1);
  const preview = await call('get', '/imports/'+id+'/preview');
  assert.equal(preview.updates[0].changes.attributes.to.supplier_note, 'safe note');
  assert.equal(preview.updates[0].changes.attributes.to.retained.length, 8500);
  assert.equal((await call('post', '/imports/'+id+'/execute', {})).summary.updatedCount, 1);
  const product = await db.catalogItem.findUniqueOrThrow({where: {businessId_externalKey: {businessId, externalKey: 'MERGED-SIZE'}}});
  assert.equal(product.attributes.supplier_note, 'safe note');
  assert.equal(product.attributes.retained.length, 8500);
});
test('concurrent import groups safely share one newly created normalized category', async () => {
  const ids = await Promise.all(
    ['A', 'B'].map((suffix) =>
      workbook([
        [
          'CAT-RACE-' + suffix,
          'Race ' + suffix,
          'CAT-RACE-' + suffix,
          'Race Category',
          null,
          null,
          null,
        ],
      ]),
    ),
  );
  for (const id of ids)
    await call('post', '/imports/' + id + '/validate', {}, 201);
  const results = await Promise.all(
    ids.map((id) => call('post', '/imports/' + id + '/execute', {})),
  );
  for (const result of results)
    assert.equal(result.summary.insertedCount, 1, JSON.stringify(result));
  assert.equal(
    await db.category.count({ where: { businessId, name: 'Race Category' } }),
    1,
  );
});

test('every import route rejects anonymous and foreign business owners by import identity', async () => {
  const id = await workbook([
    ['AUTH-SCOPE', 'Scoped import', null, null, null, null, null],
  ]);
  const routes = [
    ['get', '/imports/' + id],
    ['get', '/imports/' + id + '/mapping'],
    ['patch', '/imports/' + id + '/mapping'],
    ['post', '/imports/' + id + '/validate'],
    ['get', '/imports/' + id + '/validation-results'],
    ['get', '/imports/' + id + '/preview'],
    ['post', '/imports/' + id + '/execute'],
    ['get', '/businesses/' + businessId + '/imports'],
  ];
  for (const [method, route] of routes) {
    await call(method, route, undefined, 401, null);
    await call(method, route, undefined, 404, stranger);
  }
});
test('migration status, SQL-only constraints, Prisma drift and paginated history', async () => {
  const history = (
    await sql.query(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations',
    )
  ).rows;
  assert.equal(history.length, 10);
  for (const entry of history) {
    assert.ok(entry.finished_at);
    assert.equal(entry.rolled_back_at, null);
    assert.equal(
      entry.checksum,
      createHash('sha256')
        .update(
          fs.readFileSync(
            `prisma/migrations/${entry.migration_name}/migration.sql`,
          ),
        )
        .digest('hex'),
    );
  }
  assert.match(prisma('migrate', 'status'), /up to date/);
  assert.match(
    prisma(
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--exit-code',
    ),
    /No difference detected/,
  );
  const p = await call(
    'get',
    `/businesses/${businessId}/inventory/movements?limit=1&offset=0`,
  );
  assert.equal(p.items.length, 1);
  assert.equal(p.pagination.hasMore, true);
  const checks = (
    await sql.query(
      `SELECT conname FROM pg_constraint WHERE conname IN ('ProductVariant_inventory_check','InventoryMovement_quantities_check','InventoryMovement_reference_check','InventoryMovement_order_check')`,
    )
  ).rows;
  assert.equal(checks.length, 4);
});
after(async () => {
  if (app) await app.close();
  if (sql) await sql.end();
  await admin.end();
  console.log(
    `HTTP assertions executed: ${httpChecks}. Isolated database retained: ${database}`,
  );
});
