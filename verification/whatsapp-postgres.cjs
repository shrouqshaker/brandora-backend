// WhatsApp webhook end to end: REAL PostgreSQL, REAL HTTP, signed like Meta.
//
//   npm run test:whatsapp:postgres
//
// Creates a NEW random database on your LOCAL PostgreSQL server (from .env
// DATABASE_URL or TEST_POSTGRES_URL), deploys every migration, runs the
// checks and deletes the database. Nothing is sent to Meta: dry run only.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { randomUUID, randomBytes, createHmac } = require('node:crypto');
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
const envFile = path.join(root, '.env');
const raw =
  process.env.TEST_POSTGRES_URL ||
  (fs.existsSync(envFile)
    ? dotenv.parse(fs.readFileSync(envFile)).DATABASE_URL
    : undefined);
if (!isLocalDatabaseUrl(raw))
  throw new Error('Set DATABASE_URL in .env to a localhost PostgreSQL server.');
const database = 'brandora_whatsapp_' + randomUUID().replaceAll('-', '');
const urlFor = (name) => {
  const u = new URL(raw);
  u.pathname = '/' + name;
  u.search = '';
  return u.toString();
};
const url = urlFor(database);
const admin = new Client({ connectionString: urlFor('postgres') });
const SECRET = randomBytes(24).toString('hex');
const VERIFY = randomBytes(12).toString('hex');
const NUMBER_A = '106540352242922';
const NUMBER_B = '106540352242999';
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/whatsapp-text.json'), 'utf8'),
);

let sql, app, http, ownerA, ownerB, bizA, bizB;

async function call(method, route, { body, status = 200, as = ownerA } = {}) {
  let r = http[method](route);
  if (as) r = r.set('Authorization', 'Bearer ' + as);
  if (body !== undefined) r = r.send(body);
  const res = await r;
  assert.equal(
    res.status,
    status,
    `${method.toUpperCase()} ${route} -> ${res.status} ${JSON.stringify(res.body)}`,
  );
  return res.body;
}

/** A webhook exactly like Meta's: same shape, signed with the App secret. */
function webhook({
  number = NUMBER_A,
  messages,
  statuses,
  from = '201000000001',
}) {
  const payload = JSON.parse(JSON.stringify(fixture));
  const value = payload.entry[0].changes[0].value;
  value.metadata.phone_number_id = number;
  value.contacts[0].wa_id = from;
  if (messages)
    value.messages = messages.map(([id, text]) => ({
      from,
      id,
      timestamp: '1762866000',
      type: 'text',
      text: { body: text },
    }));
  else delete value.messages;
  if (statuses)
    value.statuses = statuses.map(([id, status]) => ({ id, status }));
  return JSON.stringify(payload);
}
function post(body, signature = sign(body)) {
  return http
    .post('/webhooks/whatsapp')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signature)
    .send(body);
}
const sign = (body, secret = SECRET) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
const rows = async (query, params = []) =>
  (await sql.query(query, params)).rows;
