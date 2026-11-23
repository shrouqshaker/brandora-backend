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
/** Every line the backend logs during the tests, and what customers wrote (test 39). */
const logLines = [];
const captureLogs = Object.fromEntries(
  ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'].map((level) => [
    level,
    (...parts) =>
      logLines.push(
        parts
          .map((p) => (typeof p === 'string' ? p : (JSON.stringify(p) ?? '')))
          .join(' '),
      ),
  ]),
);
const customerTexts = new Set();
const customerPhones = new Set();
async function restartFakeAi(port) {
  fakeAi = startFakeAi({
    port,
    backendUrl: () => backendUrl,
    aiToken: AI_TOKEN,
    backendToken: BACKEND_TOKEN,
    publicKey: keys.publicKey,
  });
  await new Promise((r) => fakeAi.once('listening', r));
}
async function stopFakeAi() {
  const port = fakeAi.address().port;
  fakeAi.close();
  await new Promise((r) => fakeAi.once('close', r));
  return port;
}
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
  customerPhones.add(from);
  for (const [, text] of messages ?? []) customerTexts.add(text);
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
    await restartFakeAi(0);

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
      // The tests run the recovery pass themselves (like a restart).
      REPLY_RECOVERY_SECONDS: '0',
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
    app = module.createNestApplication({ rawBody: true, logger: captureLogs });
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
  const aiPort = await stopFakeAi();
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

  await restartFakeAi(aiPort);
  await post(webhook({ messages: [['wamid.long', 'م'.repeat(2001)]] }));
  const long = await customerMessage('wamid.long');
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(
    await rows('SELECT id FROM "Message" WHERE "replyToMessageId"=$1', [
      long.id,
    ]),
    [],
  );
  const [chat] = await rows(
    'SELECT "aiEnabled", "handoffReason" FROM "Conversation" WHERE id=$1',
    [long.conversationId],
  );
  assert.deepEqual(chat, {
    aiEnabled: false,
    handoffReason: 'MESSAGE_TOO_LONG',
  });
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

// ---------------------------------------------------------------- Human handoff
const chatOf = async (wamid) => {
  const m = await customerMessage(wamid);
  return (
    await rows(
      'SELECT id, "aiEnabled", "handoffReason", "handoffAt" FROM "Conversation" WHERE id=$1',
      [m.conversationId],
    )
  )[0];
};

test('14. the owner switches the AI off and on in one conversation', async () => {
  await post(
    webhook({ from: '201000000014', messages: [['wamid.h14', 'سلام']] }),
  );
  const chat = await chatOf('wamid.h14');
  const path = `/businesses/${bizA}/conversations/${chat.id}`;
  const off = await call('patch', path, { body: { aiEnabled: false } });
  assert.equal(off.aiEnabled, false);
  assert.equal(off.handoffReason, 'OWNER_TOOK_OVER');
  assert.ok(off.handoffAt);
  const on = await call('patch', path, { body: { aiEnabled: true } });
  assert.deepEqual(
    [on.aiEnabled, on.handoffReason, on.handoffAt],
    [true, null, null],
  );
  await call('patch', path, { body: { aiEnabled: 'yes' }, status: 400 });
  await call('patch', path, {
    body: { aiEnabled: false },
    status: 404,
    as: ownerB,
  });
});

test('15. the owner replies from the app: sent, the AI steps back, 24-hour rule', async () => {
  await post(
    webhook({ from: '201000000015', messages: [['wamid.h15', 'ممكن سؤال؟']] }),
  );
  const chat = await chatOf('wamid.h15');
  const path = `/businesses/${bizA}/conversations/${chat.id}/messages`;
  const sent = await call('post', path, {
    body: { content: '  أهلًا، أنا صاحبة المحل  ' },
    status: 201,
  });
  assert.equal(sent.senderType, 'OWNER');
  assert.equal(sent.content, 'أهلًا، أنا صاحبة المحل');
  assert.equal(sent.status, 'SENT');
  const after = await chatOf('wamid.h15');
  assert.deepEqual(
    [after.aiEnabled, after.handoffReason],
    [false, 'OWNER_TOOK_OVER'],
  );
  await call('post', path, { body: { content: '   ' }, status: 400 });
  await sql.query(
    `UPDATE "Conversation" SET "lastCustomerMessageAt"=(now() AT TIME ZONE 'UTC') - interval '25 hours' WHERE id=$1`,
    [chat.id],
  );
  const closed = await call('post', path, {
    body: { content: 'متأخر' },
    status: 409,
  });
  assert.equal(closed.code, 'WHATSAPP_WINDOW_CLOSED');
});

test('16. the AI asks for the owner (requiresReview): its reply is sent, then it goes quiet', async () => {
  await post(
    webhook({
      from: '201000000016',
      messages: [['wamid.h16', 'عندي شكوى الطلب اتأخر']],
    }),
  );
  const first = await customerMessage('wamid.h16');
  const [answer] = await replyTo(first.id);
  assert.equal(answer.aiMeta.requiresReview, true);
  const chat = await until(async () => {
    const c = await chatOf('wamid.h16');
    return c.aiEnabled === false ? c : null;
  }, 'the handoff');
  assert.equal(chat.handoffReason, 'AI_REVIEW_REQUIRED');
  await post(
    webhook({
      from: '201000000016',
      messages: [['wamid.h16b', 'رد عليا لو سمحت']],
    }),
  );
  const second = await customerMessage('wamid.h16b');
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(
    await rows('SELECT id FROM "Message" WHERE "replyToMessageId"=$1', [
      second.id,
    ]),
    [],
  );
});

