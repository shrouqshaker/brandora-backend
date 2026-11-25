import { InventoryService } from '../../src/inventory/inventory.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { Prisma } from '../../src/generated/prisma/client';
import { ProductAccessService } from '../../src/products/product-access.service';
import { ProductsModule } from '../../src/products/products.module';
import { InventoryModule } from '../../src/inventory/inventory.module';
import { AppModule } from '../../src/app.module';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import request from 'supertest';

describe('Variant inventory transaction boundaries', () => {
  const scope = {
    businessId: 'business',
    productId: 'product',
    id: 'variant',
  };
  let service: InventoryService, tx: any, prisma: any;
  beforeEach(() => {
    tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ id: 'product', isActive: true }]),
      productVariant: {
        findFirst: jest.fn().mockResolvedValue({
          stockQuantity: 10,
          trackInventory: true,
          isActive: true,
        }),
        update: jest.fn(),
      },
      inventoryMovement: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(async ({ data }) => ({
          ...data,
          id: 'movement',
        })),
      },
    };
    prisma = {
      $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
    };
    service = new InventoryService(
      prisma as PrismaService,
      new ProductAccessService(prisma as PrismaService),
    );
  });
  it('locks the parent and writes only scoped variant inventory and its audit', async () => {
    const r = await service.setQuantity(scope, 15);
    expect(r).toEqual({
      changed: true,
      quantityBefore: 10,
      quantityAfter: 15,
      quantityDelta: 5,
      movementId: 'movement',
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.productVariant.update).toHaveBeenCalledWith({
      where: scope,
      data: { stockQuantity: 15, trackInventory: true },
    });
    expect(tx.inventoryMovement.create.mock.calls[0][0].data).toMatchObject({
      businessId: 'business',
      productId: 'product',
      variantId: 'variant',
      trackingBefore: true,
      trackingAfter: true,
      quantityDelta: 5,
    });
  });
  it('does not create an unnecessary manual no-op movement', async () => {
    expect((await service.setQuantity(scope, 10)).changed).toBe(false);
    expect(tx.productVariant.update).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });
  it.each([-1, 1.5, NaN, Infinity, 2147483648, null, '10'])(
    'rejects invalid stock %s before opening transaction',
    async (value) => {
      await expect(
        service.setQuantity(scope, value as number),
      ).rejects.toMatchObject({ code: 'INVENTORY_QUANTITY_INVALID' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects order type through absolute stock setter', async () => {
    await expect(
      service.setQuantity(scope, 3, 'ORDER_APPROVED'),
    ).rejects.toMatchObject({ code: 'INVENTORY_MOVEMENT_TYPE_INVALID' });
  });
  it.each([
    { type: '', id: 'x' },
    { type: 'x', id: ' ' },
    { type: 'x'.repeat(51), id: 'x' },
    { type: 'x', id: 'x'.repeat(201) },
  ])('rejects invalid references %j', async (reference) => {
    await expect(
      service.setQuantity(scope, 3, 'IMPORT_UPDATE', reference),
    ).rejects.toMatchObject({ code: 'INVENTORY_REFERENCE_INVALID' });
  });
  it('enables previously untracked stock with an audit', async () => {
    tx.productVariant.findFirst.mockResolvedValue({
      stockQuantity: null,
      trackInventory: false,
      isActive: true,
    });
    expect(await service.setQuantity(scope, 0)).toMatchObject({
      changed: true,
      quantityBefore: null,
      quantityAfter: 0,
      quantityDelta: 0,
    });
  });
  it('disables tracking explicitly and rejects discarded non-null stock', async () => {
    await expect(
      service.setQuantity(
        scope,
        4,
        'MANUAL_ADJUSTMENT',
        undefined,
        undefined,
        false,
      ),
    ).rejects.toMatchObject({ code: 'INVENTORY_QUANTITY_INVALID' });
    expect(
      await service.setQuantity(
        scope,
        null,
        'MANUAL_ADJUSTMENT',
        undefined,
        undefined,
        false,
      ),
    ).toMatchObject({ quantityBefore: 10, quantityAfter: null });
  });
  it('reuses a caller transaction without nesting', async () => {
    await service.setQuantity(
      scope,
      15,
      'IMPORT_UPDATE',
      undefined,
      tx as Prisma.TransactionClient,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('propagates failed audit creation for caller rollback', async () => {
    tx.inventoryMovement.create.mockRejectedValue(new Error('Audit failed'));
    await expect(service.setQuantity(scope, 15)).rejects.toThrow(
      'Audit failed',
    );
  });
  it.each(['parent', 'variant'])(
    'rejects inactive %s before stock writes',
    async (target) => {
      if (target === 'parent')
        tx.$queryRaw.mockResolvedValue([{ isActive: false }]);
      else tx.productVariant.findFirst.mockResolvedValue({ isActive: false });
      await expect(service.setQuantity(scope, 2)).rejects.toMatchObject({
        code: 'INVENTORY_INACTIVE',
      });
      expect(tx.productVariant.update).not.toHaveBeenCalled();
    },
  );
  it('does not use an unscoped or missing variant', async () => {
    tx.productVariant.findFirst.mockResolvedValue(null);
    await expect(service.setQuantity(scope, 2)).rejects.toMatchObject({
      code: 'VARIANT_NOT_FOUND',
    });
  });
  it('idempotent import reference cannot reapply absolute stock after later writes', async () => {
    tx.inventoryMovement.findFirst.mockResolvedValue({
      id: 'prior',
      quantityBefore: 5,
      quantityAfter: 8,
      quantityDelta: 3,
      trackingAfter: true,
    });
    expect(
      await service.setQuantity(scope, 8, 'IMPORT_UPDATE', {
        type: 'IMPORT_ROW',
        id: 'row',
      }),
    ).toMatchObject({ changed: false, movementId: 'prior' });
    expect(tx.productVariant.update).not.toHaveBeenCalled();
  });
  it('deduction uses current stock and refuses overselling', async () => {
    await expect(
      service.deductForOrder(tx, scope, 11, 'line'),
    ).rejects.toMatchObject({ code: 'INVENTORY_INSUFFICIENT_STOCK' });
    expect(await service.deductForOrder(tx, scope, 4, 'line')).toMatchObject({
      quantityAfter: 6,
      quantityDelta: -4,
    });
  });
  it('restoration requires its original order line and quantity', async () => {
    await expect(
      service.restoreForOrder(tx, scope, 2, 'line'),
    ).rejects.toMatchObject({ code: 'INVENTORY_CONFLICT' });
  });
  it('untracked orders still create a persistent idempotency audit', async () => {
    tx.productVariant.findFirst.mockResolvedValue({
      isActive: true,
      trackInventory: false,
      stockQuantity: null,
    });
    expect(await service.deductForOrder(tx, scope, 2, 'line')).toMatchObject({
      changed: false,
      quantityAfter: null,
      movementId: 'movement',
    });
    expect(
      tx.inventoryMovement.create.mock.calls[0][0].data.requestedQuantity,
    ).toBe(2);
  });
});

describe('Business inventory movement access (real modules and authorization)', () => {
  const businessId = '11111111-1111-4111-8111-111111111111';
  const otherBusinessId = '22222222-2222-4222-8222-222222222222';
  const userId = '33333333-3333-4333-8333-333333333333';
  const productId = '44444444-4444-4444-8444-444444444444';
  const variantId = '88888888-8888-4888-8888-888888888888';
  const base = `/businesses/${businessId}/inventory/movements`;
  const fields = [
    'id',
    'productId',
    'variantId',
    'type',
    'quantityBefore',
    'quantityAfter',
    'quantityDelta',
    'trackingBefore',
    'trackingAfter',
    'requestedQuantity',
    'referenceType',
    'referenceId',
    'createdAt',
  ];
  const select = Object.fromEntries(fields.map((field) => [field, true]));
  const owned = {
    id: '66666666-6666-4666-8666-666666666666',
    productId,
    variantId,
    type: 'MANUAL_ADJUSTMENT',
    quantityBefore: 3,
    quantityAfter: 5,
    quantityDelta: 2,
    trackingBefore: true,
    trackingAfter: true,
    requestedQuantity: null,
    referenceType: null,
    referenceId: null,
    createdAt: '2026-01-02T00:00:00.000Z',
  };
  const tx = {
    business: { findUnique: jest.fn() },
    inventoryMovement: { count: jest.fn(), findMany: jest.fn() },
  };
  const root = {
    $transaction: jest.fn(),
    business: { findUnique: jest.fn() },
    inventoryMovement: { count: jest.fn(), findMany: jest.fn() },
    productVariant: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    authSession: { findUnique: jest.fn() },
    businessMember: { findUnique: jest.fn() },
  };
  let app: INestApplication, token: string, jwt: JwtService;
  let access: ProductAccessService, service: InventoryService;
  let movements: (typeof owned & { businessId: string })[];
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(root)
      .compile();
    service = module
      .select(InventoryModule)
      .get(InventoryService, { strict: true });
    access = module
      .select(ProductsModule)
      .get(ProductAccessService, { strict: true });
    jwt = module.get(JwtService);
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
  beforeEach(async () => {
    jest.resetAllMocks();
    movements = [
      { ...owned, businessId },
      {
        ...owned,
        businessId,
        id: '55555555-5555-4555-8555-555555555555',
        variantId: productId,
      },
      {
        ...owned,
        businessId: otherBusinessId,
        id: '77777777-7777-4777-8777-777777777777',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ];
    const matching = (where: { businessId: string; variantId?: string }) =>
      movements.filter(
        (m) =>
          m.businessId === where.businessId &&
          (where.variantId === undefined || m.variantId === where.variantId),
      );
    root.$transaction.mockImplementation(async (work) => work(tx));
    root.business.findUnique.mockResolvedValue({ id: businessId });
    root.productVariant.findFirst.mockResolvedValue({ id: variantId });
    tx.inventoryMovement.count.mockImplementation(
      async ({ where }) => matching(where).length,
    );
    tx.inventoryMovement.findMany.mockImplementation(
      async ({ where, select, skip, take }) =>
        matching(where)
          .sort(
            (a, b) =>
              b.createdAt.localeCompare(a.createdAt) ||
              b.id.localeCompare(a.id),
          )
          .slice(skip, skip + take)
          .map((row) =>
            Object.fromEntries(
              Object.keys(select).map((key) => [
                key,
                row[key as keyof typeof row],
              ]),
            ),
          ),
    );
    root.user.findUnique.mockResolvedValue({ id: userId, authVersion: 0 });
    root.authSession.findUnique.mockResolvedValue({
      userId,
      expiresAt: new Date('2099-01-01'),
      revokedAt: null,
    });
    root.businessMember.findUnique.mockImplementation(async ({ where }) =>
      where.userId_businessId.businessId === businessId
        ? { role: 'OWNER', isActive: true }
        : null,
    );
    token = await jwt.signAsync({ sub: userId, sid: userId, ver: 0 });
  });
  it('uses the exported access service once on the root client before the repeatable-read movement transaction', async () => {
    const spy = jest.spyOn(access, 'business');
    try {
      const response = await request(app.getHttpServer())
        .get(base)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(service).toBeInstanceOf(InventoryService);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(businessId);
      expect(root.business.findUnique).toHaveBeenCalledTimes(1);
      expect(root.business.findUnique).toHaveBeenCalledWith({
        where: { id: businessId },
        select: { id: true },
      });
      expect(tx.business.findUnique).not.toHaveBeenCalled();
      expect(root.$transaction).toHaveBeenCalledTimes(1);
      expect(root.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
      expect(root.business.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
        root.$transaction.mock.invocationCallOrder[0],
      );
      expect(root.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
        tx.inventoryMovement.count.mock.invocationCallOrder[0],
      );
      expect(
        tx.inventoryMovement.count.mock.invocationCallOrder[0],
      ).toBeLessThan(tx.inventoryMovement.findMany.mock.invocationCallOrder[0]);
      expect(tx.inventoryMovement.count).toHaveBeenCalledTimes(1);
      expect(tx.inventoryMovement.count).toHaveBeenCalledWith({
        where: { businessId },
      });
      expect(tx.inventoryMovement.findMany).toHaveBeenCalledTimes(1);
      expect(tx.inventoryMovement.findMany).toHaveBeenCalledWith({
        where: { businessId },
        select,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        skip: 0,
      });
      expect(root.inventoryMovement.count).not.toHaveBeenCalled();
      expect(root.inventoryMovement.findMany).not.toHaveBeenCalled();
      expect(response.body.pagination).toEqual({
        limit: 20,
        offset: 0,
        totalCount: 2,
        hasMore: false,
        nextOffset: null,
      });
      expect(response.body.items.map((m: { id: string }) => m.id)).toEqual([
        owned.id,
        '55555555-5555-4555-8555-555555555555',
      ]);
      expect(response.body.items[0]).toEqual({
        ...owned,
        catalogItemId: productId,
      });
      expect(Object.keys(response.body).sort()).toEqual([
        'items',
        'pagination',
      ]);
      expect(Object.keys(response.body.items[1]).sort()).toEqual(
        [...fields, 'catalogItemId'].sort(),
      );
    } finally {
      spy.mockRestore();
    }
  });
  it('returns the exact business 404 without opening a transaction or querying movements', async () => {
    root.business.findUnique.mockResolvedValue(null);
    const response = await request(app.getHttpServer())
      .get(base)
      .auth(token, { type: 'bearer' })
      .expect(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: 'BUSINESS_NOT_FOUND',
      message: 'Business not found',
      error: 'Not Found',
    });
    expect(root.business.findUnique).toHaveBeenCalledTimes(1);
    expect(root.business.findUnique).toHaveBeenCalledWith({
      where: { id: businessId },
      select: { id: true },
    });
    expect(root.$transaction).not.toHaveBeenCalled();
    for (const operation of [
      ...Object.values(tx.inventoryMovement),
      ...Object.values(root.inventoryMovement),
    ])
      expect(operation).not.toHaveBeenCalled();
  });
  it.each([
    [0, 1, true, 1],
    [1, 1, false, null],
    [2, 0, false, null],
    [Number.MAX_SAFE_INTEGER, 0, false, null],
  ])(
    'preserves pagination at offset %s',
    async (offset, count, hasMore, nextOffset) => {
      const response = await request(app.getHttpServer())
        .get(base)
        .auth(token, { type: 'bearer' })
        .query({ limit: 1, offset })
        .expect(200);
      expect(response.body.pagination).toEqual({
        limit: 1,
        offset,
        totalCount: 2,
        hasMore,
        nextOffset,
      });
      expect(response.body.items).toHaveLength(count);
      if (offset < 2)
        expect(tx.inventoryMovement.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { businessId },
            take: 1,
            skip: offset,
          }),
        );
      else expect(tx.inventoryMovement.findMany).not.toHaveBeenCalled();
    },
  );
  it('preserves an empty result for an existing business', async () => {
    movements = movements.filter((m) => m.businessId !== businessId);
    const response = await request(app.getHttpServer())
      .get(base)
      .auth(token, { type: 'bearer' })
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
    expect(tx.inventoryMovement.findMany).not.toHaveBeenCalled();
  });
  it('retains scoped variant filtering without adding a business existence lookup', async () => {
    const response = await request(app.getHttpServer())
      .get(
        `/businesses/${businessId}/products/${productId}/variants/${variantId}/inventory/movements`,
      )
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(root.productVariant.findFirst).toHaveBeenCalledWith({
      where: { id: variantId, businessId, productId },
      select: { id: true },
    });
    expect(root.business.findUnique).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.count).toHaveBeenCalledWith({
      where: { businessId, variantId },
    });
    expect(tx.inventoryMovement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId, variantId } }),
    );
    expect(response.body.pagination.totalCount).toBe(1);
    expect(response.body.items).toEqual([
      { ...owned, catalogItemId: productId },
    ]);
  });
  it.each(['anonymous', 'foreign business'])(
    'rejects %s access before existence checks or transactions',
    async (mode) => {
      const call = request(app.getHttpServer()).get(
        mode === 'anonymous'
          ? base
          : `/businesses/${otherBusinessId}/inventory/movements`,
      );
      if (mode !== 'anonymous') call.auth(token, { type: 'bearer' });
      const response = await call.expect(mode === 'anonymous' ? 401 : 404);
      expect(response.body.code).toBe(
        mode === 'anonymous' ? 'UNAUTHORIZED' : 'NOT_FOUND',
      );
      expect(root.business.findUnique).not.toHaveBeenCalled();
      expect(root.$transaction).not.toHaveBeenCalled();
      for (const operation of Object.values(tx.inventoryMovement))
        expect(operation).not.toHaveBeenCalled();
    },
  );
  it.each([{ limit: 0 }, { limit: 101 }, { offset: -1 }, { unexpected: true }])(
    'preserves invalid query rejection %j',
    async (query) => {
      const response = await request(app.getHttpServer())
        .get(base)
        .auth(token, { type: 'bearer' })
        .query(query)
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(root.business.findUnique).not.toHaveBeenCalled();
      expect(root.$transaction).not.toHaveBeenCalled();
    },
  );
});
