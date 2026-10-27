import { Prisma } from '../../src/generated/prisma/client';
import { ImportPlanner } from '../../src/imports/preview/import-planner';
import { ExistingCatalogItem } from '../../src/imports/preview/preview.types';
import { NormalizedRow } from '../../src/imports/validation/row.types';

describe('Import planner', () => {
  const planner = new ImportPlanner();
  const businessId = 'business-a';
  const item = (
    overrides: Partial<ExistingCatalogItem> = {},
  ): ExistingCatalogItem => ({
    id: 'item-id',
    businessId,
    externalKey: 'SKU-001',
    name: 'Shirt',
    description: 'Original description',
    category: 'Original category',
    basePrice: new Prisma.Decimal('29.9'),
    stockQuantity: 10,
    attributes: {
      material: 'Cotton',
      color: 'Blue',
      nested: { preserved: true },
    },
    ...overrides,
  });
  const plan = (
    data: NormalizedRow,
    existing: ExistingCatalogItem[] = [item()],
  ) => planner.plan(businessId, [{ rowNumber: 4, data }], existing);

  it('inserts a new code without matching by name', () => {
    const result = plan({
      externalKey: 'NEW',
      name: 'Shirt',
      basePrice: '29.90',
    });
    expect(result.inserts).toEqual([
      {
        rowNumber: 4,
        action: 'INSERT',
        externalKey: 'NEW',
        data: { externalKey: 'NEW', name: 'Shirt', basePrice: '29.90' },
      },
    ]);
  });

  it.each([undefined, null])(
    'inserts when externalKey is %s even if the name matches',
    (externalKey) => {
      expect(plan({ externalKey, name: 'Shirt' }).inserts[0].action).toBe(
        'INSERT',
      );
    },
  );

  it('updates only fields that differ and formats database decimals exactly', () => {
    expect(
      plan({
        externalKey: 'SKU-001',
        name: 'New Shirt',
        basePrice: '39.99',
        stockQuantity: 0,
      }).updates,
    ).toEqual([
      {
        rowNumber: 4,
        action: 'UPDATE',
        externalKey: 'SKU-001',
        catalogItemId: 'item-id',
        changes: {
          name: { from: 'Shirt', to: 'New Shirt' },
          basePrice: { from: '29.90', to: '39.99' },
          stockQuantity: { from: 10, to: 0 },
        },
      },
    ]);
  });

  it('classifies equal decimal/standard/attribute values as unchanged', () => {
    const result = plan({
      externalKey: 'SKU-001',
      name: 'Shirt',
      basePrice: '29.90',
      stockQuantity: 10,
      attributes: { material: 'Cotton' },
    });
    expect(result.updates).toEqual([]);
    expect(result.unchanged).toEqual([
      {
        rowNumber: 4,
        action: 'UNCHANGED',
        externalKey: 'SKU-001',
        catalogItemId: 'item-id',
      },
    ]);
  });

  it('does not overwrite mapped blanks or unmapped standard fields', () => {
    const result = plan({
      externalKey: 'SKU-001',
      name: 'Shirt',
      description: null,
      basePrice: null,
      stockQuantity: null,
    });
    expect(result.unchanged).toHaveLength(1);
    expect(result.updates).toEqual([]);
  });

  it('merges only non-blank attributes while preserving unmapped/nested values', () => {
    const original = item();
    const result = plan(
      {
        externalKey: 'SKU-001',
        name: 'Shirt',
        attributes: {
          material: 'Linen',
          color: null,
          size: 'XL',
          count: 0,
          enabled: false,
        },
      },
      [original],
    );
    expect(result.updates[0].changes.attributes).toEqual({
      from: original.attributes,
      to: {
        material: 'Linen',
        color: 'Blue',
        nested: { preserved: true },
        size: 'XL',
        count: 0,
        enabled: false,
      },
    });
    expect(original.attributes).toEqual({
      material: 'Cotton',
      color: 'Blue',
      nested: { preserved: true },
    });
  });

  it('adds non-blank attributes to null existing attributes', () => {
    expect(
      plan(
        {
          externalKey: 'SKU-001',
          name: 'Shirt',
          attributes: { material: 'Cotton' },
        },
        [item({ attributes: null })],
      ).updates[0].changes.attributes,
    ).toEqual({ from: null, to: { material: 'Cotton' } });
  });

  it('keeps all-blank attributes unchanged and excludes blanks from new attribute objects', () => {
    expect(
      plan({
        externalKey: 'SKU-001',
        name: 'Shirt',
        attributes: { material: null },
      }).unchanged,
    ).toHaveLength(1);
    expect(
      plan({ name: 'New', attributes: { material: null, count: 0 } }).inserts[0]
        .data.attributes,
    ).toEqual({ count: 0 });
  });

  it('returns variant attributes as metadata without catalog changes or insert fields', () => {
    const result = plan({
      externalKey: 'SKU-001',
      name: 'Shirt',
      variantAttributes: { size: 'XL' },
    });
    expect(result.unchanged[0].variantAttributes).toEqual({ size: 'XL' });
    const inserted = plan({ name: 'New', variantAttributes: { size: 'XL' } })
      .inserts[0];
    expect(inserted.variantAttributes).toEqual({ size: 'XL' });
    expect(inserted.data).not.toHaveProperty('variantAttributes');
  });

  it('does not match the same SKU in a different business', () => {
    expect(
      plan({ externalKey: 'SKU-001', name: 'Shirt' }, [
        item({ businessId: 'business-b' }),
      ]).inserts,
    ).toHaveLength(1);
  });

  it('does not plan actions for catalog products absent from the workbook', () => {
    const result = plan({ externalKey: 'SKU-001', name: 'Shirt' }, [
      item(),
      item({ id: 'missing-item', externalKey: 'MISSING' }),
    ]);
    expect(
      result.inserts.length + result.updates.length + result.unchanged.length,
    ).toBe(1);
    expect(JSON.stringify(result)).not.toContain('missing-item');
  });

  it.each(['legacy text', ['legacy array'], 7])(
    'refuses to silently replace non-object catalog attributes: %j',
    (attributes) => {
      expect(() =>
        plan(
          {
            externalKey: 'SKU-001',
            name: 'Shirt',
            attributes: { material: 'Cotton' },
          },
          [item({ attributes })],
        ),
      ).toThrow('Existing catalog attributes must be a JSON object');
    },
  );
});
