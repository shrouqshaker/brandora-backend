// Customers, conversations and messages against REAL PostgreSQL and REAL HTTP.
//
//   npm run test:conversations:postgres
//
// It creates a NEW random database on your LOCAL PostgreSQL server, upgrades it
// from the main schema with Prisma, runs the checks, then deletes that database
// (set KEEP_TEST_DB=1 to keep it). Your own database and its data are never used.
// Server: TEST_POSTGRES_URL if set, otherwise the server in .env DATABASE_URL.
// Anything that is not localhost is refused. No WhatsApp, AI or email is called.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { Client } = require('pg');
const request = require('supertest');
const dotenv = require('dotenv');
const {
  isLocalDatabaseUrl,
} = require('../dist/common/database/is-local-database-url');

const root = path.resolve(__dirname, '..');
const migrationsDir = path.join(root, 'prisma', 'migrations');
const ours = '20261107094154_add_customers_conversations';
const migrations = fs
  .readdirSync(migrationsDir)
  .filter((n) => fs.existsSync(path.join(migrationsDir, n, 'migration.sql')))
  .sort();
const readMigration = (name) =>
  fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8');

function localServer() {
  const envFile = path.join(root, '.env');
  const raw =
    process.env.TEST_POSTGRES_URL ||
    (fs.existsSync(envFile)
      ? dotenv.parse(fs.readFileSync(envFile)).DATABASE_URL
      : undefined);
  if (!isLocalDatabaseUrl(raw))
    throw new Error(
      'Set TEST_POSTGRES_URL (or DATABASE_URL in .env) to a localhost PostgreSQL server. This test never uses a remote database.',
    );
  return new URL(raw);
}
const server = localServer();
const database = 'brandora_conversations_' + randomUUID().replaceAll('-', '');
function urlFor(name) {
  const u = new URL(server.toString());
  u.pathname = '/' + name;
  u.search = '';
  return u.toString();
}
const url = urlFor(database);
const remoteUrl =
  'postgresql://user:password@ep-example-123.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const admin = new Client({ connectionString: urlFor('postgres') });

let sql, app, http, config, messages, ownerA, ownerB, bizA, bizB;
let mainTables, mainTypes, oldRows;
let httpChecks = 0;

function prismaRaw(...args) {
  return spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', ...args],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      timeout: 120000,
    },
  );
}
function prisma(...args) {
  const r = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', ...args],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      timeout: 120000,
    },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}

async function call(method, route, { body, status = 200, as = ownerA } = {}) {
  let r = http[method](route);
  if (as) r = r.set('Authorization', 'Bearer ' + as);
  if (body !== undefined) r = r.send(body);
  const res = await r;
  httpChecks++;
  assert.equal(
    res.status,
    status,
    `${method.toUpperCase()} ${route} -> ${res.status} ${JSON.stringify(res.body)}`,
  );
  return res.body;
}
const inbound = (businessId, body, status = 201, as = ownerA) =>
  call('post', `/businesses/${businessId}/dev/inbound-message`, {
    body,
    status,
    as,
  });
const wamid = (label) => `wamid.test-${label}-${randomUUID()}`;
const count = async (query, params = []) =>
  (await sql.query(query, params)).rows[0].n;

const tableNames = async () =>
  (
    await sql.query(
      "SELECT table_name AS n FROM information_schema.tables WHERE table_schema='public' AND table_name <> '_prisma_migrations' ORDER BY 1",
    )
  ).rows.map((r) => r.n);
const enumNames = async () =>
  (
    await sql.query(
      "SELECT t.typname AS n FROM pg_type t JOIN pg_namespace s ON s.oid=t.typnamespace WHERE s.nspname='public' AND t.typtype='e' ORDER BY 1",
    )
  ).rows.map((r) => r.n);

async function snapshotOf(tables) {
  const out = {};
  for (const t of tables)
    out[t] = (await sql.query(`SELECT * FROM "${t}" ORDER BY 1`)).rows;
  return out;
}

