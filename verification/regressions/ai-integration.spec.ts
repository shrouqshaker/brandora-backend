import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { AiModule } from '../../src/ai/ai.module';
import {
  AiConversationStore,
  UnavailableAiConversationStore,
} from '../../src/ai/ai-conversation.store';
import { AiSecurity } from '../../src/ai/ai-security';
import { AiService } from '../../src/ai/ai.service';
import { AuthGuard } from '../../src/auth/auth.guard';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ProductsService } from '../../src/products/products.service';
import { VariantsService } from '../../src/variants/variants.service';
import { BusinessesService } from '../../src/businesses/businesses.service';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';

const businessId = '10000000-0000-4000-8000-000000000001';
const otherBusiness = '10000000-0000-4000-8000-000000000002';
const conversationId = '20000000-0000-4000-8000-000000000001';
const customerId = '30000000-0000-4000-8000-000000000001';
const messageId = '40000000-0000-4000-8000-000000000002';
const productId = '50000000-0000-4000-8000-000000000001';
const variantId = '60000000-0000-4000-8000-000000000001';
const userId = '70000000-0000-4000-8000-000000000001';
const sessionId = '80000000-0000-4000-8000-000000000001';
const anchor = {
  businessId,
  customerId,
  conversationId,
  messageId,
  message: 'black shirt price',
  createdAt: '2026-01-01T10:00:00.000Z',
  senderType: 'CUSTOMER' as const,
  messageType: 'TEXT' as const,
};
const response = {
  intent: 'INQUIRY',
  reply: 'Recorded information',
  requiresReview: false,
  orderCandidate: null,
};
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();
const settings = {
  AI_INTEGRATION_ENABLED: 'true',
  AI_BASE_URL: 'https://ai.example.invalid',
  AI_CONTEXT_PRIVATE_KEY: privateKey,
  AI_SERVICE_TOKEN: 'synthetic-outbound-token-at-least-32-characters',
  BACKEND_SERVICE_TOKEN: 'synthetic-inbound-token-at-least-32-characters',
};

