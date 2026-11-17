const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const {
  randomUUID,
  randomBytes,
  createHmac,
  generateKeyPairSync,
} = require('node:crypto');
const { startFakeAi } = require('./tools/fake-ai-service.cjs');
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

let sql, app, http, ownerA, ownerB, bizA, bizB, fakeAi, backendUrl;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const AI_TOKEN = randomBytes(32).toString('base64url');
const BACKEND_TOKEN = randomBytes(32).toString('base64url');

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
    fakeAi = startFakeAi({
      port: 0,
      backendUrl: () => backendUrl,
      aiToken: AI_TOKEN,
      backendToken: BACKEND_TOKEN,
      publicKey: keys.publicKey,
    });
    await new Promise((r) => fakeAi.once('listening', r));

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
      AI_INTEGRATION_ENABLED: 'true',
      AI_BASE_URL: `http://127.0.0.1:${fakeAi.address().port}`,
      AI_SERVICE_TOKEN: AI_TOKEN,
      BACKEND_SERVICE_TOKEN: BACKEND_TOKEN,
      AI_CONTEXT_PRIVATE_KEY: keys.privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }),
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
    backendUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
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
  const res = await http.get('/webhooks/whatsapp').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': VERIFY,
    'hub.challenge': '424242',
  });
  assert.equal(res.status, 200);
  assert.equal(res.text, '424242');
  const bad = await http.get('/webhooks/whatsapp').query({
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
  assert.ok(
    replies[0].externalMessageId,
    'answered by the AI and sent (dry run)',
  );
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

// ---------------------------------------------------------------- AI replies
const replyTo = async (messageId) =>
  until(async () => {
    const r = await rows(
      `SELECT content, status, "aiMeta" FROM "Message" WHERE "replyToMessageId"=$1`,
      [messageId],
    );
    return r.length && r[0].status !== 'PENDING' ? r : null;
  }, 'the AI reply');
const customerMessage = async (wamid) =>
  (
    await rows(
      'SELECT id, "conversationId" FROM "Message" WHERE "externalMessageId"=$1',
      [wamid],
    )
  )[0];

test('7. the AI answers from real products and real history, through src/ai', async () => {
  const product = await call('post', `/businesses/${bizA}/products`, {
    body: { name: 'تيشيرت أسود', basePrice: '250.00' },
    status: 201,
  });
  assert.equal(product.variants.length, 1);
  await post(webhook({ messages: [['wamid.price', 'التيشيرت الأسود بكام؟']] }));
  const asked = await customerMessage('wamid.price');
  const [answer] = await replyTo(asked.id);
  assert.equal(answer.content, 'تيشيرت أسود بـ 250.00 جنيه.');
  assert.equal(answer.status, 'SENT');
  assert.deepEqual(answer.aiMeta, {
    intent: 'INQUIRY',
    requiresReview: false,
    source: 'ai',
  });

  // History is read back through /internal/ai/data: the fake says "تاني".
  await post(webhook({ messages: [['wamid.hello', 'مساء الخير']] }));
  const hello = await customerMessage('wamid.hello');
  assert.equal(
    (await replyTo(hello.id))[0].content,
    'أهلًا بيك تاني! تحب تسأل عن إيه؟',
  );
});

test('8. one customer message never gets two AI replies, even if processed twice', async () => {
  const { AiReplyService } = require('../dist/ai-replies/ai-reply.service');
  const replies = app.get(AiReplyService);
  const asked = await customerMessage('wamid.price');
  await Promise.all([
    replies.answer({
      businessId: bizA,
      conversationId: asked.conversationId,
      messageId: asked.id,
    }),
    replies.answer({
      businessId: bizA,
      conversationId: asked.conversationId,
      messageId: asked.id,
    }),
  ]);
  assert.equal(
    (
      await rows('SELECT id FROM "Message" WHERE "replyToMessageId"=$1', [
        asked.id,
      ])
    ).length,
    1,
  );
});

test('9. AI down: one safe fixed reply; non-text: a fixed reply; too long: left for the owner', async () => {
  fakeAi.close();
  await new Promise((r) => fakeAi.once('close', r));
  await post(webhook({ messages: [['wamid.down', 'في حد هنا؟']] }));
  const down = await customerMessage('wamid.down');
  const [fallback] = await replyTo(down.id);
  assert.equal(fallback.aiMeta.source, 'fallback');
  assert.match(fallback.content, /صاحب المحل هيشوف رسالتك/);

  const payload = JSON.parse(webhook({ messages: [['wamid.voice', 'x']] }));
  const m = payload.entry[0].changes[0].value.messages[0];
  m.type = 'voice';
  delete m.text;
  m.voice = { id: 'media-1' };
  await post(JSON.stringify(payload));
  const voice = await customerMessage('wamid.voice');
  const [fixed] = await replyTo(voice.id);
  assert.equal(fixed.aiMeta.source, 'backend');

  await post(webhook({ messages: [['wamid.long', 'م'.repeat(2001)]] }));
  const long = await customerMessage('wamid.long');
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(
    await rows('SELECT id FROM "Message" WHERE "replyToMessageId"=$1', [
      long.id,
    ]),
    [],
  );
});

test('10. when the owner took the chat (aiEnabled=false) the AI stays silent', async () => {
  const asked = await customerMessage('wamid.price');
  await sql.query('UPDATE "Conversation" SET "aiEnabled"=false WHERE id=$1', [
    asked.conversationId,
  ]);
  await post(webhook({ messages: [['wamid.quiet', 'سلام']] }));
  const quiet = await customerMessage('wamid.quiet');
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(
    await rows('SELECT id FROM "Message" WHERE "replyToMessageId"=$1', [
      quiet.id,
    ]),
    [],
  );
  await sql.query('UPDATE "Conversation" SET "aiEnabled"=true WHERE id=$1', [
    asked.conversationId,
  ]);
});

// ---------------------------------------------------------------- Orders
let shirt, variantId;
const stock = async () =>
  (
    await rows('SELECT "stockQuantity" FROM "ProductVariant" WHERE id=$1', [
      variantId,
    ])
  )[0].stockQuantity;
const lastOwnerMessage = async (conversationId) =>
  (
    await rows(
      `SELECT content, status FROM "Message" WHERE "conversationId"=$1 AND "senderType"='OWNER' ORDER BY "createdAt" DESC LIMIT 1`,
      [conversationId],
    )
  )[0];

test('11. the owner makes an order from a customer message: database prices, one order per message', async () => {
  shirt = await call('post', `/businesses/${bizA}/products`, {
    body: { name: 'تيشيرت كحلي', basePrice: '250.00' },
    status: 201,
  });
  variantId = shirt.variants[0].id;
  await call(
    'post',
    `/businesses/${bizA}/products/${shirt.id}/variants/${variantId}/inventory/adjust`,
    { body: { quantity: 3 }, status: 201 },
  );
  await post(webhook({ messages: [['wamid.order-1', 'عايز 2 تيشيرت كحلي']] }));
  const asked = await customerMessage('wamid.order-1');
  const body = {
    sourceMessageId: asked.id,
    items: [{ productId: shirt.id, variantId, quantity: 2 }],
  };
  const order = await call('post', `/businesses/${bizA}/orders`, {
    body,
    status: 201,
  });
  assert.equal(order.status, 'PENDING_APPROVAL');
  assert.equal(order.total, '500.00');
  assert.equal(order.items[0].unitPrice, '250.00');
  assert.equal(order.items[0].productName, 'تيشيرت كحلي');
  assert.equal(order.requiresReview, false);
  assert.equal(await stock(), 3, 'pending orders take no stock');
  const again = await call('post', `/businesses/${bizA}/orders`, {
    body,
    status: 200,
  });
  assert.equal(again.id, order.id);

  const big = await post(
    webhook({ messages: [['wamid.order-big', 'عايز 5']] }),
  );
  assert.equal(big.status, 200);
  const bigAsked = await customerMessage('wamid.order-big');
  const low = await call('post', `/businesses/${bizA}/orders`, {
    body: {
      sourceMessageId: bigAsked.id,
      items: [{ productId: shirt.id, variantId, quantity: 5 }],
    },
    status: 201,
  });
  assert.equal(low.requiresReview, true);
  assert.equal(low.reviewReason, 'LOW_STOCK');

  const [aiReply] = await rows(
    'SELECT id FROM "Message" WHERE "replyToMessageId"=$1',
    [asked.id],
  );
  const notCustomer = await call('post', `/businesses/${bizA}/orders`, {
    body: { ...body, sourceMessageId: aiReply?.id ?? randomUUID() },
    status: 404,
  });
  assert.equal(notCustomer.code, 'MESSAGE_NOT_FOUND');
  await call('post', `/businesses/${bizA}/orders`, {
    body,
    status: 404,
    as: ownerB,
  });
  await call('get', `/businesses/${bizA}/orders/${order.id}`, {
    status: 404,
    as: ownerB,
  });
  const list = await call(
    'get',
    `/businesses/${bizA}/orders?status=PENDING_APPROVAL`,
  );
  assert.equal(list.pagination.totalCount, 2);
});

test('12. approve: stock taken once in one transaction, the customer gets the confirmation', async () => {
  const [order] = (
    await call('get', `/businesses/${bizA}/orders?status=PENDING_APPROVAL`)
  ).items.filter((o) => o.total === '500.00');
  const [first, second] = await Promise.all([
    http
      .post(`/businesses/${bizA}/orders/${order.id}/approve`)
      .set('Authorization', 'Bearer ' + ownerA),
    http
      .post(`/businesses/${bizA}/orders/${order.id}/approve`)
      .set('Authorization', 'Bearer ' + ownerA),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const ok = first.status === 200 ? first.body : second.body;
  assert.equal(ok.status, 'IN_PROGRESS');
  assert.equal(ok.customerNotification, 'SENT');
  assert.equal(await stock(), 1, '3 - 2, taken once');
  const message = await lastOwnerMessage(order.conversationId);
  assert.equal(
    message.content,
    'تم تأكيد طلبك ✅\n- تيشيرت كحلي × 2\nالإجمالي: 500.00 EGP',
  );

  const [low] = (
    await call('get', `/businesses/${bizA}/orders?status=PENDING_APPROVAL`)
  ).items;
  const refused = await call(
    'post',
    `/businesses/${bizA}/orders/${low.id}/approve`,
    { status: 409 },
  );
  assert.equal(refused.code, 'INVENTORY_INSUFFICIENT_STOCK');
  assert.equal(
    (await call('get', `/businesses/${bizA}/orders/${low.id}`)).status,
    'PENDING_APPROVAL',
  );
  assert.equal(await stock(), 1, 'nothing taken when one line fails');
});

test('13. reject: no stock change, the customer hears the reason; a decided order cannot change', async () => {
  const [low] = (
    await call('get', `/businesses/${bizA}/orders?status=PENDING_APPROVAL`)
  ).items;
  const rejected = await call(
    'post',
    `/businesses/${bizA}/orders/${low.id}/reject`,
    {
      body: { reason: '  الكمية مش متاحة  ' },
    },
  );
  assert.equal(rejected.status, 'CANCELLED');
  assert.equal(rejected.cancelReason, 'الكمية مش متاحة');
  assert.equal(await stock(), 1);
  assert.match(
    (await lastOwnerMessage(low.conversationId)).content,
    /السبب: الكمية مش متاحة/,
  );
  const again = await call(
    'post',
    `/businesses/${bizA}/orders/${low.id}/reject`,
    { body: {}, status: 409 },
  );
  assert.equal(again.code, 'ORDER_NOT_PENDING');
  await call('post', `/businesses/${bizA}/orders/${low.id}/reject`, {
    body: { reason: 'x', extra: true },
    status: 400,
  });
});

after(async () => {
  if (app) await app.close();
  if (fakeAi?.listening) fakeAi.close();
  if (sql) await sql.end();
  await admin
    .query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    .catch(() => admin.query(`DROP DATABASE IF EXISTS "${database}"`));
  await admin.end();
});
