import { RowNormalizer } from '../../src/imports/validation/row-normalizer';
import { RowValidator } from '../../src/imports/validation/row-validator';
import { MappingType } from '../../src/imports/mapping-fields';
import { SavedColumnMapping } from '../../src/imports/mapping.service';
import { ExcelValue } from '../../src/imports/adapters/excel.adapter';

describe('Row normalization and validation', () => {
  const normalizer = new RowNormalizer();
  const validator = new RowValidator(normalizer);
  const mapping: SavedColumnMapping[] = [
    ...[
      'externalKey',
      'name',
      'description',
      'category',
      'basePrice',
      'stockQuantity',
    ].map((target, index) => ({
      sourceColumn: target,
      sourceColumnIndex: index + 1,
      type: MappingType.STANDARD,
      target,
    })),
    {
      sourceColumn: 'Fabric',
      sourceColumnIndex: 7,
      type: MappingType.ATTRIBUTE,
      target: 'material',
    },
    {
      sourceColumn: 'Size',
      sourceColumnIndex: 8,
      type: MappingType.VARIANT_ATTRIBUTE,
      target: 'size',
    },
    {
      sourceColumn: 'Notes',
      sourceColumnIndex: 9,
      type: MappingType.IGNORE,
      target: null,
    },
    {
      sourceColumn: 'Other',
      sourceColumnIndex: 10,
      type: MappingType.UNMAPPED,
      target: null,
    },
  ];
  const values: ExcelValue[] = [
    ' SKU-001 ',
    ' T-Shirt  XL ',
    ' Cotton\nshirt ',
    ' Shirts ',
    '299.99',
    '10',
    ' Cotton ',
    ' XL ',
    'ignored',
    'unmapped',
  ];
  const validate = (input: ExcelValue[]) =>
    validator.validate(
      [{ rowNumber: 8, values: input, isEmpty: false }],
      mapping,
    );

  it('trims only surrounding whitespace and separates standard, attribute, and variant values', () => {
    const result = validate(values);
    expect(result.summary).toEqual({
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
      skippedRows: 0,
    });
    expect(result.validRows).toEqual([
      {
        rowNumber: 8,
        data: {
          externalKey: 'SKU-001',
          name: 'T-Shirt  XL',
          description: 'Cotton\nshirt',
          category: 'Shirts',
          basePrice: '299.99',
          stockQuantity: 10,
          attributes: { material: 'Cotton' },
          variantAttributes: { size: 'XL' },
        },
      },
    ]);
    expect(JSON.stringify(result.validRows)).not.toContain('ignored');
    expect(JSON.stringify(result.validRows)).not.toContain('unmapped');
  });

  it('distinguishes unmapped, mapped blank, and mapped value without overwriting semantics', () => {
    const partial = mapping.filter((entry) => entry.target !== 'category');
    const input = [...values];
    input[0] = ' ';
    input[2] = '\t';
    input[4] = '';
    input[5] = null;
    input[6] = ' ';
    const result = validator.validate(
      [{ rowNumber: 4, values: input, isEmpty: false }],
      partial,
    );
    const data = result.validRows[0].data;
    expect(data).toMatchObject({
      externalKey: null,
      name: 'T-Shirt  XL',
      description: null,
      basePrice: null,
      stockQuantity: null,
      attributes: { material: null },
    });
    expect(Object.hasOwn(data, 'category')).toBe(false);
    expect(Object.hasOwn(data, 'description')).toBe(true);
  });

  it.each([
    ['missing name', 1, '   ', 'name', 'REQUIRED'],
    ['negative price', 4, '-1', 'basePrice', 'INVALID_DECIMAL'],
    ['too many decimal places', 4, '1.234', 'basePrice', 'INVALID_DECIMAL'],
    ['non-numeric price', 4, 'free', 'basePrice', 'INVALID_DECIMAL'],
    [
      'decimal precision overflow',
      4,
      '10000000000.00',
      'basePrice',
      'INVALID_DECIMAL',
    ],
    ['currency price', 4, '$20', 'basePrice', 'INVALID_DECIMAL'],
    ['grouped price', 4, '1,000.00', 'basePrice', 'INVALID_DECIMAL'],
    ['scientific price', 4, '1e2', 'basePrice', 'INVALID_DECIMAL'],
    ['negative stock', 5, '-1', 'stockQuantity', 'INVALID_INTEGER'],
    ['decimal stock', 5, '1.5', 'stockQuantity', 'INVALID_INTEGER'],
    ['fractional stock string', 5, '10.0', 'stockQuantity', 'INVALID_INTEGER'],
    [
      'stock integer overflow',
      5,
      '2147483648',
      'stockQuantity',
      'INVALID_INTEGER',
    ],
    ['boolean stock', 5, true, 'stockQuantity', 'INVALID_INTEGER'],
    ['long name', 1, 'a'.repeat(201), 'name', 'TEXT_TOO_LONG'],
    ['long external key', 0, 'a'.repeat(201), 'externalKey', 'TEXT_TOO_LONG'],
    ['long category', 3, 'a'.repeat(201), 'category', 'TEXT_TOO_LONG'],
  ])('marks %s invalid', (_label, index, value, field, code) => {
    const input = [...values];
    input[index as number] = value as ExcelValue;
    const result = validate(input);
    expect(result.validRows).toHaveLength(0);
    expect(result.invalidRows).toEqual([
      { rowNumber: 8, errors: [expect.objectContaining({ field, code })] },
    ]);
  });

  it.each([
    ['0', '0.00'],
    ['.50', '0.50'],
    ['+001.20', '1.20'],
    ['9999999999.99', '9999999999.99'],
    [29.9, '29.90'],
  ])('normalizes price %s to an exact string', (value, expected) => {
    const input = [...values];
    input[4] = value;
    expect(validate(input).validRows[0].data.basePrice).toBe(expected);
  });

  it('preserves zero, scalar attributes, and numeric product codes', () => {
    const input = [...values];
    input[0] = 123;
    input[4] = 0;
    input[5] = 0;
    input[6] = false;
    input[7] = 42;
    expect(validate(input).validRows[0].data).toMatchObject({
      externalKey: '123',
      basePrice: '0.00',
      stockQuantity: 0,
      attributes: { material: false },
      variantAttributes: { size: 42 },
    });
  });

  it('marks every repeated non-null code invalid, including the first occurrence', () => {
    const first = [...values];
    const second = [...values];
    second[0] = 'SKU-001';
    second[4] = '-1';
    const result = validator.validate(
      [
        { rowNumber: 4, values: first, isEmpty: false },
        { rowNumber: 7, values: second, isEmpty: false },
      ],
      mapping,
    );
    expect(result.summary.invalidRows).toBe(2);
    expect(result.invalidRows.map((row) => row.rowNumber)).toEqual([4, 7]);
    for (const row of result.invalidRows)
      expect(row.errors).toContainEqual(
        expect.objectContaining({ code: 'DUPLICATE_EXTERNAL_KEY' }),
      );
    expect(result.invalidRows[1].errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_DECIMAL' }),
    );
  });

  it('allows multiple blank codes and treats case-distinct codes as distinct', () => {
    const result = validator.validate(
      [' ', null, 'SKU-001', 'sku-001'].map((key, index) => {
        const input = [...values];
        input[0] = key;
        return { rowNumber: index + 4, values: input, isEmpty: false };
      }),
      mapping,
    );
    expect(result.summary.validRows).toBe(4);
  });

  it('skips blank rows but marks a non-empty row with blank mapped values invalid', () => {
    const result = validator.validate(
      [
        { rowNumber: 4, values: [], isEmpty: true },
        {
          rowNumber: 5,
          values: [null, ' ', null, null, null, null, null, null, 'note'],
          isEmpty: false,
        },
      ],
      mapping,
    );
    expect(result.summary).toEqual({
      totalRows: 2,
      validRows: 0,
      invalidRows: 1,
      skippedRows: 1,
    });
    expect(result.invalidRows[0]).toMatchObject({
      rowNumber: 5,
      errors: [
        { field: 'name', code: 'REQUIRED', message: expect.any(String) },
      ],
    });
  });
});
