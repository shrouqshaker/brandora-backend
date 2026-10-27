import { HttpAdapterHost } from '@nestjs/core';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CatalogController } from '../../src/catalog/catalog.controller';
import { CatalogService } from '../../src/catalog/catalog.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { Prisma } from '../../src/generated/prisma/client';

describe('Catalog HTTP API (mocked database)', () => {
  let app: INestApplication;
  const businessId = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const prisma = { catalogItem: { create: jest.fn(), findMany: jest.fn() } };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CatalogController],
      providers: [CatalogService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    app = module.createNestApplication();
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

  beforeEach(() => jest.resetAllMocks());
  afterAll(async () => app.close());

  it('creates an item and serializes the exact decimal basePrice', async () => {
    prisma.catalogItem.create.mockImplementation(async ({ data }) => ({
      id: 'item-id',
      ...data,
    }));
    const response = await request(app.getHttpServer())
      .post('/catalog-items')
      .send({ businessId, name: ' Coffee ', basePrice: '49.90' })
      .expect(201);
    expect(response.body).toMatchObject({
      businessId,
      name: 'Coffee',
      basePrice: '49.9',
    });
    expect(
      prisma.catalogItem.create.mock.calls[0][0].data.basePrice.toString(),
    ).toBe('49.9');
  });

  it.each([
    { businessId, name: 'Coffee', basePrice: '-1' },
    { businessId, name: 'Coffee', basePrice: '1.234' },
    { businessId, name: 'Coffee', basePrice: 49.9 },
    { businessId, name: ' ', basePrice: '1' },
    { businessId: 'invalid', name: 'Coffee', basePrice: '1' },
    { businessId, name: 'Coffee', basePrice: '1', inventory: 10 },
  ])('rejects invalid create input: %j', async (body) => {
    await request(app.getHttpServer())
      .post('/catalog-items')
      .send(body)
      .expect(400);
    expect(prisma.catalogItem.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the business foreign key is missing', async () => {
    prisma.catalogItem.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed',
        { code: 'P2003', clientVersion: '7' },
      ),
    );
    await request(app.getHttpServer())
      .post('/catalog-items')
      .send({ businessId, name: 'Coffee', basePrice: '1' })
      .expect(404);
  });

  it('filters and paginates the list', async () => {
    prisma.catalogItem.findMany.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get('/catalog-items')
      .query({ businessId, limit: 10, offset: 5 })
      .expect(200, []);
    expect(prisma.catalogItem.findMany).toHaveBeenCalledWith({
      where: { businessId },
      take: 10,
      skip: 5,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('uses bounded default pagination', async () => {
    prisma.catalogItem.findMany.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get('/catalog-items')
      .query({ businessId })
      .expect(200);
    expect(prisma.catalogItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, skip: 0 }),
    );
  });

  it.each([
    {},
    { businessId, limit: 101 },
    { businessId, offset: -1 },
    { businessId, limit: 'abc' },
  ])('rejects invalid list input: %j', async (query) => {
    await request(app.getHttpServer())
      .get('/catalog-items')
      .query(query)
      .expect(400);
    expect(prisma.catalogItem.findMany).not.toHaveBeenCalled();
  });
});
