import { HttpAdapterHost } from '@nestjs/core';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbook } from 'exceljs';
import request from 'supertest';
import { ExcelAdapter } from '../../src/imports/adapters/excel.adapter';
import { ImportsController } from '../../src/imports/imports.controller';
import { ImportsService } from '../../src/imports/imports.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { Prisma } from '../../src/generated/prisma/client';
import { ImportFileStorage } from '../../src/imports/storage/import-file.storage';
import { LocalImportFileStorage } from '../../src/imports/storage/local-import-file.storage';

describe('Excel analysis HTTP API (real ExcelJS, mocked database)', () => {
  let app: INestApplication;
  let buffer: Buffer;
  let storageDirectory: string;
  let storage: LocalImportFileStorage;
  const businessId = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const path = `/businesses/${businessId}/imports/excel/analyze`;
  const prisma = {
    business: { findUnique: jest.fn() },
    importJob: { create: jest.fn() },
    catalogItem: {
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeAll(async () => {
    storageDirectory = await mkdtemp(join(tmpdir(), 'brandora-imports-http-'));
    storage = new LocalImportFileStorage(
      new ConfigService({ IMPORT_STORAGE_DIR: storageDirectory }),
    );
    const module = await Test.createTestingModule({
      controllers: [ImportsController],
      providers: [
        ImportsService,
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
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Products');
    sheet.getCell('A1').value = 'Brandora catalog';
    sheet.getRow(3).values = ['Name', 'Price', 'Active'];
    sheet.getRow(4).values = ['Coffee', 49.9, true];
    // Leave row 5 blank to verify physical row numbers and non-empty counts.
    for (let i = 6; i <= 11; i++)
      sheet.getRow(i).values = [`Product ${i}`, i, false];
    workbook.addWorksheet('Other').addRows([
      ['Name', 'Date'],
      ['Tea', new Date('2026-10-05T00:00:00Z')],
    ]);
    workbook.addWorksheet('Empty');
    buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.business.findUnique.mockResolvedValue({ id: businessId });
    prisma.importJob.create.mockResolvedValue({
      id: 'job-id',
      status: 'MAPPING_REQUIRED',
    });
  });
  afterAll(async () => {
    await app.close();
    await rmdir(storageDirectory);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const key of await readdir(storageDirectory))
      await storage.delete(key);
    expect(prisma.catalogItem.create).not.toHaveBeenCalled();
    expect(prisma.catalogItem.createMany).not.toHaveBeenCalled();
    expect(prisma.catalogItem.update).not.toHaveBeenCalled();
  });

  it('detects a header after a title/blank row, returns five samples, and records a job', async () => {
    const response = await request(app.getHttpServer())
      .post(path)
      .attach('file', buffer, 'catalog.xlsx')
      .expect(201);
    expect(response.body).toMatchObject({
      importJobId: 'job-id',
      status: 'MAPPING_REQUIRED',
      sheetNames: ['Products', 'Other', 'Empty'],
      selectedSheetName: 'Products',
      headerRow: 3,
      headers: ['Name', 'Price', 'Active'],
      totalRows: 7,
    });
    expect(response.body.sampleRows).toHaveLength(5);
    expect(response.body.sampleRows[0]).toEqual({
      rowNumber: 4,
      values: ['Coffee', 49.9, true],
    });
    expect(response.body.sampleRows[1].rowNumber).toBe(6);
    expect(prisma.importJob.create).toHaveBeenCalledWith({
      data: {
        businessId,
        sourceType: 'EXCEL',
        status: 'MAPPING_REQUIRED',
        fileName: 'catalog.xlsx',
        fileKey: expect.any(String),
        sheetName: 'Products',
        headerRow: 3,
        totalRows: 7,
      },
      select: { id: true, status: true },
    });
    const fileKey = prisma.importJob.create.mock.calls[0][0].data.fileKey;
    expect(await readdir(storageDirectory)).toEqual([fileKey]);
    // A new adapter instance can read the exact upload without another request.
    const restartedStorage = new LocalImportFileStorage(
      new ConfigService({ IMPORT_STORAGE_DIR: storageDirectory }),
    );
    expect(await restartedStorage.read(fileKey)).toEqual(buffer);
    expect(response.body).not.toHaveProperty('fileKey');
  });

  it('selects an explicit sheet and returns fewer samples when fewer rows exist', async () => {
    const response = await request(app.getHttpServer())
      .post(path)
      .field('sheetName', 'Other')
      .attach('file', buffer, 'catalog.xlsx')
      .expect(201);
    expect(response.body.selectedSheetName).toBe('Other');
    expect(response.body.sampleRows).toEqual([
      { rowNumber: 2, values: ['Tea', '2026-10-05T00:00:00.000Z'] },
    ]);
  });

  it.each(['Missing', 'Empty'])(
    'rejects unusable sheet %s without creating a job',
    async (sheetName) => {
      await request(app.getHttpServer())
        .post(path)
        .field('sheetName', sheetName)
        .attach('file', buffer, 'catalog.xlsx')
        .expect(400);
      expect(prisma.importJob.create).not.toHaveBeenCalled();
      expect(await readdir(storageDirectory)).toEqual([]);
    },
  );

  it.each([
    ['catalog.xls', Buffer.from('not excel')],
    ['catalog.xlsx', Buffer.from('not excel')],
    ['catalog.xlsx', Buffer.from([0x50])],
    ['catalog.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])],
  ])('rejects invalid file %s', async (filename, content) => {
    await request(app.getHttpServer())
      .post(path)
      .attach('file', content, filename)
      .expect(400);
    expect(prisma.importJob.create).not.toHaveBeenCalled();
    expect(await readdir(storageDirectory)).toEqual([]);
  });

  it('cleans up the saved workbook if job creation fails', async () => {
    prisma.importJob.create.mockRejectedValue(
      new Error('Database unavailable'),
    );
    await request(app.getHttpServer())
      .post(path)
      .attach('file', buffer, 'catalog.xlsx')
      .expect(500);
    expect(await readdir(storageDirectory)).toEqual([]);
  });

  it('cleans up the workbook if the business is deleted before job creation', async () => {
    prisma.importJob.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed',
        { code: 'P2003', clientVersion: '7' },
      ),
    );
    await request(app.getHttpServer())
      .post(path)
      .attach('file', buffer, 'catalog.xlsx')
      .expect(404);
    expect(await readdir(storageDirectory)).toEqual([]);
  });

  it('cleans up the saved workbook if reading it fails', async () => {
    jest.spyOn(storage, 'read').mockRejectedValue(new Error('Read failed'));
    await request(app.getHttpServer())
      .post(path)
      .attach('file', buffer, 'catalog.xlsx')
      .expect(500);
    expect(prisma.importJob.create).not.toHaveBeenCalled();
    expect(await readdir(storageDirectory)).toEqual([]);
  });

  it('does not create a job if storing the upload fails', async () => {
    jest
      .spyOn(storage, 'save')
      .mockRejectedValue(new Error('Storage unavailable'));
    await request(app.getHttpServer())
      .post(path)
      .attach('file', buffer, 'catalog.xlsx')
      .expect(500);
    expect(prisma.importJob.create).not.toHaveBeenCalled();
    expect(await readdir(storageDirectory)).toEqual([]);
  });

  it('requires the file', async () => {
    await request(app.getHttpServer()).post(path).expect(400);
    expect(prisma.importJob.create).not.toHaveBeenCalled();
  });

  it('rejects files larger than 10 MiB', async () => {
    await request(app.getHttpServer())
      .post(path)
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), 'catalog.xlsx')
      .expect(413);
    expect(prisma.importJob.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid business UUID', async () => {
    await request(app.getHttpServer())
      .post('/businesses/invalid/imports/excel/analyze')
      .attach('file', buffer, 'catalog.xlsx')
      .expect(400);
    expect(prisma.importJob.create).not.toHaveBeenCalled();
  });

  it('returns 404 for a nonexistent business', async () => {
    prisma.business.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .post(path)
      .attach('file', buffer, 'catalog.xlsx')
      .expect(404);
    expect(prisma.importJob.create).not.toHaveBeenCalled();
  });
});
