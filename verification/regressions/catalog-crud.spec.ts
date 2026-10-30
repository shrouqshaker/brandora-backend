import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CatalogModule } from '../../src/catalog/catalog.module';
import { CatalogService } from '../../src/catalog/catalog.service';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Catalog metadata CRUD HTTP API (stateful mocked persistence)', () => {
  const businessId = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const otherBusiness = 'c06a904b-14a7-4de7-98c9-9cac5bb4559b';
  const id = 'b2621a53-0797-4b1d-84f9-5f9a41697f5c';
  const itemPath = `/catalog-items/${id}`;
  let app: INestApplication;
  let items: any[];
  const prisma = {
    catalogItem: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
    },
    inventoryMovement: {
      create: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const error = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('private database SQL', {
      code,
      clientVersion: '7',
    });
  const original = () => ({
    id,
    businessId,
    externalKey: 'SKU-1',
    name: 'Coffee',
    description: 'Old description',
    category: 'Drinks',
    basePrice: new Prisma.Decimal('49.90'),
    attributes: { material: 'Cotton', color: 'Blue' },
    isActive: true,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [CatalogModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    items = [original()];
    prisma.catalogItem.create.mockImplementation(async ({ data }) => {
      if (
        data.externalKey != null &&
        items.some(
          (item) =>
            item.businessId === data.businessId &&
            item.externalKey === data.externalKey,
        )
      )
        throw error('P2002');
      const item = {
        ...original(),
        id: 'new-id',
        externalKey: null,
        description: null,
        category: null,
        attributes: null,
        isActive: true,
        ...data,
      };
      if (item.attributes === Prisma.DbNull) item.attributes = null;
      items.push(item);
      return item;
    });
    prisma.catalogItem.findFirst.mockImplementation(
      async ({ where }) =>
        items.find(
          (item) =>
            item.id === where.id && item.businessId === where.businessId,
        ) ?? null,
    );
    prisma.catalogItem.findMany.mockImplementation(
      async ({ where, skip, take }) =>
        items
          .filter((item) => item.businessId === where.businessId)
          .slice(skip, skip + take),
    );
    prisma.catalogItem.update.mockImplementation(async ({ where, data }) => {
      const item = items.find(
        (item) => item.id === where.id && item.businessId === where.businessId,
      );
      if (!item) throw error('P2025');
      if (
        data.externalKey != null &&
        items.some(
          (other) =>
            other.id !== item.id &&
            other.businessId === item.businessId &&
            other.externalKey === data.externalKey,
        )
      )
        throw error('P2002');
      Object.assign(item, data);
      if (item.attributes === Prisma.DbNull) item.attributes = null;
      return item;
    });
  });
  afterEach(() => {
    for (const fn of [
      prisma.catalogItem.delete,
      prisma.catalogItem.deleteMany,
      prisma.catalogItem.updateMany,
      prisma.inventoryMovement.create,
      prisma.inventoryMovement.delete,
      prisma.inventoryMovement.deleteMany,
    ])
      expect(fn).not.toHaveBeenCalled();
    for (const [args] of [
      ...prisma.catalogItem.create.mock.calls,
      ...prisma.catalogItem.update.mock.calls,
    ]) {
      expect(args.data).not.toHaveProperty('stockQuantity');
      expect(args.data).not.toHaveProperty('trackInventory');
      expect(args.data).not.toHaveProperty('id');
      expect(args.data).not.toHaveProperty('createdAt');
      expect(args.data).not.toHaveProperty('updatedAt');
    }
  });
  const post = (body: object) =>
    request(app.getHttpServer()).post('/catalog-items').send(body);
  const patch = (body: object) =>
    request(app.getHttpServer()).patch(itemPath).send(body);
  async function expectCode(call: request.Test, status: number, code: string) {
    const response = await call.expect(status);
    expect(response.body).toMatchObject({ statusCode: status, code });
    expect(Object.keys(response.body).sort()).toEqual([
      'code',
      'error',
      'message',
      'statusCode',
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(
      /private database|P2002|P2025|SQL/,
    );
  }

  it('creates all approved metadata while preserving Decimal/default inventory behavior', async () => {
    const response = await post({
      businessId,
      externalKey: 'NEW',
      name: ' Coffee ',
      description: 'Fresh',
      category: 'Drinks',
      basePrice: '49.90',
      attributes: { material: 'Cotton', nested: { values: [1, true, null] } },
      isActive: false,
    }).expect(201);
    expect(response.body).toMatchObject({
      businessId,
      externalKey: 'NEW',
      name: 'Coffee',
      description: 'Fresh',
      category: 'Drinks',
      basePrice: '49.9',
      attributes: { material: 'Cotton', nested: { values: [1, true, null] } },
      isActive: false,
    });
  });
  it('accepts explicit nullable create metadata and maps attributes null to database null', async () => {
    const response = await post({
      businessId,
      name: 'Item',
      externalKey: null,
      description: null,
      category: null,
      basePrice: null,
      attributes: null,
    }).expect(201);
    expect(response.body).toMatchObject({
      externalKey: null,
      description: null,
      category: null,
      basePrice: null,
      attributes: null,
      isActive: true,
    });
    expect(prisma.catalogItem.create.mock.calls[0][0].data.attributes).toBe(
      Prisma.DbNull,
    );
  });
  it.each([
    ['  SKU-1  ', 'SKU-1'],
    ['', null],
    ['   ', null],
  ])(
    'normalizes Create externalKey %j to %j',
    async (externalKey, expected) => {
      items = [];
      const response = await post({
        businessId,
        name: 'Item',
        externalKey,
      }).expect(201);
      expect(response.body.externalKey).toBe(expected);
      expect(prisma.catalogItem.create.mock.calls[0][0].data.externalKey).toBe(
        expected,
      );
    },
  );
  it.each([
    ['  SKU-1  ', 'SKU-1'],
    ['', null],
    ['   ', null],
  ])(
    'normalizes PATCH externalKey %j to %j, clearing blank keys',
    async (externalKey, expected) => {
      const response = await patch({ businessId, externalKey }).expect(200);
      expect(response.body.externalKey).toBe(expected);
      expect(items[0].externalKey).toBe(expected);
      expect(prisma.catalogItem.update.mock.calls[0][0].data.externalKey).toBe(
        expected,
      );
    },
  );
  it('preserves Arabic owner text', async () => {
    const response = await post({
      businessId,
      name: 'تيشيرت أسود',
      description: 'قطن',
      category: 'ملابس',
      attributes: { color: 'أسود' },
    }).expect(201);
    expect(response.body).toMatchObject({
      name: 'تيشيرت أسود',
      description: 'قطن',
      category: 'ملابس',
      attributes: { color: 'أسود' },
    });
  });
  it('maps same-business duplicate keys to 409 on create and update, but permits cross-business keys', async () => {
    await expectCode(
      post({ businessId, externalKey: 'SKU-1', name: 'Other' }),
      409,
      'CATALOG_EXTERNAL_KEY_CONFLICT',
    );
    await post({
      businessId: otherBusiness,
      externalKey: 'SKU-1',
      name: 'Other',
    }).expect(201);
    items.push({ ...original(), id: 'second', externalKey: 'TAKEN' });
    await expectCode(
      patch({ businessId, externalKey: 'TAKEN', name: 'Do not apply' }),
      409,
      'CATALOG_EXTERNAL_KEY_CONFLICT',
    );
    expect(items[0].name).toBe('Coffee');
  });
  it('preserves BUSINESS_NOT_FOUND for missing business', async () => {
    prisma.catalogItem.create.mockRejectedValue(error('P2003'));
    await expectCode(
      post({ businessId, name: 'Item' }),
      404,
      'BUSINESS_NOT_FOUND',
    );
  });
  it.each([[], ['Cotton'], 'Cotton', 5, true])(
    'rejects non-object attributes %j with a domain code',
    async (attributes) => {
      await expectCode(
        post({ businessId, name: 'Item', attributes }),
        400,
        'CATALOG_ATTRIBUTES_INVALID',
      );
      await expectCode(
        patch({ businessId, attributes }),
        400,
        'CATALOG_ATTRIBUTES_INVALID',
      );
      expect(prisma.catalogItem.create).not.toHaveBeenCalled();
      expect(prisma.catalogItem.update).not.toHaveBeenCalled();
    },
  );
  it('rejects non-plain root objects in the internal service boundary', async () => {
    await expect(
      app
        .get(CatalogService)
        .create({ businessId, name: 'Item', attributes: new Date() as any }),
    ).rejects.toMatchObject({ code: 'CATALOG_ATTRIBUTES_INVALID' });
  });
  it.each([
    'stockQuantity',
    'trackInventory',
    'id',
    'createdAt',
    'updatedAt',
    'unknown',
  ])('rejects forbidden %s on create and patch', async (field) => {
    await expectCode(
      post({
        businessId,
        name: 'Item',
        [field]: field === 'trackInventory' ? true : 1,
      }),
      400,
      'VALIDATION_ERROR',
    );
    await expectCode(
      patch({ businessId, name: 'Item', [field]: 1 }),
      400,
      'VALIDATION_ERROR',
    );
    expect(prisma.catalogItem.create).not.toHaveBeenCalled();
    expect(prisma.catalogItem.update).not.toHaveBeenCalled();
  });
  it.each([
    { externalKey: 'x'.repeat(201) },
    { category: 'x'.repeat(201) },
    { description: 'x'.repeat(5001) },
    { externalKey: 7 },
    { category: 7 },
    { description: 7 },
    { basePrice: '-1' },
    { basePrice: '1.234' },
    { basePrice: 12.5 },
    { basePrice: '10000000000' },
    { isActive: null },
    { isActive: 'true' },
  ])('validates create and patch metadata %j', async (fields) => {
    await expectCode(
      post({ businessId, name: 'Item', ...fields }),
      400,
      'VALIDATION_ERROR',
    );
    await expectCode(patch({ businessId, ...fields }), 400, 'VALIDATION_ERROR');
  });
  it('lists active/inactive items with unchanged business scoping, pagination and array shape', async () => {
    items.push(
      { ...original(), id: 'inactive', isActive: false },
      { ...original(), id: 'other', businessId: otherBusiness },
    );
    const response = await request(app.getHttpServer())
      .get('/catalog-items')
      .query({ businessId })
      .expect(200);
    expect(response.body.map((item: any) => item.isActive)).toEqual([
      true,
      false,
    ]);
    expect(prisma.catalogItem.findMany).toHaveBeenCalledWith({
      where: { businessId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
      skip: 0,
    });
    await request(app.getHttpServer())
      .get('/catalog-items')
      .query({ businessId, limit: 1, offset: 1 })
      .expect(200);
    expect(prisma.catalogItem.findMany.mock.calls[1][0]).toMatchObject({
      take: 1,
      skip: 1,
    });
    await request(app.getHttpServer())
      .get('/catalog-items')
      .query({ businessId: '99999999-9999-4999-8999-999999999999' })
      .expect(200, []);
  });
  it('gets the current scoped item including inactive items', async () => {
    items[0].isActive = false;
    const response = await request(app.getHttpServer())
      .get(itemPath)
      .query({ businessId })
      .expect(200);
    expect(response.body).toMatchObject({
      id,
      businessId,
      basePrice: '49.9',
      isActive: false,
    });
    expect(prisma.catalogItem.findFirst).toHaveBeenCalledWith({
      where: { id, businessId },
    });
  });
  it('returns 404 for missing or cross-business reads, patches, and deactivation', async () => {
    await expectCode(
      request(app.getHttpServer())
        .get(itemPath)
        .query({ businessId: otherBusiness }),
      404,
      'CATALOG_ITEM_NOT_FOUND',
    );
    await expectCode(
      patch({ businessId: otherBusiness, name: 'Denied' }),
      404,
      'CATALOG_ITEM_NOT_FOUND',
    );
    await expectCode(
      request(app.getHttpServer())
        .delete(itemPath)
        .query({ businessId: otherBusiness }),
      404,
      'CATALOG_ITEM_NOT_FOUND',
    );
    expect(items[0]).toMatchObject({
      businessId,
      name: 'Coffee',
      isActive: true,
    });
    items = [];
    await expectCode(
      request(app.getHttpServer()).get(itemPath).query({ businessId }),
      404,
      'CATALOG_ITEM_NOT_FOUND',
    );
    await expectCode(
      patch({ businessId, name: 'Missing' }),
      404,
      'CATALOG_ITEM_NOT_FOUND',
    );
    await expectCode(
      request(app.getHttpServer()).delete(itemPath).query({ businessId }),
      404,
      'CATALOG_ITEM_NOT_FOUND',
    );
  });
  it.each(['get', 'patch', 'delete'] as const)(
    'validates %s item UUID and business UUID',
    async (method) => {
      const call = request(app.getHttpServer());
      const invalidItem =
        method === 'patch'
          ? call
              .patch('/catalog-items/invalid')
              .send({ businessId, name: 'Item' })
          : call[method]('/catalog-items/invalid').query({ businessId });
      await expectCode(invalidItem, 400, 'VALIDATION_ERROR');
      const invalidBusiness =
        method === 'patch'
          ? request(app.getHttpServer())
              .patch(itemPath)
              .send({ businessId: 'invalid', name: 'Item' })
          : request(app.getHttpServer())
              [method](itemPath)
              .query({ businessId: 'invalid' });
      await expectCode(invalidBusiness, 400, 'VALIDATION_ERROR');
      const missingBusiness =
        method === 'patch'
          ? patch({ name: 'Item' })
          : request(app.getHttpServer())[method](itemPath);
      await expectCode(missingBusiness, 400, 'VALIDATION_ERROR');
    },
  );
  it('updates all metadata atomically and replaces attributes without touching inventory', async () => {
    const response = await patch({
      businessId,
      name: ' New Name ',
      externalKey: 'NEW',
      description: 'New description',
      category: 'New category',
      basePrice: '123.45',
      attributes: { material: 'Linen' },
    }).expect(200);
    expect(response.body).toMatchObject({
      name: 'New Name',
      externalKey: 'NEW',
      description: 'New description',
      category: 'New category',
      basePrice: '123.45',
      attributes: { material: 'Linen' },
    });
    expect(response.body.attributes).not.toHaveProperty('color');
    expect(prisma.catalogItem.update.mock.calls[0][0].where).toEqual({
      id,
      businessId,
    });
  });
  it('preserves omitted metadata, clears nullable fields explicitly, and can replace attributes with an empty object', async () => {
    await patch({ businessId, name: 'Only name' }).expect(200);
    expect(items[0]).toMatchObject({
      externalKey: 'SKU-1',
      description: 'Old description',
      category: 'Drinks',
      attributes: { material: 'Cotton', color: 'Blue' },
    });
    await patch({ businessId, attributes: {} }).expect(200);
    expect(items[0].attributes).toEqual({});
    const response = await patch({
      businessId,
      externalKey: null,
      description: null,
      category: null,
      basePrice: null,
      attributes: null,
    }).expect(200);
    expect(response.body).toMatchObject({
      name: 'Only name',
      externalKey: null,
      description: null,
      category: null,
      basePrice: null,
      attributes: null,
    });
    expect(prisma.catalogItem.update.mock.calls[2][0].data.attributes).toBe(
      Prisma.DbNull,
    );
  });
  it.each([null, '', '   ', 12, 'x'.repeat(201)])(
    'rejects invalid PATCH name %j',
    async (name) => {
      await expectCode(patch({ businessId, name }), 400, 'VALIDATION_ERROR');
      expect(prisma.catalogItem.update).not.toHaveBeenCalled();
    },
  );
  it('rejects businessId-only PATCH without writes', async () => {
    await expectCode(patch({ businessId }), 400, 'VALIDATION_ERROR');
    expect(prisma.catalogItem.update).not.toHaveBeenCalled();
  });
  it('soft-deactivates idempotently and reactivates only through explicit PATCH', async () => {
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await request(app.getHttpServer())
        .delete(itemPath)
        .query({ businessId })
        .expect(200);
      expect(response.body).toMatchObject({
        id,
        isActive: false,
      });
    }
    expect(items).toHaveLength(1);
    expect(
      prisma.catalogItem.update.mock.calls.slice(0, 2).map(([args]) => args),
    ).toEqual([
      { where: { id, businessId }, data: { isActive: false } },
      { where: { id, businessId }, data: { isActive: false } },
    ]);
    const response = await patch({ businessId, isActive: true }).expect(200);
    expect(response.body).toMatchObject({
      isActive: true,
    });
  });
  it('retains inactive-item external keys under the same unique constraint', async () => {
    await request(app.getHttpServer())
      .delete(itemPath)
      .query({ businessId })
      .expect(200);
    await expectCode(
      post({ businessId, name: 'Replacement', externalKey: 'SKU-1' }),
      409,
      'CATALOG_EXTERNAL_KEY_CONFLICT',
    );
  });
  it('sanitizes unexpected persistence errors', async () => {
    prisma.catalogItem.update.mockRejectedValue(
      new Error('private database SQL'),
    );
    await expectCode(
      patch({ businessId, name: 'Item' }),
      500,
      'INTERNAL_SERVER_ERROR',
    );
  });
});
