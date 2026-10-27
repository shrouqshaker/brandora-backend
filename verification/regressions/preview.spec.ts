import { HttpAdapterHost } from '@nestjs/core';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Workbook } from 'exceljs';
import { mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ExcelAdapter } from '../../src/imports/adapters/excel.adapter';
import { MappingType } from '../../src/imports/mapping-fields';
import { ImportFileStorage } from '../../src/imports/storage/import-file.storage';
import { LocalImportFileStorage } from '../../src/imports/storage/local-import-file.storage';
import { RowNormalizer } from '../../src/imports/validation/row-normalizer';
import { RowValidator } from '../../src/imports/validation/row-validator';
import { PreviewController } from '../../src/imports/preview.controller';
import { PreviewService } from '../../src/imports/preview.service';
import { ImportPlanner } from '../../src/imports/preview/import-planner';

describe('Preview HTTP API (real workbook/storage, mocked database)', () => {
  let app: INestApplication;
  let directory: string;
  let storage: LocalImportFileStorage;
  let fileKey: string;
  let job: Record<string, unknown>;
  const id = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const businessId = 'c06a904b-14a7-4de7-98c9-9cac5bb4559b';
  const path = `/imports/${id}/preview`;
  const mapping = [
    {
      sourceColumn: 'SKU',
      sourceColumnIndex: 1,
      type: MappingType.STANDARD,
      target: 'externalKey',
    },
    {
      sourceColumn: 'Name',
      sourceColumnIndex: 2,
      type: MappingType.STANDARD,
      target: 'name',
    },
    {
      sourceColumn: 'Price',
      sourceColumnIndex: 3,
      type: MappingType.STANDARD,
      target: 'basePrice',
    },
    {
      sourceColumn: 'Material',
      sourceColumnIndex: 4,
      type: MappingType.ATTRIBUTE,
      target: 'material',
    },
    {
      sourceColumn: 'Size',
      sourceColumnIndex: 5,
      type: MappingType.VARIANT_ATTRIBUTE,
      target: 'size',
    },
    {
      sourceColumn: 'Notes',
      sourceColumnIndex: 6,
      type: MappingType.IGNORE,
      target: null,
    },
  ];
  const item = {
    id: 'existing-id',
    businessId,
    externalKey: 'EXISTING',
    name: 'Old Name',
    description: 'Keep me',
    category: 'Keep category',
    basePrice: new Prisma.Decimal('249.99'),
    stockQuantity: 10,
    attributes: { material: 'Cotton', color: 'Blue' },
    isActive: false,
  };
  const prisma = {
    importJob: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    catalogItem: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'brandora-preview-'));
    storage = new LocalImportFileStorage(
      new ConfigService({ IMPORT_STORAGE_DIR: directory }),
    );
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Products');
    sheet.getRow(1).values = ['Wrong', 'Header'];
    sheet.getRow(3).values = mapping.map((entry) => entry.sourceColumn);
    sheet.getRow(4).values = [' NEW ', 'T-Shirt', '299.99', ' Cotton ', 'XL'];
    sheet.getRow(5).values = ['EXISTING', 'New Name', '299.99', 'Linen', 'L'];
    sheet.getRow(6).values = ['UNCHANGED', 'Unchanged', '29.90', 'Cotton'];
    sheet.getRow(7).values = [null, 'No Code', 0];
    sheet.getRow(8).values = ['INVALID', 'Invalid Price', -1];
    // Row 9 remains blank.
    sheet.getRow(10).values = ['DUP', 'Duplicate A', 20];
    sheet.getRow(11).values = ['DUP', 'Duplicate B', 20];
    sheet.getRow(12).values = ['BLANKS', 'Blank Fields', ' ', ' '];
    workbook
      .addWorksheet('Other')
      .addRows([['Name'], ['Do not use this sheet']]);
    fileKey = await storage.save(
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );
    const module = await Test.createTestingModule({
      controllers: [PreviewController],
      providers: [
        PreviewService,
        ImportPlanner,
        RowNormalizer,
        RowValidator,
        ExcelAdapter,
        { provide: PrismaService, useValue: prisma },
        { provide: ImportFileStorage, useValue: storage },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    app.useLogger(false);
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
    job = {
      id,
      businessId,
      status: 'READY',
      fileKey,
      sheetName: 'Products',
      headerRow: 3,
      mapping,
    };
    prisma.importJob.findUnique.mockImplementation(async () => ({ ...job }));
    prisma.catalogItem.findMany.mockResolvedValue([
      item,
      {
        ...item,
        id: 'same-id',
        externalKey: 'UNCHANGED',
        name: 'Unchanged',
        basePrice: new Prisma.Decimal('29.9'),
      },
      { ...item, id: 'blank-id', externalKey: 'BLANKS', name: 'Blank Fields' },
    ]);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const [method, mock] of Object.entries(prisma.catalogItem))
      if (method !== 'findMany') expect(mock).not.toHaveBeenCalled();
    expect(prisma.importJob.update).not.toHaveBeenCalled();
    expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
    expect(job.status).toBeDefined();
    expect(await readdir(directory)).toEqual([fileKey]);
  });
  afterAll(async () => {
    await app.close();
    await storage.delete(fileKey);
    await rmdir(directory);
  });

  it.each([
    { limit: 101 },
    { limit: 0 },
    { limit: 1.5 },
    { limit: 'bad' },
    { offset: -1 },
    { offset: 1.5 },
    { offset: 'bad' },
    { offset: '9007199254740992' },
    { unknown: 1 },
  ])('rejects invalid pagination %j before planning', async (query) => {
    const response = await request(app.getHttpServer())
      .get(path)
      .query(query)
      .expect(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(prisma.importJob.findUnique).not.toHaveBeenCalled();
    expect(prisma.catalogItem.findMany).not.toHaveBeenCalled();
  });
  it('paginates a shared combined Excel-row page across all four result arrays', async () => {
    const expected = [
      ['inserts', 4],
      ['updates', 5],
      ['unchanged', 6],
      ['inserts', 7],
      ['invalidRows', 8],
      ['invalidRows', 10],
      ['invalidRows', 11],
      ['unchanged', 12],
    ];
    for (let offset = 0; offset < expected.length; offset++) {
      const response = await request(app.getHttpServer())
        .get(path)
        .query({ limit: 1, offset })
        .expect(200);
      expect(response.body.pagination).toEqual({
        limit: 1,
        offset,
        totalCount: 8,
        hasMore: offset < 7,
        nextOffset: offset < 7 ? offset + 1 : null,
      });
      expect(response.body.summary).toEqual({
        totalRows: 9,
        validRows: 5,
        invalidRows: 3,
        skippedRows: 1,
        willInsert: 2,
        willUpdate: 1,
        unchanged: 2,
      });
      for (const key of ['inserts', 'updates', 'unchanged', 'invalidRows']) {
        expect(response.body[key].map((row: any) => row.rowNumber)).toEqual(
          key === expected[offset][0] ? [expected[offset][1]] : [],
        );
      }
      expect(
        prisma.catalogItem.findMany.mock.calls[offset][0].where.externalKey.in,
      ).toEqual(['NEW', 'EXISTING', 'UNCHANGED', 'BLANKS']);
    }
  });
  it('returns empty arrays beyond the final page with globally correct planning counts', async () => {
    const response = await request(app.getHttpServer())
      .get(path)
      .query({ offset: 99 })
      .expect(200);
    for (const key of ['inserts', 'updates', 'unchanged', 'invalidRows'])
      expect(response.body[key]).toEqual([]);
    expect(response.body.pagination).toEqual({
      limit: 50,
      offset: 99,
      totalCount: 8,
      hasMore: false,
      nextOffset: null,
    });
    expect(response.body.summary).toEqual({
      totalRows: 9,
      validRows: 5,
      invalidRows: 3,
      skippedRows: 1,
      willInsert: 2,
      willUpdate: 1,
      unchanged: 2,
    });
    expect(prisma.catalogItem.findMany).toHaveBeenCalledTimes(1);
  });
  it('marks a partially filled last preview page complete', async () => {
    const response = await request(app.getHttpServer())
      .get(path)
      .query({ limit: 3, offset: 6 })
      .expect(200);
    expect(response.body.pagination).toEqual({
      limit: 3,
      offset: 6,
      totalCount: 8,
      hasMore: false,
      nextOffset: null,
    });
    expect(response.body.invalidRows.map((row: any) => row.rowNumber)).toEqual([
      11,
    ]);
    expect(response.body.unchanged.map((row: any) => row.rowNumber)).toEqual([
      12,
    ]);
    expect(response.body.inserts).toEqual([]);
    expect(response.body.updates).toEqual([]);
  });
  it('rebuilds validated rows and returns INSERT/UPDATE/UNCHANGED without writes', async () => {
    const response = await request(app.getHttpServer()).get(path).expect(200);
    expect(response.body).toMatchObject({
      importId: id,
      status: 'READY',
      summary: {
        totalRows: 9,
        validRows: 5,
        invalidRows: 3,
        skippedRows: 1,
        willInsert: 2,
        willUpdate: 1,
        unchanged: 2,
      },
    });
    expect(response.body.pagination).toEqual({
      limit: 50,
      offset: 0,
      totalCount:
        response.body.summary.validRows + response.body.summary.invalidRows,
      hasMore:
        response.body.summary.validRows + response.body.summary.invalidRows >
        50,
      nextOffset:
        response.body.summary.validRows + response.body.summary.invalidRows > 50
          ? 50
          : null,
    });
    expect(
      response.body.inserts.map((row: { rowNumber: number }) => row.rowNumber),
    ).toEqual([4, 7]);
    expect(response.body.inserts[0]).toMatchObject({
      action: 'INSERT',
      externalKey: 'NEW',
      data: {
        name: 'T-Shirt',
        basePrice: '299.99',
        attributes: { material: 'Cotton' },
      },
      variantAttributes: { size: 'XL' },
    });
    expect(response.body.inserts[0].data).not.toHaveProperty(
      'variantAttributes',
    );
    expect(response.body.updates).toEqual([
      {
        rowNumber: 5,
        action: 'UPDATE',
        catalogItemId: 'existing-id',
        externalKey: 'EXISTING',
        variantAttributes: { size: 'L' },
        changes: {
          name: { from: 'Old Name', to: 'New Name' },
          basePrice: { from: '249.99', to: '299.99' },
          attributes: {
            from: { material: 'Cotton', color: 'Blue' },
            to: { material: 'Linen', color: 'Blue' },
          },
        },
      },
    ]);
    expect(
      response.body.unchanged.map(
        (row: { rowNumber: number }) => row.rowNumber,
      ),
    ).toEqual([6, 12]);
    expect(
      response.body.invalidRows.map(
        (row: { rowNumber: number }) => row.rowNumber,
      ),
    ).toEqual([8, 10, 11]);
    expect(prisma.catalogItem.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.catalogItem.findMany.mock.calls[0][0].where).toEqual({
      businessId,
      externalKey: { in: ['NEW', 'EXISTING', 'UNCHANGED', 'BLANKS'] },
    });
    expect(job.status).toBe('READY');
    expect(JSON.stringify(response.body)).not.toContain(fileKey);
    expect(JSON.stringify(response.body)).not.toContain('isActive');
  });

  it('does not match another business or match an unkeyed row by name', async () => {
    prisma.catalogItem.findMany.mockResolvedValue([
      {
        ...item,
        businessId: 'other-business',
        externalKey: 'NEW',
        name: 'No Code',
      },
    ]);
    const response = await request(app.getHttpServer()).get(path).expect(200);
    expect(response.body.summary.willInsert).toBe(5);
    expect(response.body.updates).toEqual([]);
    expect(response.body.unchanged).toEqual([]);
  });

  it('recomputes a fresh plan if catalog values change between requests', async () => {
    const first = await request(app.getHttpServer()).get(path).expect(200);
    prisma.catalogItem.findMany.mockResolvedValue([]);
    const second = await request(app.getHttpServer()).get(path).expect(200);
    expect(first.body.summary.willUpdate).toBe(1);
    expect(second.body.summary.willInsert).toBe(5);
    expect(job.status).toBe('READY');
  });

  it('uses bounded batches rather than one query per row', async () => {
    jest.spyOn(app.get(ExcelAdapter), 'readDataRows').mockResolvedValue({
      headers: mapping.map((entry) => entry.sourceColumn),
      rows: Array.from({ length: 1001 }, (_, index) => ({
        rowNumber: index + 4,
        isEmpty: false,
        values: [`SKU-${index}`, 'Product', null, null, null, null],
      })),
    });
    prisma.catalogItem.findMany.mockResolvedValue([]);
    const response = await request(app.getHttpServer()).get(path).expect(200);
    expect(response.body.summary.willInsert).toBe(1001);
    expect(response.body.inserts).toHaveLength(50);
    expect(response.body.pagination).toEqual({
      limit: 50,
      offset: 0,
      totalCount:
        response.body.summary.validRows + response.body.summary.invalidRows,
      hasMore:
        response.body.summary.validRows + response.body.summary.invalidRows >
        50,
      nextOffset:
        response.body.summary.validRows + response.body.summary.invalidRows > 50
          ? 50
          : null,
    });
    expect(prisma.catalogItem.findMany).toHaveBeenCalledTimes(2);
    expect(
      prisma.catalogItem.findMany.mock.calls.map(
        ([args]) => args.where.externalKey.in.length,
      ),
    ).toEqual([1000, 1]);
    for (const [args] of prisma.catalogItem.findMany.mock.calls)
      expect(args.where.businessId).toBe(businessId);
  });

  it('does not query the catalog when no valid rows have external keys', async () => {
    jest.spyOn(app.get(ExcelAdapter), 'readDataRows').mockResolvedValue({
      headers: mapping.map((entry) => entry.sourceColumn),
      rows: [
        {
          rowNumber: 4,
          isEmpty: false,
          values: [null, 'Product', null, null, null, null],
        },
      ],
    });
    const response = await request(app.getHttpServer()).get(path).expect(200);
    expect(response.body.summary.willInsert).toBe(1);
    expect(prisma.catalogItem.findMany).not.toHaveBeenCalled();
  });

  it.each([
    'MAPPING_REQUIRED',
    'VALIDATING',
    'IMPORTING',
    'FAILED',
    'COMPLETED',
  ])('requires READY, rejecting %s', async (status) => {
    job.status = status;
    await request(app.getHttpServer()).get(path).expect(409);
    expect(job.status).toBe(status);
    expect(prisma.catalogItem.findMany).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown import', async () => {
    prisma.importJob.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer()).get(path).expect(404);
  });

  it('rejects invalid import UUIDs', async () => {
    await request(app.getHttpServer())
      .get('/imports/invalid/preview')
      .expect(400);
    expect(prisma.importJob.findUnique).not.toHaveBeenCalled();
  });

  it.each(['fileKey', 'mapping', 'sheetName', 'headerRow'])(
    'returns 409 for missing %s and keeps READY',
    async (field) => {
      job[field] = null;
      await request(app.getHttpServer()).get(path).expect(409);
      expect(job.status).toBe('READY');
    },
  );

  it.each([
    'missing file',
    'storage error',
    'corrupt workbook',
    'corrupt mapping',
  ])(
    'handles %s without changing status or leaking storage keys',
    async (failure) => {
      if (failure === 'missing file')
        jest
          .spyOn(storage, 'read')
          .mockRejectedValue(
            Object.assign(new Error(fileKey), { code: 'ENOENT' }),
          );
      if (failure === 'storage error')
        jest.spyOn(storage, 'read').mockRejectedValue(new Error(fileKey));
      if (failure === 'corrupt workbook')
        jest
          .spyOn(storage, 'read')
          .mockResolvedValue(Buffer.from('invalid workbook'));
      if (failure === 'corrupt mapping')
        job.mapping = [
          { ...mapping[0], sourceColumnIndex: 2 },
          ...mapping.slice(1),
        ];
      const response = await request(app.getHttpServer())
        .get(path)
        .expect(failure === 'missing file' ? 409 : 500);
      expect(JSON.stringify(response.body)).not.toContain(fileKey);
      expect(job.status).toBe('READY');
      expect(prisma.catalogItem.findMany).not.toHaveBeenCalled();
    },
  );
});