test('17. the AI fails twice in a row: the conversation goes to the owner', async () => {
  const aiPort = await stopFakeAi();
  try {
    await post(
      webhook({ from: '201000000017', messages: [['wamid.h17a', 'سلام']] }),
    );
    await replyTo((await customerMessage('wamid.h17a')).id);
    assert.equal(
      (await chatOf('wamid.h17a')).aiEnabled,
      true,
      'one failure is not enough',
    );
    await post(
      webhook({
        from: '201000000017',
        messages: [['wamid.h17b', 'سلام تاني']],
      }),
    );
    await replyTo((await customerMessage('wamid.h17b')).id);
    const chat = await until(async () => {
      const c = await chatOf('wamid.h17b');
      return c.aiEnabled === false ? c : null;
    }, 'the handoff');
    assert.equal(chat.handoffReason, 'AI_UNAVAILABLE');
  } finally {
    await restartFakeAi(aiPort);
  }
});

// ---------------------------------------------------------------- Once only, even after a restart
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Counts POST /v2/ai/respond on the fake AI from now on. Call the result to read it. */
function countAiCalls() {
  let n = 0;
  const server = fakeAi;
  const on = (req) => {
    if (req.url === '/v2/ai/respond') n++;
  };
  server.on('request', on);
  return () => n;
}
const service = (file, name) => app.get(require(`../dist/${file}`)[name]);
const recovery = () =>
  service('ai-replies/reply-recovery.service', 'ReplyRecoveryService');
const sender = () =>
  service('whatsapp/whatsapp-sender.service', 'WhatsAppSenderService');
const { SendFailure } = (() => {
  try {
    return require('../dist/whatsapp/whatsapp-sender.service');
  } catch {
    return {};
  }
})();
const replyRow = async (customerMessageId) =>
  (
    await rows(
      `SELECT id, status, "sendAttempts", "sendClaimedAt", "nextSendAt", "aiMeta" FROM "Message" WHERE "replyToMessageId"=$1`,
      [customerMessageId],
    )
  )[0];
/** A customer message stored the way the webhook stores it, but nobody answered (the server stopped). */
async function storedWithoutAnswer(phone, wamid, text) {
  customerPhones.add(phone);
  customerTexts.add(text);
  const conversations = service(
    'conversations/conversations.service',
    'ConversationsService',
  );
  const r = await conversations.ingestInboundMessage({
    businessId: bizA,
    phone,
    externalMessageId: wamid,
    content: text,
  });
  return { id: r.message.id, conversationId: r.conversation.id };
}
/** Moves a message 20 seconds into the past, out of the webhook's own time. */
const age = (id) =>
  sql.query(
    `UPDATE "Message" SET "createdAt"="createdAt" - interval '20 seconds' WHERE id=$1`,
    [id],
  );

test('18. the same webhook twice at the same moment: stored once, the AI is called once, sent once', async () => {
  const calls = countAiCalls();
  const body = webhook({
    from: '201000000018',
    messages: [['wamid.twice', 'التيشيرت الأسود بكام؟']],
  });
  const [a, b] = await Promise.all([post(body), post(body)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const asked = await customerMessage('wamid.twice');
  const replies = await replyTo(asked.id);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].status, 'SENT');
  await sleep(300);
  assert.equal(calls(), 1, 'one AI call for one customer message');
  const [row] = await rows('SELECT "aiAttempts" FROM "Message" WHERE id=$1', [
    asked.id,
  ]);
  assert.equal(row.aiAttempts, 1);
  assert.equal((await replyRow(asked.id)).sendAttempts, 1, 'sent once');
});

test('19. Meta sends the webhook again later: no new AI call, nothing sent again', async () => {
  const calls = countAiCalls();
  const body = webhook({
    from: '201000000018',
    messages: [['wamid.twice', 'التيشيرت الأسود بكام؟']],
  });
  for (let i = 0; i < 2; i++) assert.equal((await post(body)).status, 200);
  await sleep(300);
  assert.equal(calls(), 0);
  const asked = await customerMessage('wamid.twice');
  assert.equal(
    (
      await rows('SELECT id FROM "Message" WHERE "replyToMessageId"=$1', [
        asked.id,
      ])
    ).length,
    1,
  );
  assert.equal((await replyRow(asked.id)).sendAttempts, 1);
});

test('20. Meta retries while the AI is still answering (our 200 came late): still one AI call', async () => {
  const ai = service('ai/ai.service', 'AiService');
  ai.respond = async (...args) => {
    await sleep(400); // a slow AI
    return Object.getPrototypeOf(ai).respond.apply(ai, args);
  };
  try {
    const calls = countAiCalls();
    const body = webhook({
      from: '201000000020',
      messages: [['wamid.slow', 'مساء الخير']],
    });
    assert.equal((await post(body)).status, 200);
    await sleep(100);
    assert.equal((await post(body)).status, 200, 'the retry, mid-answer');
    const asked = await customerMessage('wamid.slow');
    assert.equal((await replyTo(asked.id)).length, 1);
    assert.equal(calls(), 1);
  } finally {
    delete ai.respond;
  }
});