const until = async (check, label) => {
  for (let i = 0; i < 50; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('Timed out waiting for ' + label);
};

before(
  async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    sql = new Client({ connectionString: url });
    await sql.connect();
    const deploy = spawnSync(
      process.execPath,
      ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
      },
    );
    assert.equal(deploy.status, 0, deploy.stdout + deploy.stderr);

    Object.assign(process.env, {
      DATABASE_URL: url,
      JWT_SECRET: randomBytes(48).toString('base64'),
      AUTH_RATE_LIMIT_SECRET: randomBytes(48).toString('base64'),
      JWT_ISSUER: 'whatsapp-test',
      JWT_AUDIENCE: 'android-test',
      AUTH_EMAIL_MODE: 'disabled',
      AUTH_TRUSTED_PROXY_CIDRS: '',
      IMPORT_STORAGE_DIR: path.join(tmpdir(), database),
      WHATSAPP_ENABLED: 'true',
      WHATSAPP_VERIFY_TOKEN: VERIFY,
      WHATSAPP_APP_SECRET: SECRET,
      WHATSAPP_DRY_RUN: 'true',
      AI_INTEGRATION_ENABLED: 'false',
    });
    require('reflect-metadata');
    const { Test } = require('@nestjs/testing');
    const { ValidationPipe } = require('@nestjs/common');
    const { HttpAdapterHost } = require('@nestjs/core');
    const { AppModule } = require('../dist/app.module');
    const {
      HttpExceptionFilter,
    } = require('../dist/common/errors/http-exception.filter');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // Same options, pipe and filter as src/main.ts.
    app = module.createNestApplication({ rawBody: true, logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());

    const register = async (email) =>
      (
        await call('post', '/auth/register', {
          body: { email, password: 'SecurePassword123!' },
          status: 201,
          as: null,
        })
      ).accessToken;
    ownerA = await register('wa-owner-a@example.test');
    ownerB = await register('wa-owner-b@example.test');
    bizA = (
      await call('post', '/businesses', {
        body: { name: 'Store A' },
        status: 201,
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

test('1. Meta checks the URL: the right word returns the challenge, a wrong one is 403', async () => {
  const res = await http
    .get('/webhooks/whatsapp')
    .query({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY,
      'hub.challenge': '424242',
    });
  assert.equal(res.status, 200);
  assert.equal(res.text, '424242');
  const bad = await http
    .get('/webhooks/whatsapp')
    .query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'nope',
      'hub.challenge': '1',
    });
  assert.equal(bad.status, 403);
  assert.equal(bad.body.code, 'WHATSAPP_VERIFY_TOKEN_INVALID');
});

test('2. each number belongs to one business; owners only see their own link', async () => {
  await call('get', `/businesses/${bizA}/whatsapp-connection`, { status: 404 });
  const linked = await call('put', `/businesses/${bizA}/whatsapp-connection`, {
    body: { phoneNumberId: NUMBER_A },
  });
  assert.equal(linked.phoneNumberId, NUMBER_A);
  assert.equal(linked.isActive, true);
  const taken = await call('put', `/businesses/${bizB}/whatsapp-connection`, {
    body: { phoneNumberId: NUMBER_A },
    status: 409,
    as: ownerB,
  });
  assert.equal(taken.code, 'WHATSAPP_PHONE_NUMBER_IN_USE');
  await call('put', `/businesses/${bizB}/whatsapp-connection`, {
    body: { phoneNumberId: NUMBER_B },
    as: ownerB,
  });
  await call('put', `/businesses/${bizA}/whatsapp-connection`, {
    body: { phoneNumberId: '12ab' },
    status: 400,
  });
  await call('get', `/businesses/${bizA}/whatsapp-connection`, {
    status: 404,
    as: ownerB,
  });
  await call('get', `/businesses/${bizA}/whatsapp-connection`, {
    status: 401,
    as: null,
  });
});

test('3. only signed webhooks are accepted', async () => {
  const body = webhook({ messages: [['wamid.unsigned', 'hi']] });
  assert.equal((await post(body, sign(body, 'not-the-secret'))).status, 401);
  assert.equal((await post(body, '')).status, 401);
  assert.deepEqual(
    await rows('SELECT id FROM "Message" WHERE "externalMessageId"=$1', [
      'wamid.unsigned',
    ]),
    [],
  );
});

test('4. a message is stored once in the right business, and answered once', async () => {
  const body = webhook({ messages: [['wamid.once', 'التيشيرت بكام؟']] });
  for (let i = 0; i < 3; i++) assert.equal((await post(body)).status, 200);
  const stored = await rows(
    'SELECT "businessId", content, "conversationId" FROM "Message" WHERE "externalMessageId"=$1',
    ['wamid.once'],
  );
  assert.equal(stored.length, 1);
  assert.equal(stored[0].businessId, bizA);
  assert.equal(stored[0].content, 'التيشيرت بكام؟');
  const replies = await until(async () => {
    const r = await rows(
      `SELECT status, "externalMessageId" FROM "Message" WHERE "conversationId"=$1 AND "senderType"<>'CUSTOMER'`,
      [stored[0].conversationId],
    );
    return r.length && r.every((m) => m.status !== 'PENDING') ? r : null;
  }, 'the reply');
  assert.equal(replies.length, 1, 'three deliveries, one answer');
  assert.equal(replies[0].status, 'SENT');
  assert.match(replies[0].externalMessageId, /^dryrun-/);
  const customer = await rows(
    'SELECT name, phone FROM "Customer" WHERE "businessId"=$1',
    [bizA],
  );
  assert.deepEqual(customer, [{ name: 'Mona', phone: '201000000001' }]);
});

test('5. delivery reports only move forward, and only for the business of that number', async () => {
  const [reply] = await rows(
    `SELECT id, "externalMessageId" FROM "Message" WHERE "businessId"=$1 AND "senderType"<>'CUSTOMER'`,
    [bizA],
  );
  const status = async () =>
    (await rows('SELECT status FROM "Message" WHERE id=$1', [reply.id]))[0]
      .status;
  await post(
    webhook({
      number: NUMBER_B,
      statuses: [[reply.externalMessageId, 'read']],
    }),
  );
  assert.equal(
    await status(),
    'SENT',
    "business B's number cannot touch A's message",
  );
  await post(webhook({ statuses: [[reply.externalMessageId, 'read']] }));
  assert.equal(await status(), 'READ');
  await post(webhook({ statuses: [[reply.externalMessageId, 'delivered']] }));
  assert.equal(
    await status(),
    'READ',
    'a late "delivered" does not move it back',
  );
});

test('6. numbers that are not linked, or paused, are ignored', async () => {
  await post(
    webhook({ number: '999999999', messages: [['wamid.nobody', 'hi']] }),
  );
  await call('put', `/businesses/${bizA}/whatsapp-connection`, {
    body: { phoneNumberId: NUMBER_A, isActive: false },
  });
  await post(webhook({ messages: [['wamid.paused', 'hi']] }));
  assert.deepEqual(
    await rows(
      `SELECT id FROM "Message" WHERE "externalMessageId" IN ('wamid.nobody','wamid.paused')`,
    ),
    [],
  );
  await call('put', `/businesses/${bizA}/whatsapp-connection`, {
    body: { phoneNumberId: NUMBER_A, isActive: true },
  });
});

after(async () => {
  if (app) await app.close();
  if (sql) await sql.end();
  await admin
    .query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    .catch(() => admin.query(`DROP DATABASE IF EXISTS "${database}"`));
  await admin.end();
});