before(
  async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    sql = new Client({ connectionString: url });
    await sql.connect();

    // 1) The database as it is on main: every migration before ours.
    for (const name of migrations.filter((n) => n < ours)) {
      await sql.query(readMigration(name));
      prisma('migrate', 'resolve', '--applied', name);
    }
    // 2) Existing data that our migration must not touch: an owner with a
    //    business, a category, a product and a tracked variant.
    const oldBusiness = randomUUID();
    const oldUser = randomUUID();
    const oldCategory = randomUUID();
    const oldProduct = randomUUID();
    await sql.query(
      'INSERT INTO "Business" (id,name,"updatedAt") VALUES ($1,\'Existing store\',now())',
      [oldBusiness],
    );
    await sql.query(
      'INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ($1,\'existing@example.test\',\'fixture-not-for-login\',now())',
      [oldUser],
    );
    await sql.query(
      'INSERT INTO "BusinessMember" (id,"userId","businessId","updatedAt") VALUES ($1,$2,$3,now())',
      [randomUUID(), oldUser, oldBusiness],
    );
    await sql.query(
      'INSERT INTO "Category" (id,"businessId",name,"updatedAt") VALUES ($1,$2,\'تيشيرتات\',now())',
      [oldCategory, oldBusiness],
    );
    await sql.query(
      'INSERT INTO "Product" (id,"businessId","categoryId",name,"externalKey","basePrice","updatedAt") VALUES ($1,$2,$3,\'تيشيرت أسود\',\'TS-1\',299.00,now())',
      [oldProduct, oldBusiness, oldCategory],
    );
    await sql.query(
      'INSERT INTO "ProductVariant" (id,"businessId","productId",sku,"unitPrice","trackInventory","stockQuantity","updatedAt") VALUES ($1,$2,$3,\'TS-1-L\',299.00,true,7,now())',
      [randomUUID(), oldBusiness, oldProduct],
    );
    mainTables = await tableNames();
    mainTypes = await enumNames();
    oldRows = await snapshotOf(mainTables);

    // 3) Our migration, applied by Prisma exactly like a real deployment.
    prisma('migrate', 'deploy');
    assert.deepEqual(await snapshotOf(mainTables), oldRows);

    // 4) The real application on the new database.
    Object.assign(process.env, {
      DATABASE_URL: url,
      ENABLE_DEV_ENDPOINTS: 'true',
      JWT_SECRET: randomBytes(48).toString('base64'),
      AUTH_RATE_LIMIT_SECRET: randomBytes(48).toString('base64'),
      JWT_ISSUER: 'conversations-test',
      JWT_AUDIENCE: 'android-test',
      AUTH_EMAIL_MODE: 'disabled',
      AUTH_TRUSTED_PROXY_CIDRS: '',
      IMPORT_STORAGE_DIR: path.join(tmpdir(), database),
    });
    require('reflect-metadata');
    const { Test } = require('@nestjs/testing');
    const { ValidationPipe } = require('@nestjs/common');
    const { HttpAdapterHost } = require('@nestjs/core');
    const { ConfigService } = require('@nestjs/config');
    const { AppModule } = require('../dist/app.module');
    const { MessagesService } = require('../dist/messages/messages.service');
    const {
      HttpExceptionFilter,
    } = require('../dist/common/errors/http-exception.filter');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ logger: false });
    // Same pipe and filter as src/main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    // Listening once lets parallel requests share one real local port.
    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());
    config = app.get(ConfigService);
    messages = app.get(MessagesService);

    const register = async (email) =>
      (
        await call('post', '/auth/register', {
          body: { email, password: 'SecurePassword123!' },
          status: 201,
          as: null,
        })
      ).accessToken;
    ownerA = await register('owner-a@example.test');
    ownerB = await register('owner-b@example.test');
    bizA = (
      await call('post', '/businesses', {
        body: { name: 'Store A' },
        status: 201,
        as: ownerA,
      })
    ).id;
    bizB = (
      await call('post', '/businesses', {
        body: { name: 'Store B' },
        status: 201,
        as: ownerB,
      })
    ).id;
  },
  { timeout: 300000 },
);

