import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { CategoriesModule } from '../../src/categories/categories.module';
import { CategoriesService } from '../../src/categories/categories.service';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ProductAccessService } from '../../src/products/product-access.service';
import { ProductsModule } from '../../src/products/products.module';

describe('Categories shared business access (real modules and authorization)', () => {
  const businessId = '11111111-1111-4111-8111-111111111111';
  const foreignBusinessId = '22222222-2222-4222-8222-222222222222';
  const categoryId = '33333333-3333-4333-8333-333333333333';
  const userId = '44444444-4444-4444-8444-444444444444';
  const base = `/businesses/${businessId}/categories`;
  const businessQuery = { where: { id: businessId }, select: { id: true } };
  const category = { id: categoryId, businessId, name: 'Synthetic category' };
  const tx = {
    business: { findUnique: jest.fn() },
    category: { count: jest.fn(), findMany: jest.fn() },
  };
  const root = {
    $transaction: jest.fn(),
    business: { findUnique: jest.fn() },
    category: {
      create: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    authSession: { findUnique: jest.fn() },
    businessMember: { findUnique: jest.fn() },
  };
  let app: INestApplication, token: string, access: ProductAccessService;
  let categories: CategoriesService, jwt: JwtService;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(root)
      .compile();
    categories = module
      .select(CategoriesModule)
      .get(CategoriesService, { strict: true });
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
    root.$transaction.mockImplementation(async (work) => work(tx));
    root.business.findUnique.mockResolvedValue({ id: businessId });
    tx.business.findUnique.mockResolvedValue({ id: businessId });
    root.category.create.mockResolvedValue(category);
    tx.category.count.mockResolvedValue(1);
    tx.category.findMany.mockResolvedValue([category]);
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
  it('injects the exported access service and creates after exactly one root existence check', async () => {
    const spy = jest.spyOn(access, 'business');
    try {
      const response = await request(app.getHttpServer())
        .post(base)
        .auth(token, { type: 'bearer' })
        .send({ name: 'Synthetic category' })
        .expect(201);
      expect(response.body).toEqual(category);
      expect(categories).toBeInstanceOf(CategoriesService);
      expect(spy).toHaveBeenCalledWith(businessId);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(root.business.findUnique).toHaveBeenCalledTimes(1);
      expect(root.business.findUnique).toHaveBeenCalledWith(businessQuery);
      expect(tx.business.findUnique).not.toHaveBeenCalled();
      expect(root.$transaction).not.toHaveBeenCalled();
      expect(root.category.create).toHaveBeenCalledTimes(1);
      expect(root.category.create).toHaveBeenCalledWith({
        data: { businessId, name: 'Synthetic category' },
      });
      expect(root.business.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
        root.category.create.mock.invocationCallOrder[0],
      );
    } finally {
      spy.mockRestore();
    }
  });
  it('lists through the supplied transaction client with the existing snapshot and query shape', async () => {
    const spy = jest.spyOn(access, 'business');
    try {
      const response = await request(app.getHttpServer())
        .get(base)
        .auth(token, { type: 'bearer' })
        .query({ limit: 2, offset: 0 })
        .expect(200);
      expect(response.body).toEqual({
        pagination: {
          limit: 2,
          offset: 0,
          totalCount: 1,
          hasMore: false,
          nextOffset: null,
        },
        items: [category],
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(businessId, tx);
      expect(tx.business.findUnique).toHaveBeenCalledTimes(1);
      expect(tx.business.findUnique).toHaveBeenCalledWith(businessQuery);
      expect(root.business.findUnique).not.toHaveBeenCalled();
      expect(root.category.count).not.toHaveBeenCalled();
      expect(root.category.findMany).not.toHaveBeenCalled();
      expect(root.$transaction).toHaveBeenCalledTimes(1);
      expect(root.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
      expect(tx.category.count).toHaveBeenCalledTimes(1);
      expect(tx.category.count).toHaveBeenCalledWith({
        where: { businessId },
      });
      expect(tx.category.findMany).toHaveBeenCalledTimes(1);
      expect(tx.category.findMany).toHaveBeenCalledWith({
        where: { businessId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2,
        skip: 0,
      });
      expect(tx.business.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
        tx.category.count.mock.invocationCallOrder[0],
      );
    } finally {
      spy.mockRestore();
    }
  });
  it.each(['post', 'get'] as const)(
    'returns the exact business 404 and stops category operations on %s',
    async (method) => {
      root.business.findUnique.mockResolvedValue(null);
      tx.business.findUnique.mockResolvedValue(null);
      const response = await request(app.getHttpServer())
        [method](base)
        .auth(token, { type: 'bearer' })
        .send(method === 'post' ? { name: 'Valid' } : undefined)
        .expect(404);
      expect(response.body).toEqual({
        statusCode: 404,
        code: 'BUSINESS_NOT_FOUND',
        message: 'Business not found',
        error: 'Not Found',
      });
      expect(
        root.business.findUnique.mock.calls.length +
          tx.business.findUnique.mock.calls.length,
      ).toBe(1);
      expect(
        (method === 'post' ? root : tx).business.findUnique,
      ).toHaveBeenCalledWith(businessQuery);
      for (const operation of [
        ...Object.values(root.category),
        ...Object.values(tx.category),
      ])
        expect(operation).not.toHaveBeenCalled();
    },
  );
  it('preserves an empty category page past the end', async () => {
    const response = await request(app.getHttpServer())
      .get(base)
      .auth(token, { type: 'bearer' })
      .query({ offset: 1 })
      .expect(200);
    expect(response.body).toEqual({
      pagination: {
        limit: 20,
        offset: 1,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
      },
      items: [],
    });
    expect(tx.category.findMany).not.toHaveBeenCalled();
    expect(tx.business.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.business.findUnique).toHaveBeenCalledWith(businessQuery);
  });
  it.each([
    [
      'post',
      'P2002',
      409,
      'CATEGORY_NAME_CONFLICT',
      'A category with this normalized name already exists in this business',
    ],
    [
      'patch',
      'P2002',
      409,
      'CATEGORY_NAME_CONFLICT',
      'A category with this normalized name already exists in this business',
    ],
    ['post', 'P2003', 404, 'BUSINESS_NOT_FOUND', 'Business not found'],
    ['patch', 'P2003', 404, 'BUSINESS_NOT_FOUND', 'Business not found'],
    [
      'delete',
      'P2003',
      409,
      'CATEGORY_IN_USE',
      'Category is referenced by a product',
    ],
    ['patch', 'P2025', 404, 'CATEGORY_NOT_FOUND', 'Category not found'],
    ['delete', 'P2025', 404, 'CATEGORY_NOT_FOUND', 'Category not found'],
  ] as const)(
    'preserves %s %s mapping',
    async (method, prismaCode, status, code, message) => {
      const operation =
        method === 'post'
          ? root.category.create
          : method === 'patch'
            ? root.category.update
            : root.category.delete;
      operation.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('private SQL', {
          code: prismaCode,
          clientVersion: '7.10.1',
        }),
      );
      const response = await request(app.getHttpServer())
        [method](method === 'post' ? base : `${base}/${categoryId}`)
        .auth(token, { type: 'bearer' })
        .send(method === 'delete' ? undefined : { name: 'Valid' })
        .expect(status);
      expect(response.body).toEqual({
        statusCode: status,
        code,
        message,
        error: status === 404 ? 'Not Found' : 'Conflict',
      });
      expect(JSON.stringify(response.body)).not.toContain('private SQL');
    },
  );
  it('rejects invalid category input before checking the business', async () => {
    await request(app.getHttpServer())
      .post(base)
      .auth(token, { type: 'bearer' })
      .send({ name: ' ' })
      .expect(400);
    expect(root.business.findUnique).not.toHaveBeenCalled();
    expect(root.category.create).not.toHaveBeenCalled();
  });
  it('retains authentication before service access', async () => {
    const response = await request(app.getHttpServer()).get(base).expect(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
    expect(root.$transaction).not.toHaveBeenCalled();
    expect(root.business.findUnique).not.toHaveBeenCalled();
  });
  it.each(['post', 'get'] as const)(
    'hides another business from the owner on %s',
    async (method) => {
      const response = await request(app.getHttpServer())
        [method](`/businesses/${foreignBusinessId}/categories`)
        .auth(token, { type: 'bearer' })
        .send(method === 'post' ? { name: 'Valid' } : undefined)
        .expect(404);
      expect(response.body).toEqual({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Resource not found',
        error: 'Not Found',
      });
      expect(root.business.findUnique).not.toHaveBeenCalled();
      expect(root.$transaction).not.toHaveBeenCalled();
      expect(root.category.create).not.toHaveBeenCalled();
    },
  );
});
