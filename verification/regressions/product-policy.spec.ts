import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  attributes,
  MAX_OPTION_BYTES,
  productOptions,
  variantOptions,
} from '../../src/products/product-validation';
import {
  CreateProductDto,
  UpdateProductDto,
} from '../../src/products/dto/product.dto';
import {
  CreateVariantDto,
  UpdateVariantDto,
} from '../../src/variants/dto/variant.dto';
import { CategoryDto } from '../../src/categories/dto/category.dto';
import { ProductsService } from '../../src/products/products.service';
import { ProductAccessService } from '../../src/products/product-access.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ErrorCode } from '../../src/common/errors/error-code';
import { AppHttpException } from '../../src/common/errors/app-http.exception';

describe('Product/Variant dynamic option policy', () => {
  it.each(['Binding', 'Capacity', 'Finish', 'Custom option'])(
    'accepts arbitrary business option %s',
    (key) => {
      const definitions = productOptions({ [key]: [' First ', 'Second'] });
      expect(variantOptions({ [` ${key} `]: ' First ' }, definitions)).toEqual({
        [key]: 'First',
      });
    },
  );
  it('trims consistently without folding case or mutating input', () => {
    const input = { ' Mode ': ['a', ' A '] };
    expect(productOptions(input)).toEqual({ Mode: ['a', 'A'] });
    expect(input).toEqual({ ' Mode ': ['a', ' A '] });
    expect(() =>
      variantOptions({ mode: 'a' }, productOptions(input)),
    ).toThrow();
  });
  it('handles special JSON keys as data without prototype pollution', () => {
    const options = productOptions(
      JSON.parse('{"__proto__":["safe"],"constructor":["value"]}'),
    );
    expect(
      variantOptions(
        JSON.parse('{"constructor":"value","__proto__":"safe"}'),
        options,
      ),
    ).toEqual(JSON.parse('{"__proto__":"safe","constructor":"value"}'));
    expect(({} as Record<string, unknown>).safe).toBeUndefined();
  });
  it('supports one empty combination for simple products', () => {
    expect(variantOptions({}, productOptions({}))).toEqual({});
  });
  it.each([
    null,
    [],
    '',
    4,
    true,
    { Mode: [] },
    { ' ': ['x'] },
    { Mode: [''] },
    { Mode: [null] },
    { Mode: ['a', ' a '] },
    { Mode: ['a'], ' Mode ': ['b'] },
    { Mode: Array.from({ length: 51 }, (_, i) => `${i}`) },
    Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`K${i}`, ['v']])),
  ])('rejects malformed product options %#', (input) => {
    expect(() => productOptions(input)).toThrow(AppHttpException);
  });
  const definitions = productOptions({
    Binding: ['Hard', 'Soft'],
    Edition: ['First'],
  });
  it.each([
    undefined,
    null,
    [],
    'text',
    {},
    { Binding: 'Hard' },
    { Binding: 'Other', Edition: 'First' },
    { Binding: 1, Edition: 'First' },
    { Binding: 'Hard', Edition: 'First', Unknown: 'x' },
    { Binding: 'Hard', ' Binding ': 'Soft', Edition: 'First' },
  ])('rejects invalid selections %#', (input) => {
    expect(() => variantOptions(input, definitions)).toThrow();
  });
  it('bounds multibyte and escaped maximum selections below index limits', () => {
    const huge = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`Option${i}`, ['界'.repeat(100)]]),
    );
    expect(() => productOptions(huge)).toThrow();
    const bounded = productOptions({
      Mode: ['\\'.repeat(100), '界'.repeat(100)],
    });
    expect(
      Buffer.byteLength(
        JSON.stringify(variantOptions({ Mode: '界'.repeat(100) }, bounded)),
      ),
    ).toBeLessThanOrEqual(MAX_OPTION_BYTES);
    expect(() =>
      variantOptions({ Binding: 'x'.repeat(2000) }, definitions),
    ).toThrow();
  });
  it.each([
    null,
    [],
    'value',
    1,
    {
      deep: {
        deep: {
          deep: {
            deep: {
              deep: {
                deep: { deep: { deep: { deep: { deep: { deep: {} } } } } },
              },
            },
          },
        },
      },
    },
    { huge: 'x'.repeat(16384) },
  ])('rejects invalid or oversized attributes %#', (input) => {
    expect(() => attributes(input)).toThrow();
  });
  it('accepts nested JSON attributes and rejects non-JSON service input', () => {
    expect(attributes({ data: [1, true, null, { note: 'ok' }] })).toEqual({
      data: [1, true, null, { note: 'ok' }],
    });
    expect(() => attributes({ bad: undefined })).toThrow();
    expect(() => attributes({ bad: Infinity })).toThrow();
  });
});

