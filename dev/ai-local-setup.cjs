// Creates ONE new disposable localhost database. Never resets/reuses a database.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, generateKeyPairSync } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { ConfigService } = require('@nestjs/config');
const {
  localDatabase,
  FIXTURE_EMAIL,
  FIXTURE_NAME,
} = require('./ai-local.cjs');
const root = path.resolve(__dirname, '..');

async function setup(directory = path.join(root, '.tmp', 'ai-local')) {
  for (const f of ['backend.env', 'ai.env', 'fixture.json'])
    if (fs.existsSync(path.join(directory, f)))
      throw new Error(
        'Local fixture files already exist; choose a fresh directory. No overwrite allowed.',
      );
  const port = Number(process.env.AI_LOCAL_PG_PORT ?? 55439);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid local PostgreSQL port');
  const database = 'brandora_ai_local_' + randomUUID().replaceAll('-', '');
  const url = 'postgresql://postgres@127.0.0.1:' + port + '/' + database;
  localDatabase(url);
  const admin = new Client({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    database: 'postgres',
    connectionTimeoutMillis: 3000,
  });
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + database + '"');
  } finally {
    await admin.end();
  }
  const migration = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      timeout: 90000,
    },
  );
  if (migration.status !== 0)
    throw new Error('Fresh local database initialization failed');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const {
    BusinessesService,
  } = require('../dist/businesses/businesses.service');
  const {
    ProductAccessService,
  } = require('../dist/products/product-access.service');
  const { ProductsService } = require('../dist/products/products.service');
  const { VariantsService } = require('../dist/variants/variants.service');
  const { InventoryService } = require('../dist/inventory/inventory.service');
  const prisma = new PrismaService(new ConfigService({ DATABASE_URL: url }));
  try {
    await prisma.$connect();
    const owner = await prisma.user.create({
      data: {
        email: FIXTURE_EMAIL,
        passwordHash: randomBytes(48).toString('base64url'),
      },
    });
    const business = await new BusinessesService(prisma).create(
      { name: FIXTURE_NAME },
      owner.id,
    );
    const access = new ProductAccessService(prisma);
    const products = new ProductsService(prisma, access);
    const variants = new VariantsService(prisma, access);
    const inventory = new InventoryService(prisma);
    const black = await products.create(business.id, {
      name: 'تيشيرت قطن',
      externalKey: 'LOCAL-TSHIRT',
      basePrice: '250.00',
      options: { Color: ['Black', 'White'], Size: ['M', 'L'] },
      attributes: { material: 'قطن' },
    });
    const blackL = await variants.create(business.id, black.id, {
      optionValues: { Color: 'Black', Size: 'L' },
      unitPrice: '275.00',
      sku: 'LOCAL-BLACK-L',
    });
    const blackM = await variants.create(business.id, black.id, {
      optionValues: { Color: 'Black', Size: 'M' },
      sku: 'LOCAL-BLACK-M',
    });
    for (const [variant, quantity] of [
      [blackL, 7],
      [blackM, 0],
    ])
      await inventory.setQuantity(
        { businessId: business.id, productId: black.id, id: variant.id },
        quantity,
      );
    const white = black;
    const whiteL = await variants.create(business.id, white.id, {
      optionValues: { Color: 'White', Size: 'L' },
      unitPrice: '290.00',
      sku: 'LOCAL-WHITE-L',
    });
    await inventory.setQuantity(
      { businessId: business.id, productId: white.id, id: whiteL.id },
      3,
    );
    const simple = await products.create(business.id, {
      name: 'قميص كتان',
      externalKey: 'LOCAL-LINEN',
      basePrice: '350.00',
      options: {},
    });
    const foreign = await new BusinessesService(prisma).create(
      { name: 'Other isolated fixture business' },
      owner.id,
    );
    const foreignProduct = await products.create(foreign.id, {
      name: 'FOREIGN PRODUCT MUST NOT LEAK',
      externalKey: 'FOREIGN',
      basePrice: '999.00',
    });
    const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const outbound = randomBytes(48).toString('base64url');
    const inbound = randomBytes(48).toString('base64url');
    const shared = {
      APP_ENV: 'local',
      AI_LOCAL_ENABLED: 'true',
      AI_SERVICE_TOKEN: outbound,
      BACKEND_SERVICE_TOKEN: inbound,
    };
    const backend = {
      ...shared,
      NODE_ENV: 'development',
      AI_INTEGRATION_ENABLED: 'false',
      AI_LOCAL_DATABASE_URL: url,
      AI_LOCAL_BUSINESS_ID: business.id,
      AI_LOCAL_OWNER_ID: owner.id,
      AI_LOCAL_PORT: '3099',
      AI_BASE_URL: 'http://127.0.0.1:8000',
      AI_CONTEXT_PRIVATE_KEY: keys.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    };
    const ai = {
      ...shared,
      AI_PROVIDER: 'rules',
      AI_LOCAL_PROVIDER: 'rules',
      AI_INTEGRATION_ENABLED: 'true',
      BACKEND_BASE_URL: 'http://127.0.0.1:3099',
      BACKEND_CONTEXT_PUBLIC_KEY: keys.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
      BACKEND_TIMEOUT_SECONDS: '5',
      INTEGRATION_TIMEOUT_SECONDS: '25',
      PRODUCTS_INTEGRATION_ENABLED: 'false',
      SUPPLIED_CONTEXT_COMPAT_ENABLED: 'false',
      LEGACY_API_ENABLED: 'false',
      ENABLE_DEV_ENDPOINTS: 'false',
      GROQ_API_KEY: '',
    };
    const fixture = {
      database,
      businessId: business.id,
      ownerId: owner.id,
      products: { black: black.id, white: white.id, simple: simple.id },
      variants: { blackL: blackL.id, blackM: blackM.id, whiteL: whiteL.id },
      foreignBusinessId: foreign.id,
      foreignProductId: foreignProduct.id,
      expected: {
        blackLPrice: '275.00',
        blackLStock: 7,
        blackMPrice: '250.00',
        blackMStock: 0,
        whiteLPrice: '290.00',
        whiteLStock: 3,
      },
    };
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dotenv = (data) =>
      Object.entries(data)
        .map(([k, v]) => k + '=' + JSON.stringify(v))
        .join('\n') + '\n';
    for (const [name, data] of [
      ['backend.env', dotenv(backend)],
      ['ai.env', dotenv(ai)],
      ['fixture.json', JSON.stringify(fixture, null, 2) + '\n'],
    ])
      fs.writeFileSync(path.join(directory, name), data, {
        flag: 'wx',
        mode: 0o600,
      });
    return { directory, backend, ai, fixture };
  } finally {
    await prisma.$disconnect();
  }
}
if (require.main === module) {
  setup(process.argv[2] ? path.resolve(process.argv[2]) : undefined)
    .then(({ directory }) => {
      console.log(
        'Fresh localhost fixture initialized. Private config written; no credentials printed.',
      );
      console.log(
        'Local configuration directory: ' +
          path.relative(root, directory) +
          '. See docs/ai-local-testing.md for startup.',
      );
    })
    .catch(() => {
      console.error(
        'Local fixture setup failed; check local PostgreSQL and use a fresh output directory.',
      );
      process.exitCode = 1;
    });
}
module.exports = { setup };
