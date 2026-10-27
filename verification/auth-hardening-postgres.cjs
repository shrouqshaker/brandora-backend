// Real, two-instance HTTP/Prisma tests. Local-only, new database, retained data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const {
  controllerRoutes,
  verifyControllerInventory,
} = require('./controller-route-inventory.cjs');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const request = require('supertest');
const argon2 = require('argon2');
const { gzipSync } = require('node:zlib');
const nodeHttp = require('node:http');
const root = path.resolve(__dirname, '..');
const database = `brandora_hardening_${randomUUID().replaceAll('-', '')}`;
const local = { host: '127.0.0.1', port: 55439, user: 'postgres' };
const url = `postgresql://postgres@127.0.0.1:55439/${database}`;
const admin = new Client({ ...local, database: 'postgres' });
const apps = [];
let created = false,
  checks = 0;
const digest = (value) => createHash('sha256').update(value).digest('hex');
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
  const seed = new Client({ ...local, database });
  await seed.connect();
  const legacyId = randomUUID();
  const password = 'SecurePassword123!';
  const legacyHash = await argon2.hash(password, { type: argon2.argon2id });
  try {
    for (const name of fs
      .readdirSync(path.join(root, 'prisma/migrations'))
      .filter(
        (name) =>
          name < '20261029000000_auth_security_hardening' &&
          fs.existsSync(
            path.join(root, 'prisma/migrations', name, 'migration.sql'),
          ),
      )
      .sort()) {
      await seed.query(
        fs.readFileSync(
          path.join(root, 'prisma/migrations', name, 'migration.sql'),
          'utf8',
        ),
      );
      prisma('migrate', 'resolve', '--applied', name);
    }
    await seed.query(
      'INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ($1,$2,$3,now())',
      [legacyId, 'historical@example.com', legacyHash],
    );
    const before = (
      await seed.query('SELECT * FROM "User" WHERE id=$1', [legacyId])
    ).rows[0];
    prisma('migrate', 'deploy');
    const after = (
      await seed.query('SELECT * FROM "User" WHERE id=$1', [legacyId])
    ).rows[0];
    assert.equal(after.authVersion, 0);
    delete after.authVersion;
    assert.deepEqual(after, before);
    for (const table of ['AuthSession', 'PasswordResetToken', 'AuthRateBucket'])
      assert.equal(
        (await seed.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0]
          .n,
        0,
      );
  } finally {
    await seed.end();
  }
  Object.assign(process.env, {
    DATABASE_URL: url,
    PORT: '3000',
    JWT_SECRET: randomBytes(48).toString('base64'),
    JWT_ISSUER: 'hardening-test',
    JWT_AUDIENCE: 'android-test',
    AUTH_EMAIL_MODE: 'disabled',
    AUTH_TRUSTED_PROXY_CIDRS: '',
    IMPORT_STORAGE_DIR: path.join(
      tmpdir(),
      'brandora-hardening-imports',
      database,
    ),
  });
  require('reflect-metadata');
  const { Test } = require('@nestjs/testing');
  const { ConfigService } = require('@nestjs/config');
  const { ValidationPipe, HttpStatus } = require('@nestjs/common');
  const { HttpAdapterHost } = require('@nestjs/core');
  const { AppModule } = require('../dist/app.module');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const { PasswordResetMailer } = require('../dist/auth/password-reset.mailer');
  const {
    AuthRateStore,
    PostgresAuthRateStore,
  } = require('../dist/auth/auth-rate.store');
  const {
    AuthSessionsService,
    lockUser,
  } = require('../dist/auth/auth-sessions.service');
  const {
    AppHttpException,
  } = require('../dist/common/errors/app-http.exception');
  const { ErrorCode } = require('../dist/common/errors/error-code');
  const {
    HttpExceptionFilter,
  } = require('../dist/common/errors/http-exception.filter');
  const mailer = {
    ready: true,
    fail: false,
    sent: [],
    assertReady() {
      if (!this.ready)
        throw new AppHttpException(
          ErrorCode.AUTH_EMAIL_UNAVAILABLE,
          HttpStatus.SERVICE_UNAVAILABLE,
          'Password recovery email is not configured',
        );
    },
    async send(email, token) {
      this.sent.push({ email, token });
      if (this.fail) throw new Error('private SMTP failure');
    },
  };
  async function application(rateStore) {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordResetMailer)
      .useValue(mailer);
    if (rateStore)
      builder = builder.overrideProvider(AuthRateStore).useValue(rateStore);
    const module = await builder.compile();
    const app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    await app.init();
    apps.push(app);
    return app;
  }
  await application();
  await application();
  const db = apps[0].get(PrismaService),
    db2 = apps[1].get(PrismaService);
  assert.notEqual(
    db,
    db2,
    'two independent Nest/Prisma instances must share the database',
  );
  const http = apps.map((app) => request(app.getHttpServer()));
  async function call(method, route, body, expected, token, instance = 0) {
    let req = http[instance][method](route);
    if (body !== undefined) req = req.send(body);
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    const response = await req;
    assert.equal(
      response.status,
      expected,
      `${method} ${route}: ${JSON.stringify(response.body)}`,
    );
    for (const field of [
      'passwordHash',
      'refreshTokenHash',
      'usedTokenHashes',
      'tokenHash',
    ])
      assert.ok(!JSON.stringify(response.body).includes(field));
    checks++;
    return response.body;
  }
  const routes = controllerRoutes();
  const inventory = verifyControllerInventory(routes);
  for (const route of routes.filter((route) => route.scope !== 'public')) {
    const response = await call(
      route.verb.toLowerCase(),
      route.route.replace(/:[A-Za-z][A-Za-z0-9_]*/g, () => randomUUID()),
      {},
      401,
    );
    assert.equal(response.code, ErrorCode.UNAUTHORIZED);
  }
  console.log(
    `PASS: compiled inventory ${inventory.routes} routes, ${inventory.protected} protected, ${inventory.public} public; all ${inventory.protected} protected routes reject anonymous HTTP requests.`,
  );
  // Simulate a later quota window inside this new DB, never delete records.
  const expireLimits = () =>
    db.authRateBucket.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
  const login = (email, pass = password, instance = 0) =>
    call(
      'post',
      '/auth/login',
      { email, password: pass },
      200,
      undefined,
      instance,
    );
  const owner = await call(
    'post',
    '/auth/register',
    { email: 'owner@example.com', password },
    201,
  );
  const stranger = await call(
    'post',
    '/auth/register',
    { email: 'stranger@example.com', password },
    201,
    undefined,
    1,
  );
  assert.equal(owner.refreshToken.length, 80);
  assert.equal(owner.expiresIn, 900);
  let stored = await db.authSession.findUniqueOrThrow({
    where: { refreshTokenHash: digest(owner.refreshToken) },
  });
  assert.equal(stored.expiresAt - stored.createdAt, 30 * 86400000);
  assert.ok(!JSON.stringify(stored).includes(owner.refreshToken));
  const a = await call(
    'post',
    '/businesses',
    { name: 'A' },
    201,
    owner.accessToken,
  );
  const b = await call(
    'post',
    '/businesses',
    { name: 'B' },
    201,
    owner.accessToken,
  );
  await call(
    'get',
    `/businesses/${a.id}`,
    undefined,
    404,
    stranger.accessToken,
    1,
  );
  const rotated = await call(
    'post',
    '/auth/refresh',
    { refreshToken: owner.refreshToken },
    200,
    undefined,
    1,
  );
  assert.notEqual(rotated.refreshToken, owner.refreshToken);
  assert.equal(rotated.refreshExpiresAt, owner.refreshExpiresAt);
  for (const business of [a, b])
    await call(
      'get',
      `/businesses/${business.id}`,
      undefined,
      200,
      rotated.accessToken,
    );
  await call(
    'post',
    '/auth/refresh',
    { refreshToken: owner.refreshToken },
    401,
  );
  await call(
    'post',
    '/auth/refresh',
    { refreshToken: rotated.refreshToken },
    401,
  );
  await call('get', '/auth/me', undefined, 401, rotated.accessToken);
  assert.ok(
    (await db.authSession.findUniqueOrThrow({ where: { id: stored.id } }))
      .revokedAt,
  );
  const racing = await login('owner@example.com');
  const race = await Promise.all(
    http.map((client) =>
      client.post('/auth/refresh').send({ refreshToken: racing.refreshToken }),
    ),
  );
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 401]);
  checks += 2;
  const winner = race.find((r) => r.status === 200).body;
  await call(
    'post',
    '/auth/refresh',
    { refreshToken: winner.refreshToken },
    401,
  );
  await call('get', '/auth/me', undefined, 401, winner.accessToken);
  const devices = [
    await login('owner@example.com'),
    await login('owner@example.com', password, 1),
  ];
  assert.notEqual(
    devices[0].refreshToken.slice(0, 36),
    devices[1].refreshToken.slice(0, 36),
  );
  const guessed =
    devices[1].refreshToken.slice(0, 37) +
    randomBytes(32).toString('base64url');
  await call(
    'post',
    '/auth/refresh',
    { refreshToken: guessed },
    401,
    stranger.accessToken,
  );
  await call(
    'post',
    '/auth/logout',
    { refreshToken: guessed },
    204,
    stranger.accessToken,
  );
  await call('get', '/auth/me', undefined, 200, devices[1].accessToken);
  await call(
    'post',
    '/auth/logout',
    { refreshToken: devices[0].refreshToken },
    204,
  );
  await call(
    'post',
    '/auth/logout',
    { refreshToken: devices[0].refreshToken },
    204,
  );
  await call('get', '/auth/me', undefined, 401, devices[0].accessToken);
  await call(
    'post',
    '/auth/refresh',
    { refreshToken: devices[0].refreshToken },
    401,
  );
  await call('get', '/auth/me', undefined, 200, devices[1].accessToken);
  await call('post', '/auth/logout-all', {}, 204, devices[1].accessToken);
  await call('get', '/auth/me', undefined, 401, devices[1].accessToken);
  await call(
    'post',
    '/auth/refresh',
    { refreshToken: devices[1].refreshToken },
    401,
  );
  await call('get', '/auth/me', undefined, 200, stranger.accessToken);
  await expireLimits();
  const resetSession = await login('owner@example.com');
  const knownStart = Date.now();
  const known = await call(
    'post',
    '/auth/forgot-password',
    { email: 'owner@example.com' },
    200,
  );
  const knownMs = Date.now() - knownStart;
  const unknownStart = Date.now();
  const unknown = await call(
    'post',
    '/auth/forgot-password',
    { email: 'unknown@example.com' },
    200,
    undefined,
    1,
  );
  const unknownMs = Date.now() - unknownStart;
  assert.deepEqual(known, unknown);
  assert.ok(knownMs >= 2900 && unknownMs >= 2900);
  assert.ok(
    Math.abs(knownMs - unknownMs) < 1500,
    'controlled mail delivery should not create a large account timing difference',
  );
  assert.equal(mailer.sent.length, 1);
  const reset = mailer.sent[0].token;
  assert.ok(!JSON.stringify(known).includes(reset));
  const resetRecord = await db.passwordResetToken.findUniqueOrThrow({
    where: { userId: owner.user.id },
  });
  assert.equal(resetRecord.tokenHash, digest(reset));
  assert.equal(resetRecord.deliveryStatus, 'SENT');
  assert.ok(!JSON.stringify(resetRecord).includes(reset));
  const newPassword = 'NewSecurePassword123!';
  const resetRace = await Promise.all(
    http.map((client) =>
      client.post('/auth/reset-password').send({ token: reset, newPassword }),
    ),
  );
  assert.deepEqual(resetRace.map((r) => r.status).sort(), [204, 400]);
  checks += 2;
  await call(
    'post',
    '/auth/reset-password',
    { token: reset, newPassword },
    400,
  );
  const updatedUser = await db.user.findUniqueOrThrow({
    where: { id: owner.user.id },
  });
  assert.ok(await argon2.verify(updatedUser.passwordHash, newPassword));
  assert.ok(!(await argon2.verify(updatedUser.passwordHash, password)));
  assert.equal(
    await db.authSession.count({
      where: { userId: owner.user.id, revokedAt: null },
    }),
    0,
  );
  await call('get', '/auth/me', undefined, 401, resetSession.accessToken);
  await call(
    'post',
    '/auth/refresh',
    { refreshToken: resetSession.refreshToken },
    401,
  );
  await call(
    'post',
    '/auth/login',
    { email: 'owner@example.com', password },
    401,
  );
  const recovered = await login('owner@example.com', newPassword);
  for (const business of [a, b])
    await call(
      'get',
      `/businesses/${business.id}`,
      undefined,
      200,
      recovered.accessToken,
    );
  await call(
    'post',
    '/auth/reset-password',
    {
      token: `${randomUUID()}.${randomBytes(32).toString('base64url')}`,
      newPassword,
    },
    400,
  );
  await call(
    'post',
    '/auth/reset-password',
    { token: reset, newPassword: 'weak' },
    400,
  );
  await call(
    'post',
    '/auth/reset-password',
    { token: reset, newPassword: 'Aa1' + 'x'.repeat(126) },
    400,
  );
  await call('post', '/auth/refresh', { refreshToken: 'not-a-token' }, 400);
  await call(
    'post',
    '/auth/forgot-password',
    { email: 'owner@example.com' },
    200,
  );
  const expiredReset = mailer.sent.at(-1).token;
  await db.passwordResetToken.update({
    where: { userId: owner.user.id },
    data: {
      createdAt: new Date(Date.now() - 16 * 60000),
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  await call(
    'post',
    '/auth/reset-password',
    { token: expiredReset, newPassword },
    400,
  );
  mailer.ready = false;
  const unavailableKnown = await call(
    'post',
    '/auth/forgot-password',
    { email: 'owner@example.com' },
    503,
  );
  const unavailableUnknown = await call(
    'post',
    '/auth/forgot-password',
    { email: 'another@example.com' },
    503,
  );
  assert.deepEqual(unavailableKnown, unavailableUnknown);
  mailer.ready = true;
  mailer.fail = true;
  const failedDelivery = await call(
    'post',
    '/auth/forgot-password',
    { email: 'stranger@example.com' },
    200,
  );
  assert.deepEqual(failedDelivery, known);
  assert.equal(
    (
      await db.passwordResetToken.findUniqueOrThrow({
        where: { userId: stranger.user.id },
      })
    ).deliveryStatus,
    'FAILED',
  );
  await call(
    'post',
    '/auth/reset-password',
    { token: mailer.sent.at(-1).token, newPassword },
    400,
  );
  mailer.fail = false;
  await expireLimits();
  const expiring = await login('owner@example.com', newPassword);
  await db.authSession.update({
    where: { tokenFamilyId: expiring.refreshToken.slice(0, 36) },
    data: {
      createdAt: new Date(Date.now() - 31 * 86400000),
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  await call(
    'post',
    '/auth/refresh',
    { refreshToken: expiring.refreshToken },
    401,
  );
  await call('get', '/auth/me', undefined, 401, expiring.accessToken);
  const historical = await login('historical@example.com');
  await call('get', '/auth/me', undefined, 200, historical.accessToken);
  const slotsUser = await call(
    'post',
    '/auth/register',
    { email: 'slots@example.com', password },
    201,
  );
  const sessions = apps[0].get(AuthSessionsService);
  for (let i = 0; i < 12; i++)
    await db.$transaction(async (tx) =>
      sessions.issue(tx, await lockUser(tx, slotsUser.user.id)),
    );
  assert.equal(
    await db.authSession.count({ where: { userId: slotsUser.user.id } }),
    10,
  );
  await call('get', '/auth/me', undefined, 401, slotsUser.accessToken);
  const capped = await login('slots@example.com');
  await db.authSession.update({
    where: { tokenFamilyId: capped.refreshToken.slice(0, 36) },
    data: {
      rotationCount: 1000,
      usedTokenHashes: Array.from({ length: 1000 }, (_v, i) =>
        digest(String(i)),
      ),
    },
  });
  await call(
    'post',
    '/auth/refresh',
    { refreshToken: capped.refreshToken },
    401,
  );
  assert.ok(
    (
      await db.authSession.findUniqueOrThrow({
        where: { tokenFamilyId: capped.refreshToken.slice(0, 36) },
      })
    ).revokedAt,
  );
  await expireLimits();
  const healthy = await login('owner@example.com', newPassword);
  const compressed = gzipSync(
    Buffer.from(
      JSON.stringify({ email: 'owner@example.com', password: newPassword }),
    ),
  );
  // Send real compressed bytes; Superagent JSON-serializes Buffer objects when
  // Content-Type is JSON, which would test an invalid gzip header instead.
  const server = apps[0].getHttpServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const compressedRequest = (payload) =>
    new Promise((resolve, reject) => {
      const req = nodeHttp.request(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: '/auth/login',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'Content-Length': payload.length,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  assert.equal(await compressedRequest(compressed), 200);
  checks++;
  assert.ok(
    [200, 400].includes(
      await compressedRequest(
        Buffer.concat([compressed, Buffer.from('invalid trailing bytes')]),
      ),
    ),
  );
  checks++;
  await call('get', '/auth/me', undefined, 200, healthy.accessToken);
  const app3 = await application({
    consume: async () => {
      throw new Error('controlled limiter outage');
    },
  });
  const unavailable = await request(app3.getHttpServer())
    .post('/auth/login')
    .send({ email: 'owner@example.com', password: newPassword });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers['retry-after'], '5');
  assert.equal(unavailable.body.code, 'AUTH_RATE_LIMIT_UNAVAILABLE');
  checks++;
  await request(app3.getHttpServer())
    .get('/auth/me')
    .set('Authorization', `Bearer ${healthy.accessToken}`)
    .expect(200);
  checks++;
  // Verify shared limits at every sensitive HTTP boundary on both app instances.
  for (const [route, body, ordinary] of [
    ['/auth/register', { email: 'bad', password: 'weak' }, 400],
    [
      '/auth/login',
      { email: 'no-account@example.com', password: 'wrong' },
      401,
    ],
    [
      '/auth/refresh',
      {
        refreshToken: `${randomUUID()}.${randomBytes(32).toString('base64url')}`,
      },
      401,
    ],
    ['/auth/forgot-password', { email: 'not-an-email' }, 400],
    [
      '/auth/reset-password',
      {
        token: `${randomUUID()}.${randomBytes(32).toString('base64url')}`,
        newPassword: 'weak',
      },
      400,
    ],
  ]) {
    await expireLimits();
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const response = await http[i % 2].post(route).send(body);
      checks++;
      assert.ok(
        [ordinary, 429].includes(response.status),
        `${route}: ${JSON.stringify(response.body)}`,
      );
      if (response.status === 429) {
        assert.ok(Number(response.headers['retry-after']) > 0);
        limited = true;
      }
    }
    // Refresh has a 30/account limit; exercise enough same-family attempts.
    if (route === '/auth/refresh' && !limited)
      for (let i = 0; i < 20; i++) {
        const response = await http[i % 2].post(route).send(body);
        checks++;
        if (response.status === 429) {
          limited = true;
          assert.ok(Number(response.headers['retry-after']) > 0);
        } else assert.equal(response.status, ordinary);
      }
    assert.ok(limited, `${route} must be limited across both instances`);
  }
  await expireLimits();
  const stores = [
    new PostgresAuthRateStore(db),
    new PostgresAuthRateStore(db2),
  ];
  const rateKey = digest('shared-concurrent-counter');
  const shared = await Promise.all(
    Array.from({ length: 12 }, (_v, i) =>
      stores[i % 2].consume([{ key: rateKey, limit: 3, seconds: 60 }]),
    ),
  );
  assert.equal(shared.filter((v) => v.allowed).length, 3);
  assert.equal(
    (await db.authRateBucket.findUniqueOrThrow({ where: { key: rateKey } }))
      .count,
    4,
  );
  await db.authRateBucket.update({
    where: { key: rateKey },
    data: { expiresAt: new Date(Date.now() - 1) },
  });
  assert.ok(
    (await stores[1].consume([{ key: rateKey, limit: 3, seconds: 60 }]))
      .allowed,
  );
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Honolulu'");
    const scoped = new PostgresAuthRateStore({
      $transaction: (work) => work(tx),
    });
    const timezoneKey = digest('timezone-regression');
    const started = Date.now();
    await scoped.consume([{ key: timezoneKey, limit: 3, seconds: 60 }]);
    const bucket = await tx.authRateBucket.findUniqueOrThrow({
      where: { key: timezoneKey },
    });
    assert.ok(
      bucket.expiresAt.getTime() >= started + 59000 &&
        bucket.expiresAt.getTime() <= Date.now() + 61000,
      'shared expiry must use UTC independently of PostgreSQL TimeZone',
    );
  });
  // Close the original connection before constructing its replacement: counters
  // must survive the provider lifetime, not just be shared by two live objects.
  const persistenceKey = digest(randomUUID());
  const rules = [{ key: persistenceKey, limit: 1, seconds: 60 }];
  const config = new ConfigService({ DATABASE_URL: url });
  const firstConnection = new PrismaService(config);
  try {
    await firstConnection.$connect();
    assert.equal(
      (await new PostgresAuthRateStore(firstConnection).consume(rules)).allowed,
      true,
    );
  } finally {
    await firstConnection.$disconnect();
  }
  const replacementConnection = new PrismaService(config);
  try {
    await replacementConnection.$connect();
    const denied = await new PostgresAuthRateStore(
      replacementConnection,
    ).consume(rules);
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfter > 0);
    assert.equal(
      (
        await replacementConnection.authRateBucket.findUniqueOrThrow({
          where: { key: persistenceKey },
        })
      ).count,
      2,
    );
  } finally {
    await replacementConnection.$disconnect();
  }
  console.log(
    'PASS: PostgreSQL rate-limit counter remains enforced after closing and replacing its connection/provider.',
  );
  const existing = await db.authRateBucket.count();
  await db.authRateBucket.createMany({
    data: Array.from({ length: 10000 - existing }, (_v, i) => ({
      key: digest(`capacity-${i}`),
      count: 1,
      expiresAt: new Date(Date.now() + 3600000),
    })),
  });
  await db.authRateBucket.updateMany({
    data: { expiresAt: new Date(Date.now() + 3600000) },
  });
  const replacementKey = digest('capacity-new-key');
  assert.equal(
    (await stores[0].consume([{ key: replacementKey, limit: 3, seconds: 60 }]))
      .allowed,
    false,
  );
  const expired = await db.authRateBucket.findFirstOrThrow();
  await db.authRateBucket.update({
    where: { id: expired.id },
    data: { expiresAt: new Date(Date.now() - 1) },
  });
  assert.ok(
    (await stores[1].consume([{ key: replacementKey, limit: 3, seconds: 60 }]))
      .allowed,
  );
  assert.equal(await db.authRateBucket.count(), 10000);
  assert.equal(
    (
      await db.authRateBucket.findUniqueOrThrow({
        where: { key: replacementKey },
      })
    ).id,
    expired.id,
  );
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
    `PASS: ${checks} live hardening HTTP checks plus SQL/Prisma assertions; two app instances, atomic rotation/replay/reset, immediate revocation, bounded session history/device slots, shared concurrent limits/expiry/capacity/outage, controlled email readiness/failure, preserved ownership and migration data; no drift.`,
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const app of apps.reverse()) await app.close();
    await admin.end();
    if (created)
      console.log(`Disposable hardening database retained: ${database}`);
  });