test('1. migration: recorded by Prisma, no drift, tenant-safe keys enforced by PostgreSQL', async () => {
  const history = (
    await sql.query(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations',
    )
  ).rows;
  assert.deepEqual(history.map((h) => h.migration_name).sort(), migrations);
  for (const h of history) {
    assert.ok(h.finished_at);
    assert.equal(h.rolled_back_at, null);
    assert.equal(
      h.checksum,
      createHash('sha256')
        .update(
          fs.readFileSync(
            path.join(migrationsDir, h.migration_name, 'migration.sql'),
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
  const fks = (
    await sql.query(
      `SELECT conname FROM pg_constraint WHERE conname IN ('Conversation_businessId_customerId_fkey','Message_businessId_conversationId_fkey') ORDER BY 1`,
    )
  ).rows.map((r) => r.conname);
  assert.deepEqual(fks, [
    'Conversation_businessId_customerId_fkey',
    'Message_businessId_conversationId_fkey',
  ]);

  // Even raw SQL cannot attach business B's rows to business A's customer.
  const stored = await inbound(bizA, {
    phone: '201000000100',
    externalMessageId: wamid('fk'),
    content: 'Hello',
  });
  await assert.rejects(
    sql.query(
      'INSERT INTO "Conversation" (id,"businessId","customerId",channel,"updatedAt") VALUES ($1,$2,$3,\'WHATSAPP\',now())',
      [randomUUID(), bizB, stored.customer.id],
    ),
    /foreign key/,
  );
  await assert.rejects(
    sql.query(
      'INSERT INTO "Message" (id,"businessId","conversationId","senderType",content) VALUES ($1,$2,$3,\'CUSTOMER\',\'x\')',
      [randomUUID(), bizB, stored.conversation.id],
    ),
    /foreign key/,
  );
});

test('2. one message is stored once: 201 new, 200 duplicate, 409 from another business', async () => {
  const id = wamid('dup');
  const first = await inbound(bizA, {
    phone: '+20 100 000 0001',
    name: ' Mona ',
    externalMessageId: id,
    content: 'Hi, do you have black shirts?',
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.customer.phone, '201000000001');
  assert.equal(first.customer.name, 'Mona');
  assert.equal(first.conversation.status, 'OPEN');
  assert.equal(first.message.senderType, 'CUSTOMER');
  assert.equal(first.message.status, 'RECEIVED');
  assert.equal(
    new Date(first.conversation.lastMessageAt).getTime(),
    new Date(first.message.createdAt).getTime(),
  );

  const again = await inbound(
    bizA,
    { phone: '201000000001', externalMessageId: id, content: 'resent' },
    200,
  );
  assert.equal(again.duplicate, true);
  assert.equal(again.message.id, first.message.id);
  assert.equal(again.message.content, first.message.content);
  assert.equal(
    await count(
      'SELECT count(*)::int AS n FROM "Message" WHERE "externalMessageId"=$1',
      [id],
    ),
    1,
  );

  const elsewhere = await inbound(
    bizB,
    { phone: '201000000001', externalMessageId: id, content: 'x' },
    409,
    ownerB,
  );
  assert.equal(elsewhere.code, 'EXTERNAL_MESSAGE_ID_CONFLICT');
  assert.equal(
    await count(
      'SELECT count(*)::int AS n FROM "Customer" WHERE "businessId"=$1',
      [bizB],
    ),
    0,
  );

  const second = await inbound(bizA, {
    phone: '201000000001',
    content: 'No wamid this time',
  });
  assert.equal(second.conversation.id, first.conversation.id);
  assert.equal(second.customer.id, first.customer.id);
});

test('3. racing requests: one message per wamid, one customer and one conversation per phone', async () => {
  const id = wamid('race');
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      http
        .post(`/businesses/${bizA}/dev/inbound-message`)
        .set('Authorization', 'Bearer ' + ownerA)
        .send({ phone: '201000000200', externalMessageId: id, content: 'Hi' }),
    ),
  );
  httpChecks += results.length;
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(
    statuses,
    [200, 200, 200, 200, 200, 200, 200, 200, 200, 201],
  );
  assert.equal(
    new Set(results.map((r) => r.body.message.id)).size,
    1,
    'every answer points at the same stored message',
  );
  assert.equal(
    await count(
      'SELECT count(*)::int AS n FROM "Message" WHERE "externalMessageId"=$1',
      [id],
    ),
    1,
  );

  const burst = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      http
        .post(`/businesses/${bizA}/dev/inbound-message`)
        .set('Authorization', 'Bearer ' + ownerA)
        .send({
          phone: '201000000201',
          externalMessageId: wamid(`burst-${i}`),
          content: `Message ${i}`,
        }),
    ),
  );
  httpChecks += burst.length;
  assert.deepEqual(
    burst.map((r) => r.status),
    Array(8).fill(201),
  );
  const ids = (
    await sql.query(
      'SELECT c.id AS customer, v.id AS conversation, (SELECT count(*)::int FROM "Message" m WHERE m."conversationId"=v.id) AS n FROM "Customer" c JOIN "Conversation" v ON v."customerId"=c.id WHERE c."businessId"=$1 AND c.phone=$2',
      [bizA, '201000000201'],
    )
  ).rows;
  assert.equal(ids.length, 1, 'one customer with one conversation');
  assert.equal(ids[0].n, 8);
});

test('4. owners only reach their own business: other owner, foreign ids, no token', async () => {
  const mine = await inbound(bizA, {
    phone: '201000000300',
    externalMessageId: wamid('iso'),
    content: 'Private',
  });
  const { customer, conversation } = mine;

  for (const route of [
    `/businesses/${bizA}/customers`,
    `/businesses/${bizA}/customers/${customer.id}`,
    `/businesses/${bizA}/conversations`,
    `/businesses/${bizA}/conversations/${conversation.id}`,
    `/businesses/${bizA}/conversations/${conversation.id}/messages`,
  ]) {
    await call('get', route, { status: 404, as: ownerB });
    await call('get', route, { status: 401, as: null });
  }
  await inbound(bizA, { phone: '201000000300', content: 'x' }, 404, ownerB);
  await inbound(bizA, { phone: '201000000300', content: 'x' }, 401, null);

  // Business A's ids under business B's own path are simply "not found".
  assert.equal(
    (
      await call('get', `/businesses/${bizB}/customers/${customer.id}`, {
        status: 404,
        as: ownerB,
      })
    ).code,
    'CUSTOMER_NOT_FOUND',
  );
  for (const route of [
    `/businesses/${bizB}/conversations/${conversation.id}`,
    `/businesses/${bizB}/conversations/${conversation.id}/messages`,
  ])
    assert.equal(
      (await call('get', route, { status: 404, as: ownerB })).code,
      'CONVERSATION_NOT_FOUND',
    );
  await call('get', `/businesses/${bizA}/conversations/not-a-uuid`, {
    status: 400,
  });

  const listB = await call('get', `/businesses/${bizB}/customers`, {
    as: ownerB,
  });
  assert.equal(listB.pagination.totalCount, 0);
  const listA = await call('get', `/businesses/${bizA}/customers?limit=100`);
  assert.ok(listA.items.every((c) => c.businessId === bizA));
  assert.ok(listA.items.some((c) => c.id === customer.id));
});

test('5. conversation times only move forward and the inbox is sorted by the last message', async () => {
  const x = await inbound(bizA, {
    phone: '201000000401',
    externalMessageId: wamid('x'),
    content: 'First chat',
  });
  const y = await inbound(bizA, {
    phone: '201000000402',
    externalMessageId: wamid('y'),
    content: 'Second chat',
  });
  const order = async () =>
    (
      await call('get', `/businesses/${bizA}/conversations?limit=100`)
    ).items.map((c) => c.id);
  const before = await order();
  assert.ok(
    before.indexOf(y.conversation.id) < before.indexOf(x.conversation.id),
  );

  // An owner setting change touches updatedAt but is not new activity.
  await sql.query(
    'UPDATE "Conversation" SET "aiEnabled"=false, "updatedAt"=now() + interval \'1 hour\' WHERE id=$1',
    [x.conversation.id],
  );
  const after = await order();
  assert.ok(
    after.indexOf(y.conversation.id) < after.indexOf(x.conversation.id),
  );

  // A newer time already saved is never pulled back by this message.
  // Times are stored in UTC without a time zone, so pass a plain UTC text.
  const future = '2030-01-01T00:00:00.000Z';
  await sql.query(
    'UPDATE "Conversation" SET "lastMessageAt"=$2::timestamp, "lastCustomerMessageAt"=$2::timestamp WHERE id=$1',
    [x.conversation.id, '2030-01-01 00:00:00'],
  );
  const late = await inbound(bizA, {
    phone: '201000000401',
    externalMessageId: wamid('late'),
    content: 'Arrives with an older time',
  });
  assert.equal(late.conversation.lastMessageAt, future);
  assert.equal(late.conversation.lastCustomerMessageAt, future);

  // Empty times are filled.
  await sql.query(
    'UPDATE "Conversation" SET "lastMessageAt"=NULL, "lastCustomerMessageAt"=NULL WHERE id=$1',
    [x.conversation.id],
  );
  const filled = await inbound(bizA, {
    phone: '201000000401',
    externalMessageId: wamid('fill'),
    content: 'Fills the empty time',
  });
  assert.equal(filled.conversation.lastMessageAt, filled.message.createdAt);
  assert.equal(
    filled.conversation.lastCustomerMessageAt,
    filled.message.createdAt,
  );

  // lastMessage in the list is the newest message of that chat.
  const list = await call('get', `/businesses/${bizA}/conversations?limit=100`);
  const row = list.items.find((c) => c.id === x.conversation.id);
  assert.equal(row.lastMessage.id, filled.message.id);

  // Our replies (AI or owner) are activity too: the chat moves to the top,
  // lastMessageAt follows lastMessage, and the 24-hour window stays put.
  const reply = await messages.createOutbound({
    businessId: bizA,
    conversationId: y.conversation.id,
    senderType: 'AI',
    content: 'Yes, we have it.',
  });
  const replied = await call(
    'get',
    `/businesses/${bizA}/conversations?limit=100`,
  );
  assert.equal(replied.items[0].id, y.conversation.id);
  assert.equal(replied.items[0].lastMessage.id, reply.id);
  assert.equal(replied.items[0].lastMessageAt, reply.createdAt.toISOString());
  assert.equal(
    replied.items[0].lastCustomerMessageAt,
    y.conversation.lastCustomerMessageAt,
  );
  for (const item of replied.items)
    if (item.lastMessage)
      assert.equal(item.lastMessageAt, item.lastMessage.createdAt, item.id);

  // A reply never pulls a newer time back, and another business cannot
  // write into this conversation at all (the transaction is rolled back).
  await sql.query(
    'UPDATE "Conversation" SET "lastMessageAt"=$2::timestamp WHERE id=$1',
    [y.conversation.id, '2030-01-01 00:00:00'],
  );
  await messages.createOutbound({
    businessId: bizA,
    conversationId: y.conversation.id,
    senderType: 'OWNER',
    content: 'Late owner reply',
  });
  await assert.rejects(
    messages.createOutbound({
      businessId: bizB,
      conversationId: y.conversation.id,
      senderType: 'OWNER',
      content: 'Wrong business',
    }),
  );
  const yNow = await call(
    'get',
    `/businesses/${bizA}/conversations/${y.conversation.id}`,
  );
  assert.equal(yNow.lastMessageAt, future);
  assert.equal(
    await count(
      'SELECT count(*)::int AS n FROM "Message" WHERE "conversationId"=$1 AND content=$2',
      [y.conversation.id, 'Wrong business'],
    ),
    0,
  );

  // A conversation without any message time goes last.
  const lonelyCustomer = randomUUID();
  const lonely = randomUUID();
  await sql.query(
    'INSERT INTO "Customer" (id,"businessId",phone,"updatedAt") VALUES ($1,$2,\'201000000499\',now())',
    [lonelyCustomer, bizA],
  );
  await sql.query(
    'INSERT INTO "Conversation" (id,"businessId","customerId","updatedAt") VALUES ($1,$2,$3,now() + interval \'2 hours\')',
    [lonely, bizA, lonelyCustomer],
  );
  const all = await order();
  assert.equal(all[all.length - 1], lonely);
  assert.equal(
    list.items.find((c) => c.id === y.conversation.id).lastMessage.content,
    'Second chat',
  );
});

test('6. delivery status only moves forward, in one query, inside one business', async () => {
  const chat = await inbound(bizA, {
    phone: '201000000500',
    externalMessageId: wamid('status'),
    content: 'Hi',
  });
  const status = async (id) =>
    (await sql.query('SELECT status FROM "Message" WHERE id=$1', [id])).rows[0]
      .status;
  const outbound = () =>
    messages.createOutbound({
      businessId: bizA,
      conversationId: chat.conversation.id,
      senderType: 'AI',
      content: 'Yes, we do.',
    });

  const m = await outbound();
  assert.equal(m.status, 'PENDING');
  const out = wamid('out');
  assert.equal(
    (await messages.markSendResult(bizA, m.id, { externalMessageId: out }))
      .status,
    'SENT',
  );
  assert.equal(
    (await messages.markSendResult(bizA, m.id, 'FAILED')).status,
    'SENT',
  );
  await assert.rejects(messages.markSendResult(bizB, m.id, 'FAILED'));
  assert.equal(await status(m.id), 'SENT');

  // WhatsApp's id already stored on another message: 409, nothing changes.
  const clash = await outbound();
  await assert.rejects(
    messages.markSendResult(bizA, clash.id, { externalMessageId: out }),
    (e) => e.getStatus() === 409 && e.code === 'EXTERNAL_MESSAGE_ID_CONFLICT',
  );
  assert.equal(await status(clash.id), 'PENDING');

  assert.equal(await messages.updateDeliveryStatus(bizB, out, 'READ'), false);
  assert.equal(await status(m.id), 'SENT');
  assert.equal(await messages.updateDeliveryStatus(bizA, out, 'READ'), true);
  assert.equal(
    await messages.updateDeliveryStatus(bizA, out, 'DELIVERED'),
    false,
  );
  assert.equal(await messages.updateDeliveryStatus(bizA, out, 'FAILED'), false);
  assert.equal(await status(m.id), 'READ');
  assert.equal(
    await messages.updateDeliveryStatus(bizA, 'wamid.unknown', 'READ'),
    false,
  );

  const failed = await outbound();
  await messages.markSendResult(bizA, failed.id, 'FAILED');
  assert.equal(await status(failed.id), 'FAILED');

  // FAILED from WhatsApp, then a read receipt: the receipt wins.
  const late = await outbound();
  const lateId = wamid('late-read');
  await messages.markSendResult(bizA, late.id, { externalMessageId: lateId });
  assert.equal(
    await messages.updateDeliveryStatus(bizA, lateId, 'FAILED'),
    true,
  );
  assert.equal(await messages.updateDeliveryStatus(bizA, lateId, 'READ'), true);
  assert.equal(
    await messages.updateDeliveryStatus(bizA, lateId, 'FAILED'),
    false,
  );
  assert.equal(await status(late.id), 'READ');

  // A customer message is never given a delivery status.
  assert.equal(
    await messages.updateDeliveryStatus(
      bizA,
      chat.message.externalMessageId,
      'READ',
    ),
    false,
  );
  assert.equal(await status(chat.message.id), 'RECEIVED');

  // Events arriving together or out of order always end on the newest state.
  for (let i = 0; i < 15; i++) {
    const next = await outbound();
    const w = wamid(`sim-${i}`);
    await messages.markSendResult(bizA, next.id, { externalMessageId: w });
    const events = ['DELIVERED', 'READ', 'SENT', 'FAILED'];
    if (i % 2) events.reverse();
    await Promise.all(
      events.map((e) => messages.updateDeliveryStatus(bizA, w, e)),
    );
    assert.equal(await status(next.id), 'READ', `round ${i}`);
  }
});

test('7. dev endpoint: strict body, length in code points, and 404 when switched off or the database is not local', async () => {
  const body = { phone: '201000000600', content: 'Hello' };
  for (const bad of [
    { ...body, senderType: 'AI' },
    { ...body, content: '   ' },
    { ...body, messageType: 'STICKER' },
    { ...body, content: 'x'.repeat(4097) },
    { phone: '201000000600' },
  ])
    assert.equal(
      (await inbound(bizA, bad, 400)).code,
      'VALIDATION_ERROR',
      JSON.stringify(bad),
    );
  assert.equal(
    (await inbound(bizA, { ...body, phone: '12ab' }, 400)).code,
    'INVALID_PHONE_NUMBER',
  );

  // Length is counted in Unicode code points (see src/messages/message-limits.ts).
  // Up to 4096 (Meta's limit for one text message) is stored exactly, never cut.
  for (const content of [
    'م'.repeat(4096),
    '😀'.repeat(4096),
    '👍🏽'.repeat(2048),
    '❤️'.repeat(2048),
  ]) {
    const stored = await inbound(bizA, { ...body, content });
    assert.equal(stored.message.content, content);
    const row = (
      await sql.query('SELECT content FROM "Message" WHERE id=$1', [
        stored.message.id,
      ])
    ).rows[0];
    assert.equal(row.content, content);
  }
  for (const content of [
    'م'.repeat(4097),
    '😀'.repeat(4097),
    '❤️'.repeat(2049),
  ])
    assert.equal(
      (await inbound(bizA, { ...body, content }, 400)).code,
      'VALIDATION_ERROR',
    );

  const realGet = config.get.bind(config);
  const pretend = (key, value) => {
    config.get = (k, ...rest) => (k === key ? value : realGet(k, ...rest));
  };
  try {
    pretend('ENABLE_DEV_ENDPOINTS', 'false');
    assert.equal((await inbound(bizA, body, 404)).code, 'NOT_FOUND');
    pretend('DATABASE_URL', remoteUrl);
    assert.equal((await inbound(bizA, body, 404)).code, 'NOT_FOUND');
  } finally {
    config.get = realGet;
  }
  await inbound(bizA, body, 201);
});

test('8. pages: newest messages first, closed chats reopen, single conversation shape', async () => {
  const phone = '201000000201'; // the 8-message chat from test 3
  const conv = (
    await sql.query(
      'SELECT v.id FROM "Conversation" v JOIN "Customer" c ON c.id=v."customerId" WHERE c."businessId"=$1 AND c.phone=$2',
      [bizA, phone],
    )
  ).rows[0].id;
  const page = (q) =>
    call('get', `/businesses/${bizA}/conversations/${conv}/messages?${q}`);
  const p1 = await page('limit=3&offset=0');
  assert.deepEqual(p1.pagination, {
    limit: 3,
    offset: 0,
    totalCount: 8,
    hasMore: true,
    nextOffset: 3,
  });
  const times = p1.items.map((m) => new Date(m.createdAt).getTime());
  assert.deepEqual(
    [...times].sort((a, b) => b - a),
    times,
  );
  const p3 = await page('limit=3&offset=6');
  assert.equal(p3.items.length, 2);
  assert.equal(p3.pagination.hasMore, false);
  assert.equal(p3.pagination.nextOffset, null);
  assert.deepEqual((await page('limit=3&offset=50')).items, []);
  for (const q of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc'])
    await call('get', `/businesses/${bizA}/conversations?${q}`, {
      status: 400,
    });
  await call('get', `/businesses/${bizA}/conversations?status=PAUSED`, {
    status: 400,
  });

  await sql.query('UPDATE "Conversation" SET status=\'CLOSED\' WHERE id=$1', [
    conv,
  ]);
  const closed = await call(
    'get',
    `/businesses/${bizA}/conversations?status=CLOSED`,
  );
  assert.ok(closed.items.some((c) => c.id === conv));
  const open = await call(
    'get',
    `/businesses/${bizA}/conversations?status=OPEN&limit=100`,
  );
  assert.ok(!open.items.some((c) => c.id === conv));
  const reopened = await inbound(bizA, { phone, content: 'Back again' });
  assert.equal(reopened.conversation.status, 'OPEN');

  const one = await call('get', `/businesses/${bizA}/conversations/${conv}`);
  for (const key of [
    'id',
    'businessId',
    'customerId',
    'channel',
    'status',
    'aiEnabled',
    'handoffReason',
    'lastMessageAt',
    'lastCustomerMessageAt',
    'createdAt',
    'updatedAt',
    'customer',
  ])
    assert.ok(Object.hasOwn(one, key), key);
  assert.ok(!Object.hasOwn(one, 'lastMessage'));
  assert.deepEqual(Object.keys(one.customer).sort(), ['id', 'name', 'phone']);
});

test('9. seed refuses a remote database, works on the upgraded schema, and is safe to repeat', async () => {
  const tsx = require.resolve('tsx/cli', { paths: [root] });
  const seed = (databaseUrl) =>
    spawnSync(process.execPath, [tsx, 'prisma/seed.ts'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      timeout: 120000,
    });
  const refused = seed(remoteUrl);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing to seed/);

  const first = seed(url);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Seeded businesses/);
  const seeded = () =>
    count(
      'SELECT count(*)::int AS n FROM "Message" WHERE "businessId" IN ($1,$2)',
      [
        'a0000000-0000-4000-8000-000000000001',
        'b0000000-0000-4000-8000-000000000002',
      ],
    );
  const n = await seeded();
  assert.ok(n > 0);
  const second = seed(url);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(await seeded(), n);
});

