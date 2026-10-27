import {
  Controller,
  Get,
  HttpException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Workbook } from 'exceljs';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AuthGuard } from '../../src/auth/auth.guard';
import { AppHttpException } from '../../src/common/errors/app-http.exception';
import { ErrorCode } from '../../src/common/errors/error-code';
import { HttpExceptionFilter } from '../../src/common/errors/http-exception.filter';
import {
  InventoryMovementType,
  Prisma,
} from '../../src/generated/prisma/client';
import { InventoryService } from '../../src/inventory/inventory.service';
import { LocalImportFileStorage } from '../../src/imports/storage/local-import-file.storage';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Global HTTP error contract (real application modules, mocked persistence)', () => {
  let app: INestApplication;
  let inventory: InventoryService;
  let unexpected: unknown;
  let job: any;
  let buffer: Buffer;
  const id = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const uploadPath = `/businesses/${id}/imports/excel/analyze`;
  const storage = {
    save: jest.fn(),
    read: jest.fn(),
    delete: jest.fn(),
    saveValidationResult: jest.fn(),
    readValidationResult: jest.fn(),
    deleteValidationResult: jest.fn(),
  };
  const tx = {
    catalogItem: { findFirst: jest.fn(), updateMany: jest.fn() },
    inventoryMovement: { create: jest.fn() },
  };
  const prisma = {
    business: { findUnique: jest.fn() },
    catalogItem: { create: jest.fn(), findMany: jest.fn() },
    importJob: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  // Test-only routes exercise errors from the internal InventoryService and framework.
  @Controller('test-errors')
  class ErrorController {
    @Get('inventory-invalid')
    invalidInventory() {
      return inventory.setQuantity(
        { id, businessId: id },
        -1,
        InventoryMovementType.IMPORT_UPDATE,
      );
    }

    @Get('inventory-conflict')
    inventoryConflict() {
      return inventory.setQuantity(
        { id, businessId: id },
        9,
        InventoryMovementType.IMPORT_UPDATE,
      );
    }

    @Get('unexpected')
    unexpectedError() {
      throw unexpected;
    }

    @Get('renamed-message')
    renamedMessage() {
      throw new AppHttpException(
        ErrorCode.IMPORT_NOT_READY,
        409,
        'An intentionally different English description',
      );
    }
  }

  beforeAll(async () => {
    const book = new Workbook();
    book.addWorksheet('Products').addRows([
      ['Name', 'Price', 'SKU', 'Fabric'],
      ['Shirt', '12.50', 'A', 'Cotton'],
    ]);
    buffer = Buffer.from(await book.xlsx.writeBuffer());
    const module = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ErrorController],
    })
      .overrideProvider(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(LocalImportFileStorage)
      .useValue(storage)
      .compile();
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
    inventory = app.get(InventoryService);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    unexpected = new Error(
      'SQL password=private-token C:\\private\\workbook.xlsx fileKey=private-key',
    );
    job = {
      id,
      businessId: id,
      status: 'MAPPING_REQUIRED',
      fileKey: 'private-key',
      sheetName: 'Products',
      headerRow: 1,
      mapping: [
        {
          sourceColumn: 'Name',
          sourceColumnIndex: 1,
          type: 'STANDARD',
          target: 'name',
        },
        {
          sourceColumn: 'Price',
          sourceColumnIndex: 2,
          type: 'STANDARD',
          target: 'basePrice',
        },
        {
          sourceColumn: 'SKU',
          sourceColumnIndex: 3,
          type: 'STANDARD',
          target: 'externalKey',
        },
        {
          sourceColumn: 'Fabric',
          sourceColumnIndex: 4,
          type: 'UNMAPPED',
          target: null,
        },
      ],
    };
    prisma.business.findUnique.mockResolvedValue({ id });
    prisma.catalogItem.create.mockResolvedValue({ id, name: 'Shirt' });
    prisma.importJob.findUnique.mockImplementation(async () => job);
    prisma.importJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.importJob.create.mockResolvedValue({
      id,
      status: 'MAPPING_REQUIRED',
    });
    storage.save.mockImplementation(async (upload: Buffer) => {
      storage.read.mockResolvedValue(upload);
      return 'private-key';
    });
    storage.read.mockResolvedValue(buffer);
    tx.catalogItem.findFirst.mockResolvedValue({ stockQuantity: 5 });
    tx.catalogItem.updateMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
  });

  async function expectError(
    promise: request.Test,
    statusCode: number,
    code: ErrorCode,
    message?: string,
  ) {
    const response = await promise.expect(statusCode);
    expect(Object.keys(response.body).sort()).toEqual([
      'code',
      'error',
      'message',
      'statusCode',
    ]);
    expect(response.body).toMatchObject({ statusCode, code });
    if (message) expect(response.body.message).toBe(message);
    expect(JSON.stringify(response.body)).not.toMatch(
      /private-key|private-token|C:\\\\private/,
    );
    return response.body;
  }

  it('normalizes business-not-found from both catalog and analyze', async () => {
    prisma.catalogItem.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('private foreign key SQL', {
        code: 'P2003',
        clientVersion: '7',
      }),
    );
    const body = await expectError(
      request(app.getHttpServer())
        .post('/catalog-items')
        .send({ businessId: id, name: 'Shirt' }),
      404,
      ErrorCode.BUSINESS_NOT_FOUND,
      'Business not found',
    );
    expect(body.error).toBe('Not Found');
    prisma.business.findUnique.mockResolvedValue(null);
    await expectError(
      request(app.getHttpServer())
        .post(uploadPath)
        .attach('file', buffer, 'catalog.xlsx'),
      404,
      ErrorCode.BUSINESS_NOT_FOUND,
    );
  });

  it.each(['mapping', 'preview', 'execute', 'validate'])(
    'normalizes missing import jobs for %s',
    async (stage) => {
      job = null;
      const call = request(app.getHttpServer());
      const promise = ['mapping', 'preview'].includes(stage)
        ? call.get(`/imports/${id}/${stage}`)
        : call.post(`/imports/${id}/${stage}`);
      await expectError(
        promise,
        404,
        ErrorCode.IMPORT_JOB_NOT_FOUND,
        'Import job not found',
      );
    },
  );

  it('normalizes missing, unsupported, invalid, and unreadable Excel files', async () => {
    await expectError(
      request(app.getHttpServer()).post(uploadPath),
      400,
      ErrorCode.EXCEL_FILE_REQUIRED,
    );
    await expectError(
      request(app.getHttpServer())
        .post(uploadPath)
        .attach('file', buffer, 'catalog.csv'),
      400,
      ErrorCode.EXCEL_FILE_UNSUPPORTED,
    );
    await expectError(
      request(app.getHttpServer())
        .post(uploadPath)
        .attach('file', Buffer.from('not Excel'), 'catalog.xlsx'),
      400,
      ErrorCode.EXCEL_FILE_INVALID,
    );
    await expectError(
      request(app.getHttpServer())
        .post(uploadPath)
        .attach('file', Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'catalog.xlsx'),
      400,
      ErrorCode.EXCEL_FILE_UNREADABLE,
    );
  });

  it('normalizes missing sheet and header errors', async () => {
    await expectError(
      request(app.getHttpServer())
        .post(uploadPath)
        .field('sheetName', 'Missing')
        .attach('file', buffer, 'catalog.xlsx'),
      400,
      ErrorCode.EXCEL_SHEET_NOT_FOUND,
    );
    const book = new Workbook();
    book.addWorksheet('Empty');
    await expectError(
      request(app.getHttpServer())
        .post(uploadPath)
        .attach(
          'file',
          Buffer.from(await book.xlsx.writeBuffer()),
          'catalog.xlsx',
        ),
      400,
      ErrorCode.EXCEL_HEADER_NOT_FOUND,
    );
  });

  it('normalizes oversized Excel uploads without leaking Multer details', async () => {
    const body = await expectError(
      request(app.getHttpServer())
        .post(uploadPath)
        .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), 'large.xlsx'),
      413,
      ErrorCode.EXCEL_FILE_TOO_LARGE,
      'The Excel file exceeds the maximum allowed size of 10 MB.',
    );
    expect(body.error).toBe('Payload Too Large');
    expect(prisma.business.findUnique).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
  });

  it.each([
    [
      { sourceColumn: 'Missing', type: 'STANDARD', target: 'name' },
      ErrorCode.MAPPING_SOURCE_INVALID,
    ],
    [
      { sourceColumn: 'Name', type: 'STANDARD', target: 'unknown' },
      ErrorCode.MAPPING_STANDARD_TARGET_INVALID,
    ],
    [
      { sourceColumn: 'Name', type: 'IGNORE', target: 'name' },
      ErrorCode.MAPPING_TARGET_MUST_BE_NULL,
    ],
    [
      { sourceColumn: 'Name', type: 'ATTRIBUTE', target: 'Bad Key' },
      ErrorCode.MAPPING_ATTRIBUTE_TARGET_INVALID,
    ],
    [
      { sourceColumn: 'Name', type: 'IGNORE', target: null },
      ErrorCode.MAPPING_NAME_REQUIRED,
    ],
  ])(
    'gives invalid mapping a stable semantic code: %j',
    async (entry, code) => {
      await expectError(
        request(app.getHttpServer())
          .patch(`/imports/${id}/mapping`)
          .send({ mapping: [entry] }),
        400,
        code as ErrorCode,
      );
    },
  );

  it('uses one lifecycle code for both preview and execution not READY', async () => {
    await expectError(
      request(app.getHttpServer()).get(`/imports/${id}/preview`),
      409,
      ErrorCode.IMPORT_NOT_READY,
    );
    await expectError(
      request(app.getHttpServer()).post(`/imports/${id}/execute`),
      409,
      ErrorCode.IMPORT_NOT_READY,
    );
  });

  it('normalizes wrong mapping and validation states and lost lifecycle claims', async () => {
    job.status = 'READY';
    await expectError(
      request(app.getHttpServer()).get(`/imports/${id}/mapping`),
      409,
      ErrorCode.IMPORT_NOT_AWAITING_MAPPING,
    );
    await expectError(
      request(app.getHttpServer()).post(`/imports/${id}/validate`),
      409,
      ErrorCode.IMPORT_NOT_AWAITING_VALIDATION,
    );
    prisma.importJob.updateMany.mockResolvedValue({ count: 0 });
    await expectError(
      request(app.getHttpServer()).post(`/imports/${id}/execute`),
      409,
      ErrorCode.IMPORT_EXECUTION_ALREADY_STARTED,
    );
    job.status = 'MAPPING_REQUIRED';
    await expectError(
      request(app.getHttpServer()).post(`/imports/${id}/validate`),
      409,
      ErrorCode.IMPORT_VALIDATION_ALREADY_STARTED,
    );
  });

  it('normalizes absent metadata and retained files as workbook unavailable', async () => {
    job.fileKey = null;
    await expectError(
      request(app.getHttpServer()).get(`/imports/${id}/mapping`),
      409,
      ErrorCode.IMPORT_WORKBOOK_UNAVAILABLE,
    );
    job.fileKey = 'private-key';
    storage.read.mockRejectedValue(
      Object.assign(new Error('private-key'), { code: 'ENOENT' }),
    );
    await expectError(
      request(app.getHttpServer()).get(`/imports/${id}/mapping`),
      409,
      ErrorCode.IMPORT_WORKBOOK_UNAVAILABLE,
    );
  });

  it('retains safe codes/messages on known server failures', async () => {
    storage.read.mockRejectedValue(new Error('private-key'));
    await expectError(
      request(app.getHttpServer()).get(`/imports/${id}/mapping`),
      500,
      ErrorCode.IMPORT_WORKBOOK_READ_FAILED,
      'Unable to read the retained workbook',
    );
    await expectError(
      request(app.getHttpServer()).post(`/imports/${id}/validate`),
      500,
      ErrorCode.IMPORT_VALIDATION_FAILED,
      'Workbook validation could not be completed',
    );
    job.status = 'READY';
    await expectError(
      request(app.getHttpServer()).post(`/imports/${id}/execute`),
      500,
      ErrorCode.IMPORT_EXECUTION_FAILED,
      'Import execution could not be completed',
    );
  });

  it('normalizes internal inventory quantity and conflict exceptions', async () => {
    await expectError(
      request(app.getHttpServer()).get('/test-errors/inventory-invalid'),
      400,
      ErrorCode.INVENTORY_QUANTITY_INVALID,
    );
    await expectError(
      request(app.getHttpServer()).get('/test-errors/inventory-conflict'),
      409,
      ErrorCode.INVENTORY_CONFLICT,
    );
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('preserves class-validator message arrays and handles UUID pipe errors', async () => {
    const body = await expectError(
      request(app.getHttpServer())
        .post('/catalog-items')
        .send({ businessId: 'invalid', name: 'x'.repeat(201) }),
      400,
      ErrorCode.VALIDATION_ERROR,
    );
    expect(body.error).toBe('Bad Request');
    expect(body.message).toEqual(
      expect.arrayContaining([
        'businessId must be a UUID',
        'name must be shorter than or equal to 200 characters',
      ]),
    );
    await expectError(
      request(app.getHttpServer()).get('/imports/invalid/mapping'),
      400,
      ErrorCode.VALIDATION_ERROR,
    );
    expect(prisma.catalogItem.create).not.toHaveBeenCalled();
  });

  it('unknown mapping types rejected by DTO keep the framework validation contract', async () => {
    const body = await expectError(
      request(app.getHttpServer())
        .patch(`/imports/${id}/mapping`)
        .send({
          mapping: [{ sourceColumn: 'Name', type: 'AI', target: 'name' }],
        }),
      400,
      ErrorCode.VALIDATION_ERROR,
    );
    expect(Array.isArray(body.message)).toBe(true);
  });

  it('preserves malformed JSON HTTP 400 with useful framework parsing details', async () => {
    const body = await expectError(
      request(app.getHttpServer())
        .post('/catalog-items')
        .set('Content-Type', 'application/json')
        .send('{"password":"private-token"'),
      400,
      ErrorCode.VALIDATION_ERROR,
    );
    expect(typeof body.message).toBe('string');
    expect(body.message).toContain('JSON');
    expect(prisma.catalogItem.create).not.toHaveBeenCalled();
  });

  it('keeps oversized JSON separate from the Excel-specific size code', async () => {
    await expectError(
      request(app.getHttpServer())
        .post('/catalog-items')
        .send({ name: 'x'.repeat(200000) }),
      413,
      ErrorCode.PAYLOAD_TOO_LARGE,
      'The request body exceeds the maximum allowed size',
    );
    expect(prisma.catalogItem.create).not.toHaveBeenCalled();
  });

  it.each([
    [401, ErrorCode.UNAUTHORIZED],
    [403, ErrorCode.FORBIDDEN],
    [409, ErrorCode.CONFLICT],
    [413, ErrorCode.PAYLOAD_TOO_LARGE],
    [418, ErrorCode.HTTP_ERROR],
  ])('normalizes framework HTTP %s', async (status, code) => {
    unexpected = new HttpException('Safe framework message', status as number);
    await expectError(
      request(app.getHttpServer()).get('/test-errors/unexpected'),
      status as number,
      code as ErrorCode,
      'Safe framework message',
    );
  });

  it('preserves framework 503 status while sanitizing server failure details', async () => {
    unexpected = new HttpException('private-token', 503);
    await expectError(
      request(app.getHttpServer()).get('/test-errors/unexpected'),
      503,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'An internal server error occurred',
    );
  });

  it.each(['error', 'plain object', 'framework 500', 'Prisma'])(
    'sanitizes unexpected %s errors',
    async (type) => {
      if (type === 'plain object')
        unexpected = { message: 'private-token', code: 'SECRET', stack: 'SQL' };
      if (type === 'framework 500')
        unexpected = new HttpException(
          { code: 'SECRET', message: 'private-token', stack: 'SQL' },
          500,
        );
      if (type === 'Prisma')
        unexpected = new Prisma.PrismaClientKnownRequestError(
          'SQL private-token',
          { code: 'P2002', clientVersion: '7' },
        );
      expect(
        await expectError(
          request(app.getHttpServer()).get('/test-errors/unexpected'),
          500,
          ErrorCode.INTERNAL_SERVER_ERROR,
        ),
      ).toEqual({
        statusCode: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An internal server error occurred',
        error: 'Internal Server Error',
      });
    },
  );

  it('keeps the code independent of English message wording', async () => {
    await expectError(
      request(app.getHttpServer()).get('/test-errors/renamed-message'),
      409,
      ErrorCode.IMPORT_NOT_READY,
      'An intentionally different English description',
    );
  });

  it('normalizes an unmatched HTTP route', async () => {
    await expectError(
      request(app.getHttpServer()).get('/unknown'),
      404,
      ErrorCode.NOT_FOUND,
    );
  });

  it('leaves successful responses and Excel row-level validation codes unchanged', async () => {
    await request(app.getHttpServer())
      .post('/catalog-items')
      .send({ businessId: id, name: 'Shirt' })
      .expect(201, { id, name: 'Shirt' });
    const book = new Workbook();
    book.addWorksheet('Products').addRows([
      ['Name', 'Price', 'SKU', 'Fabric'],
      ['Shirt', 'bad', 'A', 'Cotton'],
    ]);
    storage.read.mockResolvedValue(Buffer.from(await book.xlsx.writeBuffer()));
    const response = await request(app.getHttpServer())
      .post(`/imports/${id}/validate`)
      .expect(201);
    expect(response.body).toMatchObject({
      importId: id,
      status: 'READY',
      summary: { invalidRows: 1 },
    });
    expect(
      prisma.importJob.updateMany.mock.calls.at(-1)![0].data.errors.rows,
    ).toEqual([
      {
        rowNumber: 2,
        errors: [
          expect.objectContaining({
            field: 'basePrice',
            code: 'INVALID_DECIMAL',
          }),
        ],
      },
    ]);
    expect(response.body).not.toHaveProperty('statusCode');
    expect(response.body).not.toHaveProperty('code');
  });
});
