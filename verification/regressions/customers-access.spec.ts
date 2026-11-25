import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { CustomersModule } from '../../src/customers/customers.module';
import {
  CustomersService,
  customerSelect,
} from '../../src/customers/customers.service';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ProductAccessService } from '../../src/products/product-access.service';
import { ProductsModule } from '../../src/products/products.module';

describe('Customers shared business access (real modules and authorization)', () => {
  const businessId = '11111111-1111-4111-8111-111111111111';
  const otherBusinessId = '22222222-2222-4222-8222-222222222222';
  const userId = '33333333-3333-4333-8333-333333333333';
  const firstId = '55555555-5555-4555-8555-555555555555';
  const secondId = '44444444-4444-4444-8444-444444444444';
  const thirdId = '66666666-6666-4666-8666-666666666666';
  const foreignId = '77777777-7777-4777-8777-777777777777';
  const base = `/businesses/${businessId}/customers`;
  const businessQuery = { where: { id: businessId }, select: { id: true } };
  const fields = [
    'id',
    'businessId',
    'phone',
    'name',
    'createdAt',
    'updatedAt',
  ].sort();
  const root = {
    $transaction: jest.fn(),
    business: { findUnique: jest.fn() },
    customer: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    authSession: { findUnique: jest.fn() },
    businessMember: { findUnique: jest.fn() },
  };
  let app: INestApplication, jwt: JwtService, token: string;
  let access: ProductAccessService, service: CustomersService;
  let customers: {
    id: string;
    businessId: string;
    phone: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
    internal: string;
  }[];
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(root)
      .compile();
    service = module
      .select(CustomersModule)
      .get(CustomersService, { strict: true });
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
    customers = [
      { id: thirdId, businessId, date: '2026-01-01' },
      { id: secondId, businessId, date: '2026-01-02' },
      { id: foreignId, businessId: otherBusinessId, date: '2026-01-03' },
      { id: firstId, businessId, date: '2026-01-02' },
    ].map((row, index) => ({
      id: row.id,
      businessId: row.businessId,
      phone: `20100000000${index}`,
      name: `Synthetic ${index}`,
      createdAt: new Date(row.date),
      updatedAt: new Date(row.date),
      internal: 'private fixture field',
    }));
    const project = (
      row: (typeof customers)[number],
      select: Record<string, boolean>,
    ) =>
      Object.fromEntries(
        Object.keys(select)
          .filter((key) => select[key])
          .map((key) => [key, row[key as keyof typeof row]]),
      );
    root.business.findUnique.mockResolvedValue({ id: businessId });
    root.customer.count.mockImplementation(
      async ({ where }) =>
        customers.filter((c) => c.businessId === where.businessId).length,
    );
    root.customer.findMany.mockImplementation(
      async ({ where, select, skip, take }) =>
        customers
          .filter((c) => c.businessId === where.businessId)
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.id.localeCompare(a.id),
          )
          .slice(skip, skip + take)
          .map((c) => project(c, select)),
    );
    root.customer.findFirst.mockImplementation(async ({ where, select }) => {
      const row = customers.find(
        (c) => c.id === where.id && c.businessId === where.businessId,
      );
      return row ? project(row, select) : null;
    });
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
  it('uses the exported service instance and lists only owned customers with the existing contract', async () => {
    const spy = jest.spyOn(access, 'business');
    try {
      const response = await request(app.getHttpServer())
        .get(base)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(service).toBeInstanceOf(CustomersService);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(businessId);
      expect(root.business.findUnique).toHaveBeenCalledTimes(1);
      expect(root.business.findUnique).toHaveBeenCalledWith(businessQuery);
      expect(root.customer.count).toHaveBeenCalledTimes(1);
      expect(root.customer.count).toHaveBeenCalledWith({
        where: { businessId },
      });
      expect(root.customer.findMany).toHaveBeenCalledTimes(1);
      expect(root.customer.findMany).toHaveBeenCalledWith({
        where: { businessId },
        select: customerSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        skip: 0,
      });
      expect(root.business.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
        root.customer.count.mock.invocationCallOrder[0],
      );
      expect(root.customer.count.mock.invocationCallOrder[0]).toBeLessThan(
        root.customer.findMany.mock.invocationCallOrder[0],
      );
      expect(root.$transaction).not.toHaveBeenCalled();
      expect(Object.keys(response.body).sort()).toEqual([
        'items',
        'pagination',
      ]);
      expect(response.body.items.map((c: { id: string }) => c.id)).toEqual([
        firstId,
        secondId,
        thirdId,
      ]);
      expect(response.body.pagination).toEqual({
        limit: 20,
        offset: 0,
        totalCount: 3,
        hasMore: false,
        nextOffset: null,
      });
      for (const customer of response.body.items)
        expect(Object.keys(customer).sort()).toEqual(fields);
      expect(JSON.stringify(response.body)).not.toContain('private');
    } finally {
      spy.mockRestore();
    }
  });
  it('returns the exact service-level business 404 before any customer query', async () => {
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
    expect(root.business.findUnique).toHaveBeenCalledWith(businessQuery);
    for (const operation of Object.values(root.customer))
      expect(operation).not.toHaveBeenCalled();
    expect(root.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    [0, [firstId, secondId], true, 2],
    [1, [secondId, thirdId], false, null],
    [2, [thirdId], false, null],
    [99, [], false, null],
    [Number.MAX_SAFE_INTEGER, [], false, null],
  ])(
    'preserves customer pagination at offset %s',
    async (offset, ids, hasMore, nextOffset) => {
      const response = await request(app.getHttpServer())
        .get(base)
        .auth(token, { type: 'bearer' })
        .query({ limit: 2, offset })
        .expect(200);
      expect(response.body.items.map((c: { id: string }) => c.id)).toEqual(ids);
      expect(response.body.pagination).toEqual({
        limit: 2,
        offset,
        totalCount: 3,
        hasMore,
        nextOffset,
      });
      expect(root.business.findUnique).toHaveBeenCalledTimes(1);
      expect(root.business.findUnique).toHaveBeenCalledWith(businessQuery);
      if (offset >= 3) expect(root.customer.findMany).not.toHaveBeenCalled();
    },
  );
  it('keeps the empty list envelope for an existing business', async () => {
    customers = customers.filter((c) => c.businessId !== businessId);
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
    expect(root.customer.findMany).not.toHaveBeenCalled();
  });
  it.each([
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { search: 'Synthetic' },
    { name: 'Synthetic' },
  ])(
    'preserves rejected pagination or unsupported filters %j',
    async (query) => {
      const response = await request(app.getHttpServer())
        .get(base)
        .auth(token, { type: 'bearer' })
        .query(query)
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(root.business.findUnique).not.toHaveBeenCalled();
      expect(root.customer.count).not.toHaveBeenCalled();
      expect(root.customer.findMany).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, 'invalid-token'])(
    'rejects missing or invalid authentication before service access: %s',
    async (value) => {
      const call = request(app.getHttpServer()).get(base);
      if (value) call.auth(value, { type: 'bearer' });
      const response = await call.expect(401);
      expect(response.body.code).toBe('UNAUTHORIZED');
      expect(root.business.findUnique).not.toHaveBeenCalled();
      for (const operation of Object.values(root.customer))
        expect(operation).not.toHaveBeenCalled();
    },
  );
  it('hides an existing business without owner membership before checking existence', async () => {
    const response = await request(app.getHttpServer())
      .get(`/businesses/${otherBusinessId}/customers`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Resource not found',
      error: 'Not Found',
    });
    expect(root.business.findUnique).not.toHaveBeenCalled();
    for (const operation of Object.values(root.customer))
      expect(operation).not.toHaveBeenCalled();
  });
  it('keeps customer detail queries scoped to the selected business', async () => {
    const response = await request(app.getHttpServer())
      .get(`${base}/${foreignId}`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: 'CUSTOMER_NOT_FOUND',
      message: 'Customer not found in this business',
      error: 'Not Found',
    });
    expect(root.customer.findFirst).toHaveBeenCalledWith({
      where: { id: foreignId, businessId },
      select: customerSelect,
    });
    expect(root.business.findUnique).not.toHaveBeenCalled();
  });
});