test('10. rollback: refused while customers exist, then back to main, then deployable again', async () => {
  // Its own database with main + our migration only, so migrations added
  // after ours (WhatsApp, orders...) never change what this test proves.
  const rbName = database + '_rb';
  const rbUrl = urlFor(rbName);
  await admin.query(`CREATE DATABASE "${rbName}"`);
  const rb = new Client({ connectionString: rbUrl });
  await rb.connect();
  const at = (...args) => {
    const r = spawnSync(
      process.execPath,
      ['node_modules/prisma/build/index.js', ...args],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: rbUrl },
        encoding: 'utf8',
        timeout: 120000,
      },
    );
    return r;
  };
  const names = async (query) =>
    (await rb.query(query)).rows.map((r) => r.n).sort();
  const tables = () =>
    names(
      "SELECT table_name AS n FROM information_schema.tables WHERE table_schema='public' AND table_name <> '_prisma_migrations'",
    );
  const types = () =>
    names(
      "SELECT t.typname AS n FROM pg_type t JOIN pg_namespace s ON s.oid=t.typnamespace WHERE s.nspname='public' AND t.typtype='e'",
    );
  try {
    for (const name of migrations.filter((n) => n < ours)) {
      await rb.query(readMigration(name));
      assert.equal(at('migrate', 'resolve', '--applied', name).status, 0);
    }
    const mainOnly = { tables: await tables(), types: await types() };
    await rb.query(readMigration(ours));
    assert.equal(at('migrate', 'resolve', '--applied', ours).status, 0);
    const business = randomUUID();
    await rb.query(
      'INSERT INTO "Business" (id,name,"updatedAt") VALUES ($1,\'Existing store\',now())',
      [business],
    );
    await rb.query(
      'INSERT INTO "Customer" (id,"businessId",phone,"updatedAt") VALUES ($1,$2,\'201000000999\',now())',
      [randomUUID(), business],
    );

    const rollback = fs.readFileSync(
      path.join(
        root,
        'prisma/maintenance/rollback-customers-conversations.sql',
      ),
      'utf8',
    );
    await assert.rejects(rb.query(rollback), /Refusing to roll back/);
    assert.ok((await tables()).includes('Message'), 'nothing was dropped');

    // Only test rows exist in this database, so they may go.
    await rb.query('DELETE FROM "Customer"');
    await rb.query(rollback);
    assert.deepEqual(await tables(), mainOnly.tables);
    assert.deepEqual(await types(), mainOnly.types);
    assert.equal(
      (await rb.query('SELECT name FROM "Business" WHERE id=$1', [business]))
        .rows[0].name,
      'Existing store',
    );
    const pending = at('migrate', 'status');
    assert.notEqual(pending.status, 0);
    assert.match(pending.stdout + pending.stderr, new RegExp(ours));

    // Running it twice is harmless, and everything can be deployed again.
    await rb.query(rollback);
    assert.equal(at('migrate', 'deploy').status, 0);
    assert.match(at('migrate', 'status').stdout, /up to date/);
    assert.ok((await tables()).includes('Message'));
  } finally {
    await rb.end();
    await admin.query(`DROP DATABASE IF EXISTS "${rbName}"`);
  }
  });

after(async () => {
  if (app) await app.close();
  if (sql) await sql.end();
  const keep = process.env.KEEP_TEST_DB === '1';
  if (!keep)
    await admin
      .query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
      .catch(() => admin.query(`DROP DATABASE IF EXISTS "${database}"`));
  await admin.end();
  console.log(
    `HTTP checks: ${httpChecks}. Test database ${keep ? 'kept' : 'deleted'}: ${database}`,
  );
});
