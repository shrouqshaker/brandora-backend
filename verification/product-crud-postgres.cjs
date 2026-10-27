// Explicit local-only Task 2 integration verification. Never reads DATABASE_URL.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const request = require('supertest');
const root = path.resolve(__dirname, '..');
const database = `brandora_task2_${randomUUID().replaceAll('-', '')}`;
const local = { host: '127.0.0.1', port: 55439, user: 'postgres' };
const url = `postgresql://postgres@127.0.0.1:55439/${database}`;
const admin = new Client({ ...local, database: 'postgres' });
let app,
  prisma,
  locker,
  created = false,
  checks = 0;

async function main() {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  const migration = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
  );
  assert.equal(migration.status, 0, migration.stdout + migration.stderr);
  process.env.DATABASE_URL = url;
  process.env.PORT = '3000';
  process.env.IMPORT_STORAGE_DIR = path.join(
    root,
    '.tmp/task2-integration-imports',
    database,
  );
  require('reflect-metadata');
  const { NestFactory, HttpAdapterHost } = require('@nestjs/core');
  const { ValidationPipe } = require('@nestjs/common');
  const { AppModule } = require('../dist/app.module');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const {
    HttpExceptionFilter,
  } = require('../dist/common/errors/http-exception.filter');
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
  await app.init();
  prisma = app.get(PrismaService);
  const http = request(app.getHttpServer());
  async function call(method, route, body, status, code) {
    let operation = http[method](route);
    if (body !== undefined) operation = operation.send(body);
    const response = await operation;
    assert.equal(
      response.status,
      status,
      `${method} ${route}: ${JSON.stringify(response.body)}`,
    );
    if (code) assert.equal(response.body.code, code);
    checks++;
    return response.body;
  }
  const a = (await call('post', '/businesses', { name: 'Task 2 A' }, 201)).id;
  const b = (await call('post', '/businesses', { name: 'Task 2 B' }, 201)).id;
  const categories = (tenant) => `/businesses/${tenant}/categories`;
  const products = (tenant) => `/businesses/${tenant}/products`;
  const productPath = (id, tenant = a) => `${products(tenant)}/${id}`;
  const variants = (id, tenant = a) => `${productPath(id, tenant)}/variants`;

  const category = await call(
    'post',
    categories(a),
    { name: '  General\t Goods ' },
    201,
  );
  assert.equal(category.name, 'General\t Goods');
  await call(
    'post',
    categories(a),
    { name: 'general goods' },
    409,
    'CATEGORY_NAME_CONFLICT',
  );
  const foreignCategory = await call(
    'post',
    categories(b),
    { name: 'General Goods' },
    201,
  );
  const spare = await call('post', categories(a), { name: 'Spare' }, 201);
  await call(
    'patch',
    `${categories(a)}/${spare.id}`,
    { name: ' GENERAL GOODS ' },
    409,
    'CATEGORY_NAME_CONFLICT',
  );
  await call('patch', `${categories(a)}/${spare.id}`, { name: 'Renamed' }, 200);
  await call(
    'get',
    `${categories(b)}/${category.id}`,
    undefined,
    404,
    'CATEGORY_NOT_FOUND',
  );
  await call(
    'patch',
    `${categories(b)}/${category.id}`,
    { name: 'No' },
    404,
    'CATEGORY_NOT_FOUND',
  );
  await call(
    'delete',
    `${categories(b)}/${category.id}`,
    undefined,
    404,
    'CATEGORY_NOT_FOUND',
  );
  const categoryPage = await call(
    'get',
    `${categories(a)}?limit=1&offset=0`,
    undefined,
    200,
  );
  assert.equal(categoryPage.pagination.totalCount, 2);
  assert.equal(categoryPage.pagination.hasMore, true);
  assert.equal(categoryPage.items.length, 1);
  await call('delete', `${categories(a)}/${spare.id}`, undefined, 204);
  await call(
    'get',
    categories(randomUUID()),
    undefined,
    404,
    'BUSINESS_NOT_FOUND',
  );

  for (const body of [{}, { name: ' ' }, { name: 'x', forbidden: true }])
    await call('post', categories(a), body, 400, 'VALIDATION_ERROR');
  const simple = await call(
    'post',
    products(a),
    {
      name: ' Simple ',
      categoryId: category.id,
      basePrice: '12.50',
      attributes: { nested: { text: 'kept' } },
    },
    201,
  );
  assert.equal(simple.name, 'Simple');
  assert.equal(simple.variants.length, 1);
  assert.deepEqual(simple.variants[0].optionValues, {});
  assert.equal(simple.variants[0].effectivePrice, '12.50');
  assert.equal(simple.variants[0].stockQuantity, null);
  assert.equal(simple.variants[0].trackInventory, false);
  assert.equal(simple.isSellable, true);
  await call(
    'post',
    variants(simple.id),
    { optionValues: {} },
    409,
    'VARIANT_OPTIONS_CONFLICT',
  );
  await call(
    'delete',
    `${categories(a)}/${category.id}`,
    undefined,
    409,
    'CATEGORY_IN_USE',
  );
  await call(
    'post',
    products(a),
    { name: 'Cross category', categoryId: foreignCategory.id },
    404,
    'CATEGORY_NOT_FOUND',
  );
  await call(
    'patch',
    productPath(simple.id),
    { categoryId: foreignCategory.id },
    404,
    'CATEGORY_NOT_FOUND',
  );
  const nullPrice = await call('post', products(a), { name: 'No price' }, 201);
  assert.equal(nullPrice.isSellable, false);
  assert.equal(nullPrice.variants[0].effectivePrice, null);
  const config = await call(
    'post',
    products(a),
    {
      name: 'Configurable',
      basePrice: '90.00',
      options: { ' Mode ': [' First ', 'Second'], Edition: ['I', 'II'] },
    },
    201,
  );
  assert.deepEqual(config.options, {
    Mode: ['First', 'Second'],
    Edition: ['I', 'II'],
  });
  assert.deepEqual(config.variants, []);
  assert.equal(config.isSellable, false);
  const v = await call(
    'post',
    variants(config.id),
    {
      sku: ' SKU-A ',
      optionValues: { ' Mode ': ' First ', Edition: 'I' },
      unitPrice: '100.25',
    },
    201,
  );
  assert.equal(v.sku, 'SKU-A');
  assert.equal(v.effectivePrice, '100.25');
  assert.deepEqual(v.optionValues, { Mode: 'First', Edition: 'I' });
  await call(
    'post',
    variants(config.id),
    { optionValues: { Edition: 'I', Mode: 'First' } },
    409,
    'VARIANT_OPTIONS_CONFLICT',
  );
  await call(
    'post',
    variants(config.id),
    { sku: 'SKU-A', optionValues: { Mode: 'Second', Edition: 'II' } },
    409,
    'VARIANT_SKU_CONFLICT',
  );
  for (const optionValues of [
    null,
    [],
    {},
    { Mode: 'First' },
    { Mode: 'Third', Edition: 'I' },
    { Mode: 'First', Edition: 'I', Unknown: 'x' },
  ])
    await call(
      'post',
      variants(config.id),
      { optionValues },
      400,
      'VARIANT_OPTIONS_INVALID',
    );
  for (const body of [
    { optionValues: {}, stockQuantity: 1 },
    { optionValues: {}, trackInventory: true },
    { optionValues: {}, unitPrice: 10 },
    { optionValues: {}, sku: ' ' },
  ])
    await call('post', variants(config.id), body, 400, 'VALIDATION_ERROR');
  for (const body of [
    { name: 'x', options: null },
    { name: 'x', attributes: [] },
    { name: 'x', options: { Mode: [] } },
    { name: 'x', options: { Mode: ['x', ' x '] } },
    { name: 'x', options: { Mode: ['x'], ' Mode ': ['y'] } },
    { name: 'x', stockQuantity: 2 },
  ])
    await call('post', products(a), body, 400, 'VALIDATION_ERROR');
  await call('patch', productPath(config.id), {}, 400, 'VALIDATION_ERROR');
  await call(
    'patch',
    `${variants(config.id)}/${v.id}`,
    {},
    400,
    'VALIDATION_ERROR',
  );
  const inherited = await call(
    'patch',
    `${variants(config.id)}/${v.id}`,
    { unitPrice: null, sku: null },
    200,
  );
  assert.equal(inherited.effectivePrice, '90.00');
  const changed = await call(
    'patch',
    productPath(config.id),
    { basePrice: '91.01', description: null },
    200,
  );
  assert.equal(changed.variants[0].effectivePrice, '91.01');
  await call(
    'patch',
    productPath(config.id),
    { options: { Mode: ['Second'], Edition: ['I'] } },
    409,
    'PRODUCT_OPTIONS_IN_USE',
  );
  await call(
    'patch',
    productPath(simple.id),
    { options: { Arbitrary: ['x'] } },
    409,
    'PRODUCT_OPTIONS_IN_USE',
  );
  const transition = await call(
    'post',
    products(a),
    { name: 'Transition', options: { Original: ['x'] } },
    201,
  );
  const simplified = await call(
    'patch',
    productPath(transition.id),
    { options: {} },
    200,
  );
  assert.equal(simplified.variants.length, 1);
  await call(
    'get',
    productPath(config.id, b),
    undefined,
    404,
    'PRODUCT_NOT_FOUND',
  );
  await call(
    'patch',
    productPath(config.id, b),
    { name: 'No' },
    404,
    'PRODUCT_NOT_FOUND',
  );
  await call(
    'delete',
    productPath(config.id, b),
    undefined,
    404,
    'PRODUCT_NOT_FOUND',
  );
  await call(
    'get',
    `${variants(config.id, b)}/${v.id}`,
    undefined,
    404,
    'PRODUCT_NOT_FOUND',
  );
  await call(
    'post',
    variants(config.id, b),
    { optionValues: {} },
    404,
    'PRODUCT_NOT_FOUND',
  );
  await call(
    'get',
    `${variants(simple.id)}/${v.id}`,
    undefined,
    404,
    'VARIANT_NOT_FOUND',
  );
  await call(
    'patch',
    `${variants(simple.id)}/${v.id}`,
    { unitPrice: '1.00' },
    404,
    'VARIANT_NOT_FOUND',
  );
  await call(
    'delete',
    `${variants(simple.id)}/${v.id}`,
    undefined,
    404,
    'VARIANT_NOT_FOUND',
  );
  const variantPage = await call(
    'get',
    `${variants(config.id)}?limit=1&offset=0`,
    undefined,
    200,
  );
  assert.equal(variantPage.pagination.totalCount, 1);
  await call(
    'get',
    `${products(a)}?limit=1&offset=999999999999`,
    undefined,
    200,
  );
  await call(
    'get',
    `${products(a)}?unknown=1`,
    undefined,
    400,
    'VALIDATION_ERROR',
  );
  await call(
    'get',
    `${variants(config.id)}?limit=101`,
    undefined,
    400,
    'VALIDATION_ERROR',
  );
  await call('delete', `${variants(config.id)}/${v.id}`, undefined, 204);
  assert.equal(
    (await call('get', `${variants(config.id)}/${v.id}`, undefined, 200))
      .isActive,
    false,
  );
  await call(
    'post',
    variants(config.id),
    { optionValues: { Mode: 'First', Edition: 'I' } },
    409,
    'VARIANT_OPTIONS_CONFLICT',
  );
  await call(
    'patch',
    productPath(config.id),
    { options: {} },
    409,
    'PRODUCT_OPTIONS_IN_USE',
  );
  assert.equal(
    (await call('get', productPath(config.id), undefined, 200)).isSellable,
    false,
  );

  // Lifecycle checks use the actual application and database, never service mocks.
  const stockSnapshot = async () => ({
    products: await prisma.catalogItem.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, stockQuantity: true, trackInventory: true },
    }),
    variants: await prisma.productVariant.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, stockQuantity: true, trackInventory: true },
    }),
    movements: await prisma.inventoryMovement.findMany({
      orderBy: { id: 'asc' },
    }),
  });
  const beforeLifecycle = await stockSnapshot();
  const defaultVariant = await prisma.productVariant.findFirstOrThrow({
    where: { catalogItemId: simple.id },
  });
  const defaultPath = `${variants(simple.id)}/${defaultVariant.id}`;
  await call('patch', defaultPath, { isActive: false }, 200);
  assert.equal(
    (await call('get', productPath(simple.id), undefined, 200)).isSellable,
    false,
  );
  assert.equal(
    await prisma.productVariant.count({ where: { catalogItemId: simple.id } }),
    1,
  );
  await call(
    'patch',
    productPath(simple.id),
    { options: { Size: ['M'] } },
    409,
    'PRODUCT_OPTIONS_IN_USE',
  );
  const repeatedActivation = await Promise.all([
    http.patch(defaultPath).send({ isActive: true }),
    http.patch(defaultPath).send({ isActive: true }),
  ]);
  assert.deepEqual(
    repeatedActivation.map((r) => r.status),
    [200, 200],
  );
  checks += 2;
  assert.equal(
    (await call('get', productPath(simple.id), undefined, 200)).isSellable,
    true,
  );
  await call('delete', defaultPath, undefined, 204);
  await call('patch', defaultPath, { isActive: true }, 200);
  await call(
    'patch',
    `${variants(simple.id, b)}/${defaultVariant.id}`,
    { isActive: true },
    404,
    'PRODUCT_NOT_FOUND',
  );
  await call(
    'patch',
    `${variants(config.id)}/${defaultVariant.id}`,
    { isActive: true },
    404,
    'VARIANT_NOT_FOUND',
  );
  await call(
    'patch',
    `${variants(simple.id)}/${randomUUID()}`,
    { isActive: true },
    404,
    'VARIANT_NOT_FOUND',
  );
  const lifecyclePath = `${variants(config.id)}/${v.id}`;
  await call('patch', lifecyclePath, { isActive: true }, 200);
  await call('patch', lifecyclePath, { isActive: false }, 200);
  await call('delete', productPath(config.id), undefined, 204);
  await call(
    'patch',
    lifecyclePath,
    { isActive: true },
    409,
    'PRODUCT_INACTIVE',
  );
  await call('patch', lifecyclePath, { isActive: false }, 200);
  await call('patch', productPath(config.id), { isActive: true }, 200);

  // Simulate stale external/legacy definitions only inside this disposable DB.
  const originalOptions = (
    await prisma.catalogItem.findUniqueOrThrow({ where: { id: config.id } })
  ).options;
  await prisma.catalogItem.update({
    where: { id: config.id },
    data: { options: { Mode: ['New'], Edition: ['I'] } },
  });
  await call(
    'patch',
    lifecyclePath,
    { isActive: true },
    400,
    'VARIANT_OPTIONS_INVALID',
  );
  assert.equal(
    (await prisma.productVariant.findUniqueOrThrow({ where: { id: v.id } }))
      .isActive,
    false,
  );
  await call('patch', lifecyclePath, { isActive: false }, 200);
  await call(
    'patch',
    lifecyclePath,
    { isActive: true, optionValues: { Mode: 'New', Edition: 'I' } },
    200,
  );
  await call('patch', lifecyclePath, { isActive: false }, 200);
  await prisma.catalogItem.update({
    where: { id: config.id },
    data: { options: originalOptions },
  });
  await call(
    'patch',
    lifecyclePath,
    { optionValues: { Mode: 'First', Edition: 'I' }, isActive: true },
    200,
  );
  await call('patch', lifecyclePath, { isActive: false }, 200);
  assert.deepEqual(await stockSnapshot(), beforeLifecycle);

  // Legacy identities, stock and audit links survive new metadata/deactivation APIs.
  const legacy = await call(
    'post',
    '/catalog-items',
    {
      businessId: a,
      name: 'Legacy',
      externalKey: 'LEGACY-1',
      category: 'legacy text',
    },
    201,
  );
  await call(
    'post',
    `/businesses/${a}/catalog-items/${legacy.id}/inventory/adjust`,
    { quantity: 7 },
    201,
  );
  const stockBefore = await prisma.inventoryMovement.findMany({
    where: { catalogItemId: legacy.id },
  });
  await call(
    'patch',
    productPath(legacy.id),
    { name: 'New metadata', categoryId: category.id },
    200,
  );
  await call('delete', productPath(legacy.id), undefined, 204);
  await call(
    'delete',
    `${categories(a)}/${category.id}`,
    undefined,
    409,
    'CATEGORY_IN_USE',
  );
  const retained = await prisma.catalogItem.findUnique({
    where: { id: legacy.id },
  });
  assert.equal(retained.externalKey, 'LEGACY-1');
  assert.equal(retained.category, 'legacy text');
  assert.equal(retained.stockQuantity, 7);
  assert.equal(retained.trackInventory, false);
  assert.deepEqual(
    await prisma.inventoryMovement.findMany({
      where: { catalogItemId: legacy.id },
    }),
    stockBefore,
  );
  await call('patch', productPath(legacy.id), { isActive: true }, 200);

  // Competing option edit and variant creation both wait on the same parent.
  const race = await call(
    'post',
    products(a),
    { name: 'Option race', options: { Mode: ['A', 'B'] } },
    201,
  );
  locker = new Client({ ...local, database });
  await locker.connect();
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM "CatalogItem" WHERE id=$1 FOR UPDATE', [
    race.id,
  ]);
  const creating = http
    .post(variants(race.id))
    .send({ optionValues: { Mode: 'A' } })
    .then((r) => r);
  const editing = http
    .patch(productPath(race.id))
    .send({ options: { Mode: ['B'] } })
    .then((r) => r);
  let blocked = false;
  for (let i = 0; i < 100; i++) {
    const { rows } = await locker.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
      [database],
    );
    if (rows[0].n >= 2) {
      blocked = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await locker.query('SELECT pg_stat_clear_snapshot()');
  }
  await locker.query('COMMIT');
  assert.equal(blocked, true, 'both writers must wait on the parent lock');
  const [createdVariant, editedProduct] = await Promise.all([
    creating,
    editing,
  ]);
  assert.ok(
    (createdVariant.status === 201 && editedProduct.status === 409) ||
      (createdVariant.status === 400 && editedProduct.status === 200),
    JSON.stringify([createdVariant.body, editedProduct.body]),
  );
  const finalRace = await call('get', productPath(race.id), undefined, 200);
  for (const variant of finalRace.variants)
    assert.ok(finalRace.options.Mode.includes(variant.optionValues.Mode));
  checks += 2;
  const duplicateRace = await Promise.all([
    http.post(categories(a)).send({ name: 'Concurrent name' }),
    http.post(categories(a)).send({ name: ' CONCURRENT   NAME ' }),
  ]);
  assert.deepEqual(duplicateRace.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    duplicateRace.find((r) => r.status === 409).body.code,
    'CATEGORY_NAME_CONFLICT',
  );
  checks += 2;
  const disabled = await call(
    'post',
    products(a),
    { name: 'Disabled', isActive: false, options: { Dynamic: ['a'] } },
    201,
  );
  await call(
    'post',
    variants(disabled.id),
    { optionValues: { Dynamic: 'a' } },
    409,
    'PRODUCT_INACTIVE',
  );
  await call(
    'post',
    products(a),
    {
      name: 'Arbitrary JSON keys',
      options: JSON.parse('{"__proto__":["safe"],"constructor":["value"]}'),
    },
    400,
    'VALIDATION_ERROR',
  );
  const special = await call(
    'post',
    products(a),
    {
      name: 'Safe JSON keys',
      options: { toString: ['safe'], hasOwnProperty: ['value'] },
    },
    201,
  );
  const specialVariant = await call(
    'post',
    variants(special.id),
    { optionValues: { hasOwnProperty: 'value', toString: 'safe' } },
    201,
  );
  assert.deepEqual(specialVariant.optionValues, {
    toString: 'safe',
    hasOwnProperty: 'value',
  });
  const collection = await call(
    'post',
    products(a),
    {
      name: 'Bounded collection',
      options: { Selection: Array.from({ length: 21 }, (_, i) => `${i}`) },
    },
    201,
  );
  for (let i = 0; i < 21; i++)
    await call(
      'post',
      variants(collection.id),
      {
        optionValues: { Selection: `${i}` },
        unitPrice: i === 0 ? '0.00' : null,
      },
      201,
    );
  const bounded = await call('get', productPath(collection.id), undefined, 200);
  assert.equal(bounded.variants.length, 20);
  assert.equal(bounded.variantsPagination.totalCount, 21);
  assert.equal(bounded.variantsPagination.nextOffset, 20);
  assert.equal(
    bounded.isSellable,
    true,
    'the priced variant outside the first page must count',
  );
  const last = await call(
    'get',
    `${variants(collection.id)}?limit=20&offset=20`,
    undefined,
    200,
  );
  assert.equal(last.items.length, 1);
  assert.equal(last.items[0].effectivePrice, '0.00');
  const skuParentA = await call(
    'post',
    products(a),
    { name: 'SKU A', options: { Key: ['a', 'b'] } },
    201,
  );
  const skuParentB = await call(
    'post',
    products(b),
    { name: 'SKU B', options: { Key: ['a', 'b'] } },
    201,
  );
  const reserved = await call(
    'post',
    variants(skuParentA.id),
    { sku: 'RESERVED', optionValues: { Key: 'a' } },
    201,
  );
  await call(
    'post',
    variants(skuParentB.id, b),
    { sku: 'RESERVED', optionValues: { Key: 'a' } },
    201,
  );
  await call(
    'delete',
    `${variants(skuParentA.id)}/${reserved.id}`,
    undefined,
    204,
  );
  await call(
    'post',
    variants(skuParentA.id),
    { sku: 'RESERVED', optionValues: { Key: 'b' } },
    409,
    'VARIANT_SKU_CONFLICT',
  );
  const editable = await call(
    'post',
    variants(skuParentA.id),
    { optionValues: { Key: 'b' } },
    201,
  );
  await call(
    'patch',
    `${variants(skuParentA.id)}/${editable.id}`,
    { optionValues: { Key: 'a' } },
    409,
    'VARIANT_OPTIONS_CONFLICT',
  );
  await call(
    'patch',
    `${variants(skuParentA.id)}/${editable.id}`,
    { isActive: false },
    200,
  );
  await call(
    'patch',
    `${variants(skuParentA.id)}/${editable.id}`,
    { isActive: true, sku: 'RESERVED' },
    409,
    'VARIANT_SKU_CONFLICT',
  );
  await call(
    'patch',
    `${variants(skuParentA.id)}/${editable.id}`,
    { isActive: true, optionValues: { Key: 'a' } },
    409,
    'VARIANT_OPTIONS_CONFLICT',
  );
  assert.equal(
    (
      await prisma.productVariant.findUniqueOrThrow({
        where: { id: editable.id },
      })
    ).isActive,
    false,
  );
  await call(
    'patch',
    `${variants(skuParentA.id)}/${editable.id}`,
    { isActive: true },
    200,
  );
  const raceParent = await call(
    'post',
    products(a),
    { name: 'Variant duplicate race', options: { A: ['a'], B: ['b'] } },
    201,
  );
  const optionRace = await Promise.all([
    http
      .post(variants(raceParent.id))
      .send({ optionValues: { A: 'a', B: 'b' } }),
    http
      .post(variants(raceParent.id))
      .send({ optionValues: { B: 'b', A: 'a' } }),
  ]);
  assert.deepEqual(optionRace.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    optionRace.find((r) => r.status === 409).body.code,
    'VARIANT_OPTIONS_CONFLICT',
  );
  checks += 2;
  const refRaceCategory = await call(
    'post',
    categories(a),
    { name: 'Reference race' },
    201,
  );
  const referenceRace = await Promise.all([
    http.delete(`${categories(a)}/${refRaceCategory.id}`),
    http
      .post(products(a))
      .send({ name: 'Reference race product', categoryId: refRaceCategory.id }),
  ]);
  assert.ok(
    (referenceRace[0].status === 204 && referenceRace[1].status === 404) ||
      (referenceRace[0].status === 409 && referenceRace[1].status === 201),
    JSON.stringify(
      referenceRace.map((r) => ({ status: r.status, body: r.body })),
    ),
  );
  checks += 2;
  const skuRaceParents = [];
  for (let i = 0; i < 2; i++)
    skuRaceParents.push(
      await call(
        'post',
        products(a),
        { name: `SKU race ${i}`, options: { Kind: ['One'] } },
        201,
      ),
    );
  const skuRace = await Promise.all(
    skuRaceParents.map((p) =>
      http
        .post(variants(p.id))
        .send({ sku: 'SIMULTANEOUS-SKU', optionValues: { Kind: 'One' } }),
    ),
  );
  assert.deepEqual(skuRace.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    skuRace.find((r) => r.status === 409).body.code,
    'VARIANT_SKU_CONFLICT',
  );
  checks += 2;
  // Fault injection is scoped to this disposable database and this fixture name.
  // It proves the parent INSERT rolls back when default-variant INSERT fails.
  const variantsBefore = await prisma.productVariant.count();
  await prisma.$executeRawUnsafe(`CREATE FUNCTION task2_default_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM "CatalogItem" WHERE id=NEW."catalogItemId" AND name='Task 2 atomic failure probe') THEN
        RAISE EXCEPTION 'Expected disposable verification failure';
      END IF;
      RETURN NEW;
    END $$`);
  try {
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER task2_default_failure BEFORE INSERT ON "ProductVariant" FOR EACH ROW EXECUTE FUNCTION task2_default_failure()',
    );
    try {
      await call(
        'post',
        products(a),
        { name: 'Task 2 atomic failure probe' },
        500,
        'INTERNAL_SERVER_ERROR',
      );
      assert.equal(
        await prisma.catalogItem.count({
          where: { name: 'Task 2 atomic failure probe' },
        }),
        0,
      );
      assert.equal(await prisma.productVariant.count(), variantsBefore);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER task2_default_failure ON "ProductVariant"',
      );
    }
  } finally {
    await prisma.$executeRawUnsafe('DROP FUNCTION task2_default_failure()');
  }
  console.log(
    `PASS: ${checks} live HTTP checks plus database assertions; Category/Product/Variant CRUD, pagination, decimal inheritance, validation, tenant isolation, defaults/transitions, retained legacy stock/history, and competing option writes.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (locker) {
      await locker.query('ROLLBACK').catch(() => {});
      await locker.end();
    }
    if (app) await app.close();
    await admin.end();
    if (created)
      console.log(`Disposable Task 2 database retained: ${database}`);
  });
