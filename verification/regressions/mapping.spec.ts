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
import { ExcelAdapter } from '../../src/imports/adapters/excel.adapter';
import { MappingController } from '../../src/imports/mapping.controller';
import { MappingService } from '../../src/imports/mapping.service';
import { ImportFileStorage } from '../../src/imports/storage/import-file.storage';
import { LocalImportFileStorage } from '../../src/imports/storage/local-import-file.storage';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Excel mapping HTTP API (real workbook/storage, mocked database)', () => {
  let app: INestApplication;
  let directory: string;
  let storage: LocalImportFileStorage;
  let fileKey: string;
  const importId = 'f6bc7287-3285-4e19-a819-459c41f0a138';
  const path = `/imports/${importId}/mapping`;
  const headers = [
    'Item Name',
    'Product Code',
    'Description',
    'Category',
    'Price',
    'Stock Quantity',
    'Fabric',
    'Size',
    'Notes',
    'Discount',
    'Order Quantity',
  ];
  const nameEntry = {
    sourceColumn: 'Item Name',
    type: 'STANDARD',
    target: 'name',
  };
  const prisma = {
    importJob: { findUnique: jest.fn(), updateMany: jest.fn() },
    catalogItem: {
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  async function workbookBytes(
    columnHeaders: string[],
    row = 3,
  ): Promise<Buffer> {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Products');
    // Multiple text cells at row 1 deliberately fool auto-detection. Mapping
    // must use the persisted row instead of detecting headers again.
    if (row !== 1) sheet.getRow(1).values = ['Report', 'October'];
    sheet.getRow(row).values = columnHeaders;
    for (let index = 1; index <= 6; index++) {
      sheet.getRow(row + index).values = columnHeaders.map(
        (_header, column) => {
          if (column === 0) return `Product ${index}`;
          if (column === 4) return index * 10;
          if (column === 5) return index;
          if (column === 6) return index % 2 ? 'Cotton' : 'Linen';
          return `Sample ${index}`;
        },
      );
    }
    workbook.addWorksheet('Other').addRows([
      ['Wrong Header', 'Other'],
      ['Wrong Sample', 'Other'],
    ]);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'brandora-mapping-'));
    storage = new LocalImportFileStorage(
      new ConfigService({ IMPORT_STORAGE_DIR: directory }),
    );
    fileKey = await storage.save(await workbookBytes(headers));
    const module = await Test.createTestingModule({
      controllers: [MappingController],
      providers: [
        MappingService,
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
    prisma.importJob.findUnique.mockResolvedValue({
      id: importId,
      status: 'MAPPING_REQUIRED',
      fileKey,
      sheetName: 'Products',
      headerRow: 3,
      mapping: null,
    });
    prisma.importJob.updateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    expect(prisma.catalogItem.create).not.toHaveBeenCalled();
    expect(prisma.catalogItem.createMany).not.toHaveBeenCalled();
    expect(prisma.catalogItem.update).not.toHaveBeenCalled();
    expect(prisma.catalogItem.updateMany).not.toHaveBeenCalled();
    // Invalid mappings must not delete the previously retained upload.
    expect(await readdir(directory)).toContain(fileKey);
    for (const key of await readdir(directory))
      if (key !== fileKey) await storage.delete(key);
  });

  afterAll(async () => {
    await app.close();
    await storage.delete(fileKey);
    await rmdir(directory);
  });

  it('suggests all six standard fields and keeps unknown/ambiguous labels unmapped', async () => {
    const response = await request(app.getHttpServer()).get(path).expect(200);
    expect(response.body).toMatchObject({
      importId,
      status: 'MAPPING_REQUIRED',
      mapping: null,
    });
    expect(
      response.body.columns
        .slice(0, 6)
        .map((column: { suggestedTarget: string }) => column.suggestedTarget),
    ).toEqual([
      'name',
      'externalKey',
      'description',
      'category',
      'basePrice',
      'stockQuantity',
    ]);
    expect(
      response.body.columns
        .slice(0, 6)
        .map((column: { displayLabel: string }) => column.displayLabel),
    ).toEqual([
      'Product Name',
      'Product Code (groups variants)',
      'Description',
      'Category',
      'Price',
      'Available Quantity',
    ]);
    expect(response.body.columns[0]).toEqual({
      sourceColumn: 'Item Name',
      sourceColumnIndex: 1,
      samples: ['Product 1', 'Product 2', 'Product 3'],
      suggestedType: 'STANDARD',
      suggestedTarget: 'name',
      displayLabel: 'Product Name',
    });
    expect(response.body.columns[4].samples).toEqual([10, 20, 30]);
    expect(response.body.columns[6]).toMatchObject({
      samples: ['Cotton', 'Linen'],
      suggestedType: 'UNMAPPED',
      suggestedTarget: null,
      displayLabel: null,
    });
    expect(
      response.body.columns
        .slice(6)
        .every(
          (column: { suggestedType: string }) =>
            column.suggestedType === 'UNMAPPED',
        ),
    ).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain(fileKey);
    expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
  });

  it('matches aliases only after case/whitespace comparison and demotes conflicting targets', async () => {
    const otherKey = await storage.save(
      await workbookBytes([
        ' Name ',
        'PRODUCT   NAME',
        'Sale Price',
        'Product Code',
        'stock quantitiy',
      ]),
    );
    prisma.importJob.findUnique.mockResolvedValue({
      id: importId,
      status: 'MAPPING_REQUIRED',
      fileKey: otherKey,
      sheetName: 'Products',
      headerRow: 3,
      mapping: null,
    });
    const response = await request(app.getHttpServer()).get(path).expect(200);
    expect(
      response.body.columns.map(
        (column: { suggestedTarget: string | null }) => column.suggestedTarget,
      ),
    ).toEqual([null, null, 'basePrice', 'externalKey', null]);
  });

  it.each([
    [
      'English shorthand',
      ['item', 'product code', 'description', 'category', 'sale price', 'qty'],
    ],
    [
      'English product fields',
      [
        'Product Name',
        'Product Code',
        'Product Description',
        'Product Category',
        'Selling Price',
        'Quantity',
      ],
    ],
    [
      'English explicit underscore aliases',
      [
        'item_name',
        'external_key',
        'item_description',
        'item_category',
        'base_price',
        'stock_quantity',
      ],
    ],
    [
      'Arabic product fields',
      [
        'اسم المنتج',
        'كود المنتج',
        'وصف المنتج',
        'فئة المنتج',
        'سعر البيع',
        'الكمية المتاحة',
      ],
    ],
    [
      'Arabic item fields',
      [
        'اسم الصنف',
        'رمز الصنف',
        'وصف الصنف',
        'التصنيف',
        'سعر الصنف',
        'كمية المخزون',
      ],
    ],
    [
      'Arabic whitespace and mixed SKU case',
      [
        '  اسم   السلعة  ',
        'كود SKU',
        'الوصف',
        'تصنيف المنتج',
        'السعر الأساسي',
        'رصيد المخزون',
      ],
    ],
  ])('suggests the six fields for %s', async (_label, columnHeaders) => {
    const otherKey = await storage.save(await workbookBytes(columnHeaders));
    prisma.importJob.findUnique.mockResolvedValue({
      id: importId,
      status: 'MAPPING_REQUIRED',
      fileKey: otherKey,
      sheetName: 'Products',
      headerRow: 3,
      mapping: null,
    });
    const response = await request(app.getHttpServer()).get(path).expect(200);
    expect(
      response.body.columns.map(
        (column: { suggestedTarget: string }) => column.suggestedTarget,
      ),
    ).toEqual([
      'name',
      'externalKey',
      'description',
      'category',
      'basePrice',
      'stockQuantity',
    ]);
    expect(
      response.body.columns.map(
        (column: { displayLabel: string }) => column.displayLabel,
      ),
    ).toEqual([
      'Product Name',
      'Product Code (groups variants)',
      'Description',
      'Category',
      'Price',
      'Available Quantity',
    ]);
    expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
  });

  it('keeps competing English/Arabic aliases unmapped without selecting a preferred column', async () => {
    const otherKey = await storage.save(
      await workbookBytes([
        'Product Name',
        'اسم المنتج',
        'Price',
        'Sale Price',
        'سعر البيع',
        'quantity',
        'qty',
        'الكمية',
        'external key',
        'product code',
        'كود المنتج',
      ]),
    );
    prisma.importJob.findUnique.mockResolvedValue({
      id: importId,
      status: 'MAPPING_REQUIRED',
      fileKey: otherKey,
      sheetName: 'Products',
      headerRow: 3,
      mapping: null,
    });
    const response = await request(app.getHttpServer()).get(path).expect(200);
    for (const column of response.body.columns) {
      expect(column).toMatchObject({
        suggestedType: 'UNMAPPED',
        suggestedTarget: null,
        displayLabel: null,
      });
    }
  });

  it('keeps broad, qualified, misspelled, and non-exact English/Arabic headers unmapped', async () => {
    const otherKey = await storage.save(
      await workbookBytes([
        'code',
        'id',
        'value',
        'type',
        'الصنف',
        'الرصيد',
        'رقم',
        'قيمة',
        'cost price',
        'purchase price',
        'order quantity',
        'سعر الشراء',
        'سعر التكلفة',
        'الكمية المطلوبة',
        'product-name',
        'sku-code',
        'selling prices',
        'stock quantitiy',
        'اسم المنتح',
        'سعر البييع',
      ]),
    );
    prisma.importJob.findUnique.mockResolvedValue({
      id: importId,
      status: 'MAPPING_REQUIRED',
      fileKey: otherKey,
      sheetName: 'Products',
      headerRow: 3,
      mapping: null,
    });
    const response = await request(app.getHttpServer()).get(path).expect(200);
    for (const column of response.body.columns) {
      expect(column).toMatchObject({
        suggestedType: 'UNMAPPED',
        suggestedTarget: null,
        displayLabel: null,
      });
    }
  });

  it('saves all mapping types, fills omitted columns, and preserves status/counters', async () => {
    const entries = [
      nameEntry,
      { sourceColumn: 'Fabric', type: 'ATTRIBUTE', target: 'material' },
      { sourceColumn: 'Size', type: 'VARIANT_ATTRIBUTE', target: 'size' },
      { sourceColumn: 'Notes', type: 'IGNORE', target: null },
      { sourceColumn: 'Discount', type: 'UNMAPPED', target: null },
      { sourceColumn: 'Product Code', type: 'STANDARD', target: 'externalKey' },
    ];
    const response = await request(app.getHttpServer())
      .patch(path)
      .send({ mapping: entries })
      .expect(200);
    expect(response.body.status).toBe('MAPPING_REQUIRED');
    expect(response.body.mapping).toHaveLength(headers.length);
    expect(response.body.mapping[0]).toEqual({
      ...nameEntry,
      sourceColumnIndex: 1,
    });
    expect(response.body.mapping[1]).toEqual({
      sourceColumn: 'Product Code',
      sourceColumnIndex: 2,
      type: 'STANDARD',
      target: 'externalKey',
    });
    expect(response.body.mapping[6]).toEqual({
      ...entries[1],
      sourceColumnIndex: 7,
    });
    expect(response.body.mapping[7]).toEqual({
      ...entries[2],
      sourceColumnIndex: 8,
    });
    expect(prisma.importJob.updateMany).toHaveBeenCalledWith({
      where: { id: importId, status: 'MAPPING_REQUIRED' },
      data: { mapping: response.body.mapping },
    });
    expect(JSON.stringify(response.body)).not.toContain(fileKey);
    prisma.importJob.findUnique.mockResolvedValue({
      id: importId,
      status: 'MAPPING_REQUIRED',
      fileKey,
      sheetName: 'Products',
      headerRow: 3,
      mapping: response.body.mapping,
    });
    const saved = await request(app.getHttpServer()).get(path).expect(200);
    expect(saved.body.mapping).toEqual(response.body.mapping);
  });

  it.each(['Coffee Origin', 'حجم العبوة'])(
    'accepts a dynamic option name %s without imposing a business type',
    async (target) => {
      const response = await request(app.getHttpServer())
        .patch(path)
        .send({
          mapping: [
            nameEntry,
            {
              sourceColumn: 'Product Code',
              type: 'STANDARD',
              target: 'externalKey',
            },
            { sourceColumn: 'Size', type: 'VARIANT_ATTRIBUTE', target },
          ],
        })
        .expect(200);
      expect(response.body.mapping[7].target).toBe(target);
    },
  );

  it('supports duplicate and blank headers by index without guessing their suggestions', async () => {
    const otherKey = await storage.save(
      await workbookBytes(['Name', 'Name', '', 'Fabric']),
    );
    prisma.importJob.findUnique.mockResolvedValue({
      id: importId,
      status: 'MAPPING_REQUIRED',
      fileKey: otherKey,
      sheetName: 'Products',
      headerRow: 3,
      mapping: null,
    });
    const suggested = await request(app.getHttpServer()).get(path).expect(200);
    expect(
      suggested.body.columns
        .slice(0, 3)
        .every(
          (column: { suggestedType: string }) =>
            column.suggestedType === 'UNMAPPED',
        ),
    ).toBe(true);
    await request(app.getHttpServer())
      .patch(path)
      .send({
        mapping: [{ sourceColumn: 'Name', type: 'STANDARD', target: 'name' }],
      })
      .expect(400);
    const response = await request(app.getHttpServer())
      .patch(path)
      .send({
        mapping: [
          {
            sourceColumn: 'Name',
            sourceColumnIndex: 1,
            type: 'STANDARD',
            target: 'name',
          },
          {
            sourceColumn: 'Name',
            sourceColumnIndex: 2,
            type: 'STANDARD',
            target: 'externalKey',
          },
          {
            sourceColumn: '',
            sourceColumnIndex: 3,
            type: 'IGNORE',
            target: null,
          },
        ],
      })
      .expect(200);
    expect(response.body.mapping[2]).toEqual({
      sourceColumn: '',
      sourceColumnIndex: 3,
      type: 'IGNORE',
      target: null,
    });
  });

  it.each([
    [
      'missing name',
      [{ sourceColumn: 'Fabric', type: 'ATTRIBUTE', target: 'material' }],
    ],
    [
      'duplicate source',
      [
        nameEntry,
        {
          sourceColumn: 'Item Name',
          sourceColumnIndex: 1,
          type: 'IGNORE',
          target: null,
        },
      ],
    ],
    [
      'duplicate standard target',
      [
        nameEntry,
        { sourceColumn: 'Product Code', type: 'STANDARD', target: 'name' },
      ],
    ],
    [
      'unknown standard target',
      [
        nameEntry,
        { sourceColumn: 'Fabric', type: 'STANDARD', target: 'material' },
      ],
    ],
    [
      'unknown type',
      [
        nameEntry,
        { sourceColumn: 'Fabric', type: 'MAGIC', target: 'material' },
      ],
    ],
    [
      'missing column',
      [nameEntry, { sourceColumn: 'Missing', type: 'IGNORE', target: null }],
    ],
    ['mismatched index', [{ ...nameEntry, sourceColumnIndex: 2 }]],
    ['index out of range', [{ ...nameEntry, sourceColumnIndex: 100 }]],
    ['fractional index', [{ ...nameEntry, sourceColumnIndex: 1.5 }]],
    ['null index', [{ ...nameEntry, sourceColumnIndex: null }]],
    [
      'non-null ignore target',
      [nameEntry, { sourceColumn: 'Notes', type: 'IGNORE', target: 'notes' }],
    ],
    [
      'non-null unmapped target',
      [nameEntry, { sourceColumn: 'Notes', type: 'UNMAPPED', target: 'notes' }],
    ],
    ['null standard target', [{ ...nameEntry, target: null }]],
    ['missing target', [{ sourceColumn: 'Item Name', type: 'STANDARD' }]],
    [
      'empty attribute target',
      [nameEntry, { sourceColumn: 'Fabric', type: 'ATTRIBUTE', target: '' }],
    ],
    [
      'unsafe attribute key',
      [
        nameEntry,
        { sourceColumn: 'Fabric', type: 'ATTRIBUTE', target: '__proto__' },
      ],
    ],
    [
      'reserved variant key',
      [
        nameEntry,
        {
          sourceColumn: 'Size',
          type: 'VARIANT_ATTRIBUTE',
          target: 'constructor',
        },
      ],
    ],
    [
      'invalid attribute syntax',
      [
        nameEntry,
        { sourceColumn: 'Fabric', type: 'ATTRIBUTE', target: 'Fabric Color' },
      ],
    ],
    [
      'duplicate attribute target',
      [
        nameEntry,
        { sourceColumn: 'Fabric', type: 'ATTRIBUTE', target: 'material' },
        { sourceColumn: 'Notes', type: 'ATTRIBUTE', target: 'material' },
      ],
    ],
    ['extra input fields', [{ ...nameEntry, displayLabel: 'Product Name' }]],
  ])('rejects %s without saving', async (_label, mapping) => {
    await request(app.getHttpServer())
      .patch(path)
      .send({ mapping })
      .expect(400);
    expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { mapping: [] },
    { mapping: null },
    { mapping: 'invalid' },
    { mapping: [null] },
  ])('rejects malformed payload %j', async (body) => {
    await request(app.getHttpServer()).patch(path).send(body).expect(400);
    expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
  });

  it.each(['get', 'patch'] as const)(
    'returns 404 for an unknown import on %s',
    async (method) => {
      prisma.importJob.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        [method](path)
        .send({
          mapping: [
            nameEntry,
            {
              sourceColumn: 'Product Code',
              type: 'STANDARD',
              target: 'externalKey',
            },
          ],
        })
        .expect(404);
      expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(['get', 'patch'] as const)(
    'returns 409 for a job outside the mapping stage on %s',
    async (method) => {
      prisma.importJob.findUnique.mockResolvedValue({
        id: importId,
        status: 'VALIDATING',
        fileKey,
        sheetName: 'Products',
        headerRow: 3,
        mapping: null,
      });
      await request(app.getHttpServer())
        [method](path)
        .send({
          mapping: [
            nameEntry,
            {
              sourceColumn: 'Product Code',
              type: 'STANDARD',
              target: 'externalKey',
            },
          ],
        })
        .expect(409);
      expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
    },
  );

  it('guards confirmation against a concurrent lifecycle transition', async () => {
    prisma.importJob.updateMany.mockResolvedValue({ count: 0 });
    await request(app.getHttpServer())
      .patch(path)
      .send({
        mapping: [
          nameEntry,
          {
            sourceColumn: 'Product Code',
            type: 'STANDARD',
            target: 'externalKey',
          },
        ],
      })
      .expect(409);
  });

  it('returns a safe conflict for old jobs without a file key', async () => {
    prisma.importJob.findUnique.mockResolvedValue({
      id: importId,
      status: 'MAPPING_REQUIRED',
      fileKey: null,
      sheetName: 'Products',
      headerRow: 3,
      mapping: null,
    });
    await request(app.getHttpServer()).get(path).expect(409);
  });

  it('returns a safe conflict when the retained file is missing', async () => {
    jest
      .spyOn(storage, 'read')
      .mockRejectedValue(
        Object.assign(new Error(`Missing ${fileKey}`), { code: 'ENOENT' }),
      );
    const response = await request(app.getHttpServer()).get(path).expect(409);
    expect(JSON.stringify(response.body)).not.toContain(fileKey);
  });

  it('does not expose storage paths on other read errors', async () => {
    jest
      .spyOn(storage, 'read')
      .mockRejectedValue(
        Object.assign(new Error(`Denied ${fileKey}`), { code: 'EACCES' }),
      );
    const response = await request(app.getHttpServer())
      .patch(path)
      .send({
        mapping: [
          nameEntry,
          {
            sourceColumn: 'Product Code',
            type: 'STANDARD',
            target: 'externalKey',
          },
        ],
      })
      .expect(500);
    expect(JSON.stringify(response.body)).not.toContain(fileKey);
    expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an invalid import UUID', async () => {
    await request(app.getHttpServer())
      .get('/imports/invalid/mapping')
      .expect(400);
    expect(prisma.importJob.findUnique).not.toHaveBeenCalled();
  });
});