describe('New DTO boundaries', () => {
  const errors = (type: new () => object, data: object) =>
    validateSync(plainToInstance(type, data), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  it.each([
    {},
    { name: null },
    { name: ' ' },
    { name: 'x'.repeat(201) },
    { name: 'ok', stockQuantity: 4 },
    { name: 'ok', externalKey: 'key' },
    { name: 'ok', basePrice: 2 },
    { name: 'ok', basePrice: '-1' },
    { name: 'ok', basePrice: '10000000000' },
    { name: 'ok', basePrice: '1.001' },
    { name: 'ok', isActive: null },
    { name: 'ok', categoryId: 'invalid' },
  ])('rejects invalid product body %#', (body) => {
    expect(errors(CreateProductDto, body).length).toBeGreaterThan(0);
  });
  it('accepts bounded decimal strings, nullable price/category and partial patches', () => {
    expect(
      errors(CreateProductDto, {
        name: ' Item ',
        basePrice: '9999999999.99',
        categoryId: null,
      }),
    ).toEqual([]);
    expect(
      errors(UpdateProductDto, { description: null, basePrice: null }),
    ).toEqual([]);
    expect(errors(CategoryDto, { name: ' Trim ' })).toEqual([]);
  });
  it.each([
    { sku: ' ' },
    { sku: 'x'.repeat(201) },
    { stockQuantity: 0 },
    { trackInventory: true },
    { isActive: true },
    { unitPrice: 1 },
    { unitPrice: '-1' },
  ])('rejects forbidden variant fields / values %#', (body) => {
    expect(
      errors(CreateVariantDto, { optionValues: {}, ...body }).length,
    ).toBeGreaterThan(0);
  });
  it('supports nullable sku and inherited price', () => {
    expect(errors(UpdateVariantDto, { sku: null, unitPrice: null })).toEqual(
      [],
    );
  });
  it.each([true, false])('accepts variant lifecycle flag %s', (isActive) => {
    expect(errors(UpdateVariantDto, { isActive })).toEqual([]);
  });
  it.each([null, 'true', 1])(
    'rejects invalid variant lifecycle flag %s',
    (isActive) => {
      expect(errors(UpdateVariantDto, { isActive }).length).toBeGreaterThan(0);
    },
  );
});

describe('Atomic simple-product creation', () => {
  it('runs both writes inside the same transaction and propagates a variant-write failure', async () => {
    const variantFailure = new Error('variant write failed');
    const tx = {
      business: { findUnique: jest.fn().mockResolvedValue({ id: 'business' }) },
      catalogItem: { create: jest.fn().mockResolvedValue({ id: 'product' }) },
      productVariant: { create: jest.fn().mockRejectedValue(variantFailure) },
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (value: unknown) => Promise<unknown>) => work(tx),
      ),
    };
    const access = new ProductAccessService(prisma as unknown as PrismaService);
    const service = new ProductsService(
      prisma as unknown as PrismaService,
      access,
    );
    await expect(service.create('business', { name: 'Simple' })).rejects.toBe(
      variantFailure,
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.productVariant.create).toHaveBeenCalledWith({
      data: { businessId: 'business', catalogItemId: 'product' },
    });
  });
  it('returns a business-not-found error before creating any product', async () => {
    const tx = {
      business: { findUnique: jest.fn().mockResolvedValue(null) },
      catalogItem: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (value: unknown) => Promise<unknown>) => work(tx),
      ),
    };
    const service = new ProductsService(
      prisma as unknown as PrismaService,
      new ProductAccessService(prisma as unknown as PrismaService),
    );
    await expect(
      service.create('missing', { name: 'Simple' }),
    ).rejects.toMatchObject({ code: ErrorCode.BUSINESS_NOT_FOUND });
    expect(tx.catalogItem.create).not.toHaveBeenCalled();
  });
});
