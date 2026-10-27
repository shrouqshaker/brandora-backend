import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { InventoryModule } from '../../src/inventory/inventory.module';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Inventory public HTTP API (stateful mocked Prisma transactions)', () => {
  const businessId = 'c06a904b-14a7-4de7-98c9-9cac5bb4559b';
  const otherBusiness = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const itemId = 'b2621a53-0797-4b1d-84f9-5f9a41697f5c';
  const secondId = '9b7851f1-15ac-4ca3-a705-97e723825336';
  const foreignId = '1b7851f1-15ac-4ca3-a705-97e723825336';
  const missingId = '2b7851f1-15ac-4ca3-a705-97e723825336';
  const base = `/businesses/${businessId}/catalog-items/${itemId}/inventory`;
  const businessPath = `/businesses/${businessId}/inventory/movements`;
  const fields = [
    'id',
    'catalogItemId',
    'type',
    'quantityBefore',
    'quantityAfter',
    'quantityDelta',
    'referenceType',
    'referenceId',
    'createdAt',
  ].sort();
  let app: INestApplication;
  let items: any[];
  let movements: any[];
  let draftItems: any[];
  let draftMovements: any[];
  const tx = {
    catalogItem: { findFirst: jest.fn(), updateMany: jest.fn() },
    inventoryMovement: { create: jest.fn() },
  };
  const prisma = {
    business: { findUnique: jest.fn() },
    catalogItem: { findFirst: jest.fn(), updateMany: jest.fn() },
    inventoryMovement: {
      count: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const project = (row: any, select: Record<string, boolean>) =>
    Object.fromEntries(
      Object.entries(select)
        .filter(([, included]) => included)
        .map(([key]) => [key, row[key]]),
    );
  const movement = (id: string, overrides = {}) => ({
    id,
    businessId,
    catalogItemId: itemId,
    type: 'MANUAL_ADJUSTMENT',
    quantityBefore: 10,
    quantityAfter: 15,
    quantityDelta: 5,
    referenceType: null,
    referenceId: null,
    createdAt: new Date('2026-10-09T10:00:00Z'),
    private: 'hidden',
    ...overrides,
  });
  const matches = (row: any, where: any) =>
    row.businessId === where.businessId &&
    (where.catalogItemId === undefined ||
      row.catalogItemId === where.catalogItemId);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [InventoryModule],
    })
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
  beforeEach(() => {
    jest.resetAllMocks();
    movements = [];
    items = [
      {
        id: itemId,
        businessId,
        stockQuantity: 10,
        trackInventory: true,
        isActive: true,
      },
      {
        id: secondId,
        businessId,
        stockQuantity: null,
        trackInventory: false,
        isActive: false,
      },
      {
        id: foreignId,
        businessId: otherBusiness,
        stockQuantity: 5,
        trackInventory: true,
        isActive: true,
      },
    ];
    prisma.business.findUnique.mockImplementation(async ({ where }) =>
      [businessId, otherBusiness].includes(where.id) ? { id: where.id } : null,
    );
    prisma.catalogItem.findFirst.mockImplementation(
      async ({ where, select }) => {
        const item = items.find(
          (item) =>
            item.id === where.id && item.businessId === where.businessId,
        );
        return item ? project(item, select) : null;
      },
    );
    prisma.inventoryMovement.count.mockImplementation(
      async ({ where }) =>
        movements.filter((row) => matches(row, where)).length,
    );
    prisma.inventoryMovement.findMany.mockImplementation(
      async ({ where, select, take, skip }) =>
        movements
          .filter((row) => matches(row, where))
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.id.localeCompare(a.id),
          )
          .slice(skip, skip + take)
          .map((row) => project(row, select)),
    );
    tx.catalogItem.findFirst.mockImplementation(async ({ where }) => {
      const item = draftItems.find(
        (item) => item.id === where.id && item.businessId === where.businessId,
      );
      return item ? { stockQuantity: item.stockQuantity } : null;
    });
    tx.catalogItem.updateMany.mockImplementation(async ({ where, data }) => {
      const item = draftItems.find(
        (item) =>
          item.id === where.id &&
          item.businessId === where.businessId &&
          item.stockQuantity === where.stockQuantity,
      );
      if (!item) return { count: 0 };
      item.stockQuantity = data.stockQuantity;
      return { count: 1 };
    });
    tx.inventoryMovement.create.mockImplementation(async ({ data }) => {
      const row = movement('new-movement', data);
      draftMovements.push(row);
      return { id: row.id };
    });
    prisma.$transaction.mockImplementation(async (callback) => {
      draftItems = items.map((item) => ({ ...item }));
      draftMovements = movements.map((row) => ({ ...row }));
      const result = await callback(tx);
      items = draftItems;
      movements = draftMovements;
      return result;
    });
  });
  afterEach(() => {
    expect(prisma.catalogItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.inventoryMovement.create).not.toHaveBeenCalled();
    for (const [args] of tx.catalogItem.updateMany.mock.calls)
      expect(args.data).toEqual({ stockQuantity: expect.any(Number) });
  });
  afterAll(async () => {
    await app.close();
  });
  async function expectCode(call: request.Test, status: number, code: string) {
    const response = await call.expect(status);
    expect(response.body).toMatchObject({ statusCode: status, code });
    expect(Object.keys(response.body).sort()).toEqual([
      'code',
      'error',
      'message',
      'statusCode',
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/SQL|private|password/);
  }
  it('uses the existing transactional operation and creates a MANUAL_ADJUSTMENT audit', async () => {
    const response = await request(app.getHttpServer())
      .post(base + '/adjust')
      .send({ quantity: 15 })
      .expect(201);
    expect(response.body).toEqual({
      changed: true,
      quantityBefore: 10,
      quantityAfter: 15,
      quantityDelta: 5,
      movementId: 'new-movement',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.catalogItem.updateMany.mock.calls[0][0]).toEqual({
      where: { id: itemId, businessId, stockQuantity: 10 },
      data: { stockQuantity: 15 },
    });
    expect(tx.inventoryMovement.create.mock.calls[0][0].data).toEqual({
      businessId,
      catalogItemId: itemId,
      type: 'MANUAL_ADJUSTMENT',
      quantityBefore: 10,
      quantityAfter: 15,
      quantityDelta: 5,
      referenceType: null,
      referenceId: null,
    });
    expect(items[0].stockQuantity).toBe(15);
    expect(movements).toHaveLength(1);
  });
  it('accepts zero and records a negative delta without negative stock', async () => {
    const response = await request(app.getHttpServer())
      .post(base + '/adjust')
      .send({ quantity: 0 })
      .expect(201);
    expect(response.body).toMatchObject({
      quantityBefore: 10,
      quantityAfter: 0,
      quantityDelta: -10,
      changed: true,
    });
    expect(items[0].stockQuantity).toBe(0);
    expect(movements[0].type).toBe('MANUAL_ADJUSTMENT');
  });
  it('returns the no-op result without stock or audit writes', async () => {
    const response = await request(app.getHttpServer())
      .post(base + '/adjust')
      .send({ quantity: 10 })
      .expect(201);
    expect(response.body).toEqual({
      changed: false,
      quantityBefore: 10,
      quantityAfter: 10,
      quantityDelta: 0,
      movementId: null,
    });
    expect(tx.catalogItem.updateMany).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });
  it('initializes unknown stock to zero without toggling tracking or active state', async () => {
    const path = `/businesses/${businessId}/catalog-items/${secondId}/inventory/adjust`;
    const response = await request(app.getHttpServer())
      .post(path)
      .send({ quantity: 0 })
      .expect(201);
    expect(response.body).toMatchObject({
      changed: true,
      quantityBefore: null,
      quantityAfter: 0,
      quantityDelta: 0,
    });
    expect(items[1]).toMatchObject({
      stockQuantity: 0,
      trackInventory: false,
      isActive: false,
    });
    expect(movements).toHaveLength(1);
  });
  it.each([-1, 1.5, 2147483648, null, '15', true])(
    'rejects invalid quantity %j before opening a transaction',
    async (quantity) => {
      await expectCode(
        request(app.getHttpServer())
          .post(base + '/adjust')
          .send({ quantity }),
        400,
        'VALIDATION_ERROR',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { quantity: 15, reason: 'Recount' },
    { quantity: 15, trackInventory: true },
    { quantity: 15, type: 'IMPORT_UPDATE' },
    { quantity: 15, businessId: otherBusiness },
  ])('rejects missing quantity or unknown fields %j', async (body) => {
    await expectCode(
      request(app.getHttpServer())
        .post(base + '/adjust')
        .send(body),
      400,
      'VALIDATION_ERROR',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([missingId, foreignId])(
    'returns the same safe not-found error for inaccessible item %s',
    async (catalogItemId) => {
      const path = `/businesses/${businessId}/catalog-items/${catalogItemId}/inventory`;
      await expectCode(
        request(app.getHttpServer())
          .post(path + '/adjust')
          .send({ quantity: 15 }),
        404,
        'CATALOG_ITEM_NOT_FOUND',
      );
      await expectCode(
        request(app.getHttpServer()).get(path + '/movements'),
        404,
        'CATALOG_ITEM_NOT_FOUND',
      );
      expect(tx.catalogItem.updateMany).not.toHaveBeenCalled();
      expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
      expect(prisma.inventoryMovement.count).not.toHaveBeenCalled();
      expect(items[2].stockQuantity).toBe(5);
    },
  );
  it.each(['adjust', 'movements'])(
    'validates business/item UUIDs for %s',
    async (route) => {
      for (const path of [
        `/businesses/invalid/catalog-items/${itemId}/inventory/${route}`,
        `/businesses/${businessId}/catalog-items/invalid/inventory/${route}`,
      ]) {
        const call =
          route === 'adjust'
            ? request(app.getHttpServer()).post(path).send({ quantity: 15 })
            : request(app.getHttpServer()).get(path);
        await expectCode(call, 400, 'VALIDATION_ERROR');
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.catalogItem.findFirst).not.toHaveBeenCalled();
    },
  );
  it('preserves concurrency conflicts without creating or committing an audit', async () => {
    tx.catalogItem.updateMany.mockResolvedValue({ count: 0 });
    await expectCode(
      request(app.getHttpServer())
        .post(base + '/adjust')
        .send({ quantity: 15 }),
      409,
      'INVENTORY_CONFLICT',
    );
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    expect(items[0].stockQuantity).toBe(10);
    expect(movements).toEqual([]);
  });
  it('rolls back stock when movement creation fails and sanitizes the error', async () => {
    tx.inventoryMovement.create.mockRejectedValue(
      new Error('private SQL password'),
    );
    await expectCode(
      request(app.getHttpServer())
        .post(base + '/adjust')
        .send({ quantity: 15 }),
      500,
      'INTERNAL_SERVER_ERROR',
    );
    expect(items[0].stockQuantity).toBe(10);
    expect(movements).toEqual([]);
  });
  it.each(['item', 'business'])(
    'returns an empty scoped %s history envelope without writes',
    async (scope) => {
      const response = await request(app.getHttpServer())
        .get(scope === 'item' ? base + '/movements' : businessPath)
        .expect(200);
      expect(response.body).toEqual({
        pagination: {
          limit: 20,
          offset: 0,
          totalCount: 0,
          hasMore: false,
          nextOffset: null,
        },
        items: [],
      });
      expect(prisma.inventoryMovement.findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['item', 'business'])(
    'pages and orders %s history without leaking another business',
    async (scope) => {
      movements = [
        movement('a', { createdAt: new Date('2026-10-08') }),
        movement('b'),
        movement('c'),
        movement('foreign', {
          businessId: otherBusiness,
          catalogItemId: foreignId,
          createdAt: new Date('2026-10-10'),
        }),
        movement('second', {
          catalogItemId: secondId,
          createdAt: new Date('2026-10-07'),
        }),
      ];
      const path = scope === 'item' ? base + '/movements' : businessPath;
      const ids =
        scope === 'item' ? ['c', 'b', 'a'] : ['c', 'b', 'a', 'second'];
      const where =
        scope === 'item'
          ? { businessId, catalogItemId: itemId }
          : { businessId };
      for (let offset = 0; offset <= ids.length; offset++) {
        const response = await request(app.getHttpServer())
          .get(path)
          .query({ limit: 1, offset })
          .expect(200);
        expect(response.body.items.map((row: any) => row.id)).toEqual(
          ids.slice(offset, offset + 1),
        );
        expect(response.body.pagination).toEqual({
          limit: 1,
          offset,
          totalCount: ids.length,
          hasMore: offset < ids.length - 1,
          nextOffset: offset < ids.length - 1 ? offset + 1 : null,
        });
        for (const row of response.body.items)
          expect(Object.keys(row).sort()).toEqual(fields);
      }
      expect(prisma.inventoryMovement.count).toHaveBeenCalledWith({ where });
      expect(prisma.inventoryMovement.findMany.mock.calls[0][0]).toEqual({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        skip: 0,
        select: Object.fromEntries(fields.map((field) => [field, true])),
      });
      const final = await request(app.getHttpServer())
        .get(path)
        .query({ limit: 2, offset: ids.length - 1 })
        .expect(200);
      expect(final.body.items).toHaveLength(1);
      expect(final.body.pagination.hasMore).toBe(false);
      expect(final.body.pagination.nextOffset).toBeNull();
      const beyond = await request(app.getHttpServer())
        .get(path)
        .query({ offset: Number.MAX_SAFE_INTEGER })
        .expect(200);
      expect(beyond.body.items).toEqual([]);
      expect(beyond.body.pagination.totalCount).toBe(ids.length);
      expect(beyond.body.pagination.hasMore).toBe(false);
      expect(beyond.body.pagination.nextOffset).toBeNull();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['item', 'business'])(
    'uses the default 20-row limit for %s history',
    async (scope) => {
      movements = Array.from({ length: 25 }, (_, i) =>
        movement(String(i).padStart(2, '0')),
      );
      const response = await request(app.getHttpServer())
        .get(scope === 'item' ? base + '/movements' : businessPath)
        .expect(200);
      expect(response.body.items).toHaveLength(20);
      expect(response.body.pagination).toEqual({
        limit: 20,
        offset: 0,
        totalCount: 25,
        hasMore: true,
        nextOffset: 20,
      });
    },
  );
  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: 'bad' },
    { offset: -1 },
    { offset: 1.5 },
    { offset: 'bad' },
    { offset: '9007199254740992' },
    { unknown: 1 },
  ])('rejects invalid pagination %j for both histories', async (query) => {
    for (const path of [base + '/movements', businessPath])
      await expectCode(
        request(app.getHttpServer()).get(path).query(query),
        400,
        'VALIDATION_ERROR',
      );
    expect(prisma.inventoryMovement.count).not.toHaveBeenCalled();
    expect(prisma.inventoryMovement.findMany).not.toHaveBeenCalled();
  });
  it('handles missing/invalid business and scopes the other business correctly', async () => {
    await expectCode(
      request(app.getHttpServer()).get(
        `/businesses/${missingId}/inventory/movements`,
      ),
      404,
      'BUSINESS_NOT_FOUND',
    );
    await expectCode(
      request(app.getHttpServer()).get(
        '/businesses/invalid/inventory/movements',
      ),
      400,
      'VALIDATION_ERROR',
    );
    movements = [
      movement('own'),
      movement('foreign', {
        businessId: otherBusiness,
        catalogItemId: foreignId,
      }),
    ];
    const response = await request(app.getHttpServer())
      .get(`/businesses/${otherBusiness}/inventory/movements`)
      .expect(200);
    expect(response.body.items.map((row: any) => row.id)).toEqual(['foreign']);
    expect(response.body.pagination.totalCount).toBe(1);
  });
});
