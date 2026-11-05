import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AuthGuard } from '../../src/auth/auth.guard';
import { Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';

describe('Products is the sole product CRUD API (real application modules)', () => {
  const businessId = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const otherBusiness = 'c06a904b-14a7-4de7-98c9-9cac5bb4559b';
  const id = 'b2621a53-0797-4b1d-84f9-5f9a41697f5c';
  const base = `/businesses/${businessId}/products`;
  let app: INestApplication;
  let item: any;
  let variants: any[];
  const prisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    business: { findUnique: jest.fn() },
    product: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    productVariant: { create: jest.fn(), groupBy: jest.fn() },
    inventoryMovement: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const responseRow = () => ({
    ...item,
    variants: [...variants],
    _count: { variants: variants.length },
  });
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    jest.resetAllMocks();
    item = {
      id,
      businessId,
      name: 'Existing import product',
      externalKey: 'IMPORT-1',
      category: 'legacy category',
      categoryId: null,
      description: 'Original',
      basePrice: new Prisma.Decimal('49.90'),
      attributes: { old: true },
      options: {},
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    variants = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        businessId,
        productId: id,
        optionValues: {},
        unitPrice: null,
        isActive: true,
        trackInventory: true,
        stockQuantity: 7,
      },
    ];
    prisma.$transaction.mockImplementation(async (work) => work(prisma));
    prisma.$queryRaw.mockResolvedValue([{ id }]);
    prisma.business.findUnique.mockResolvedValue({ id: businessId });
    prisma.product.findFirst.mockImplementation(async ({ where }) =>
      where.id === item.id && where.businessId === item.businessId
        ? responseRow()
        : null,
    );
    prisma.product.findMany.mockImplementation(async () => [responseRow()]);
    prisma.product.count.mockResolvedValue(1);
    prisma.product.create.mockImplementation(async ({ data }) => {
      item = {
        ...item,
        externalKey: null,
        category: null,
        ...Object.fromEntries(
          Object.entries(data).filter(([, value]) => value !== undefined),
        ),
      };
      return { ...item };
    });
    prisma.product.update.mockImplementation(async ({ data }) => {
      Object.assign(item, data);
      return { ...item };
    });
    prisma.productVariant.create.mockImplementation(async ({ data }) => {
      const created = {
        id: '22222222-2222-4222-8222-222222222222',
        isActive: true,
        unitPrice: null,
        optionValues: {},
        ...data,
      };
      variants.push(created);
      return created;
    });
    prisma.productVariant.groupBy.mockImplementation(async () =>
      item.basePrice === null ? [] : [{ productId: id }],
    );
  });

  it.each(['get', 'post', 'patch', 'delete'] as const)(
    'removed Catalog collection does not expose %s or an alias',
    async (method) => {
      const result = await request(app.getHttpServer())
        [method]('/catalog-items')
        .query({ businessId })
        .send({ businessId, name: 'Obsolete' })
        .expect(404);
      expect(result.headers.location).toBeUndefined();
      expect(prisma.product.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    },
  );
  it.each(['get', 'post', 'patch', 'delete'] as const)(
    'removed Catalog item does not expose %s or an alias',
    async (method) => {
      await request(app.getHttpServer())
        [method](`/catalog-items/${id}`)
        .query({ businessId })
        .send({ businessId, name: 'Obsolete' })
        .expect(404);
    },
  );

  it('creates Arabic product metadata and its Default Variant through Products using Product persistence', async () => {
    variants = [];
    const response = await request(app.getHttpServer())
      .post(base)
      .send({
        name: '  تيشيرت أسود  ',
        description: 'قطن',
        basePrice: '49.90',
        attributes: { color: 'أسود', nested: { values: [1, true] } },
      })
      .expect(201);
    expect(response.body).toMatchObject({
      name: 'تيشيرت أسود',
      description: 'قطن',
      basePrice: '49.90',
      externalKey: null,
      attributes: { color: 'أسود', nested: { values: [1, true] } },
      variants: [{ optionValues: {}, effectivePrice: '49.90' }],
      isSellable: true,
    });
    expect(prisma.product.create).toHaveBeenCalledTimes(1);
    expect(prisma.productVariant.create).toHaveBeenCalledTimes(1);
  });
  it('lists existing import metadata in the canonical paginated Products response with default bounds', async () => {
    const response = await request(app.getHttpServer()).get(base).expect(200);
    expect(response.body).toMatchObject({
      pagination: { limit: 20, offset: 0, totalCount: 1 },
      items: [
        {
          id,
          externalKey: 'IMPORT-1',
          category: 'legacy category',
          basePrice: '49.90',
        },
      ],
    });
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId },
        take: 20,
        skip: 0,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });
  it('assigns, preserves and explicitly clears a manual product import identity through Products', async () => {
    const assigned = await request(app.getHttpServer())
      .patch(`${base}/${id}`)
      .send({ externalKey: '  MANUAL-001  ' })
      .expect(200);
    expect(assigned.body.externalKey).toBe('MANUAL-001');
    await request(app.getHttpServer())
      .patch(`${base}/${id}`)
      .send({ name: 'Updated' })
      .expect(200);
    expect(item.externalKey).toBe('MANUAL-001');
    await request(app.getHttpServer())
      .patch(`${base}/${id}`)
      .send({ externalKey: null })
      .expect(200);
    expect(item.externalKey).toBeNull();
    await request(app.getHttpServer())
      .patch(`${base}/${id}`)
      .send({ externalKey: '   ' })
      .expect(200);
    expect(item.externalKey).toBeNull();
  });
  it.each(['post', 'patch'] as const)(
    'returns a sanitized 409 for an externalKey conflict on %s',
    async (method) => {
      const error = new Prisma.PrismaClientKnownRequestError(
        'private unique constraint details',
        {
          code: 'P2002',
          clientVersion: '7',
          meta: { target: ['businessId', 'externalKey'] },
        },
      );
      (method === 'post'
        ? prisma.product.create
        : prisma.product.update
      ).mockRejectedValueOnce(error);
      const response = await request(app.getHttpServer())
        [method](method === 'post' ? base : `${base}/${id}`)
        .send({ name: 'Manual', externalKey: 'TAKEN' })
        .expect(409);
      expect(response.body).toMatchObject({
        code: 'PRODUCT_EXTERNAL_KEY_CONFLICT',
        statusCode: 409,
      });
      expect(JSON.stringify(response.body)).not.toMatch(/private|P2002/);
    },
  );
  it('replaces metadata, clears nullable fields, soft-deletes and reactivates without changing import identity or stock', async () => {
    const stockBefore = structuredClone(variants);
    await request(app.getHttpServer())
      .patch(`${base}/${id}`)
      .send({
        name: 'Changed',
        description: null,
        basePrice: null,
        categoryId: null,
        attributes: {},
      })
      .expect(200);
    expect(item).toMatchObject({
      name: 'Changed',
      description: null,
      basePrice: null,
      attributes: {},
      externalKey: 'IMPORT-1',
      category: 'legacy category',
    });
    await request(app.getHttpServer()).delete(`${base}/${id}`).expect(204, '');
    const inactive = await request(app.getHttpServer())
      .get(`${base}/${id}`)
      .expect(200);
    expect(inactive.body).toMatchObject({ id, isActive: false });
    await request(app.getHttpServer())
      .patch(`${base}/${id}`)
      .send({ isActive: true })
      .expect(200);
    expect(item.isActive).toBe(true);
    expect(variants).toEqual(stockBefore);
    expect(prisma.product.delete).not.toHaveBeenCalled();
    for (const mutation of Object.values(prisma.inventoryMovement))
      expect(mutation).not.toHaveBeenCalled();
  });
  it.each(['get', 'patch', 'delete'] as const)(
    'scopes %s to the selected business',
    async (method) => {
      await request(app.getHttpServer())
        [method](`/businesses/${otherBusiness}/products/${id}`)
        .send(method === 'patch' ? { name: 'Forbidden' } : undefined)
        .expect(404);
      expect(prisma.product.update).not.toHaveBeenCalled();
    },
  );
  it.each(['category', 'stockQuantity', 'trackInventory'])(
    'keeps %s outside writable Product metadata',
    async (field) => {
      await request(app.getHttpServer())
        .patch(`${base}/${id}`)
        .send({ [field]: 'forbidden' })
        .expect(400);
      expect(prisma.product.update).not.toHaveBeenCalled();
    },
  );
});
