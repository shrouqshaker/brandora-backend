import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import request from 'supertest';
import { PreviewController } from '../../src/imports/preview.controller';
import { PreviewService } from '../../src/imports/preview.service';
import { RowNormalizer } from '../../src/imports/validation/row-normalizer';
import { RowValidator } from '../../src/imports/validation/row-validator';
import { ImportPlanner } from '../../src/imports/preview/import-planner';
import { ExcelAdapter } from '../../src/imports/adapters/excel.adapter';
import { ImportFileStorage } from '../../src/imports/storage/import-file.storage';
import { PrismaService } from '../../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { Prisma } from '../../src/generated/prisma/client';
import { Workbook } from 'exceljs';

describe('Variant import preview combined pagination and current database planning', () => {
  let app: INestApplication, job: any;
  const id = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const mapping = ['externalKey', 'name', 'stockQuantity'].map((target, i) => ({
    sourceColumn: target,
    sourceColumnIndex: i + 1,
    type: 'STANDARD',
    target,
  }));
  const db = {
    $transaction: jest.fn(),
    importJob: { findUnique: jest.fn() },
    catalogItem: { findMany: jest.fn() },
    productVariant: { findMany: jest.fn() },
  };
  const storage = { read: jest.fn() };
  const product = (key: string) => ({
    id: key,
    businessId: id,
    externalKey: key,
    name: 'Tea',
    description: null,
    category: null,
    basePrice: null,
    attributes: null,
    options: {},
    isActive: true,
    variants: [
      {
        id: 'v-' + key,
        businessId: id,
        catalogItemId: key,
        optionValues: {},
        sku: null,
        unitPrice: null,
        stockQuantity: 5,
        trackInventory: true,
        isActive: true,
      },
    ],
  });
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      controllers: [PreviewController],
      providers: [
        PreviewService,
        RowNormalizer,
        RowValidator,
        ImportPlanner,
        ExcelAdapter,
        { provide: PrismaService, useValue: db },
        { provide: ImportFileStorage, useValue: storage },
      ],
    }).compile();
    app = m.createNestApplication({ logger: false });
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
  beforeEach(async () => {
    jest.resetAllMocks();
    db.$transaction.mockImplementation((fn) => fn(db));
    job = {
      id,
      businessId: id,
      status: 'READY',
      fileKey: 'file',
      sheetName: 'Products',
      headerRow: 1,
      mapping,
    };
    db.importJob.findUnique.mockImplementation(async () => ({ ...job }));
    db.catalogItem.findMany.mockResolvedValue([
      product('UPDATE'),
      product('SAME'),
    ]);
    db.productVariant.findMany.mockResolvedValue([]);
    const b = new Workbook();
    b.addWorksheet('Products').addRows([
      mapping.map((m) => m.sourceColumn),
      ['NEW', 'Tea', 1],
      ['UPDATE', 'Tea', 8],
      ['SAME', 'Tea', null],
      ['INVALID', null, -1],
    ]);
    storage.read.mockResolvedValue(Buffer.from(await b.xlsx.writeBuffer()));
  });
  afterAll(async () => {
    await app.close();
  });
  it('reports INSERT/UPDATE/UNCHANGED per variant and current stock', async () => {
    const r = await request(app.getHttpServer())
      .get(`/imports/${id}/preview`)
      .expect(200);
    expect(r.body.summary).toMatchObject({
      willInsert: 1,
      willUpdate: 1,
      unchanged: 1,
      invalidRows: 1,
    });
    expect(r.body.updates[0]).toMatchObject({
      catalogItemId: 'UPDATE',
      variantId: 'v-UPDATE',
      changes: { stockQuantity: { from: 5, to: 8 } },
    });
  });
  it.each([0, 1, 2, 3, 4, 99])(
    'uses one combined row page at offset %s',
    async (offset) => {
      const r = await request(app.getHttpServer())
        .get(`/imports/${id}/preview?limit=1&offset=${offset}`)
        .expect(200);
      expect(r.body.pagination.totalCount).toBe(4);
      expect(
        ['inserts', 'updates', 'unchanged', 'invalidRows'].flatMap(
          (k) => r.body[k],
        ),
      ).toHaveLength(offset < 4 ? 1 : 0);
    },
  );
  it.each([
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { offset: 'bad' },
    { unknown: 1 },
  ])('rejects invalid pagination %j', async (query) => {
    await request(app.getHttpServer())
      .get(`/imports/${id}/preview`)
      .query(query)
      .expect(400);
    expect(storage.read).not.toHaveBeenCalled();
  });
  it.each(['MAPPING_REQUIRED', 'IMPORTING', 'COMPLETED', 'FAILED'])(
    'rejects preview in %s state',
    async (status) => {
      job.status = status;
      await request(app.getHttpServer())
        .get(`/imports/${id}/preview`)
        .expect(409);
    },
  );
  it('recomputes the plan against current database values', async () => {
    db.catalogItem.findMany.mockResolvedValue([]);
    const r = await request(app.getHttpServer())
      .get(`/imports/${id}/preview`)
      .expect(200);
    expect(r.body.summary.willInsert).toBe(3);
  });
  it('returns not found for missing jobs', async () => {
    db.importJob.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`/imports/${id}/preview`)
      .expect(404);
  });
  it('sanitizes missing retained file errors', async () => {
    storage.read.mockRejectedValue(
      Object.assign(new Error('private path'), { code: 'ENOENT' }),
    );
    const r = await request(app.getHttpServer())
      .get(`/imports/${id}/preview`)
      .expect(409);
    expect(r.body.code).toBe('IMPORT_WORKBOOK_UNAVAILABLE');
    expect(JSON.stringify(r.body)).not.toContain('private path');
  });
  it('does not change a disabled product or reserved SKU into an insert preview', async () => {
    db.catalogItem.findMany.mockResolvedValue([
      { ...product('UPDATE'), isActive: false },
    ]);
    const r = await request(app.getHttpServer())
      .get(`/imports/${id}/preview`)
      .expect(200);
    expect(r.body.summary.invalidRows).toBe(2);
  });
});
