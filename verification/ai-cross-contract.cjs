// Offline cross-repository contract check; no database or real provider.
const path = require('node:path');
const cp = require('node:child_process');
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const aiDir = path.resolve(
  option('--ai-dir') ?? path.join(__dirname, '..', '..', 'brandora-ai'),
);
const pythonSetting =
  option('--python') ?? process.env.AI_LOCAL_PYTHON ?? 'python';
const python = /[\\/]/.test(pythonSetting)
  ? path.resolve(pythonSetting)
  : pythonSetting;
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { ConfigService } = require('@nestjs/config');
const { AiSecurity } = require('../dist/ai/ai-security');
const { validateAiResponse } = require('../dist/ai/ai-response');
const { AiService } = require('../dist/ai/ai.service');
const { productResponse } = require('../dist/products/product-presenter');
const ids = {
  businessId: '10000000-0000-4000-8000-000000000001',
  customerId: '30000000-0000-4000-8000-000000000001',
  conversationId: '20000000-0000-4000-8000-000000000001',
  messageId: '40000000-0000-4000-8000-000000000002',
};
const m = {
  ...ids,
  message: 'black tshirt size L price',
  createdAt: '2026-11-04T10:00:00.000Z',
};
const body = JSON.stringify({ ...ids, message: m.message });
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const outbound = crypto.randomBytes(48).toString('base64url');
const inbound = crypto.randomBytes(48).toString('base64url');
const security = new AiSecurity(
  new ConfigService({
    AI_INTEGRATION_ENABLED: 'true',
    AI_BASE_URL: 'http://127.0.0.1:8000',
    AI_SERVICE_TOKEN: outbound,
    BACKEND_SERVICE_TOKEN: inbound,
    AI_CONTEXT_PRIVATE_KEY: keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  }),
);
const pid = '50000000-0000-4000-8000-000000000001';
const product = productResponse(
  {
    id: pid,
    businessId: ids.businessId,
    name: 'black tshirt',
    description: null,
    basePrice: { toFixed: () => '275.00' },
    options: { Size: ['L'] },
    colorOptionName: null,
    images: [
      {
        id: '70000000-0000-4000-8000-000000000001',
        productId: pid,
        publicId: 'fixture-not-a-real-cloudinary-upload',
        secureUrl:
          'https://res.cloudinary.com/test-cloud/image/upload/fixture.jpg',
        optionName: null,
        optionValue: null,
        width: 40,
        height: 30,
        bytes: 100,
        format: 'jpg',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    attributes: {},
    isActive: true,
    externalKey: 'LOCAL-FIXTURE',
    categoryId: null,
    category: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    variants: [
      {
        id: '60000000-0000-4000-8000-000000000001',
        businessId: ids.businessId,
        productId: pid,
        optionValues: { Size: 'L' },
        unitPrice: null,
        trackInventory: true,
        stockQuantity: 7,
        isActive: true,
      },
    ],
    _count: { variants: 1 },
  },
  true,
);
const history = {
  businessId: ids.businessId,
  customerId: ids.customerId,
  conversationId: ids.conversationId,
  beforeMessageId: ids.messageId,
  beforeMessageCreatedAt: m.createdAt,
  snapshot: 'synthetic-snapshot',
  order: 'createdAt_desc_id_desc',
  complete: true,
  pagination: {
    limit: 20,
    offset: 0,
    totalCount: 1,
    hasMore: false,
    nextOffset: null,
  },
  items: [
    {
      id: '40000000-0000-4000-8000-000000000001',
      conversationId: ids.conversationId,
      senderType: 'CUSTOMER',
      messageType: 'TEXT',
      content: 'black tshirt',
      createdAt: '2026-11-04T09:59:59.000Z',
    },
  ],
};
Object.create(AiService.prototype).history(history, m, {
  limit: 20,
  offset: 0,
});
for (const mutate of [
  (h) => { h.items[0].createdAt = m.createdAt; },
  (h) => { h.items[0].content = '\u{1F600}'.repeat(2001); },
  (h) => { h.items.push({ ...h.items[0], id: '30000000-0000-4000-8000-000000000001' }); },
]) {
  const unsafe = structuredClone(history);
  mutate(unsafe);
  assert.throws(() => Object.create(AiService.prototype).history(unsafe, m, { limit: 20, offset: 0 }));
}
const boundary = structuredClone(history);
boundary.items[0].content = '\u{1F600}'.repeat(2000);
Object.create(AiService.prototype).history(boundary, m, { limit: 20, offset: 0 });
const r = cp.spawnSync(
  python,
  ['-B', path.join(__dirname, 'ai-cross-contract.py')],
  {
    input: JSON.stringify({
      ids,
      body,
      token: security.issue(m, body),
      public: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      outbound,
      inbound,
      product,
      history,
    }),
    encoding: 'utf8',
    maxBuffer: 1048576,
    env: {
      ...process.env,
      BRANDORA_AI_SOURCE: aiDir,
      PYTHON_DOTENV_DISABLED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      AI_PROVIDER: 'rules',
      GROQ_API_KEY: '',
      GEMINI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      ENABLE_DEV_ENDPOINTS: 'false',
    },
  },
);
if (r.status !== 0) {
  console.error('Cross-contract check failed; credentials suppressed.');
  process.exit(1);
}
const v = JSON.parse(r.stdout.trim());
validateAiResponse(v.response);
assert(v.calls.includes('get_products'));
console.log(
  JSON.stringify(
    {
      nodeSignedRequestAcceptedByCurrentFastApi: true,
      nodeProductPresenterAcceptedByAiSchema: true,
      aiE03AcceptedByBackend: true,
      rawBodyTamperRejected: true,
      wrongDirectionalCredentialRejected: true,
      currentAiCheckoutOnly: true,
      backendAndAiRejectSourceTimestamp: true,
      backendAndAiRejectAmbiguousCustomerTies: true,
      sharedHistoryMaxCodePoints: 2000,
      aiHistoryCoverage: v.coverage,
      aiHistoryIssues: v.issues,
      networkRequests: 0,
      realPersistence: false,
    },
    null,
    2,
  ),
);
