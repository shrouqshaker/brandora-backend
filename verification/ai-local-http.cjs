// Actual loopback HTTP between NestJS and FastAPI, with real disposable PostgreSQL.
// Rules provider only. No production URL, real model call or conversation records.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setup } = require('../dev/ai-local-setup.cjs');
const { createHarness } = require('../dev/ai-local.cjs');

const root = path.resolve(__dirname, '..');
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const aiDir = path.resolve(
    option('--ai-dir') ?? path.join(root, '..', 'brandora-ai'),
  );
  const pythonSetting =
    option('--python') ?? process.env.AI_LOCAL_PYTHON ?? 'python';
  const python = /[\\/]/.test(pythonSetting)
    ? path.resolve(pythonSetting)
    : pythonSetting;
  assert(
    fs.existsSync(path.join(aiDir, 'app', 'local.py')),
    'Current AI local runner required',
  );
  assert(
    !aiDir.startsWith(path.join(root, '.tmp') + path.sep),
    'Do not test an ignored AI snapshot',
  );
  const directory = path.join(root, '.tmp', 'ai-local-check-' + randomUUID());
  const fixture = await setup(directory);
  const aiPort = await freePort();
  let backend, child;
  const results = {
    layer: 'real-local-http-and-postgresql',
    provider: 'rules',
    liveGroqVerified: false,
    realConversationPersistence: false,
    assertions: 0,
    scenarios: [],
  };
  function equal(a, b, label) {
    assert.deepEqual(a, b, label);
    results.assertions++;
  }
  try {
    backend = await createHarness({
      ...fixture.backend,
      AI_LOCAL_PORT: '0',
      AI_BASE_URL: 'http://127.0.0.1:' + aiPort,
    });
    const wrapper = [
      'import sys',
      'from pathlib import Path',
      'repo=Path.cwd().resolve()',
      'sys.path.insert(0,str(repo))',
      'from app import local',
      'assert Path(local.__file__).resolve().is_relative_to(repo)',
      'local.main()',
    ].join('\n');
    child = spawn(python, ['-B', '-c', wrapper], {
      cwd: aiDir,
      windowsHide: true,
      env: {
        ...process.env,
        ...fixture.ai,
        AI_LOCAL_PORT: String(aiPort),
        BACKEND_BASE_URL: backend.url,
        PYTHON_DOTENV_DISABLED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONIOENCODING: 'utf-8',
        GROQ_API_KEY: '',
        GEMINI_API_KEY: '',
        OPENROUTER_API_KEY: '',
        AI_LOCAL_PROVIDER: 'rules',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let launchError;
    child.on('error', () => {
      launchError = true;
    });
    const until = Date.now() + 20000;
    let ready = false;
    while (Date.now() < until && !launchError && child.exitCode === null) {
      try {
        ready =
          (await fetch('http://127.0.0.1:' + aiPort + '/ready')).status === 200;
      } catch {}
      if (ready) break;
      await pause(100);
    }
    equal(ready, true, 'FastAPI starts on a real loopback listener');
    const headers = {
      'Content-Type': 'application/json',
      'X-Brandora-Local-Test': 'true',
    };
    async function post(body, overrides = {}) {
      const r = await fetch(backend.url + '/dev/ai/respond', {
        method: 'POST',
        headers: { ...headers, ...overrides },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json(), headers: r.headers };
    }
    for (const [name, message, price] of [
      ['Egyptian product availability', 'عندكوا تيشيرت أسود؟', null],
      ['variant price override', 'بكام التيشيرت الأسود مقاس L؟', '275'],
      [
        'base price fallback and zero stock',
        'هل التيشيرت الأسود مقاس M متوفر؟',
        null,
      ],
      ['white variant', 'بكام التيشيرت الأبيض مقاس L؟', '290'],
      ['ambiguous product', 'عندكم تيشيرت؟', null],
      ['unknown product', 'عندكم ديناصور؟', null],
      [
        'missing actual variant combination',
        'هل التيشيرت الأبيض مقاس M متوفر؟',
        null,
      ],
      ['history unavailable', 'طب مقاس L بكام؟', null],
    ]) {
      const r = await post({ message });
      equal(r.status, 200, name);
      equal(
        Object.keys(r.body).sort(),
        ['intent', 'orderCandidate', 'reply', 'requiresReview'],
        'E0-3 fields',
      );
      equal(r.body.orderCandidate, null, 'No orders');
      equal(
        r.headers.get('X-Brandora-Live-Groq'),
        'false',
        'Rules is not reported as Groq',
      );
      if (price) {
        equal(
          r.body.reply.includes(price),
          true,
          name + ' uses real fixture price',
        );
        equal(
          r.headers.get('X-Brandora-Tool-Calls').includes('get_products'),
          true,
          'Real NestJS tool callback',
        );
      }
      if (name === 'history unavailable')
        equal(
          r.headers.get('X-AI-History-Status'),
          'unavailable',
          'No invented history',
        );
      if (name === 'Egyptian product availability')
        equal(
          r.headers.get('X-Brandora-Tool-Calls').includes('get_products'),
          true,
          'Availability uses real products',
        );
      results.scenarios.push({
        name,
        status: r.status,
        reply: r.body.reply,
        tools: r.headers.get('X-Brandora-Tool-Calls'),
        understanding: r.headers.get('X-AI-Understanding-Provider'),
        replyProvider: r.headers.get('X-AI-Reply-Provider'),
        history: r.headers.get('X-AI-History-Status'),
      });
    }
    for (const bad of [
      { message: 'hi', businessId: fixture.fixture.foreignBusinessId },
      { message: 'hi', history: [] },
      { message: ' ' },
      { message: 'x'.repeat(2001) },
    ])
      equal(
        (await post(bad)).status,
        400,
        'No caller-controlled scope/history or invalid text',
      );
    equal(
      (await post({ message: 'hi' }, { 'X-Brandora-Local-Test': '' })).status,
      403,
      'Local confirmation required',
    );
    equal(
      (await post({ message: 'hi' }, { Origin: 'https://untrusted.example' }))
        .status,
      403,
      'Browser cross-origin blocked',
    );

    const m = backend.registry.open('independent synthetic tool checks');
    const body = JSON.stringify({
      businessId: m.businessId,
      customerId: m.customerId,
      conversationId: m.conversationId,
      messageId: m.messageId,
      message: m.message,
    });
    const context = backend.security.issue(m, body);
    async function tool(
      name,
      args = {},
      token = context,
      credential = fixture.backend.BACKEND_SERVICE_TOKEN,
    ) {
      const r = await fetch(backend.url + '/internal/ai/data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + credential,
          'X-AI-Context': token,
        },
        body: JSON.stringify({ tool: name, arguments: args }),
      });
      return { status: r.status, body: await r.json() };
    }
    const p = fixture.fixture.products,
      v = fixture.fixture.variants;
    const listed = await tool('get_products');
    equal(listed.status, 200, 'Product retrieval');
    equal(
      listed.body.data.items.some(
        (x) => x.id === fixture.fixture.foreignProductId,
      ),
      false,
      'Tenant filter',
    );
    equal(
      listed.body.data.items.every((x) => x.businessId === m.businessId),
      true,
      'All products scoped',
    );
    for (const [id, price, stock] of [
      [v.blackL, '275.00', 7],
      [v.blackM, '250.00', 0],
    ]) {
      const detail = await tool('get_variant_details', {
        productId: p.black,
        variantId: id,
      });
      equal(detail.status, 200, 'Variant detail');
      equal(
        detail.body.data.effectivePrice,
        price,
        'Exact variant or inherited price',
      );
      equal(
        detail.body.data.stockQuantity,
        stock,
        'Exact real PostgreSQL quantity',
      );
    }
    const simple = await tool('get_product_details', { productId: p.simple });
    equal(
      simple.body.data.variants[0].trackInventory,
      false,
      'Untracked state preserved',
    );
    equal(
      simple.body.data.variants[0].stockQuantity,
      null,
      'Unknown stock remains null',
    );
    const page = await tool('get_product_variants', {
      productId: p.black,
      limit: 1,
      offset: 0,
    });
    equal(page.body.data.items.length, 1, 'Variant pagination limit');
    equal(
      page.body.data.pagination.hasMore,
      true,
      'Variant pagination coverage',
    );
    equal(
      (
        await tool('get_product_details', {
          productId: fixture.fixture.foreignProductId,
        })
      ).status,
      404,
      'Foreign product hidden',
    );
    equal(
      (await tool('get_product_details', { productId: randomUUID() })).status,
      404,
      'Missing product hidden',
    );
    equal(
      (
        await tool('get_products', {
          businessId: fixture.fixture.foreignBusinessId,
        })
      ).status,
      400,
      'Scope injection rejected',
    );
    equal(
      (await tool('delete_product')).status,
      400,
      'Unsupported write tool rejected',
    );
    equal(
      (
        await tool(
          'get_products',
          {},
          context,
          fixture.backend.AI_SERVICE_TOKEN,
        )
      ).status,
      401,
      'Wrong direction rejected',
    );
    equal(
      (await tool('get_products', {}, context.slice(0, -4) + 'abcd')).status,
      401,
      'Signature tampering rejected',
    );
    const foreignContext = backend.security.issue(
      { ...m, businessId: fixture.fixture.foreignBusinessId },
      body,
    );
    equal(
      (await tool('get_products', {}, foreignContext)).status,
      401,
      'Even signed foreign scope rejected',
    );
    equal(
      (await tool('get_products', {}, backend.security.issue(m, body + ' ')))
        .status,
      401,
      'Body hash binding rechecked',
    );
    const originalNow = Date.now;
    let expired;
    try {
      Date.now = () => originalNow() - 61000;
      expired = backend.security.issue(m, body);
    } finally {
      Date.now = originalNow;
    }
    equal(
      (await tool('get_products', {}, expired)).status,
      401,
      'Expired context rejected',
    );
    equal(
      (
        await tool('get_conversation_history', {
          conversationId: m.conversationId,
        })
      ).status,
      503,
      'History genuinely unavailable',
    );
    backend.registry.close(m.messageId);
    equal(
      (await tool('get_products')).status,
      401,
      'Completed synthetic request discarded',
    );
    equal(backend.registry.active.size, 0, 'No accumulated conversation state');
    const { PrismaService } = require('../dist/prisma/prisma.service');
    const prisma = backend.app.get(PrismaService);
    const memberKey = {
      userId_businessId: {
        userId: fixture.fixture.ownerId,
        businessId: fixture.fixture.businessId,
      },
    };
    await prisma.businessMember.update({
      where: memberKey,
      data: { isActive: false },
    });
    try {
      equal(
        (await post({ message: 'price' })).status,
        403,
        'Revoked fixture ownership denies new requests',
      );
    } finally {
      await prisma.businessMember.update({
        where: memberKey,
        data: { isActive: true },
      });
    }
    fs.writeFileSync(
      path.join(root, '.tmp', 'ai-local-http-results.json'),
      JSON.stringify(results, null, 2) + '\n',
    );
    console.log(
      JSON.stringify(
        {
          ...results,
          scenarios: results.scenarios.map((s) => ({
            name: s.name,
            status: s.status,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    if (child && child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([stopped, pause(3000)]);
    }
    if (backend) await backend.close();
  }
}
main().catch((error) => {
  // Assertions contain only synthetic fixture results, never config or provider exceptions.
  console.error(
    'FAIL local HTTP verification: ' +
      (error.code === 'ERR_ASSERTION'
        ? error.message
        : 'check local prerequisites'),
  );
  process.exitCode = 1;
});
