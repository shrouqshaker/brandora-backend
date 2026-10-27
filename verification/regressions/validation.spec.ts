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
import { PrismaService } from '../../src/prisma/prisma.service';
import { ExcelAdapter } from '../../src/imports/adapters/excel.adapter';
import { MappingController } from '../../src/imports/mapping.controller';
import { MappingService } from '../../src/imports/mapping.service';
import { MappingType } from '../../src/imports/mapping-fields';
import { ImportFileStorage } from '../../src/imports/storage/import-file.storage';
import { LocalImportFileStorage } from '../../src/imports/storage/local-import-file.storage';
import { ValidationController } from '../../src/imports/validation.controller';
import { ValidationService } from '../../src/imports/validation.service';
import { RowNormalizer } from '../../src/imports/validation/row-normalizer';
import { RowValidator } from '../../src/imports/validation/row-validator';

describe('Validation HTTP lifecycle (real workbook/storage, mocked database)', () => {
  let app: INestApplication;
  let directory: string;
  let storage: LocalImportFileStorage;
  let fileKey: string;
  let job: Record<string, unknown>;
  const id = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const path = `/imports/${id}/validate`;
  const mapping = [
    {
      sourceColumn: 'Name',
      sourceColumnIndex: 1,
      type: MappingType.STANDARD,
      target: 'name',
    },
    {
      sourceColumn: 'Price',
      sourceColumnIndex: 2,
      type: MappingType.STANDARD,
      target: 'basePrice',
    },
  ];
  const prisma = {
    importJob: { findUnique: jest.fn(), updateMany: jest.fn() },
    catalogItem: {
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'brandora-validation-'));
    storage = new LocalImportFileStorage(
      new ConfigService({ IMPORT_STORAGE_DIR: directory }),
    );
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Products');
    sheet.getRow(1).values = ['Not', 'Headers'];
    sheet.getRow(3).values = ['Name', 'Price'];
    sheet.getRow(4).values = [' Shirt ', 29.9];
    // A physical blank row between records must count as skipped.
    sheet.getRow(6).values = [' ', -1];
    sheet.getRow(7).values = ['  ', '\t'];
    sheet.getRow(8).values = ['Tea', 0];
    workbook.addWorksheet('Other').addRows([
      ['Name', 'Price'],
      ['Wrong sheet', -5],
    ]);
    fileKey = await storage.save(
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );
    const module = await Test.createTestingModule({
      controllers: [ValidationController, MappingController],
      providers: [
        ValidationService,
        MappingService,
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

  beforeEach(async () => {
    await storage.deleteValidationResult(fileKey);
    jest.resetAllMocks();
    job = {
      id,
      status: 'MAPPING_REQUIRED',
      fileKey,
      sheetName: 'Products',
      headerRow: 3,
      mapping,
    };
    prisma.importJob.findUnique.mockImplementation(async () => ({ ...job }));
    prisma.importJob.updateMany.mockImplementation(async ({ where, data }) => {
      if (job.status !== where.status) return { count: 0 };
      Object.assign(job, data);
      return { count: 1 };
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const method of Object.values(prisma.catalogItem))
      expect(method).not.toHaveBeenCalled();
    const files = await readdir(directory);
    expect(files).toContain(fileKey);
    expect(
      files.every(
        (file) =>
          file === fileKey ||
          file === fileKey.replace('.xlsx', '.validation.json'),
      ),
    ).toBe(true);
    expect(files.length).toBeLessThanOrEqual(2);
  });
  afterAll(async () => {
    await app.close();
    await storage.deleteValidationResult(fileKey);
    await storage.delete(fileKey);
    await rmdir(directory);
  });

  const resultsPath = '/imports/' + id + '/validation-results';
  it('validates the full workbook once and returns only compact status/summary', async () => {
    const response = await request(app.getHttpServer()).post(path).expect(201);
    expect(response.body).toEqual({
      importId: id,
      status: 'READY',
      summary: { totalRows: 5, validRows: 2, invalidRows: 1, skippedRows: 2 },
    });
    expect(prisma.importJob.updateMany.mock.calls[0][0]).toEqual({
      where: { id, status: 'MAPPING_REQUIRED' },
      data: { status: 'VALIDATING' },
    });
    const stored = JSON.parse(
      (await storage.readValidationResult(fileKey)).toString(),
    );
    expect(stored).toMatchObject({
      version: 1,
      importId: id,
      result: { summary: response.body.summary },
    });
    expect(stored.result.validRows).toEqual([
      { rowNumber: 4, data: { name: 'Shirt', basePrice: '29.90' } },
      { rowNumber: 8, data: { name: 'Tea', basePrice: '0.00' } },
    ]);
    expect(job.errors).toEqual({
      summary: response.body.summary,
      rows: stored.result.invalidRows,
    });
    expect(JSON.stringify(response.body)).not.toContain(fileKey);
    await request(app.getHttpServer()).post(path).expect(409);
    expect(prisma.importJob.updateMany).toHaveBeenCalledTimes(2);
  });
  it('does not depend on pagination query parameters for executing validation', async () => {
    const response = await request(app.getHttpServer())
      .post(path)
      .query({ limit: 'bad', offset: -1 })
      .expect(201);
    expect(response.body).not.toHaveProperty('pagination');
    expect(response.body).not.toHaveProperty('validRows');
    expect(response.body.summary.validRows).toBe(2);
  });
  it('reads first, middle, last, and out-of-range combined pages without workbook reads or state mutations', async () => {
    await request(app.getHttpServer()).post(path).expect(201);
    const before = JSON.stringify(job);
    jest
      .spyOn(storage, 'read')
      .mockRejectedValue(new Error('Workbook must not be read'));
    const excelRead = jest.spyOn(app.get(ExcelAdapter), 'readDataRows');
    const validateRows = jest.spyOn(app.get(RowValidator), 'validate');
    const mutations = prisma.importJob.updateMany.mock.calls.length;
    for (let offset = 0; offset < 4; offset++) {
      const response = await request(app.getHttpServer())
        .get(resultsPath)
        .query({ limit: 1, offset })
        .expect(200);
      expect(response.body.pagination).toEqual({
        limit: 1,
        offset,
        totalCount: 3,
        hasMore: offset < 2,
        nextOffset: offset < 2 ? offset + 1 : null,
      });
      expect(response.body.summary).toEqual({
        totalRows: 5,
        validRows: 2,
        invalidRows: 1,
        skippedRows: 2,
      });
      expect(response.body.validRows.map((row: any) => row.rowNumber)).toEqual(
        offset === 0 ? [4] : offset === 2 ? [8] : [],
      );
      expect(
        response.body.invalidRows.map((row: any) => row.rowNumber),
      ).toEqual(offset === 1 ? [6] : []);
      expect(JSON.stringify(response.body)).not.toContain(fileKey);
    }
    expect(storage.read).not.toHaveBeenCalled();
    expect(excelRead).not.toHaveBeenCalled();
    expect(validateRows).not.toHaveBeenCalled();
    expect(prisma.importJob.updateMany).toHaveBeenCalledTimes(mutations);
    expect(JSON.stringify(job)).toBe(before);
  });
  it('uses default pagination metadata on stored results', async () => {
    await request(app.getHttpServer()).post(path).expect(201);
    const response = await request(app.getHttpServer())
      .get(resultsPath)
      .expect(200);
    expect(response.body.pagination).toEqual({
      limit: 50,
      offset: 0,
      totalCount: 3,
      hasMore: false,
      nextOffset: null,
    });
  });
  it('marks a partially filled final result page complete', async () => {
    await request(app.getHttpServer()).post(path).expect(201);
    const response = await request(app.getHttpServer())
      .get(resultsPath)
      .query({ limit: 2, offset: 2 })
      .expect(200);
    expect(response.body.pagination).toEqual({
      limit: 2,
      offset: 2,
      totalCount: 3,
      hasMore: false,
      nextOffset: null,
    });
    expect(response.body.validRows.map((row: any) => row.rowNumber)).toEqual([
      8,
    ]);
    expect(response.body.invalidRows).toEqual([]);
  });
  it('does not overwrite the immutable snapshot and rejects unsafe storage keys', async () => {
    await request(app.getHttpServer()).post(path).expect(201);
    const before = await storage.readValidationResult(fileKey);
    await expect(
      storage.saveValidationResult(fileKey, Buffer.from('replacement')),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await storage.readValidationResult(fileKey)).toEqual(before);
    await expect(
      storage.saveValidationResult('../outside.xlsx', Buffer.from('data')),
    ).rejects.toThrow('Invalid import file key');
    expect(() => storage.readValidationResult('../outside.xlsx')).toThrow(
      'Invalid import file key',
    );
  });
  it.each(['json', 'version', 'identity', 'counts'])(
    'rejects a corrupt snapshot %s safely without modifying the job',
    async (failure) => {
      await request(app.getHttpServer()).post(path).expect(201);
      const snapshot = JSON.parse(
        (await storage.readValidationResult(fileKey)).toString(),
      );
      if (failure === 'version') snapshot.version = 2;
      if (failure === 'identity') snapshot.importId = 'another-job';
      if (failure === 'counts') snapshot.result.summary.validRows = 99;
      jest
        .spyOn(storage, 'readValidationResult')
        .mockResolvedValue(
          Buffer.from(
            failure === 'json' ? 'not json' : JSON.stringify(snapshot),
          ),
        );
      const before = JSON.stringify(job);
      const response = await request(app.getHttpServer())
        .get(resultsPath)
        .expect(500);
      expect(response.body.code).toBe('INTERNAL_SERVER_ERROR');
      expect(JSON.stringify(response.body)).not.toContain(fileKey);
      expect(JSON.stringify(job)).toBe(before);
    },
  );
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
  ])(
    'rejects invalid results pagination %j before reading the job',
    async (query) => {
      const response = await request(app.getHttpServer())
        .get(resultsPath)
        .query(query)
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(prisma.importJob.findUnique).not.toHaveBeenCalled();
      expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
    },
  );
  it('detects duplicate external keys across result pages and persists both occurrences', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Products');
    sheet.getRow(3).values = ['Name', 'Price', 'SKU'];
    sheet.getRow(4).values = ['First', 10, 'DUP'];
    sheet.getRow(5).values = ['Second', 10, 'OTHER'];
    sheet.getRow(6).values = ['Last', 10, 'DUP'];
    job.mapping = [
      ...mapping,
      {
        sourceColumn: 'SKU',
        sourceColumnIndex: 3,
        type: MappingType.STANDARD,
        target: 'externalKey',
      },
    ];
    jest
      .spyOn(storage, 'read')
      .mockResolvedValue(Buffer.from(await workbook.xlsx.writeBuffer()));
    const response = await request(app.getHttpServer()).post(path).expect(201);
    expect(response.body.summary).toEqual({
      totalRows: 3,
      validRows: 1,
      invalidRows: 2,
      skippedRows: 0,
    });
    for (const offset of [0, 2]) {
      const page = await request(app.getHttpServer())
        .get(resultsPath)
        .query({ limit: 1, offset })
        .expect(200);
      expect(page.body.invalidRows[0]).toMatchObject({
        rowNumber: offset + 4,
        errors: [expect.objectContaining({ code: 'DUPLICATE_EXTERNAL_KEY' })],
      });
    }
    expect((job.errors as any).rows.map((row: any) => row.rowNumber)).toEqual([
      4, 6,
    ]);
  });
  it('returns stored results consistently across service restarts and later states even if counters/errors change', async () => {
    await request(app.getHttpServer()).post(path).expect(201);
    const restarted = new ValidationService(
      prisma as any,
      new LocalImportFileStorage(
        new ConfigService({ IMPORT_STORAGE_DIR: directory }),
      ),
      app.get(ExcelAdapter),
      app.get(RowValidator),
    );
    job.errors = { execution: [] };
    job.validRows = 999;
    for (const status of [
      'READY',
      'IMPORTING',
      'COMPLETED',
      'COMPLETED_WITH_ERRORS',
      'FAILED',
      'CANCELLED',
    ]) {
      job.status = status;
      const response = await restarted.results(id, { limit: 1, offset: 1 });
      expect(response.status).toBe(status);
      expect(response.summary.validRows).toBe(2);
      expect(response.invalidRows[0].rowNumber).toBe(6);
    }
    job.status = 'READY';
  });
  it.each(['UPLOADED', 'ANALYZING', 'MAPPING_REQUIRED', 'VALIDATING'])(
    'returns a stable unavailable conflict before results exist in %s',
    async (status) => {
      job.status = status;
      const response = await request(app.getHttpServer())
        .get(resultsPath)
        .expect(409);
      expect(response.body.code).toBe('IMPORT_VALIDATION_RESULTS_UNAVAILABLE');
      expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
    },
  );
  it('returns a conflict for a legacy READY job without a snapshot', async () => {
    job.status = 'READY';
    const response = await request(app.getHttpServer())
      .get(resultsPath)
      .expect(409);
    expect(response.body.code).toBe('IMPORT_VALIDATION_RESULTS_UNAVAILABLE');
    job.status = 'MAPPING_REQUIRED';
  });
  it('returns 404 for a missing results job and 400 for an invalid UUID', async () => {
    prisma.importJob.findUnique.mockResolvedValue(null);
    const missing = await request(app.getHttpServer())
      .get(resultsPath)
      .expect(404);
    expect(missing.body.code).toBe('IMPORT_JOB_NOT_FOUND');
    const invalid = await request(app.getHttpServer())
      .get('/imports/invalid/validation-results')
      .expect(400);
    expect(invalid.body.code).toBe('VALIDATION_ERROR');
  });
  it('reports snapshot storage errors safely without changing READY', async () => {
    await request(app.getHttpServer()).post(path).expect(201);
    jest
      .spyOn(storage, 'readValidationResult')
      .mockRejectedValue(new Error('private ' + fileKey));
    const response = await request(app.getHttpServer())
      .get(resultsPath)
      .expect(500);
    expect(response.body.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(response.body)).not.toContain(fileKey);
    expect(job.status).toBe('READY');
  });
  it('fails validation if saving the immutable snapshot fails', async () => {
    jest
      .spyOn(storage, 'saveValidationResult')
      .mockRejectedValue(new Error('disk full'));
    const response = await request(app.getHttpServer()).post(path).expect(500);
    expect(response.body.code).toBe('IMPORT_VALIDATION_FAILED');
    expect(job.status).toBe('FAILED');
  });

  it.each(['READY', 'VALIDATING', 'FAILED', 'IMPORTING'])(
    'rejects status %s before claiming',
    async (status) => {
      job.status = status;
      await request(app.getHttpServer()).post(path).expect(409);
      expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'finishes READY when there are no valid rows (blank=%s)',
    async (blank) => {
      const excel = app.get(ExcelAdapter);
      jest.spyOn(excel, 'readDataRows').mockResolvedValue({
        headers: ['Name', 'Price'],
        rows: [
          { rowNumber: 4, values: [null, blank ? null : -1], isEmpty: blank },
        ],
      });
      const response = await request(app.getHttpServer())
        .post(path)
        .expect(201);
      expect(response.body.status).toBe('READY');
      expect(response.body.summary).toEqual({
        totalRows: 1,
        validRows: 0,
        invalidRows: blank ? 0 : 1,
        skippedRows: blank ? 1 : 0,
      });
    },
  );

  it('does not skip a populated formula row that lacks a cached name', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Products');
    sheet.getRow(3).values = ['Name', 'Price'];
    sheet.getCell('A4').value = { formula: '"Shirt"' };
    jest
      .spyOn(storage, 'read')
      .mockResolvedValue(Buffer.from(await workbook.xlsx.writeBuffer()));
    const response = await request(app.getHttpServer()).post(path).expect(201);
    expect(response.body.summary).toEqual({
      totalRows: 1,
      validRows: 0,
      invalidRows: 1,
      skippedRows: 0,
    });
    expect((job.errors as any).rows[0].errors).toContainEqual(
      expect.objectContaining({ field: 'name', code: 'REQUIRED' }),
    );
  });

  it.each([null, []])('requires confirmed mapping %j', async (saved) => {
    job.mapping = saved;
    await request(app.getHttpServer()).post(path).expect(409);
    expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing import', async () => {
    prisma.importJob.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer()).post(path).expect(404);
    expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
  });

  it('rejects malformed UUIDs', async () => {
    await request(app.getHttpServer())
      .post('/imports/invalid/validate')
      .expect(400);
    expect(prisma.importJob.findUnique).not.toHaveBeenCalled();
  });

  it('guards a lost atomic claim without marking another run FAILED', async () => {
    prisma.importJob.updateMany.mockResolvedValue({ count: 0 });
    await request(app.getHttpServer()).post(path).expect(409);
    expect(prisma.importJob.updateMany).toHaveBeenCalledTimes(1);
  });

  it('prevents concurrent validation and mapping changes while processing', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalRead = storage.read.bind(storage);
    jest.spyOn(storage, 'read').mockImplementation(async (key) => {
      entered();
      await waiting;
      return originalRead(key);
    });
    const first = request(app.getHttpServer())
      .post(path)
      .then((response) => response);
    await started;
    try {
      await request(app.getHttpServer()).post(path).expect(409);
      await request(app.getHttpServer())
        .patch(`/imports/${id}/mapping`)
        .send({
          mapping: [{ sourceColumn: 'Name', type: 'STANDARD', target: 'name' }],
        })
        .expect(409);
    } finally {
      release();
    }
    expect((await first).status).toBe(201);
  });

  it('reloads mapping after the claim to include a confirmation that won before it', async () => {
    const originalUpdate = prisma.importJob.updateMany.getMockImplementation()!;
    prisma.importJob.updateMany.mockImplementation(async (args) => {
      if (args.data.status === 'VALIDATING')
        job.mapping = [
          mapping[0],
          { ...mapping[1], type: MappingType.IGNORE, target: null },
        ];
      return originalUpdate(args);
    });
    const response = await request(app.getHttpServer()).post(path).expect(201);
    expect((job.errors as any).rows[0].errors).toEqual([
      expect.objectContaining({ field: 'name' }),
    ]);
    const stored = JSON.parse(
      (await storage.readValidationResult(fileKey)).toString(),
    );
    expect(stored.result.validRows[0].data).not.toHaveProperty('basePrice');
  });

  it.each(['storage', 'workbook', 'metadata', 'mapping'])(
    'marks processing failure %s FAILED without leaking keys',
    async (failure) => {
      if (failure === 'storage')
        jest
          .spyOn(storage, 'read')
          .mockRejectedValue(new Error(`Missing ${fileKey}`));
      if (failure === 'workbook')
        jest
          .spyOn(storage, 'read')
          .mockResolvedValue(Buffer.from('not a workbook'));
      if (failure === 'metadata') job.fileKey = null;
      if (failure === 'mapping')
        job.mapping = [{ ...mapping[0], sourceColumnIndex: 2 }, mapping[1]];
      const response = await request(app.getHttpServer())
        .post(path)
        .expect(500);
      expect(job.status).toBe('FAILED');
      expect(job.errors).toEqual({
        code: 'VALIDATION_FAILED',
        message: 'Workbook validation could not be completed',
      });
      expect(JSON.stringify(response.body)).not.toContain(fileKey);
      expect(
        prisma.importJob.updateMany.mock.calls.map(
          ([args]) => args.data.status,
        ),
      ).toEqual(['VALIDATING', 'FAILED']);
    },
  );

  it('marks failed persistence of results FAILED when the database is available again', async () => {
    const originalUpdate = prisma.importJob.updateMany.getMockImplementation()!;
    prisma.importJob.updateMany.mockImplementation(async (args) => {
      if (args.data.status === 'READY')
        throw new Error('Database write failed');
      return originalUpdate(args);
    });
    await request(app.getHttpServer()).post(path).expect(500);
    expect(job.status).toBe('FAILED');
    expect(await readdir(directory)).toEqual([fileKey]);
  });
});