test('21. sending fails after the AI reply is saved: tried again only when Meta surely did not get it', async () => {
  const whatsapp = sender();
  let tries = 0;
  const busy = async () => {
    tries++;
    throw new SendFailure('Meta answered 503 (2) busy', true);
  };
  const refuses = async () => {
    tries++;
    throw new SendFailure('Meta answered 400 (131047) window', false);
  };
  const due = (id) =>
    sql.query(
      `UPDATE "Message" SET "nextSendAt"="nextSendAt" - interval '5 minutes' WHERE id=$1`,
      [id],
    );
  const firstTry = (asked) =>
    until(async () => {
      const r = await replyRow(asked.id);
      return r?.sendAttempts === 1 && !r.sendClaimedAt ? r : null;
    }, 'the first try');
  try {
    // Meta busy once: kept PENDING, sent on the next try.
    whatsapp.post = busy;
    await post(
      webhook({ from: '201000000021', messages: [['wamid.busy', 'سلام']] }),
    );
    const asked = await customerMessage('wamid.busy');
    const reply = await firstTry(asked);
    assert.equal(reply.status, 'PENDING', 'Meta was busy: another try later');
    assert.ok(reply.nextSendAt);
    await recovery().sweep();
    assert.equal(tries, 1, 'not due yet (30 seconds)');
    delete whatsapp.post; // Meta works again
    await due(reply.id);
    await recovery().sweep();
    const sent = await replyRow(asked.id);
    assert.deepEqual([sent.status, sent.sendAttempts], ['SENT', 2]);

    // Meta refuses (400): FAILED at once, never tried again.
    whatsapp.post = refuses;
    tries = 0;
    await post(
      webhook({ from: '201000000121', messages: [['wamid.refused', 'سلام']] }),
    );
    const refused = await customerMessage('wamid.refused');
    const failed = await until(async () => {
      const r = await replyRow(refused.id);
      return r?.status === 'FAILED' ? r : null;
    }, 'FAILED');
    await due(failed.id);
    await recovery().sweep();
    assert.equal(tries, 1);
    assert.equal((await replyRow(refused.id)).sendAttempts, 1);

    // Busy three times: FAILED after the third try.
    whatsapp.post = busy;
    tries = 0;
    await post(
      webhook({ from: '201000000221', messages: [['wamid.busy3', 'سلام']] }),
    );
    const busy3 = await customerMessage('wamid.busy3');
    const r3 = await firstTry(busy3);
    for (let i = 0; i < 3; i++) {
      await due(r3.id);
      await recovery().sweep();
    }
    const gaveUp = await replyRow(busy3.id);
    assert.deepEqual(
      [gaveUp.status, gaveUp.sendAttempts, tries],
      ['FAILED', 3, 3],
    );
  } finally {
    delete whatsapp.post;
  }
});

test('22. restart after the customer message was stored, before the AI: answered once by the recovery pass', async () => {
  const calls = countAiCalls();
  const m = await storedWithoutAnswer(
    '201000000022',
    'wamid.restart-1',
    'التيشيرت الأسود بكام؟',
  );
  await age(m.id);
  await recovery().sweep();
  const [reply] = await replyTo(m.id);
  assert.equal(reply.status, 'SENT');
  assert.match(reply.content, /بـ 250\.00 جنيه/, 'a real answer from the AI');
  await recovery().sweep(); // a second pass, or a second restart
  assert.equal(calls(), 1);
  assert.equal((await replyRow(m.id)).sendAttempts, 1);

  // An AI run that crashed is taken again after its 2-minute lease, twice in total at most.
  const crashed = await storedWithoutAnswer(
    '201000000122',
    'wamid.restart-crashed',
    'سلام',
  );
  await age(crashed.id);
  await sql.query(
    `UPDATE "Message" SET "aiClaimedAt"=(now() AT TIME ZONE 'UTC') - interval '30 seconds', "aiAttempts"=1 WHERE id=$1`,
    [crashed.id],
  );
  await recovery().sweep();
  assert.equal(await replyRow(crashed.id), undefined, 'lease not over yet');
  await sql.query(
    `UPDATE "Message" SET "aiClaimedAt"="aiClaimedAt" - interval '3 minutes' WHERE id=$1`,
    [crashed.id],
  );
  await recovery().sweep();
  assert.equal((await replyTo(crashed.id))[0].status, 'SENT');
  const [tries] = await rows('SELECT "aiAttempts" FROM "Message" WHERE id=$1', [
    crashed.id,
  ]);
  assert.equal(tries.aiAttempts, 2);
});

test('23. restart after the AI reply was saved, before sending: sent once, the AI is not asked again', async () => {
  const calls = countAiCalls();
  const m = await storedWithoutAnswer(
    '201000000023',
    'wamid.restart-2',
    'سلام',
  );
  const messages = service('messages/messages.service', 'MessagesService');
  const saved = await messages.createAiReply({
    businessId: bizA,
    conversationId: m.conversationId,
    replyToMessageId: m.id,
    content: 'أهلًا بيك! تحب تسأل عن إيه؟',
    aiMeta: { intent: 'OTHER', requiresReview: false, source: 'ai' },
  });
  await age(m.id);
  await age(saved.id);
  await recovery().sweep();
  const sent = await replyRow(m.id);
  assert.deepEqual([sent.status, sent.sendAttempts], ['SENT', 1]);
  await recovery().sweep();
  assert.equal((await replyRow(m.id)).sendAttempts, 1);
  assert.equal(calls(), 0);
});

