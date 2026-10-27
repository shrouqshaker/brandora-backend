import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CategoriesModule } from '../../src/categories/categories.module';
import { CategoriesService } from '../../src/categories/categories.service';
import { ProductsModule } from '../../src/products/products.module';
import { ProductsService } from '../../src/products/products.service';
import { VariantsModule } from '../../src/variants/variants.module';
import { VariantsService } from '../../src/variants/variants.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { AppHttpException } from '../../src/common/errors/app-http.exception';
import { ErrorCode } from '../../src/common/errors/error-code';

describe('Category/Product/Variant HTTP boundaries (mocked feature services)', () => {
  const businessId = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const id = 'c06a904b-14a7-4de7-98c9-9cac5bb4559b';
  const variantId = 'b2621a53-0797-4b1d-84f9-5f9a41697f5c';
  const categories = `/businesses/${businessId}/categories`;
  const products = `/businesses/${businessId}/products`;
  const variants = `${products}/${id}/variants`;
  const mock = () => ({
    create: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  });
  const categoryService = mock(),
    productService = mock(),
    variantService = mock();
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [CategoriesModule, ProductsModule, VariantsModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(CategoriesService)
      .useValue(categoryService)
      .overrideProvider(ProductsService)
      .useValue(productService)
      .overrideProvider(VariantsService)
      .useValue(variantService)
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
    for (const service of [categoryService, productService, variantService])
      for (const method of Object.values(service))
        method.mockResolvedValue({ result: 'ok' });
  });
  it.each([
    ['categories', categories, categoryService, { name: 'Valid' }],
    ['products', products, productService, { name: 'Valid' }],
    ['variants', variants, variantService, { optionValues: {} }],
  ] as const)(
    'registers complete %s routes and passes scoped IDs',
    async (_name, base, service, body) => {
      const child = base === variants ? variantId : id;
      const scope = base === variants ? [businessId, id] : [businessId];
      const http = request(app.getHttpServer());
      await http.post(base).send(body).expect(201);
      expect(service.create.mock.calls[0].slice(0, scope.length)).toEqual(
        scope,
      );
      await http.get(base).expect(200);
      expect(service.list.mock.calls[0]).toEqual([
        ...scope,
        expect.objectContaining({ limit: 20, offset: 0 }),
      ]);
      await http.get(`${base}/${child}`).expect(200);
      expect(service.get).toHaveBeenCalledWith(...scope, child);
      await http.patch(`${base}/${child}`).send(body).expect(200);
      expect(service.update.mock.calls[0].slice(0, scope.length + 1)).toEqual([
        ...scope,
        child,
      ]);
      await http.delete(`${base}/${child}`).expect(204, '');
      expect(service.remove).toHaveBeenCalledWith(...scope, child);
    },
  );
  it.each([
    `${categories}?limit=0`,
    `${categories}?offset=-1`,
    `${products}?limit=101`,
    `${variants}?offset=9007199254740992`,
    `${products}?unexpected=true`,
    '/businesses/not-a-uuid/categories',
    `${products}/invalid`,
    `${variants}/invalid`,
  ])(
    'rejects invalid query/path before calling services: %s',
    async (route) => {
      const result = await request(app.getHttpServer()).get(route).expect(400);
      expect(result.body.code).toBe('VALIDATION_ERROR');
      for (const service of [categoryService, productService, variantService])
        for (const method of Object.values(service))
          expect(method).not.toHaveBeenCalled();
    },
  );
  it.each([
    [categories, { name: 'Valid', businessId }],
    [categories, { name: ' ' }],
    [products, { name: 'Valid', stockQuantity: 3 }],
    [products, { name: 'Valid', trackInventory: true }],
    [products, { name: 'Valid', externalKey: 'forbidden' }],
    [variants, { optionValues: {}, isActive: true }],
    [variants, { optionValues: {}, sku: ' ' }],
    [variants, { optionValues: {}, unitPrice: 1.2 }],
  ])('rejects forbidden writes before feature services', async (base, body) => {
    const result = await request(app.getHttpServer())
      .post(base)
      .send(body)
      .expect(400);
    expect(result.body.code).toBe('VALIDATION_ERROR');
    expect(categoryService.create).not.toHaveBeenCalled();
    expect(productService.create).not.toHaveBeenCalled();
    expect(variantService.create).not.toHaveBeenCalled();
  });
  it('rejects framework-reserved keys before they can be silently stripped', async () => {
    const options = JSON.parse(
      '{"__proto__":["safe"],"constructor":["value"]}',
    );
    const attributes = JSON.parse('{"__proto__":{"safe":true}}');
    await request(app.getHttpServer())
      .post(products)
      .send({ name: ' Trim ', options, attributes })
      .expect(400);
    expect(productService.create).not.toHaveBeenCalled();
    const optionValues = JSON.parse(
      '{"__proto__":"safe","constructor":"value"}',
    );
    await request(app.getHttpServer())
      .post(variants)
      .send({ optionValues })
      .expect(400);
    expect(variantService.create).not.toHaveBeenCalled();
  });
  it('uses the existing error envelope for scoped feature conflicts', async () => {
    categoryService.create.mockRejectedValue(
      new AppHttpException(
        ErrorCode.CATEGORY_NAME_CONFLICT,
        HttpStatus.CONFLICT,
        'Duplicate category',
      ),
    );
    const result = await request(app.getHttpServer())
      .post(categories)
      .send({ name: 'Valid' })
      .expect(409);
    expect(result.body).toEqual({
      statusCode: 409,
      code: 'CATEGORY_NAME_CONFLICT',
      message: 'Duplicate category',
      error: 'Conflict',
    });
  });
  it.each([true, false])(
    'passes lifecycle PATCH %s to the scoped current service',
    async (isActive) => {
      await request(app.getHttpServer())
        .patch(`${variants}/${variantId}`)
        .send({ isActive })
        .expect(200);
      expect(variantService.update).toHaveBeenCalledWith(
        businessId,
        id,
        variantId,
        expect.objectContaining({ isActive }),
      );
    },
  );
});
