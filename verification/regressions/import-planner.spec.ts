import { ImportPlanner } from '../../src/imports/preview/import-planner';
import { Prisma } from '../../src/generated/prisma/client';
import {
  checkImportDatabase,
  mergedOptions,
} from '../../src/imports/variant-import-policy';

describe('Variant import planning and scoped database conflict checks', () => {
  const planner = new ImportPlanner();
  const product: any = {
    id: 'p',
    businessId: 'b',
    externalKey: 'P',
    name: 'Tea',
    description: null,
    category: null,
    basePrice: new Prisma.Decimal('5'),
    attributes: null,
    options: {},
    isActive: true,
    variants: [
      {
        id: 'v',
        businessId: 'b',
        catalogItemId: 'p',
        optionValues: {},
        sku: 'TEA',
        unitPrice: null,
        stockQuantity: 4,
        trackInventory: true,
        isActive: true,
      },
    ],
  };
  const row: any = {
    rowNumber: 2,
    data: { externalKey: 'P', name: 'Tea', sku: 'TEA', options: {} },
  };
  it('matches a product code and its default variant', () => {
    expect(planner.plan('b', [row], [product]).unchanged[0]).toMatchObject({
      catalogItemId: 'p',
      variantId: 'v',
    });
  });
  it('matches the same combination independently of JSON key ordering', () => {
    const configured = {
      ...product,
      options: { Color: ['Red'], Size: ['M'] },
      variants: [
        { ...product.variants[0], optionValues: { Size: 'M', Color: 'Red' } },
      ],
    };
    const incoming = {
      ...row,
      data: {
        ...row.data,
        options: { Color: ['Red'], Size: ['M'] },
        variantAttributes: { Color: 'Red', Size: 'M' },
      },
    };
    expect(
      planner.plan('b', [incoming], [configured]).unchanged[0].variantId,
    ).toBe('v');
  });
  it('does not match another business', () => {
    expect(planner.plan('other', [row], [product]).inserts).toHaveLength(1);
  });
  it('plans insertion when an existing legacy product has no default variant', () => {
    expect(
      planner.plan('b', [row], [{ ...product, variants: [] }]).inserts,
    ).toHaveLength(1);
  });
  it('plans variant stock updates, never product stock', () => {
    expect(
      planner.plan(
        'b',
        [{ ...row, data: { ...row.data, stockQuantity: 8 } }],
        [product],
      ).updates[0].changes,
    ).toEqual({ stockQuantity: { from: 4, to: 8 } });
  });
  it('blank/unmapped stock leaves inventory untouched', () => {
    expect(
      planner.plan(
        'b',
        [{ ...row, data: { ...row.data, stockQuantity: null } }],
        [product],
      ).unchanged,
    ).toHaveLength(1);
  });
  it('compares decimal variant prices precisely', () => {
    expect(
      planner.plan(
        'b',
        [{ ...row, data: { ...row.data, unitPrice: '6.25' } }],
        [product],
      ).updates[0].changes.unitPrice,
    ).toEqual({ from: null, to: '6.25' });
  });
  it('preserves existing attributes while merging mapped nonblank values', () => {
    expect(
      planner.plan(
        'b',
        [
          {
            ...row,
            data: {
              ...row.data,
              attributes: { material: 'cotton', ignored: null },
            },
          },
        ],
        [{ ...product, attributes: { brand: 'local' } }],
      ).updates[0].changes.attributes.to,
    ).toEqual({ brand: 'local', material: 'cotton' });
  });
  it('extends allowed values without removing unimported selections', () => {
    expect(mergedOptions({ size: ['M'] }, { size: ['S', 'L'] })).toEqual({
      size: ['S', 'L', 'M'],
    });
  });
  it('rejects implicit simple-to-configurable conversion', () => {
    expect(() => mergedOptions({ size: ['M'] }, {})).toThrow();
  });
  it('validates an existing scoped SKU reservation', async () => {
    const db: any = {
      catalogItem: { findMany: jest.fn().mockResolvedValue([product]) },
      productVariant: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { ...product.variants[0], catalogItemId: 'other' },
          ]),
      },
    };
    const r = await checkImportDatabase(
      {
        summary: { totalRows: 1, validRows: 1, invalidRows: 0, skippedRows: 0 },
        validRows: [row],
        invalidRows: [],
      },
      'b',
      db,
    );
    expect(r.summary.invalidRows).toBe(1);
    expect(db.productVariant.findMany.mock.calls[0][0].where.businessId).toBe(
      'b',
    );
  });
  it('rejects imports into inactive products', async () => {
    const db: any = {
      catalogItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ ...product, isActive: false }]),
      },
      productVariant: { findMany: jest.fn().mockResolvedValue([]) },
    };
    expect(
      (
        await checkImportDatabase(
          {
            summary: {
              totalRows: 1,
              validRows: 1,
              invalidRows: 0,
              skippedRows: 0,
            },
            validRows: [row],
            invalidRows: [],
          },
          'b',
          db,
        )
      ).validRows,
    ).toHaveLength(0);
  });
  it('repairs category relation even when the legacy category string matches', () => {
    const incoming = { ...row, data: { ...row.data, category: 'Clothes' } };
    const current = { ...product, category: 'Clothes', categoryId: 'wrong' };
    const categories = new Map([['Clothes', { name: 'Clothes', id: 'right' }]]);
    expect(
      planner.plan('b', [incoming], [current], categories).updates[0].changes
        .categoryId,
    ).toEqual({ from: 'wrong', to: 'right' });
    expect(
      planner.plan(
        'b',
        [incoming],
        [{ ...current, categoryId: 'right' }],
        categories,
      ).unchanged,
    ).toHaveLength(1);
  });
  it('previews normalized category creation without writing a category', () => {
    const incoming = {
      ...row,
      data: { ...row.data, category: '  New   category  ' },
    };
    expect(
      planner.plan('b', [incoming], [product]).updates[0].changes.categoryId,
    ).toEqual({ from: null, to: { create: 'New category' } });
  });
  it('rejects oversized merged attributes before READY although each input fits', async () => {
    const incoming = {
      ...row,
      data: { ...row.data, attributes: { second: 'b'.repeat(8500) } },
    };
    const previous = { ...product, attributes: { first: 'a'.repeat(8500) } };
    const db: any = {
      catalogItem: { findMany: jest.fn().mockResolvedValue([previous]) },
      productVariant: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const result = await checkImportDatabase(
      {
        summary: { totalRows: 1, validRows: 1, invalidRows: 0, skippedRows: 0 },
        validRows: [incoming],
        invalidRows: [],
      },
      'b',
      db,
    );
    expect(result.validRows).toHaveLength(0);
    expect(result.invalidRows[0].errors[0]).toMatchObject({
      field: 'attributes',
      code: 'MERGED_ATTRIBUTES_INVALID',
    });
  });
});