test('24. restart in the middle of a send: never sent twice, FAILED so the owner sees it', async () => {
  const m = await storedWithoutAnswer(
    '201000000024',
    'wamid.restart-3',
    'سلام',
  );
  const messages = service('messages/messages.service', 'MessagesService');
  const saved = await messages.createAiReply({
    businessId: bizA,
    conversationId: m.conversationId,
    replyToMessageId: m.id,
    content: 'أهلًا بيك!',
    aiMeta: { intent: 'OTHER', requiresReview: false, source: 'ai' },
  });
  // The send started 3 minutes ago and never wrote its result.
  await sql.query(
    `UPDATE "Message" SET "sendClaimedAt"=(now() AT TIME ZONE 'UTC') - interval '3 minutes', "sendAttempts"=1 WHERE id=$1`,
    [saved.id],
  );
  await recovery().sweep();
  const r = await replyRow(m.id);
  assert.deepEqual(
    [r.status, r.sendAttempts, r.sendClaimedAt],
    ['FAILED', 1, null],
  );
});

test('25. Meta gets its 200 only after the message is saved; images, voice notes and documents never reach the AI', async () => {
  const calls = countAiCalls();
  const media = {
    image: { id: 'media-img', mime_type: 'image/jpeg', caption: 'ده المقاس؟' },
    audio: { id: 'media-aud', mime_type: 'audio/ogg' },
    document: { id: 'media-doc', filename: 'order.pdf' },
  };
  for (const [type, value] of Object.entries(media)) {
    const wamid = `wamid.media-${type}`;
    const payload = JSON.parse(
      webhook({ from: '201000000025', messages: [[wamid, 'x']] }),
    );
    const m = payload.entry[0].changes[0].value.messages[0];
    m.type = type;
    delete m.text;
    m[type] = value;
    const res = await post(JSON.stringify(payload));
    assert.equal(res.status, 200);
    const [row] = await rows(
      'SELECT id, "messageType" FROM "Message" WHERE "externalMessageId"=$1',
      [wamid],
    );
    assert.ok(row, `${type}: saved before the 200`);
    assert.equal(row.messageType, type.toUpperCase());
    const [fixed] = await replyTo(row.id);
    assert.equal(fixed.aiMeta.source, 'backend');
  }
  assert.equal(calls(), 0);
});

// ---------------------------------------------------------------- What the AI may read
const store = () =>
  service('conversations/conversations-ai.store', 'ConversationsAiStore');
/** A chat of its own, with the AI off so nothing answers it during these tests. */
async function quietChat(phone, wamid, text = 'أول رسالة') {
  const m = await storedWithoutAnswer(phone, wamid, text);
  await sql.query('UPDATE "Conversation" SET "aiEnabled"=false WHERE id=$1', [
    m.conversationId,
  ]);
  return m;
}
/** A message written straight into the table, at a chosen moment. */
async function insertMessage(
  conversationId,
  { at, sender = 'CUSTOMER', type = 'TEXT', text = 'x', id = randomUUID() },
) {
  await sql.query(
    `INSERT INTO "Message" (id, "businessId", "conversationId", "senderType", content, "messageType", status, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, ($8::timestamptz AT TIME ZONE 'UTC'))`,
    [
      id,
      bizA,
      conversationId,
      sender,
      text,
      type,
      sender === 'CUSTOMER' ? 'RECEIVED' : 'SENT',
      at.toISOString(),
    ],
  );
  return id;
}
const hourAgo = (seconds) => new Date(Date.now() - 3600_000 + seconds * 1000);
/** POST /internal/ai/data the way the AI service calls it. */
async function aiTool(current, tool, args, headers = {}) {
  const body = JSON.stringify({
    businessId: current.businessId,
    customerId: current.customerId,
    conversationId: current.conversationId,
    messageId: current.messageId,
    message: current.message,
  });
  const context = service('ai/ai-security', 'AiSecurity').issue(current, body);
  let r = http
    .post('/internal/ai/data')
    .set('Content-Type', 'application/json');
  const all = {
    Authorization: 'Bearer ' + BACKEND_TOKEN,
    'X-AI-Context': context,
    ...headers,
  };
  for (const [k, v] of Object.entries(all)) if (v !== null) r = r.set(k, v);
  return r.send({ tool, arguments: args });
}

