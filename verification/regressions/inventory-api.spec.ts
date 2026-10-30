import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import request from 'supertest';
import { InventoryController } from '../../src/inventory/inventory.controller';
import { InventoryService } from '../../src/inventory/inventory.service';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';

describe('Variant inventory HTTP contract (real DTO/controller, mocked service)', () => {
  let app: INestApplication;
  const businessId = 'c06a904b-14a7-4de7-98c9-9cac5bb4559b',
    productId = 'b2621a53-0797-4b1d-84f9-5f9a41697f5c',
    variantId = '9b7851f1-15ac-4ca3-a705-97e723825336';
  const base = `/businesses/${businessId}/products/${productId}/variants/${variantId}/inventory`;
  const service = {
    setQuantity: jest.fn(),
    listVariantMovements: jest.fn(),
    listBusinessMovements: jest.fn(),
  };
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      controllers: [InventoryController],
      providers: [{ provide: InventoryService, useValue: service }],
    }).compile();
    app = m.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    await app.init();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    service.setQuantity.mockResolvedValue({ changed: true });
    service.listVariantMovements.mockResolvedValue({
      items: [],
      pagination: { totalCount: 0 },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  it.each([0, 7, 2147483647])(
    'accepts quantity %s and supplies all ownership IDs',
    async (quantity) => {
      await request(app.getHttpServer())
        .post(base + '/adjust')
        .send({ quantity })
        .expect(201);
      expect(service.setQuantity).toHaveBeenCalledWith(
        { id: variantId, catalogItemId: productId, businessId },
        quantity,
        'MANUAL_ADJUSTMENT',
        undefined,
        undefined,
        true,
      );
    },
  );
  it.each([-1, 1.2, 2147483648, null, '4'])(
    'rejects invalid quantity %s',
    async (quantity) => {
      const r = await request(app.getHttpServer())
        .post(base + '/adjust')
        .send({ quantity })
        .expect(400);
      expect(r.body.code).toBe('VALIDATION_ERROR');
      expect(service.setQuantity).not.toHaveBeenCalled();
    },
  );
  it('allows explicit disable only with null quantity', async () => {
    await request(app.getHttpServer())
      .post(base + '/adjust')
      .send({ trackInventory: false, quantity: null })
      .expect(201);
    expect(service.setQuantity.mock.calls[0][5]).toBe(false);
    await request(app.getHttpServer())
      .post(base + '/adjust')
      .send({ trackInventory: false, quantity: 3 })
      .expect(400);
  });
  it('forbids obsolete product stock route', async () => {
    await request(app.getHttpServer())
      .post(
        `/businesses/${businessId}/catalog-items/${productId}/inventory/adjust`,
      )
      .send({ quantity: 3 })
      .expect(404);
  });
  it('rejects internal or unrelated body fields instead of silently accepting them', async () => {
    await request(app.getHttpServer())
      .post(base + '/adjust')
      .send({ quantity: 3, untrackedQuantity: null })
      .expect(400);
    expect(service.setQuantity).not.toHaveBeenCalled();
  });
  it('reads a variant history with scoped IDs and pagination', async () => {
    await request(app.getHttpServer())
      .get(base + '/movements?limit=2&offset=1')
      .expect(200);
    expect(service.listVariantMovements).toHaveBeenCalledWith(
      { id: variantId, catalogItemId: productId, businessId },
      expect.objectContaining({ limit: 2, offset: 1 }),
    );
  });
  it.each([
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { offset: 'bad' },
    { unknown: 1 },
  ])('rejects invalid history pagination %j', async (query) => {
    await request(app.getHttpServer())
      .get(base + '/movements')
      .query(query)
      .expect(400);
    expect(service.listVariantMovements).not.toHaveBeenCalled();
  });
  it.each([businessId, productId, variantId])(
    'validates UUID path component %s',
    async (id) => {
      await request(app.getHttpServer())
        .get(base.replace(id, 'invalid') + '/movements')
        .expect(400);
    },
  );
});