describe('Backend AI integration: real guards/controllers, synthetic persistence and no network', () => {
  let app: INestApplication;
  let fetchSpy: jest.SpyInstance;
  let owner: string;
  let security: AiSecurity;
  const store = {
    current: jest.fn(),
    historyBefore: jest.fn(),
    saveReply: jest.fn(),
  };
  const products = { list: jest.fn(), get: jest.fn() };
  const variants = { list: jest.fn(), get: jest.fn() };
  const businesses = { get: jest.fn(), settings: jest.fn(), hours: jest.fn() };
  const prisma = {
    user: { findUnique: jest.fn() },
    authSession: { findUnique: jest.fn() },
    businessMember: { findUnique: jest.fn() },
  };
  const jwt = new JwtService({
    secret: 'synthetic-owner-jwt-secret-with-enough-length',
  });
  const body = () =>
    JSON.stringify({
      businessId,
      customerId,
      conversationId,
      messageId,
      message: anchor.message,
    });
  const context = () => security.issue(anchor, body());
  const tool = (
    name: string,
    args: object = {},
    token = context(),
    credential = 'Bearer ' + settings.BACKEND_SERVICE_TOKEN,
  ) =>
    request(app.getHttpServer())
      .post('/internal/ai/data')
      .set('Authorization', credential)
      .set('X-AI-Context', token)
      .send({ tool: name, arguments: args });
  const respond = () =>
    request(app.getHttpServer())
      .post(`/businesses/${businessId}/ai/respond`)
      .set('Authorization', 'Bearer ' + owner)
      .send({ conversationId, messageId });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        AiModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService(settings))
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AiConversationStore)
      .useValue(store)
      .overrideProvider(ProductsService)
      .useValue(products)
      .overrideProvider(VariantsService)
      .useValue(variants)
      .overrideProvider(BusinessesService)
      .useValue(businesses)
      .compile();
    app = module.createNestApplication();
    app.useGlobalGuards(
      new AuthGuard(new Reflector(), jwt, prisma as unknown as PrismaService),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    await app.init();
    security = app.get(AiSecurity);
    owner = await jwt.signAsync(
      { sub: userId, sid: sessionId, ver: 0 },
      { expiresIn: 900 },
    );
  });
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ id: userId, authVersion: 0 });
    prisma.authSession.findUnique.mockResolvedValue({
      userId,
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
    });
    prisma.businessMember.findUnique.mockImplementation(async ({ where }) =>
      where.userId_businessId.businessId === businessId
        ? { role: 'OWNER', isActive: true }
        : null,
    );
    store.current.mockResolvedValue({ ...anchor });
    store.saveReply.mockImplementation(async (_m, result) => result);
    products.list.mockResolvedValue({
      items: [],
      pagination: {
        limit: 20,
        offset: 0,
        totalCount: 0,
        hasMore: false,
        nextOffset: null,
      },
    });
    products.get.mockResolvedValue({
      id: productId,
      businessId,
      isActive: true,
      basePrice: '0.00',
      options: {},
      variants: [],
    });
    variants.get.mockResolvedValue({
      id: variantId,
      businessId,
      productId: productId,
      catalogItemId: productId,
      isActive: true,
      unitPrice: null,
      effectivePrice: '0.00',
      trackInventory: true,
      stockQuantity: 0,
    });
    variants.list.mockResolvedValue({
      items: [],
      pagination: {
        limit: 20,
        offset: 0,
        totalCount: 0,
        hasMore: false,
        nextOffset: null,
      },
    });
    businesses.get.mockResolvedValue({ id: businessId, name: 'Store' });
    businesses.settings.mockResolvedValue({ acceptsCash: true });
    businesses.hours.mockResolvedValue([]);
    store.historyBefore.mockImplementation(async (_m, limit, offset) => ({
      businessId,
      customerId,
      conversationId,
      beforeMessageId: messageId,
      beforeMessageCreatedAt: anchor.createdAt,
      snapshot: 'immutable-test-snapshot',
      order: 'createdAt_desc_id_desc',
      complete: true,
      pagination: {
        limit,
        offset,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
      },
      items: [
        {
          id: '40000000-0000-4000-8000-000000000001',
          conversationId,
          senderType: 'CUSTOMER',
          messageType: 'TEXT',
          content: 'Earlier selection',
          createdAt: '2026-01-01T09:59:00.000Z',
        },
      ],
    }));
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(response)));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  afterAll(async () => {
    await app.close();
  });

  it('loads the persisted message, signs exact minimal bytes and validates/persists E0-3', async () => {
    expect((await respond()).status).toBe(200);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://ai.example.invalid/v2/ai/respond');
    expect(options.redirect).toBe('error');
    expect(options.headers['X-Internal-Token']).toBe(settings.AI_SERVICE_TOKEN);
    expect(JSON.parse(options.body)).toEqual(JSON.parse(body()));
    expect(JSON.parse(options.body)).not.toHaveProperty('history');
    const claims = security.authenticate(
      'Bearer ' + settings.BACKEND_SERVICE_TOKEN,
      options.headers['X-AI-Context'],
    );
    expect(claims).toMatchObject({
      businessId,
      customerId,
      conversationId,
      messageId,
      aud: 'brandora-ai-tools-v1',
    });
    expect(store.saveReply).toHaveBeenCalledWith(anchor, response);
  });
  it('requires owner authentication and hides cross-business access', async () => {
    await request(app.getHttpServer())
      .post(`/businesses/${businessId}/ai/respond`)
      .send({ conversationId, messageId })
      .expect(401);
    await request(app.getHttpServer())
      .post(`/businesses/${otherBusiness}/ai/respond`)
      .set('Authorization', 'Bearer ' + owner)
      .send({ conversationId, messageId })
      .expect(404);
    expect(store.current).not.toHaveBeenCalled();
  });
  it.each([
    { message: 'client text' },
    { history: [] },
    { businessId: otherBusiness },
  ])('rejects client-supplied data beyond stored IDs: %j', async (extra) => {
    await request(app.getHttpServer())
      .post(`/businesses/${businessId}/ai/respond`)
      .set('Authorization', 'Bearer ' + owner)
      .send({ conversationId, messageId, ...extra })
      .expect(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each(['', 'Bearer wrong', 'Bearer ' + settings.AI_SERVICE_TOKEN])(
    'rejects wrong-direction or missing S2S credentials: %s',
    async (credential) => {
      expect(
        (await tool('get_products', {}, context(), credential)).status,
      ).toBe(401);
      expect(store.current).not.toHaveBeenCalled();
    },
  );
  it('rejects tampered and expired context tokens before reads', async () => {
    const token = context().split('.');
    token[1] = Buffer.from(
      JSON.stringify({ businessId: otherBusiness }),
    ).toString('base64url');
    expect((await tool('get_products', {}, token.join('.'))).status).toBe(401);
    const valid = context();
    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 61000);
    expect((await tool('get_products', {}, valid)).status).toBe(401);
    expect(products.list).not.toHaveBeenCalled();
  });
  it('denies changed current-message content and cross-customer scope', async () => {
    const token = context();
    store.current.mockResolvedValue({ ...anchor, message: 'changed' });
    expect((await tool('get_products', {}, token)).status).toBe(401);
    store.current.mockResolvedValue({ ...anchor, customerId: otherBusiness });
    expect((await tool('get_products', {}, token)).status).toBe(401);
  });
  it.each([
    { businessId: otherBusiness },
    { limit: 101 },
    { offset: -1 },
    { url: 'https://other.invalid' },
  ])('rejects scope/URL and invalid pagination arguments: %j', async (args) => {
    expect((await tool('get_products', args)).status).toBe(400);
    expect(products.list).not.toHaveBeenCalled();
  });
  it('dispatches the six read-only tools through existing scoped services', async () => {
    expect((await tool('get_products')).body.data.items).toEqual([]);
    expect(products.list).toHaveBeenCalledWith(businessId, {
      limit: 20,
      offset: 0,
    });
    expect(
      (await tool('get_product_details', { productId })).body.data.basePrice,
    ).toBe('0.00');
    expect(products.get).toHaveBeenCalledWith(businessId, productId);
    await tool('get_product_variants', {
      productId,
      limit: 1,
      offset: 2,
    }).expect(200);
    expect(variants.list).toHaveBeenCalledWith(businessId, productId, {
      limit: 1,
      offset: 2,
    });
    const result = await tool('get_variant_details', { productId, variantId });
    expect(result.body.data).toMatchObject({
      effectivePrice: '0.00',
      trackInventory: true,
      stockQuantity: 0,
    });
    expect(variants.get).toHaveBeenCalledWith(businessId, productId, variantId);
    expect((await tool('get_business_info')).body.data).toMatchObject({
      business: { id: businessId },
      settings: { acceptsCash: true },
      workingHours: [],
    });
    expect(
      (await tool('get_conversation_history', { conversationId })).body.data
        .items,
    ).toHaveLength(1);
  });
  it('passes approved Product image metadata through read-only tools without image management tools', async () => {
    const images = [
      {
        id: variantId,
        productId,
        secureUrl:
          'https://res.cloudinary.com/test-cloud/image/upload/fixture.jpg',
        optionName: null,
        optionValue: null,
      },
    ];
    products.get.mockResolvedValue({
      id: productId,
      businessId,
      colorOptionName: null,
      images,
    });
    expect(
      (await tool('get_product_details', { productId })).body.data.images,
    ).toEqual(images);
    expect((await tool('upload_product_image', { productId })).status).toBe(
      400,
    );
    expect((await tool('delete_product_image', { productId })).status).toBe(
      400,
    );
  });
  it.each([null, '0.00', '275.00'])(
    'preserves exact variant price/stock observations: %s',
    async (price) => {
      variants.get.mockResolvedValue({
        effectivePrice: price,
        trackInventory: false,
        stockQuantity: null,
        isActive: false,
      });
      expect(
        (await tool('get_variant_details', { productId, variantId })).body.data,
      ).toEqual({
        effectivePrice: price,
        trackInventory: false,
        stockQuantity: null,
        isActive: false,
      });
    },
  );
  it('does not hide inactive records or fabricate missing product details', async () => {
    products.get.mockResolvedValueOnce({ id: productId, isActive: false });
    expect(
      (await tool('get_product_details', { productId })).body.data.isActive,
    ).toBe(false);
    products.get.mockRejectedValueOnce(new Error('private database details'));
    const result = await tool('get_product_details', { productId });
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain('private');
  });
  it('denies another conversation before fetching history', async () => {
    expect(
      (
        await tool('get_conversation_history', {
          conversationId: otherBusiness,
        })
      ).status,
    ).toBe(401);
    expect(store.historyBefore).not.toHaveBeenCalled();
  });
  it.each([
    'current',
    'duplicate',
    'unordered',
    'future',
    'wrong-business',
    'source-timestamp',
    'customer-tie',
    'oversized-content',
  ])('rejects unsafe history: %s', async (condition) => {
    const data = await store.historyBefore(anchor, 20, 0);
    if (condition === 'current') data.items[0].id = messageId;
    if (condition === 'duplicate') data.items.push({ ...data.items[0] });
    if (condition === 'unordered')
      data.items.push({
        ...data.items[0],
        id: messageId,
        createdAt: '2026-01-01T09:59:30.000Z',
      });
    if (condition === 'future')
      data.items[0].createdAt = '2026-01-01T10:01:00.000Z';
    if (condition === 'wrong-business') data.businessId = otherBusiness;
    if (condition === 'source-timestamp') {
      data.items[0].id = '40000000-0000-4000-8000-000000000001';
      data.items[0].createdAt = anchor.createdAt;
    }
    if (condition === 'customer-tie') {
      data.items[0].senderType = 'CUSTOMER';
      data.items.push({
        ...data.items[0],
        id: '10000000-0000-4000-8000-000000000000',
      });
    }
    if (condition === 'oversized-content')
      data.items[0].content = '\u{1F600}'.repeat(2001);
    store.historyBefore.mockResolvedValue(data);
    expect(
      (await tool('get_conversation_history', { conversationId })).status,
    ).toBe(503);
  });
  it('accepts exactly 2000 Unicode code points in history content', async () => {
    const data = await store.historyBefore(anchor, 20, 0);
    data.items[0].content = '\u{1F600}'.repeat(2000);
    store.historyBefore.mockResolvedValue(data);
    expect(
      (await tool('get_conversation_history', { conversationId })).status,
    ).toBe(200);
  });
  it.each([
    { ...response, price: '9.00' },
    { ...response, orderCandidate: { sourceMessageId: messageId } },
    { ...response, intent: 'CONFIRMED_ORDER' },
    { ...response, intent: ['INQUIRY'] },
  ])(
    'rejects unsafe E0-3 responses without persistence: %j',
    async (result) => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(result)));
      expect((await respond()).status).toBe(503);
      expect(store.saveReply).not.toHaveBeenCalled();
    },
  );
  it.each([401, 429, 500, 503])(
    'sanitizes provider HTTP %s without persistence',
    async (status) => {
      fetchSpy.mockResolvedValue(
        new Response('private upstream body', { status }),
      );
      const result = await respond();
      expect(result.status).toBe(503);
      expect(JSON.stringify(result.body)).not.toContain('private');
      expect(store.saveReply).not.toHaveBeenCalled();
    },
  );
  it('bounds response bytes and HTTPS wait, including the body', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('x'.repeat(65537)));
    expect((await respond()).status).toBe(503);
    jest.useFakeTimers();
    fetchSpy.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () =>
            reject(new Error('private timeout')),
          ),
        ),
    );
    const result = app
      .get(AiService)
      .respond(businessId, { conversationId, messageId });
    const assertion = expect(result).rejects.toMatchObject({ status: 503 });
    await jest.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(store.saveReply).not.toHaveBeenCalled();
  });
  it('fails closed until the conversations-team persistence adapter is supplied', async () => {
    await expect(
      new UnavailableAiConversationStore().current(),
    ).rejects.toMatchObject({ status: 503 });
    const disabled = new AiSecurity(new ConfigService({}));
    expect(() => disabled.settings()).toThrow('unavailable');
  });
});
