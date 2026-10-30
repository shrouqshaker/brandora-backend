// Local-only real HTTP/Prisma verification. Never reads a production URL.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');
const request = require('supertest');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const database = `brandora_auth_${randomUUID().replaceAll('-', '')}`;
const local = { host: '127.0.0.1', port: 55439, user: 'postgres' };
const url = `postgresql://postgres@127.0.0.1:55439/${database}`;
const admin = new Client({ ...local, database: 'postgres' });
let app,
  db,
  checks = 0,
  created = false;
const secret = randomBytes(48).toString('base64');
const password = 'SecurePassword123!';
const root = path.resolve(__dirname, '..');
function prisma(...args) {
  const result = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', ...args],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      timeout: 60000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
async function main() {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  // Start at the actual Task 2 migrations, seed historical data, then upgrade.
  const beforeAuth = new Client({ ...local, database });
  await beforeAuth.connect();
  const legacyId = randomUUID(),
    legacyItem = randomUUID();
  try {
    for (const name of fs
      .readdirSync(path.join(root, 'prisma/migrations'))
      .filter(
        (name) =>
          name < '20261028000000_add_auth_ownership' &&
          fs.existsSync(
            path.join(root, 'prisma/migrations', name, 'migration.sql'),
          ),
      )
      .sort()) {
      await beforeAuth.query(
        fs.readFileSync(
          path.join(root, 'prisma/migrations', name, 'migration.sql'),
          'utf8',
        ),
      );
      prisma('migrate', 'resolve', '--applied', name);
    }
    await beforeAuth.query(
      'INSERT INTO "Business" (id,name,"updatedAt") VALUES ($1,\'Unowned legacy fixture\',now())',
      [legacyId],
    );
    await beforeAuth.query(
      'INSERT INTO "BusinessSettings" ("businessId","updatedAt") VALUES ($1,now())',
      [legacyId],
    );
    await beforeAuth.query(
      'INSERT INTO "CatalogItem" (id,"businessId",name,"stockQuantity","trackInventory","updatedAt") VALUES ($1,$2,\'Historical item\',NULL,false,now())',
      [legacyItem, legacyId],
    );
    const tables = [
      'Business',
      'BusinessSettings',
      'WorkingHour',
      'Category',
      'CatalogItem',
      'ProductVariant',
      'InventoryMovement',
      'ImportJob',
    ];
    const snapshot = async () => {
      const result = {};
      for (const table of tables) {
        result[table] = (
          await beforeAuth.query(
            `SELECT ${table === 'CatalogItem' ? "to_jsonb(t) - ARRAY['stockQuantity','trackInventory']" : 'to_jsonb(t)'} AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
          )
        ).rows;
      }
      return result;
    };
    const before = await snapshot();
    prisma('migrate', 'deploy');
    assert.deepEqual(
      await snapshot(),
      before,
      'Auth migration must preserve all existing rows',
    );
  } finally {
    await beforeAuth.end();
  }
  prisma('migrate', 'deploy');
  Object.assign(process.env, {
    DATABASE_URL: url,
    PORT: '3000',
    JWT_SECRET: secret,
    JWT_ISSUER: 'brandora-auth-test',
    JWT_AUDIENCE: 'android-test',
    AUTH_EMAIL_MODE: 'disabled',
    AUTH_TRUSTED_PROXY_CIDRS: '',
    IMPORT_STORAGE_DIR: path.join(root, '.tmp/auth-imports', database),
  });
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
  db = app.get(PrismaService);
  const http = request(app.getHttpServer());
  async function call(method, route, body, status, token, code) {
    let op = http[method](route);
    if (token) op = op.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) op = op.send(body);
    const result = await op;
    assert.equal(
      result.status,
      status,
      `${method} ${route}: ${JSON.stringify(result.body)}`,
    );
    if (code) assert.equal(result.body.code, code);
    assert.ok(!JSON.stringify(result.body).includes('passwordHash'));
    checks++;
    return result.body;
  }
  assert.equal(await db.user.count(), 0);
  assert.equal(await db.businessMember.count(), 0);
  await call(
    'post',
    '/businesses',
    { name: 'Unauthenticated creation' },
    401,
    undefined,
    'UNAUTHORIZED',
  );
  await call('get', '/businesses', undefined, 401, undefined, 'UNAUTHORIZED');
  await call('get', '/auth/me', undefined, 401, undefined, 'UNAUTHORIZED');
  // Explicitly unowned test fixture. No claim endpoint or automatic ownership.
  const legacy = await db.business.findUniqueOrThrow({
    where: { id: legacyId },
  });
  const owner = await call(
    'post',
    '/auth/register',
    { email: ' OWNER@Example.com ', password },
    201,
  );
  assert.equal(owner.user.email, 'owner@example.com');
  assert.equal(owner.expiresIn, 900);
  const stored = await db.user.findUniqueOrThrow({
    where: { id: owner.user.id },
  });
  assert.match(stored.passwordHash, /^\$argon2id\$/);
  assert.ok(await argon2.verify(stored.passwordHash, password));
  assert.notEqual(stored.passwordHash, password);
  await call(
    'post',
    '/auth/register',
    { email: 'Owner@example.com', password },
    409,
    undefined,
    'EMAIL_UNAVAILABLE',
  );
  for (const body of [
    { email: 'bad', password },
    { email: 'bad@example.com', password: 'weak' },
    { email: 'valid@example.com', password, role: 'OWNER' },
    { email: 'valid@example.com', password, businessId: legacy.id },
  ]) {
    await call(
      'post',
      '/auth/register',
      body,
      400,
      undefined,
      'VALIDATION_ERROR',
    );
  }
  const concurrent = await Promise.all([
    http.post('/auth/register').send({ email: 'RACE@example.com', password }),
    http.post('/auth/register').send({ email: ' race@example.com ', password }),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 409]);
  checks += 2;
  assert.equal(
    await db.user.count({ where: { email: 'race@example.com' } }),
    1,
  );
  const stranger = await call(
    'post',
    '/auth/register',
    { email: 'stranger@example.com', password },
    201,
  );
  const login = await call(
    'post',
    '/auth/login',
    { email: 'OWNER@example.com', password },
    200,
  );
  assert.equal(login.user.id, owner.user.id);
  const usersBeforeOversized = await db.user.count();
  await call(
    'post',
    '/auth/register',
    {
      email: 'oversized@example.com',
      password: 'Aa1' + 'x'.repeat(126),
    },
    400,
    undefined,
    'VALIDATION_ERROR',
  );
  assert.equal(await db.user.count(), usersBeforeOversized);
  const incorrect = await call(
    'post',
    '/auth/login',
    { email: 'owner@example.com', password: 'incorrect' },
    401,
  );
  const unknown = await call(
    'post',
    '/auth/login',
    { email: 'unknown@example.com', password: 'incorrect' },
    401,
  );
  assert.deepEqual(incorrect, unknown);
  const claims = jwt.verify(owner.accessToken, secret, {
    algorithms: ['HS256'],
    issuer: 'brandora-auth-test',
    audience: 'android-test',
  });
  assert.deepEqual(Object.keys(claims).sort(), [
    'aud',
    'exp',
    'iat',
    'iss',
    'sid',
    'sub',
    'ver',
  ]);
  assert.equal(claims.exp - claims.iat, 900);
  const a = await call(
    'post',
    '/businesses',
    { name: 'Business A' },
    201,
    owner.accessToken,
  );
  const b = await call(
    'post',
    '/businesses',
    { name: 'Business B' },
    201,
    owner.accessToken,
  );
  assert.equal(
    await db.businessMember.count({
      where: { userId: owner.user.id, role: 'OWNER', isActive: true },
    }),
    2,
  );
  await call(
    'post',
    '/businesses',
    { name: 'Forged owner', ownerId: stranger.user.id },
    400,
    owner.accessToken,
  );
  const me = await call('get', '/auth/me', undefined, 200, owner.accessToken);
  assert.equal(
    (
      await call(
        'get',
        `/auth/me?userId=${stranger.user.id}`,
        undefined,
        200,
        owner.accessToken,
      )
    ).id,
    owner.user.id,
  );
  assert.deepEqual(me.businesses.map((v) => v.id).sort(), [a.id, b.id].sort());
  assert.ok(me.businesses.every((v) => v.role === 'OWNER'));
  const list = await call(
    'get',
    '/businesses?limit=1',
    undefined,
    200,
    owner.accessToken,
  );
  assert.equal(list.items.length, 1);
  assert.equal(list.pagination.totalCount, 2);
  assert.equal(
    (await call('get', '/businesses', undefined, 200, stranger.accessToken))
      .items.length,
    0,
  );
  await call(
    'get',
    `/businesses/${legacy.id}`,
    undefined,
    404,
    owner.accessToken,
  );
  assert.equal(
    await db.businessMember.count({ where: { businessId: legacy.id } }),
    0,
  );
  await call(
    'patch',
    `/businesses/${legacy.id}`,
    { name: 'Claimed', ownerId: owner.user.id },
    404,
    owner.accessToken,
    'NOT_FOUND',
  );
  await call(
    'post',
    '/businesses',
    { name: 'Claim by ID', businessId: legacy.id },
    400,
    owner.accessToken,
    'VALIDATION_ERROR',
  );
  const injectedClaims = jwt.sign(
    {
      sub: stranger.user.id,
      sid: jwt.decode(stranger.accessToken).sid,
      ver: 0,
      role: 'OWNER',
      businessId: a.id,
    },
    secret,
    {
      algorithm: 'HS256',
      issuer: 'brandora-auth-test',
      audience: 'android-test',
      expiresIn: 900,
    },
  );
  await call(
    'get',
    `/businesses/${a.id}`,
    undefined,
    404,
    injectedClaims,
    'NOT_FOUND',
  );
  for (const business of [a, b])
    await call(
      'get',
      `/businesses/${business.id}`,
      undefined,
      200,
      owner.accessToken,
    );
  const product = await call(
    'post',
    `/businesses/${a.id}/products`,
    { name: 'Owned product', basePrice: '12.00' },
    201,
    owner.accessToken,
  );
  const variant = product.variants[0];
  const category = await call(
    'post',
    `/businesses/${a.id}/categories`,
    { name: 'General' },
    201,
    owner.accessToken,
  );
  const job = await db.importJob.create({
    data: { businessId: a.id, fileName: 'ownership-fixture.xlsx' },
  });
  const routes = [
    ['get', `/businesses/${a.id}`],
    ['patch', `/businesses/${a.id}`, { name: 'Owned' }],
    ['get', `/businesses/${a.id}/settings`],
    ['patch', `/businesses/${a.id}/settings`, { acceptsCash: true }],
    ['get', `/businesses/${a.id}/working-hours`],
    ['put', `/businesses/${a.id}/working-hours`, {}],
    ['get', `/catalog-items?businessId=${a.id}`],
    ['post', '/catalog-items', { businessId: a.id, name: 'Owned' }],
    ['get', `/catalog-items/${product.id}?businessId=${a.id}`],
    [
      'patch',
      `/catalog-items/${product.id}`,
      { businessId: a.id, name: 'Owned' },
    ],
    ['delete', `/catalog-items/${product.id}?businessId=${a.id}`],
    ['get', `/businesses/${a.id}/categories`],
    ['post', `/businesses/${a.id}/categories`, { name: 'Other' }],
    ['get', `/businesses/${a.id}/categories/${category.id}`],
    [
      'patch',
      `/businesses/${a.id}/categories/${category.id}`,
      { name: 'Other' },
    ],
    ['delete', `/businesses/${a.id}/categories/${category.id}`],
    ['get', `/businesses/${a.id}/products`],
    ['post', `/businesses/${a.id}/products`, { name: 'Owned' }],
    ['get', `/businesses/${a.id}/products/${product.id}`],
    ['patch', `/businesses/${a.id}/products/${product.id}`, { name: 'Owned' }],
    ['delete', `/businesses/${a.id}/products/${product.id}`],
    ['get', `/businesses/${a.id}/products/${product.id}/variants`],
    [
      'post',
      `/businesses/${a.id}/products/${product.id}/variants`,
      { optionValues: {} },
    ],
    [
      'get',
      `/businesses/${a.id}/products/${product.id}/variants/${variant.id}`,
    ],
    [
      'patch',
      `/businesses/${a.id}/products/${product.id}/variants/${variant.id}`,
      { isActive: false },
    ],
    [
      'delete',
      `/businesses/${a.id}/products/${product.id}/variants/${variant.id}`,
    ],
    [
      'post',
      `/businesses/${a.id}/products/${product.id}/variants/${variant.id}/inventory/adjust`,
      { quantity: 9 },
    ],
    [
      'get',
      `/businesses/${a.id}/products/${product.id}/variants/${variant.id}/inventory/movements`,
    ],
    ['get', `/businesses/${a.id}/inventory/movements`],
    ['post', `/businesses/${a.id}/imports/excel/analyze`],
    ['get', `/businesses/${a.id}/imports`],
    ['get', `/imports/${job.id}`],
    ['get', `/imports/${job.id}/mapping`],
    ['patch', `/imports/${job.id}/mapping`, {}],
    ['post', `/imports/${job.id}/validate`],
    ['get', `/imports/${job.id}/validation-results`],
    ['get', `/imports/${job.id}/preview`],
    ['post', `/imports/${job.id}/execute`],
  ];
  for (const [method, route, body] of routes) {
    await call(method, route, body, 401, undefined, 'UNAUTHORIZED');
    await call(method, route, body, 404, stranger.accessToken, 'NOT_FOUND');
  }
  for (const route of [
    `/businesses/${a.id}`,
    `/businesses/${a.id}/settings`,
    `/businesses/${a.id}/working-hours`,
    `/catalog-items?businessId=${a.id}`,
    `/businesses/${a.id}/categories`,
    `/businesses/${a.id}/products`,
    `/businesses/${a.id}/products/${product.id}/variants`,
    `/businesses/${a.id}/inventory/movements`,
    `/businesses/${a.id}/imports`,
    `/imports/${job.id}`,
  ])
    await call('get', route, undefined, 200, owner.accessToken);
  // Malformed headers and bad JWT policies traverse the real global guard.
  for (const header of [
    'Bearer',
    'Basic abc',
    'Bearer a.b.c',
    'Bearer  a.b.c',
    'Bearer a.b.c trailing',
  ]) {
    await http.get('/auth/me').set('Authorization', header).expect(401);
    checks++;
  }
  for (const options of [
    { expiresIn: -1 },
    { issuer: 'wrong' },
    { audience: 'wrong' },
    { algorithm: 'HS384' },
  ]) {
    const token = jwt.sign(
      { sub: owner.user.id, sid: claims.sid, ver: 0 },
      secret,
      {
        algorithm: 'HS256',
        issuer: 'brandora-auth-test',
        audience: 'android-test',
        expiresIn: 900,
        ...options,
      },
    );
    await call('get', '/auth/me', undefined, 401, token);
  }
  await call(
    'get',
    '/auth/me',
    undefined,
    401,
    jwt.sign({ sub: owner.user.id }, randomBytes(48), { expiresIn: 900 }),
  );
  await db.businessMember.update({
    where: { userId_businessId: { userId: owner.user.id, businessId: a.id } },
    data: { isActive: false },
  });
  await call('get', `/businesses/${a.id}`, undefined, 404, owner.accessToken);
  await call('get', `/imports/${job.id}`, undefined, 404, owner.accessToken);
  const afterRevocation = await call(
    'get',
    '/auth/me',
    undefined,
    200,
    owner.accessToken,
  );
  assert.deepEqual(
    afterRevocation.businesses.map((v) => v.id),
    [b.id],
  );
  assert.equal(
    (await call('get', '/businesses', undefined, 200, owner.accessToken))
      .pagination.totalCount,
    1,
  );
  // SQL-level normalization, uniqueness and restrictive foreign keys.
  const sql = new Client({ ...local, database });
  await sql.connect();
  try {
    await assert.rejects(
      sql.query(
        'INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ($1,$2,$3,now())',
        [randomUUID(), 'OWNER@example.com', 'fixture'],
      ),
      (e) => e.code === '23514',
    );
    await assert.rejects(
      sql.query(
        'INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ($1,$2,$3,now())',
        [randomUUID(), 'owner@example.com', 'fixture'],
      ),
      (e) => e.code === '23505',
    );
    await assert.rejects(
      sql.query(
        'INSERT INTO "BusinessMember" (id,"userId","businessId","updatedAt") VALUES ($1,$2,$3,now())',
        [randomUUID(), owner.user.id, b.id],
      ),
      (e) => e.code === '23505',
    );
    await assert.rejects(
      sql.query('DELETE FROM "User" WHERE id=$1', [owner.user.id]),
      (e) => e.code === '23503',
    );
    await assert.rejects(
      sql.query('DELETE FROM "Business" WHERE id=$1', [b.id]),
      (e) => e.code === '23503',
    );
    // Fixture-specific failure verifies Business + settings + membership rollback.
    const businessesBefore = await db.business.count();
    const settingsBefore = await db.businessSettings.count();
    await sql.query(
      `CREATE FUNCTION auth_owner_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."userId" = '${stranger.user.id}'::uuid THEN RAISE EXCEPTION 'ownership fixture failure'; END IF; RETURN NEW; END $$`,
    );
    await sql.query(
      'CREATE TRIGGER auth_owner_failure BEFORE INSERT ON "BusinessMember" FOR EACH ROW EXECUTE FUNCTION auth_owner_failure()',
    );
    try {
      await call(
        'post',
        '/businesses',
        { name: 'Must roll back' },
        500,
        stranger.accessToken,
      );
    } finally {
      await sql.query('DROP TRIGGER auth_owner_failure ON "BusinessMember"');
      await sql.query('DROP FUNCTION auth_owner_failure()');
    }
    assert.equal(await db.business.count(), businessesBefore);
    assert.equal(await db.businessSettings.count(), settingsBefore);
  } finally {
    await sql.end();
  }
  assert.equal(
    Object.hasOwn(
      await db.catalogItem.findUniqueOrThrow({ where: { id: product.id } }),
      'stockQuantity',
    ),
    false,
  );
  assert.equal(await db.inventoryMovement.count(), 0);
  assert.equal(
    (await db.catalogItem.findUniqueOrThrow({ where: { id: legacyItem } }))
      .name,
    'Historical item',
  );
  // Only invalid credentials are used to exhaust the endpoint's separate limiter.
  let limited = false;
  for (let i = 0; i < 11; i++) {
    const response = await http
      .post('/auth/login')
      .send({ email: 'unknown@example.com', password: 'wrong' });
    assert.ok([401, 429].includes(response.status));
    if (response.status === 429) limited = true;
    checks++;
  }
  assert.ok(limited);
  const registerLimited = await http
    .post('/auth/register')
    .send({ email: 'never-created@example.com', password });
  assert.equal(registerLimited.status, 429);
  checks++;
  await http
    .post('/auth/register')
    .send({ email: 'limited@example.com', password })
    .expect(429);
  checks++;
  console.log(prisma('migrate', 'status').trim());
  console.log(
    prisma(
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--exit-code',
    ).trim(),
  );
  console.log(
    `PASS: ${checks} live auth HTTP checks plus database assertions; Argon2id, JWT policies, all ${routes.length} resource route denial pairs, multi-business ownership, revocation, uniqueness, rollback, rate limiting, unchanged stock and no drift.`,
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app) await app.close();
    await admin.end();
    if (created) console.log(`Disposable auth database retained: ${database}`);
  });
