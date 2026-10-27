import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ExcelAdapter } from '../../src/imports/adapters/excel.adapter';
import { ImportJobsController } from '../../src/imports/import-jobs.controller';
import { ImportsService } from '../../src/imports/imports.service';
import { ImportFileStorage } from '../../src/imports/storage/import-file.storage';

describe('Import status and history HTTP API', () => {
  const businessId = 'c06a904b-14a7-4de7-98c9-9cac5bb4559b';
  const otherBusiness = 'b2621a53-0797-4b1d-84f9-5f9a41697f5c';
  const id = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const historyPath = `/businesses/${businessId}/imports`;
  const fields = [
    'id',
    'businessId',
    'status',
    'fileName',
    'sheetName',
    'headerRow',
    'totalRows',
    'validRows',
    'invalidRows',
    'skippedRows',
    'insertedCount',
    'updatedCount',
    'failedCount',
    'createdAt',
    'updatedAt',
  ].sort();
  let app: INestApplication;
  let jobs: any[];
  const prisma = {
    business: { findUnique: jest.fn() },
    importJob: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const excel = { analyze: jest.fn() };
  const storage = { read: jest.fn(), save: jest.fn(), delete: jest.fn() };
  const record = (overrides = {}) => ({
    id,
    businessId,
    status: 'COMPLETED_WITH_ERRORS',
    fileName: 'Products.xlsx',
    sheetName: 'Products',
    headerRow: 3,
    totalRows: 5,
    validRows: 3,
    invalidRows: 1,
    skippedRows: 1,
    insertedCount: 1,
    updatedCount: 1,
    failedCount: 1,
    createdAt: new Date('2026-10-09T10:00:00Z'),
    updatedAt: new Date('2026-10-09T11:00:00Z'),
    fileKey: 'private-workbook-key',
    mapping: [],
    errors: { private: 'details' },
    ...overrides,
  });
  const project = (job: any, select: Record<string, boolean>) =>
    Object.fromEntries(
      Object.entries(select)
        .filter(([, included]) => included)
        .map(([key]) => [key, job[key]]),
    );

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ImportJobsController],
      providers: [
        ImportsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ExcelAdapter, useValue: excel },
        { provide: ImportFileStorage, useValue: storage },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
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
  beforeEach(() => {
    jest.resetAllMocks();
    jobs = [record()];
    prisma.business.findUnique.mockImplementation(async ({ where }) =>
      where.id === businessId ? { id: businessId } : null,
    );
    prisma.importJob.findUnique.mockImplementation(
      async ({ where, select }) => {
        const job = jobs.find((job) => job.id === where.id);
        return job ? project(job, select) : null;
      },
    );
    prisma.importJob.count.mockImplementation(
      async ({ where }) =>
        jobs.filter((job) => job.businessId === where.businessId).length,
    );
    prisma.importJob.findMany.mockImplementation(
      async ({ where, select, skip, take }) =>
        jobs
          .filter((job) => job.businessId === where.businessId)
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.id.localeCompare(a.id),
          )
          .slice(skip, skip + take)
          .map((job) => project(job, select)),
    );
  });
  afterEach(() => {
    expect(prisma.importJob.create).not.toHaveBeenCalled();
    expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
    for (const mock of [...Object.values(storage), ...Object.values(excel)])
      expect(mock).not.toHaveBeenCalled();
  });
  afterAll(async () => {
    await app.close();
  });
  async function expectCode(call: request.Test, status: number, code: string) {
    const response = await call.expect(status);
    expect(response.body).toMatchObject({ statusCode: status, code });
    expect(Object.keys(response.body).sort()).toEqual([
      'code',
      'error',
      'message',
      'statusCode',
    ]);
  }
  it('returns only the compact status contract including final execution counts', async () => {
    const response = await request(app.getHttpServer())
      .get(`/imports/${id}`)
      .expect(200);
    expect(Object.keys(response.body).sort()).toEqual(fields);
    expect(response.body).toMatchObject({
      id,
      businessId,
      status: 'COMPLETED_WITH_ERRORS',
      insertedCount: 1,
      updatedCount: 1,
      failedCount: 1,
      headerRow: 3,
    });
    expect(
      Object.keys(prisma.importJob.findUnique.mock.calls[0][0].select).sort(),
    ).toEqual(fields);
    expect(JSON.stringify(response.body)).not.toMatch(
      /private|fileKey|storage|mapping|errors/,
    );
  });
  it('returns IMPORT_JOB_NOT_FOUND for a missing job', async () => {
    jobs = [];
    await expectCode(
      request(app.getHttpServer()).get(`/imports/${id}`),
      404,
      'IMPORT_JOB_NOT_FOUND',
    );
  });
  it('rejects an invalid import UUID before querying', async () => {
    await expectCode(
      request(app.getHttpServer()).get('/imports/invalid'),
      400,
      'VALIDATION_ERROR',
    );
    expect(prisma.importJob.findUnique).not.toHaveBeenCalled();
  });
  it('returns an empty pagination envelope for an existing business with no imports', async () => {
    jobs = [];
    const response = await request(app.getHttpServer())
      .get(historyPath)
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
  });
  it('returns BUSINESS_NOT_FOUND instead of [] for a nonexistent business', async () => {
    await expectCode(
      request(app.getHttpServer()).get(`/businesses/${otherBusiness}/imports`),
      404,
      'BUSINESS_NOT_FOUND',
    );
    expect(prisma.importJob.findMany).not.toHaveBeenCalled();
  });
  it('rejects an invalid business UUID before querying', async () => {
    await expectCode(
      request(app.getHttpServer()).get('/businesses/invalid/imports'),
      400,
      'VALIDATION_ERROR',
    );
    expect(prisma.business.findUnique).not.toHaveBeenCalled();
  });
  it('orders newest first with an ID tie-break and excludes other businesses and private fields', async () => {
    jobs = [
      record({ id: 'old', createdAt: new Date('2026-10-08') }),
      record({ id: 'new-a' }),
      record({ id: 'new-b' }),
      record({
        id: 'foreign',
        businessId: otherBusiness,
        createdAt: new Date('2026-10-10'),
      }),
    ];
    const response = await request(app.getHttpServer())
      .get(historyPath)
      .expect(200);
    expect(response.body.items.map((job: any) => job.id)).toEqual([
      'new-b',
      'new-a',
      'old',
    ]);
    for (const job of response.body.items)
      expect(Object.keys(job).sort()).toEqual(fields);
    expect(JSON.stringify(response.body)).not.toMatch(
      /private|fileKey|storage|mapping|errors/,
    );
    expect(prisma.importJob.findMany.mock.calls[0][0]).toMatchObject({
      where: { businessId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
      skip: 0,
    });
    expect(
      Object.keys(prisma.importJob.findMany.mock.calls[0][0].select).sort(),
    ).toEqual(fields);
  });
  it('applies default history page size 20', async () => {
    jobs = Array.from({ length: 25 }, (_, i) => record({ id: String(i) }));
    const response = await request(app.getHttpServer())
      .get(historyPath)
      .expect(200);
    expect(response.body.items).toHaveLength(20);
    expect(response.body.pagination).toEqual({
      limit: 20,
      offset: 0,
      totalCount: 25,
      hasMore: true,
      nextOffset: 20,
    });
  });
  it('supports custom pagination and out-of-range offsets', async () => {
    jobs = [record({ id: 'c' }), record({ id: 'b' }), record({ id: 'a' })];
    const response = await request(app.getHttpServer())
      .get(historyPath)
      .query({ limit: 1, offset: 1 })
      .expect(200);
    expect(response.body.items.map((job: any) => job.id)).toEqual(['b']);
    expect(prisma.importJob.findMany.mock.calls[0][0]).toMatchObject({
      take: 1,
      skip: 1,
    });
    expect(response.body.pagination).toEqual({
      limit: 1,
      offset: 1,
      totalCount: 3,
      hasMore: true,
      nextOffset: 2,
    });
    const last = await request(app.getHttpServer())
      .get(historyPath)
      .query({ limit: 2, offset: 2 })
      .expect(200);
    expect(last.body.items.map((job: any) => job.id)).toEqual(['a']);
    expect(last.body.pagination).toEqual({
      limit: 2,
      offset: 2,
      totalCount: 3,
      hasMore: false,
      nextOffset: null,
    });
    expect(prisma.importJob.count).toHaveBeenCalledWith({
      where: { businessId },
    });
    const beyond = await request(app.getHttpServer())
      .get(historyPath)
      .query({ offset: 99 })
      .expect(200);
    expect(beyond.body).toEqual({
      pagination: {
        limit: 20,
        offset: 99,
        totalCount: 3,
        hasMore: false,
        nextOffset: null,
      },
      items: [],
    });
  });
  it('accepts a safe offset far beyond the end without passing it to the database', async () => {
    const response = await request(app.getHttpServer())
      .get(historyPath)
      .query({ offset: Number.MAX_SAFE_INTEGER })
      .expect(200);
    expect(response.body).toEqual({
      pagination: {
        limit: 20,
        offset: Number.MAX_SAFE_INTEGER,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
      },
      items: [],
    });
    expect(prisma.importJob.findMany).not.toHaveBeenCalled();
  });
  it.each([
    { limit: 101 },
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: 'bad' },
    { offset: -1 },
    { offset: 1.5 },
    { offset: 'bad' },
    { offset: '9007199254740992' },
    { unknown: 1 },
  ])('rejects invalid history pagination %j', async (query) => {
    await expectCode(
      request(app.getHttpServer()).get(historyPath).query(query),
      400,
      'VALIDATION_ERROR',
    );
    expect(prisma.business.findUnique).not.toHaveBeenCalled();
    expect(prisma.importJob.findMany).not.toHaveBeenCalled();
  });
});
