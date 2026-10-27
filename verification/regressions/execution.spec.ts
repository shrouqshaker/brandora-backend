import { HttpAdapterHost } from '@nestjs/core';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Workbook } from 'exceljs';
import request from 'supertest';
import { Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { ExecutionController } from '../../src/imports/execution.controller';
import { ExecutionService } from '../../src/imports/execution.service';
import { ExcelAdapter } from '../../src/imports/adapters/excel.adapter';
import { ImportPlanner } from '../../src/imports/preview/import-planner';
import { ImportFileStorage } from '../../src/imports/storage/import-file.storage';
import { RowNormalizer } from '../../src/imports/validation/row-normalizer';
import { RowValidator } from '../../src/imports/validation/row-validator';

describe('Import execution (real workbook, planner and inventory, transactional database double)', () => {
  const id = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const businessId = 'c06a904b-14a7-4de7-98c9-9cac5bb4559b';
  const path = `/imports/${id}/execute`;
  const headers = [
    'SKU',
    'Name',
    'Description',
    'Category',
    'Price',
    'Quantity',
    'Material',
    'Size',
    'Notes',
  ];
  const targets = [
    'externalKey',
    'name',
    'description',
    'category',
    'basePrice',
    'stockQuantity',
    'material',
    'size',
    null,
  ];
  const mapping = headers.map((sourceColumn, index) => ({
    sourceColumn,
    sourceColumnIndex: index + 1,
    type:
      index < 6
        ? 'STANDARD'
        : index === 6
          ? 'ATTRIBUTE'
          : index === 7
            ? 'VARIANT_ATTRIBUTE'
            : 'IGNORE',
    target: targets[index],
  }));
  let app: INestApplication;
  let job: any;
  let catalog: any[];
  let movements: any[];
  let failAudit: boolean;
  let transactionError: string | undefined;
  let failName: string | undefined;
  const storage = { read: jest.fn(), save: jest.fn(), delete: jest.fn() };
  const tx = {
    catalogItem: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    inventoryMovement: { create: jest.fn() },
  };
  const prisma = {
    importJob: { findUnique: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const existing = (overrides: any = {}) => ({
    id: 'existing',
    businessId,
    externalKey: 'SKU1',
    name: 'Product',
    description: 'Keep description',
    category: 'Keep category',
    basePrice: new Prisma.Decimal('12.50'),
    stockQuantity: 5,
    trackInventory: true,
    attributes: { material: 'Cotton', color: 'Blue' },
    isActive: false,
    ...overrides,
  });
  async function workbook(rows: unknown[][]) {
    const book = new Workbook();
    const sheet = book.addWorksheet('Products');
    sheet.getRow(1).values = ['Not the header'];
    sheet.getRow(3).values = headers;
    rows.forEach((row, index) => {
      sheet.getRow(index + 4).values = row as any;
    });
    book.addWorksheet('Other').addRows([['Name'], ['Wrong product']]);
    storage.read.mockResolvedValue(Buffer.from(await book.xlsx.writeBuffer()));
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ExecutionController],
      providers: [
        ExecutionService,
        ExcelAdapter,
        ImportPlanner,
        RowNormalizer,
        RowValidator,
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: ImportFileStorage, useValue: storage },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    app.useLogger(false);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    jest.resetAllMocks();
    catalog = [];
    movements = [];
    failAudit = false;
    transactionError = undefined;
    failName = undefined;
    job = {
      id,
      businessId,
      status: 'READY',
      fileKey: 'private-file-key',
      sheetName: 'Products',
      headerRow: 3,
      mapping,
    };
    prisma.importJob.findUnique.mockImplementation(
      async () => job && { ...job },
    );
    prisma.importJob.updateMany.mockImplementation(async ({ where, data }) => {
      if (!job || where.status !== job.status) return { count: 0 };
      Object.assign(job, data);
      return { count: 1 };
    });
    // Stage row writes and publish only on successful callback completion.
    prisma.$transaction.mockImplementation(async (callback, options) => {
      expect(options).toEqual({ isolationLevel: 'Serializable' });
      if (transactionError)
        throw Object.assign(new Error('private database details'), {
          code: transactionError,
        });
      const staged = catalog.map((item) => ({ ...item }));
      const audits: any[] = [];
      tx.catalogItem.findUnique.mockImplementation(async ({ where }) => {
        const identity = where.businessId_externalKey;
        return (
          staged.find(
            (item) =>
              item.businessId === identity.businessId &&
              item.externalKey === identity.externalKey,
          ) ?? null
        );
      });
      tx.catalogItem.create.mockImplementation(async ({ data }) => {
        if (data.name === failName) throw new Error('private database details');
        expect(data).not.toHaveProperty('stockQuantity');
        expect(data).not.toHaveProperty('variantAttributes');
        expect(data).not.toHaveProperty('isActive');
        const item = existing({
          id: `created-${staged.length}`,
          externalKey: null,
          description: null,
          category: null,
          basePrice: null,
          stockQuantity: null,
          trackInventory: false,
          attributes: null,
          isActive: true,
          ...data,
        });
        staged.push(item);
        return { id: item.id };
      });
      tx.catalogItem.update.mockImplementation(async ({ where, data }) => {
        expect(data).not.toHaveProperty('stockQuantity');
        expect(data).not.toHaveProperty('variantAttributes');
        expect(data).not.toHaveProperty('isActive');
        const item = staged.find((item) => item.id === where.id);
        Object.assign(item, data);
        return item;
      });
      tx.catalogItem.findFirst.mockImplementation(async ({ where }) => {
        const item = staged.find(
          (item) =>
            item.id === where.id && item.businessId === where.businessId,
        );
        return item ? { stockQuantity: item.stockQuantity } : null;
      });
      tx.catalogItem.updateMany.mockImplementation(async ({ where, data }) => {
        const item = staged.find(
          (item) =>
            item.id === where.id &&
            item.businessId === where.businessId &&
            item.stockQuantity === where.stockQuantity,
        );
        if (!item) return { count: 0 };
        Object.assign(item, data);
        return { count: 1 };
      });
      tx.inventoryMovement.create.mockImplementation(async ({ data }) => {
        if (failAudit) throw new Error('private audit failure');
        audits.push(data);
        return { id: `audit-${audits.length}` };
      });
      const result = await callback(tx);
      catalog = staged;
      movements.push(...audits);
      return result;
    });
    await workbook([['SKU1', 'Product']]);
  });
  afterEach(() => {
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
    expect(tx.catalogItem.delete).not.toHaveBeenCalled();
    expect(tx.catalogItem.deleteMany).not.toHaveBeenCalled();
  });

  it('inserts only mapped non-null data, ignores variant/notes, and completes', async () => {
    await workbook([
      ['SKU1', 'Product', null, null, '12.50', null, 'Cotton', 'XL', 'Ignore'],
    ]);
    const response = await request(app.getHttpServer()).post(path).expect(200);
    expect(response.body).toMatchObject({
      status: 'COMPLETED',
      summary: {
        totalRows: 1,
        validRows: 1,
        invalidRows: 0,
        skippedRows: 0,
        insertedCount: 1,
        updatedCount: 0,
        failedCount: 0,
        unchangedCount: 0,
      },
      inserted: [{ rowNumber: 4 }],
    });
    expect(catalog[0]).toMatchObject({
      businessId,
      externalKey: 'SKU1',
      name: 'Product',
      basePrice: '12.50',
      attributes: { material: 'Cotton' },
      stockQuantity: null,
      trackInventory: false,
      isActive: true,
    });
    expect(storage.read).toHaveBeenCalledWith('private-file-key');
    expect(JSON.stringify(response.body)).not.toContain('private');
    expect(job).toMatchObject({ status: 'COMPLETED', insertedCount: 1 });
  });

  it('updates current scoped values and merges attributes without blank overwrites or reactivation', async () => {
    catalog = [existing()];
    await workbook([
      ['SKU1', 'New Product', ' ', null, null, null, 'Linen', 'XL'],
    ]);
    const response = await request(app.getHttpServer()).post(path).expect(200);
    expect(response.body.summary.updatedCount).toBe(1);
    expect(catalog[0]).toMatchObject({
      name: 'New Product',
      description: 'Keep description',
      category: 'Keep category',
      stockQuantity: 5,
      trackInventory: true,
      attributes: { material: 'Linen', color: 'Blue' },
      isActive: false,
    });
    expect(catalog[0].basePrice.toFixed(2)).toBe('12.50');
    expect(movements).toEqual([]);
  });

  it('counts unchanged rows separately, preserving blanks and ignoring variant changes', async () => {
    catalog = [existing()];
    await workbook([
      ['SKU1', 'Product', null, null, '12.50', null, ' ', 'New size'],
    ]);
    const response = await request(app.getHttpServer()).post(path).expect(200);
    expect(response.body.summary).toMatchObject({
      insertedCount: 0,
      updatedCount: 0,
      unchangedCount: 1,
    });
    expect(tx.catalogItem.update).not.toHaveBeenCalled();
    expect(tx.catalogItem.updateMany).not.toHaveBeenCalled();
  });

  it.each([0, 8])(
    'initializes new stock %i through InventoryService in the same row transaction',
    async (quantity) => {
      await workbook([['SKU1', 'Product', null, null, null, quantity]]);
      await request(app.getHttpServer()).post(path).expect(200);
      expect(catalog[0]).toMatchObject({
        trackInventory: true,
        stockQuantity: quantity,
      });
      expect(movements).toEqual([
        expect.objectContaining({
          type: 'INITIAL_IMPORT',
          businessId,
          catalogItemId: catalog[0].id,
          quantityBefore: null,
          quantityAfter: quantity,
          quantityDelta: quantity,
          referenceType: 'IMPORT_JOB',
          referenceId: id,
        }),
      ]);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    },
  );

  it.each([0, 12])(
    'updates existing stock to %i and enables tracking with IMPORT_UPDATE audit',
    async (quantity) => {
      catalog = [existing({ trackInventory: false })];
      await workbook([['SKU1', 'Product', null, null, null, quantity]]);
      const response = await request(app.getHttpServer())
        .post(path)
        .expect(200);
      expect(response.body.summary.updatedCount).toBe(1);
      expect(catalog[0]).toMatchObject({
        stockQuantity: quantity,
        trackInventory: true,
      });
      expect(movements[0]).toMatchObject({
        type: 'IMPORT_UPDATE',
        quantityBefore: 5,
        quantityAfter: quantity,
        quantityDelta: quantity - 5,
        referenceType: 'IMPORT_JOB',
        referenceId: id,
      });
    },
  );

  it('enables tracking even if supplied stock is already equal, without an unnecessary movement', async () => {
    catalog = [existing({ trackInventory: false })];
    await workbook([['SKU1', 'Product', null, null, null, 5]]);
    const response = await request(app.getHttpServer()).post(path).expect(200);
    expect(response.body.summary.updatedCount).toBe(1);
    expect(catalog[0].trackInventory).toBe(true);
    expect(movements).toEqual([]);
  });

  it('equal stock with tracking enabled remains unchanged', async () => {
    catalog = [existing()];
    await workbook([['SKU1', 'Product', null, null, null, 5]]);
    const response = await request(app.getHttpServer()).post(path).expect(200);
    expect(response.body.summary.unchangedCount).toBe(1);
    expect(movements).toEqual([]);
  });

  it.each([false, true])(
    'blank/unmapped stock leaves stock and tracking untouched (unmapped=%s)',
    async (unmapped) => {
      catalog = [existing({ trackInventory: false })];
      if (unmapped)
        job.mapping = mapping.map((entry, index) =>
          index === 5 ? { ...entry, type: 'IGNORE', target: null } : entry,
        );
      await workbook([
        ['SKU1', 'Product', null, null, null, unmapped ? 9 : ' '],
      ]);
      await request(app.getHttpServer()).post(path).expect(200);
      expect(catalog[0]).toMatchObject({
        stockQuantity: 5,
        trackInventory: false,
      });
      expect(tx.catalogItem.updateMany).not.toHaveBeenCalled();
      expect(movements).toEqual([]);
    },
  );

  it('excludes invalid/skipped rows, persists validation errors, and completes with errors', async () => {
    await workbook([
      ['OK', 'Product'],
      ['BAD', 'Bad Price', null, null, -1],
      [],
      ['NO-NAME', null, null, null, 10],
    ]);
    const response = await request(app.getHttpServer()).post(path).expect(200);
    expect(response.body).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      summary: {
        totalRows: 4,
        validRows: 1,
        invalidRows: 2,
        skippedRows: 1,
        insertedCount: 1,
        failedCount: 0,
      },
    });
    expect(catalog).toHaveLength(1);
    expect(response.body.invalidRows.map((row: any) => row.rowNumber)).toEqual([
      5, 7,
    ]);
    expect(job.errors.rows).toEqual(response.body.invalidRows);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('continues after a failed row while retaining other committed rows and safe errors', async () => {
    failName = 'Fail';
    await workbook([
      ['A', 'First'],
      ['B', 'Fail'],
      ['C', 'Last'],
    ]);
    const response = await request(app.getHttpServer()).post(path).expect(200);
    expect(response.body).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      summary: { insertedCount: 2, failedCount: 1 },
      failedRows: [{ rowNumber: 5, code: 'ROW_EXECUTION_FAILED' }],
    });
    expect(catalog.map((item) => item.externalKey)).toEqual(['A', 'C']);
    expect(JSON.stringify(response.body)).not.toContain('private');
    expect(job.errors.execution).toEqual(response.body.failedRows);
  });

  it('preserves validation errors alongside execution errors', async () => {
    failName = 'Fail';
    await workbook([
      ['A', 'Success'],
      ['B', 'Fail'],
      ['C', 'Invalid', null, null, -1],
    ]);
    const response = await request(app.getHttpServer()).post(path).expect(200);
    expect(response.body.summary).toMatchObject({
      validRows: 2,
      invalidRows: 1,
      insertedCount: 1,
      failedCount: 1,
    });
    expect(job.errors.rows).toEqual(response.body.invalidRows);
    expect(job.errors.execution).toEqual(response.body.failedRows);
  });

  it('treats unmergeable existing attributes as a row failure and continues', async () => {
    catalog = [existing({ attributes: ['legacy array'] })];
    await workbook([
      ['SKU1', 'Product', null, null, null, null, 'Linen'],
      ['NEW', 'Success'],
    ]);
    const response = await request(app.getHttpServer()).post(path).expect(200);
    expect(response.body.summary).toMatchObject({
      insertedCount: 1,
      failedCount: 1,
    });
    expect(catalog[0].attributes).toEqual(['legacy array']);
  });

  it('rejects every duplicate workbook SKU rather than attempting multiple writes', async () => {
    await workbook([
      ['DUP', 'First'],
      ['DUP', 'Second'],
      ['OK', 'Success'],
    ]);
    const response = await request(app.getHttpServer()).post(path).expect(200);
    expect(response.body.summary).toMatchObject({
      validRows: 1,
      invalidRows: 2,
      insertedCount: 1,
    });
    expect(catalog.map((item) => item.externalKey)).toEqual(['OK']);
  });

  it('retains committed counters when job finalization fails', async () => {
    const update = prisma.importJob.updateMany.getMockImplementation()!;
    prisma.importJob.updateMany.mockImplementation(async (args) => {
      if (args.data.status === 'COMPLETED')
        throw new Error('private completion failure');
      return update(args);
    });
    await request(app.getHttpServer()).post(path).expect(500);
    expect(catalog).toHaveLength(1);
    expect(job).toMatchObject({
      status: 'FAILED',
      insertedCount: 1,
      failedCount: 0,
    });
    expect(job.errors.job.code).toBe('EXECUTION_FAILED');
  });

  it.each([false, true])(
    'rolls back catalog, tracking, and quantity when audit fails (existing=%s)',
    async (isExisting) => {
      if (isExisting) catalog = [existing({ trackInventory: false })];
      failAudit = true;
      await workbook([['SKU1', 'Changed', null, null, null, 20]]);
      const response = await request(app.getHttpServer())
        .post(path)
        .expect(200);
      expect(response.body.summary).toMatchObject({
        failedCount: 1,
        insertedCount: 0,
        updatedCount: 0,
      });
      expect(movements).toEqual([]);
      if (isExisting)
        expect(catalog[0]).toMatchObject({
          name: 'Product',
          trackInventory: false,
          stockQuantity: 5,
        });
      else expect(catalog).toEqual([]);
    },
  );

  it.each(['P2002', 'P2034'])(
    'reports concurrent %s conflicts without retrying or overwriting',
    async (code) => {
      transactionError = code;
      const response = await request(app.getHttpServer())
        .post(path)
        .expect(200);
      expect(response.body.failedRows).toEqual([
        {
          rowNumber: 4,
          code: 'EXECUTION_CONFLICT',
          message:
            'Catalog data changed concurrently; this row was not applied',
        },
      ]);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(catalog).toEqual([]);
    },
  );

  it('isolates another business SKU and never matches an unkeyed row by name', async () => {
    catalog = [existing({ businessId: 'other-business' })];
    await workbook([
      ['SKU1', 'Product'],
      [null, 'Product'],
    ]);
    const response = await request(app.getHttpServer()).post(path).expect(200);
    expect(response.body.summary.insertedCount).toBe(2);
    expect(catalog).toHaveLength(3);
    expect(catalog[0].businessId).toBe('other-business');
    expect(catalog[2].externalKey).toBeNull();
  });

  it('rechecks current identity inside the transaction instead of relying on an old preview', async () => {
    catalog = [existing({ name: 'Changed since preview' })];
    const response = await request(app.getHttpServer()).post(path).expect(200);
    expect(response.body.summary.updatedCount).toBe(1);
    expect(catalog[0].name).toBe('Product');
    expect(tx.catalogItem.findUnique).toHaveBeenCalledWith({
      where: { businessId_externalKey: { businessId, externalKey: 'SKU1' } },
    });
  });

  it.each([
    'MAPPING_REQUIRED',
    'VALIDATING',
    'IMPORTING',
    'COMPLETED',
    'COMPLETED_WITH_ERRORS',
    'FAILED',
    'CANCELLED',
  ])('rejects %s without writes', async (status) => {
    job.status = status;
    await request(app.getHttpServer()).post(path).expect(409);
    expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('permits only one concurrent execution to claim READY', async () => {
    const responses = await Promise.all([
      request(app.getHttpServer()).post(path),
      request(app.getHttpServer()).post(path),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('losing the atomic claim performs no workbook or catalog work', async () => {
    prisma.importJob.updateMany.mockResolvedValue({ count: 0 });
    await request(app.getHttpServer()).post(path).expect(409);
    expect(storage.read).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects unknown IDs and malformed UUIDs', async () => {
    job = null;
    await request(app.getHttpServer()).post(path).expect(404);
    prisma.importJob.findUnique.mockClear();
    await request(app.getHttpServer())
      .post('/imports/invalid/execute')
      .expect(400);
    expect(prisma.importJob.findUnique).not.toHaveBeenCalled();
  });

  it.each(['missing workbook', 'corrupt mapping', 'database unavailable'])(
    'records FAILED for job-level %s without leaking details',
    async (failure) => {
      if (failure === 'missing workbook')
        storage.read.mockRejectedValue(new Error('private-file-key'));
      if (failure === 'corrupt mapping') job.mapping = [];
      if (failure === 'database unavailable') transactionError = 'P1001';
      const response = await request(app.getHttpServer())
        .post(path)
        .expect(500);
      expect(job.status).toBe('FAILED');
      expect(job.errors.job.code).toBe('EXECUTION_FAILED');
      expect(JSON.stringify(response.body)).not.toContain('private');
      expect(catalog).toEqual([]);
    },
  );
});