test('26. the AI store answers only inside one business, one customer and one chat', async () => {
  const a = await quietChat('201000000026', 'wamid.iso-a', 'سؤال من منى');
  const b = await quietChat('201000000126', 'wamid.iso-b', 'سؤال من هالة');
  const current = await store().current(bizA, a.conversationId, a.id);
  assert.equal(current.message, 'سؤال من منى');
  const notFound = (e) => e.getStatus?.() === 404;
  // Another business, another chat, a message that is not this chat's.
  await assert.rejects(store().current(bizB, a.conversationId, a.id), notFound);
  await assert.rejects(store().current(bizA, b.conversationId, a.id), notFound);
  await assert.rejects(store().current(bizA, a.conversationId, b.id), notFound);
  // Only a customer's text is answered: not the owner's, not an image.
  const owner = await insertMessage(a.conversationId, {
    at: new Date(),
    sender: 'OWNER',
  });
  const image = await insertMessage(a.conversationId, {
    at: new Date(),
    type: 'IMAGE',
    text: '[image]',
  });
  for (const id of [owner, image])
    await assert.rejects(store().current(bizA, a.conversationId, id), notFound);
  // History under A's message never shows B's chat, even with B's ids.
  const later = {
    ...current,
    createdAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const mine = await store().historyBefore(later, 20, 0);
  assert.ok(mine.items.length >= 1);
  assert.ok(mine.items.every((m) => m.conversationId === a.conversationId));
  const bCustomer = (
    await rows('SELECT "customerId" FROM "Conversation" WHERE id=$1', [
      b.conversationId,
    ])
  )[0].customerId;
  const mixed = await store().historyBefore(
    { ...later, customerId: bCustomer },
    20,
    0,
  );
  assert.deepEqual(
    mixed.items,
    [],
    'customer id and chat must belong together',
  );
});

test('27. history: only before the current message, newest first, the same pages even while new messages arrive', async () => {
  const c = await quietChat('201000000027', 'wamid.cut');
  const t = (s) => hourAgo(s);
  const first = await insertMessage(c.conversationId, {
    at: t(0),
    text: 'واحد',
  });
  const ai = await insertMessage(c.conversationId, {
    at: t(1),
    sender: 'AI',
    text: 'اتنين',
  });
  const owner = await insertMessage(c.conversationId, {
    at: t(2),
    sender: 'OWNER',
    text: 'تلاتة',
  });
  const now = await insertMessage(c.conversationId, {
    at: t(3),
    text: 'السؤال الحالي',
  });
  await insertMessage(c.conversationId, {
    at: t(3),
    sender: 'AI',
    text: 'نفس اللحظة',
  });
  await insertMessage(c.conversationId, { at: t(4), text: 'بعده' });
  const current = await store().current(bizA, c.conversationId, now);
  const all = await store().historyBefore(current, 20, 0);
  assert.deepEqual(
    all.items.map((m) => m.id),
    [owner, ai, first],
    'before the current moment only, newest first',
  );
  const page1 = await store().historyBefore(current, 2, 0);
  assert.deepEqual(
    [
      page1.items.map((m) => m.id),
      page1.pagination.hasMore,
      page1.pagination.nextOffset,
    ],
    [[owner, ai], true, 2],
  );
  await insertMessage(c.conversationId, {
    at: new Date(),
    text: 'رسالة جديدة',
  });
  const page2 = await store().historyBefore(current, 2, 2);
  assert.deepEqual(
    page2.items.map((m) => m.id),
    [first],
    'page 2 did not move',
  );
  // The same through the AI's tool endpoint (src/ai checks every row again).
  const res = await aiTool(current, 'get_conversation_history', {
    conversationId: c.conversationId,
    limit: 20,
    offset: 0,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.data.items.map((m) => m.id),
    [owner, ai, first],
  );
});

test('28. equal timestamps: always the same order, and two customer turns at one moment fail closed', async () => {
  const d = await quietChat('201000000028', 'wamid.same');
  const at = hourAgo(10);
  const [low, high] = [randomUUID(), randomUUID()].sort();
  await insertMessage(d.conversationId, { at, text: 'قبل', id: low });
  await insertMessage(d.conversationId, {
    at,
    sender: 'AI',
    text: 'رد',
    id: high,
  });
  const now = await insertMessage(d.conversationId, {
    at: hourAgo(11),
    text: 'الحالي',
  });
  const current = await store().current(bizA, d.conversationId, now);
  for (let i = 0; i < 3; i++)
    assert.deepEqual(
      (await store().historyBefore(current, 20, 0)).items.map((m) => m.id),
      [high, low],
      'same moment: id decides, every time',
    );
  assert.equal(
    (
      await aiTool(current, 'get_conversation_history', {
        conversationId: d.conversationId,
      })
    ).status,
    200,
  );

  // Two customer messages at the very same moment: which came first is unknown.
  const e = await quietChat('201000000128', 'wamid.same-2');
  const tie = hourAgo(20);
  await insertMessage(e.conversationId, { at: tie, text: 'أ' });
  await insertMessage(e.conversationId, { at: tie, text: 'ب' });
  const now2 = await insertMessage(e.conversationId, {
    at: hourAgo(21),
    text: 'الحالي',
  });
  const current2 = await store().current(bizA, e.conversationId, now2);
  const unsure = await aiTool(current2, 'get_conversation_history', {
    conversationId: e.conversationId,
  });
  assert.equal(unsure.status, 503, 'no guessed order is ever given to the AI');
});

test('29. /internal/ai/data refuses everything outside the read tools and the signed message', async () => {
  const mine = await quietChat('201000000029', 'wamid.tools', 'عندكم إيه؟');
  const current = await store().current(bizA, mine.conversationId, mine.id);
  const other = await quietChat('201000000129', 'wamid.tools-2', 'سلام');
  const otherCurrent = await store().current(
    bizA,
    other.conversationId,
    other.id,
  );
  const theirs = await call('post', `/businesses/${bizB}/products`, {
    body: { name: 'منتج محل تاني', basePrice: '99.00' },
    status: 201,
    as: ownerB,
  });
  const expect = async (status, tool, args, headers) =>
    assert.equal(
      (await aiTool(current, tool, args, headers)).status,
      status,
      `${tool} ${JSON.stringify(args)} ${JSON.stringify(headers ?? {})}`,
    );
  // No service credential, a wrong one, no signed context.
  await expect(401, 'get_products', {}, { Authorization: null });
  await expect(
    401,
    'get_products',
    {},
    { Authorization: 'Bearer ' + AI_TOKEN },
  );
  await expect(401, 'get_products', {}, { 'X-AI-Context': null });
  // Unknown and write tools.
  for (const tool of ['get_orders', 'update_stock', 'create_order'])
    await expect(400, tool, {});
  // get_business_info is kept (the AI does not call it today): this business only.
  const info = await aiTool(current, 'get_business_info', {});
  assert.equal(info.status, 200);
  assert.equal(info.body.data.business.id, bizA);
  // businessId, a URL or unknown arguments; bad pages.
  for (const args of [
    { businessId: bizB },
    { url: 'https://evil.example/steal' },
    { q: 'all' },
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { limit: '5' },
  ])
    await expect(400, 'get_products', args);
  // Another business's product: not found under this context.
  await expect(404, 'get_product_details', { productId: theirs.id });
  // Another chat's history under this message's context.
  await expect(401, 'get_conversation_history', {
    conversationId: other.conversationId,
  });
  // A context signed for another message, used with this message's body: refused.
  const forOther = JSON.stringify({
    businessId: otherCurrent.businessId,
    customerId: otherCurrent.customerId,
    conversationId: otherCurrent.conversationId,
    messageId: otherCurrent.messageId,
    message: otherCurrent.message,
  });
  const otherContext = service('ai/ai-security', 'AiSecurity').issue(
    otherCurrent,
    forOther,
  );
  const tampered = otherContext.split('.');
  tampered[1] = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(tampered[1], 'base64url').toString()),
      messageId: current.messageId,
    }),
  ).toString('base64url');
  await expect(401, 'get_products', {}, { 'X-AI-Context': tampered.join('.') });
  // What is allowed: this business's products only.
  const ok = await aiTool(current, 'get_products', { limit: 100 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.tool, 'get_products');
  assert.ok(ok.body.data.items.length > 0);
  assert.ok(ok.body.data.items.every((p) => p.businessId === bizA));
});

