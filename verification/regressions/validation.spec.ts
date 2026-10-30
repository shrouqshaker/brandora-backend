import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import request from 'supertest';
import { ValidationController } from '../../src/imports/validation.controller';
import { ValidationService } from '../../src/imports/validation.service';
import { RowNormalizer } from '../../src/imports/validation/row-normalizer';
import { RowValidator } from '../../src/imports/validation/row-validator';
import { ExcelAdapter } from '../../src/imports/adapters/excel.adapter';
import { ImportFileStorage } from '../../src/imports/storage/import-file.storage';
import { PrismaService } from '../../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { Workbook } from 'exceljs';

describe('Variant import validation lifecycle and stored results', () => {
  let app: INestApplication, job: any, snapshot: Buffer | undefined;
  const id = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const mapping = ['externalKey', 'name', 'stockQuantity'].map((target, i) => ({
    sourceColumn: target,
    sourceColumnIndex: i + 1,
    type: 'STANDARD',
    target,
  }));
  const db = {
    importJob: { findUnique: jest.fn(), updateMany: jest.fn() },
    catalogItem: { findMany: jest.fn() },
    productVariant: { findMany: jest.fn() },
  };
  const storage = {
    read: jest.fn(),
    saveValidationResult: jest.fn(),
    readValidationResult: jest.fn(),
    deleteValidationResult: jest.fn(),
  };
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      controllers: [ValidationController],
      providers: [
        ValidationService,
        RowNormalizer,
        RowValidator,
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
    snapshot = undefined;
    job = {
      id,
      businessId: id,
      status: 'MAPPING_REQUIRED',
      fileKey: 'workbook',
      sheetName: 'Products',
      headerRow: 1,
      mapping,
    };
    const book = new Workbook();
    book
      .addWorksheet('Products')
      .addRows([
        mapping.map((m) => m.sourceColumn),
        ['TEA', 'Tea', 4],
        ['BAD', null, -1],
        [null, null, null],
        ['COFFEE', 'Coffee', null],
      ]);
    storage.read.mockResolvedValue(Buffer.from(await book.xlsx.writeBuffer()));
    storage.saveValidationResult.mockImplementation(async (_key, bytes) => {
      snapshot = bytes;
    });
    storage.readValidationResult.mockImplementation(async () => {
      if (!snapshot)
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return snapshot;
    });
    db.importJob.findUnique.mockImplementation(async () => ({ ...job }));
    db.importJob.updateMany.mockImplementation(async ({ where, data }) => {
      if (job.status !== where.status) return { count: 0 };
      Object.assign(job, data);
      return { count: 1 };
    });
    db.catalogItem.findMany.mockResolvedValue([]);
    db.productVariant.findMany.mockResolvedValue([]);
  });
  afterAll(async () => {
    await app.close();
  });
  it('claims, normalizes, checks scoped database identities, stores results and returns READY', async () => {
    const r = await request(app.getHttpServer())
      .post(`/imports/${id}/validate`)
      .expect(201);
    expect(r.body).toEqual({
      importId: id,
      status: 'READY',
      summary: { totalRows: 4, validRows: 2, invalidRows: 1, skippedRows: 1 },
    });
    expect(db.catalogItem.findMany.mock.calls[0][0].where.businessId).toBe(id);
    expect(
      JSON.parse(snapshot!.toString()).result.validRows[0].data.options,
    ).toEqual({});
    await request(app.getHttpServer())
      .post(`/imports/${id}/validate`)
      .expect(409);
  });
  it.each([0, 1, 2, 3, 99])(
    'paginates stored valid/invalid rows together at offset %s without rereading workbook',
    async (offset) => {
      await request(app.getHttpServer())
        .post(`/imports/${id}/validate`)
        .expect(201);
      storage.read.mockRejectedValue(new Error('must not reread'));
      const r = await request(app.getHttpServer())
        .get(`/imports/${id}/validation-results?limit=1&offset=${offset}`)
        .expect(200);
      expect(r.body.pagination.totalCount).toBe(3);
      expect(r.body.validRows.length + r.body.invalidRows.length).toBe(
        offset < 3 ? 1 : 0,
      );
      expect(r.body.pagination.hasMore).toBe(offset < 2);
    },
  );
  it.each([
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { offset: 'bad' },
    { unknown: 1 },
  ])('rejects invalid result pagination %j', async (query) => {
    await request(app.getHttpServer())
      .get(`/imports/${id}/validation-results`)
      .query(query)
      .expect(400);
    expect(storage.readValidationResult).not.toHaveBeenCalled();
  });
  it.each(['UPLOADED', 'READY', 'IMPORTING', 'COMPLETED', 'CANCELLED'])(
    'refuses validate in %s state',
    async (status) => {
      job.status = status;
      await request(app.getHttpServer())
        .post(`/imports/${id}/validate`)
        .expect(409);
      expect(storage.read).not.toHaveBeenCalled();
    },
  );
  it('does not reveal inaccessible/missing stored snapshots', async () => {
    job.status = 'READY';
    const r = await request(app.getHttpServer())
      .get(`/imports/${id}/validation-results`)
      .expect(409);
    expect(r.body.code).toBe('IMPORT_VALIDATION_RESULTS_UNAVAILABLE');
  });
  it('rejects missing jobs', async () => {
    db.importJob.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .post(`/imports/${id}/validate`)
      .expect(404);
  });
  it('rejects a concurrent lifecycle claim', async () => {
    db.importJob.updateMany.mockResolvedValue({ count: 0 });
    await request(app.getHttpServer())
      .post(`/imports/${id}/validate`)
      .expect(409);
  });
  it('sanitizes workbook failures and marks FAILED', async () => {
    storage.read.mockRejectedValue(new Error('private filename'));
    const r = await request(app.getHttpServer())
      .post(`/imports/${id}/validate`)
      .expect(500);
    expect(r.body.code).toBe('IMPORT_VALIDATION_FAILED');
    expect(JSON.stringify(r.body)).not.toContain('private');
    expect(job.status).toBe('FAILED');
  });
  it('rejects corrupted stored counters instead of returning an inconsistent page', async () => {
    job.status = 'READY';
    snapshot = Buffer.from(
      JSON.stringify({
        version: 2,
        importId: id,
        result: {
          summary: {
            totalRows: 0,
            validRows: 5,
            invalidRows: 0,
            skippedRows: 0,
          },
          validRows: [],
          invalidRows: [],
        },
      }),
    );
    await request(app.getHttpServer())
      .get(`/imports/${id}/validation-results`)
      .expect(500);
  });
  it('rejects legacy mappings without product identity safely', async () => {
    job.mapping = mapping.map((m) =>
      m.target === 'externalKey' ? { ...m, type: 'IGNORE', target: null } : m,
    );
    await request(app.getHttpServer())
      .post(`/imports/${id}/validate`)
      .expect(500);
    expect(job.status).toBe('FAILED');
  });
  it('rejects legacy inert-variant snapshots with a safe conflict instead of presenting them as current variants', async () => {
    job.status = 'READY';
    snapshot = Buffer.from(
      JSON.stringify({
        version: 1,
        importId: id,
        result: {
          summary: {
            totalRows: 0,
            validRows: 0,
            invalidRows: 0,
            skippedRows: 0,
          },
          validRows: [],
          invalidRows: [],
        },
      }),
    );
    const r = await request(app.getHttpServer())
      .get(`/imports/${id}/validation-results`)
      .expect(409);
    expect(r.body.code).toBe('IMPORT_VALIDATION_RESULTS_UNAVAILABLE');
  });
});