test('30. variant data: productId is the official name, catalogItemId stays the same value for older readers', async () => {
  const mine = await quietChat('201000000030', 'wamid.dto', 'المقاسات؟');
  const current = await store().current(bizA, mine.conversationId, mine.id);
  const res = await aiTool(current, 'get_variant_details', {
    productId: shirt.id,
    variantId,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.productId, shirt.id);
  assert.equal(res.body.data.catalogItemId, shirt.id);
  const list = await aiTool(current, 'get_product_variants', {
    productId: shirt.id,
  });
  assert.ok(
    list.body.data.items.every(
      (v) => v.productId === shirt.id && v.catalogItemId === v.productId,
    ),
  );
});

// ---------------------------------------------------------------- Purchase intent and approval
async function productWithStock(name, price, quantity) {
  const p = await call('post', `/businesses/${bizA}/products`, {
    body: { name, basePrice: price },
    status: 201,
  });
  const v = p.variants[0].id;
  await call(
    'post',
    `/businesses/${bizA}/products/${p.id}/variants/${v}/inventory/adjust`,
    { body: { quantity }, status: 201 },
  );
  return { productId: p.id, variantId: v };
}
const stockOf = async (id) =>
  (
    await rows('SELECT "stockQuantity" FROM "ProductVariant" WHERE id=$1', [id])
  )[0].stockQuantity;
/** A pending order from a new customer message (no AI involved). */
async function pendingOrder(phone, item, quantity) {
  const m = await quietChat(phone, `wamid.order-${phone}`, 'عايز اطلب');
  return call('post', `/businesses/${bizA}/orders`, {
    body: { sourceMessageId: m.id, items: [{ ...item, quantity }] },
    status: 201,
  });
}
const approve = (orderId, body = {}) =>
  http
    .post(`/businesses/${bizA}/orders/${orderId}/approve`)
    .set('Authorization', 'Bearer ' + ownerA)
    .send(body);

test('31. PURCHASE_INTENT: an alert for the owner, no order, no stock taken; her order clears it', async () => {
  const before = await stock();
  const count = async () =>
    (await rows('SELECT count(*)::int AS n FROM "Order"'))[0].n;
  const orders = await count();
  await post(
    webhook({
      from: '201000000031',
      messages: [['wamid.buy', 'عايز تيشيرت كحلي']],
    }),
  );
  const asked = await customerMessage('wamid.buy');
  const [reply] = await replyTo(asked.id);
  assert.equal(reply.aiMeta.intent, 'PURCHASE_INTENT');
  const path = `/businesses/${bizA}/conversations/${asked.conversationId}`;
  const chat = await until(async () => {
    const c = await call('get', path);
    return c.purchaseMessageId ? c : null;
  }, 'the alert');
  assert.equal(chat.purchaseMessageId, asked.id);
  assert.ok(chat.purchaseIntentAt);
  assert.equal(chat.aiEnabled, true, 'the AI keeps helping (size, color...)');
  assert.equal(await stock(), before, 'nothing taken');
  assert.equal(await count(), orders, 'no order by itself');

  await call('post', `/businesses/${bizA}/orders`, {
    body: {
      sourceMessageId: asked.id,
      items: [{ productId: shirt.id, variantId, quantity: 1 }],
    },
    status: 201,
  });
  const after = await call('get', path);
  assert.deepEqual(
    [after.purchaseMessageId, after.purchaseIntentAt],
    [null, null],
  );
  assert.equal(await stock(), before, 'a pending order takes nothing either');
});

test("32. approve after the price changed: refused until the owner accepts today's price", async () => {
  const bag = await productWithStock('شنطة جلد', '400.00', 5);
  const order = await pendingOrder('201000000032', bag, 2);
  assert.equal(order.total, '800.00');
  await call(
    'patch',
    `/businesses/${bizA}/products/${bag.productId}/variants/${bag.variantId}`,
    { body: { unitPrice: '450.00' } },
  );
  const refused = await approve(order.id);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'ORDER_PRICE_CHANGED');
  assert.equal(await stockOf(bag.variantId), 5, 'nothing taken');
  assert.equal(
    (await call('get', `/businesses/${bizA}/orders/${order.id}`)).status,
    'PENDING_APPROVAL',
  );
  assert.equal(
    (await approve(order.id, { acceptCurrentPrices: 'yes' })).status,
    400,
  );
  assert.equal((await approve(order.id, { extra: true })).status, 400);
  const ok = await approve(order.id, { acceptCurrentPrices: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(
    [
      ok.body.status,
      ok.body.items[0].unitPrice,
      ok.body.items[0].lineTotal,
      ok.body.total,
    ],
    ['IN_PROGRESS', '450.00', '900.00', '900.00'],
    "today's price is the new snapshot",
  );
  assert.equal(await stockOf(bag.variantId), 3);
  assert.match(
    (await lastOwnerMessage(order.conversationId)).content,
    /900\.00/,
  );
});

test('33. approve checks stock and the product again: not enough or switched off -> 409, nothing taken', async () => {
  const cap = await productWithStock('كاب', '100.00', 3);
  const order = await pendingOrder('201000000033', cap, 3);
  const adjust = (quantity) =>
    call(
      'post',
      `/businesses/${bizA}/products/${cap.productId}/variants/${cap.variantId}/inventory/adjust`,
      { body: { quantity }, status: 201 },
    );
  await adjust(2); // someone bought one in the shop
  const low = await approve(order.id);
  assert.deepEqual(
    [low.status, low.body.code],
    [409, 'INVENTORY_INSUFFICIENT_STOCK'],
  );
  assert.equal(await stockOf(cap.variantId), 2);
  await adjust(3);
  const variantPath = `/businesses/${bizA}/products/${cap.productId}/variants/${cap.variantId}`;
  await call('patch', variantPath, { body: { isActive: false } });
  const off = await approve(order.id);
  assert.deepEqual(
    [off.status, off.body.code],
    [409, 'ORDER_ITEM_UNAVAILABLE'],
  );
  assert.equal(await stockOf(cap.variantId), 3);
  await call('patch', variantPath, { body: { isActive: true } });
  assert.equal((await approve(order.id)).status, 200);
  assert.equal(await stockOf(cap.variantId), 0);
});

test('34. two approvals at the same moment: one order moves, its stock is taken once', async () => {
  const coat = await productWithStock('جاكيت', '500.00', 4);
  const order = await pendingOrder('201000000034', coat, 2);
  const results = await Promise.all([approve(order.id), approve(order.id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await stockOf(coat.variantId), 2);
  const [moves] = await rows(
    `SELECT count(*)::int AS n FROM "InventoryMovement" WHERE "referenceType"='ORDER_LINE' AND "referenceId"=$1 AND type='ORDER_APPROVED'`,
    [order.items[0].id],
  );
  assert.equal(moves.n, 1, 'one movement for the line');
});

test('35. the last unit: two orders approved together, only one gets it (no overselling)', async () => {
  const last = await productWithStock('آخر قطعة', '300.00', 1);
  const a = await pendingOrder('201000000035', last, 1);
  const b = await pendingOrder('201000000135', last, 1);
  const results = await Promise.all([approve(a.id), approve(b.id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    results.find((r) => r.status === 409).body.code,
    'INVENTORY_INSUFFICIENT_STOCK',
  );
  assert.equal(await stockOf(last.variantId), 0, 'never below zero');
  const statuses = await rows(
    'SELECT status FROM "Order" WHERE id = ANY($1::uuid[])',
    [[a.id, b.id]],
  );
  assert.deepEqual(statuses.map((o) => o.status).sort(), [
    'IN_PROGRESS',
    'PENDING_APPROVAL',
  ]);
});

test('36. one order per customer message, even when two taps arrive together', async () => {
  const m = await quietChat('201000000036', 'wamid.tap', 'عايز جاكيت');
  const coat = (
    await rows(
      `SELECT v.id AS "variantId", v."productId" FROM "ProductVariant" v JOIN "Product" p ON p.id=v."productId" WHERE p.name='جاكيت'`,
    )
  )[0];
  const body = {
    sourceMessageId: m.id,
    items: [
      { productId: coat.productId, variantId: coat.variantId, quantity: 1 },
    ],
  };
  const send = () =>
    http
      .post(`/businesses/${bizA}/orders`)
      .set('Authorization', 'Bearer ' + ownerA)
      .send(body);
  const [x, y] = await Promise.all([send(), send()]);
  assert.deepEqual([x.status, y.status].sort(), [200, 201]);
  assert.equal(x.body.id, y.body.id);
  const [n] = await rows(
    'SELECT count(*)::int AS n FROM "Order" WHERE "sourceMessageId"=$1',
    [m.id],
  );
  assert.equal(n.n, 1);
});

// ---------------------------------------------------------------- End to end
test('37. end to end: question, answer from the products, wants to buy, owner order, approve, stock once, confirmation', async () => {
  const calls = countAiCalls();
  const phone = '201000000037';
  const kit = await productWithStock('طقم رياضي', '650.00', 2);
  const orders = `/businesses/${bizA}/orders`;
  const ask = webhook({
    from: phone,
    messages: [['wamid.e2e-1', 'طقم رياضي بكام؟']],
  });
  const buyIt = webhook({
    from: phone,
    messages: [['wamid.e2e-2', 'تمام عايز طقم رياضي']],
  });

  // 1) Saved once, the AI reads the product from the backend, the reply is saved and sent once.
  assert.equal((await post(ask)).status, 200);
  const question = await customerMessage('wamid.e2e-1');
  const [answer] = await replyTo(question.id);
  assert.equal(answer.content, 'طقم رياضي بـ 650.00 جنيه.');
  assert.equal(answer.status, 'SENT');

  // 2) The customer confirms: PURCHASE_INTENT, the owner sees it, nothing is ordered yet.
  assert.equal((await post(buyIt)).status, 200);
  const buy = await customerMessage('wamid.e2e-2');
  const [ok] = await replyTo(buy.id);
  assert.equal(ok.aiMeta.intent, 'PURCHASE_INTENT');
  const chat = await until(async () => {
    const c = await call(
      'get',
      `/businesses/${bizA}/conversations/${buy.conversationId}`,
    );
    return c.purchaseMessageId === buy.id ? c : null;
  }, 'the purchase alert');
  assert.equal(await stockOf(kit.variantId), 2);

  // 3) The owner makes the order from that message and approves it.
  const order = await call('post', orders, {
    body: {
      sourceMessageId: chat.purchaseMessageId,
      items: [{ ...kit, quantity: 1 }],
    },
    status: 201,
  });
  const approved = await call('post', `${orders}/${order.id}/approve`, {
    body: {},
  });
  assert.deepEqual(
    [approved.status, approved.total, approved.customerNotification],
    ['IN_PROGRESS', '650.00', 'SENT'],
  );

  // 4) Stock taken once; the customer gets the confirmation on WhatsApp.
  assert.equal(await stockOf(kit.variantId), 1);
  const confirmation = await lastOwnerMessage(chat.id);
  assert.deepEqual(confirmation, {
    content: 'تم تأكيد طلبك ✅\n- طقم رياضي × 1\nالإجمالي: 650.00 EGP',
    status: 'SENT',
  });

  // 5) Meta sends both webhooks again: nothing happens twice.
  await post(ask);
  await post(buyIt);
  await sleep(300);
  assert.equal(calls(), 2, 'one AI call per customer message');
  for (const id of [question.id, buy.id]) {
    const replies = await rows(
      'SELECT "sendAttempts", status FROM "Message" WHERE "replyToMessageId"=$1',
      [id],
    );
    assert.deepEqual(replies, [{ sendAttempts: 1, status: 'SENT' }]);
  }
  assert.equal(await stockOf(kit.variantId), 1);
  const [n] = await rows(
    'SELECT count(*)::int AS n FROM "Order" WHERE "conversationId"=$1',
    [chat.id],
  );
  assert.equal(n.n, 1, 'one order');
});

test('38. end to end handoff: complaint, no invented answer, handoff with its reason, AI silent, owner reply reaches the customer', async () => {
  const calls = countAiCalls();
  const phone = '201000000038';
  await post(
    webhook({
      from: phone,
      messages: [['wamid.e2e-c1', 'عندي شكوى الطلب اتأخر ومش راضي']],
    }),
  );
  const complaint = await customerMessage('wamid.e2e-c1');
  const [answer] = await replyTo(complaint.id);
  assert.equal(answer.aiMeta.requiresReview, true);
  assert.doesNotMatch(
    answer.content,
    /\d/,
    'no made-up order number, date or price',
  );
  const path = `/businesses/${bizA}/conversations/${complaint.conversationId}`;
  const chat = await until(async () => {
    const c = await call('get', path);
    return c.aiEnabled === false ? c : null;
  }, 'the handoff');
  assert.equal(chat.handoffReason, 'AI_REVIEW_REQUIRED');
  assert.ok(chat.handoffAt);
  const inbox = await call(
    'get',
    `/businesses/${bizA}/conversations?limit=100`,
  );
  assert.ok(
    inbox.items.some(
      (c) => c.id === chat.id && c.handoffReason === 'AI_REVIEW_REQUIRED',
    ),
    'the owner sees why in her inbox',
  );

  // The customer writes again: no automatic reply, not even from the recovery pass.
  await post(
    webhook({
      from: phone,
      messages: [['wamid.e2e-c2', 'حد يرد عليا لو سمحت']],
    }),
  );
  const again = await customerMessage('wamid.e2e-c2');
  await age(again.id);
  await recovery().sweep();
  await sleep(300);
  assert.equal(await replyRow(again.id), undefined);
  assert.equal(calls(), 1);

  // The owner answers from the app: saved and sent to the customer.
  const sent = await call('post', `${path}/messages`, {
    body: { content: 'أنا آسفة جدًا، طلبك هيوصلك النهارده' },
    status: 201,
  });
  assert.deepEqual([sent.senderType, sent.status], ['OWNER', 'SENT']);
  assert.match(sent.externalMessageId, /^dryrun-/);

  // She switches the AI back on: it answers the next message again.
  await call('patch', path, { body: { aiEnabled: true } });
  await post(webhook({ from: phone, messages: [['wamid.e2e-c3', 'شكرًا']] }));
  const thanks = await customerMessage('wamid.e2e-c3');
  assert.equal((await replyTo(thanks.id))[0].status, 'SENT');
  assert.equal(calls(), 2);
});

test('39. logs never hold a customer text, a full customer number or a secret', async () => {
  await sleep(300); // let background replies finish their logs
  assert.ok(logLines.length > 0, 'the backend did log');
  const secrets = [
    SECRET,
    VERIFY,
    AI_TOKEN,
    BACKEND_TOKEN,
    process.env.JWT_SECRET,
    process.env.AUTH_RATE_LIMIT_SECRET,
  ];
  for (const line of logLines) {
    for (const secret of secrets)
      assert.ok(
        !line.includes(secret),
        `a secret in the log: ${line.slice(0, 80)}`,
      );
    for (const text of customerTexts)
      if (text.length >= 4)
        assert.ok(
          !line.includes(text),
          `customer text in the log: ${line.slice(0, 80)}`,
        );
    for (const phone of customerPhones)
      assert.ok(
        !line.includes(phone),
        `full number in the log: ${line.slice(0, 80)}`,
      );
  }
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
