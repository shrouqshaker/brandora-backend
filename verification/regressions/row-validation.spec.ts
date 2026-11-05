import { RowValidator } from '../../src/imports/validation/row-validator';
import { RowNormalizer } from '../../src/imports/validation/row-normalizer';
import { MappingType } from '../../src/imports/mapping-fields';
import { ExcelValue } from '../../src/imports/adapters/excel.adapter';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateProductDto,
  UpdateProductDto,
} from '../../src/products/dto/product.dto';

describe('Products and Excel share the externalKey Unicode length boundary', () => {
  const validator = new RowValidator(new RowNormalizer());
  const mapping = ['externalKey', 'name'].map((target, index) => ({
    sourceColumn: target,
    sourceColumnIndex: index + 1,
    type: MappingType.STANDARD,
    target,
  }));
  const cases = [
    ['ASCII', 'A'],
    ['Arabic', '\u0634'],
    ['non-BMP', '\u{1F9F5}'],
    ['mixed Arabic/non-BMP', '\u0634\u{1F9F5}'],
    ['combining mark', 'a\u0301'],
    ['variation selector', '\u2764\uFE0F'],
  ].flatMap(([label, text]) =>
    [199, 200, 201].map((length) => ({
      label,
      length,
      key: Array.from(text.repeat(length)).slice(0, length).join(''),
    })),
  );

  it.each(cases)(
    '$label with $length code points agrees on create, update and import',
    ({ key, length }) => {
      const accepted = length <= 200;
      for (const dto of [
        plainToInstance(CreateProductDto, {
          name: 'Manual',
          externalKey: `  ${key}  `,
        }),
        plainToInstance(UpdateProductDto, { externalKey: `  ${key}  ` }),
      ]) {
        const errors = validateSync(dto);
        expect(errors.length === 0).toBe(accepted);
        expect(dto.externalKey).toBe(key);
        if (!accepted)
          expect(errors).toEqual([
            expect.objectContaining({
              property: 'externalKey',
              constraints: {
                maxLength:
                  'externalKey must be shorter than or equal to 200 characters',
              },
            }),
          ]);
      }
      const result = validator.validate(
        [{ rowNumber: 2, values: [`  ${key}  `, 'Manual'], isEmpty: false }],
        mapping,
      );
      expect(result.summary.validRows).toBe(accepted ? 1 : 0);
      if (accepted) expect(result.validRows[0].data.externalKey).toBe(key);
      else
        expect(result.invalidRows[0].errors).toEqual([
          {
            field: 'externalKey',
            code: 'TEXT_TOO_LONG',
            message: 'externalKey must be at most 200 characters',
          },
        ]);
    },
  );

  it('preserves case and distinct composed/decomposed matching identities', () => {
    const keys = ['Manual', 'manual', '\u00E9', 'e\u0301'];
    const result = validator.validate(
      keys.map((key, index) => ({
        rowNumber: index + 2,
        values: [key, 'Manual'],
        isEmpty: false,
      })),
      mapping,
    );
    expect(result.summary.validRows).toBe(keys.length);
    expect(result.validRows.map((row) => row.data.externalKey)).toEqual(keys);
    for (const key of keys) {
      const dto = plainToInstance(CreateProductDto, {
        name: 'Manual',
        externalKey: key,
      });
      expect(validateSync(dto)).toEqual([]);
      expect(dto.externalKey).toBe(key);
    }
  });
});

describe('Product/variant workbook normalization and grouping', () => {
  const validator = new RowValidator(new RowNormalizer());
  const targets = [
    'externalKey',
    'name',
    'sku',
    'basePrice',
    'unitPrice',
    'stockQuantity',
    'color',
    'size',
  ];
  const mapping = targets.map((target, i) => ({
    sourceColumn: target,
    sourceColumnIndex: i + 1,
    type: i < 6 ? MappingType.STANDARD : MappingType.VARIANT_ATTRIBUTE,
    target,
  }));
  const validate = (rows: ExcelValue[][], configurable = true) =>
    validator.validate(
      rows.map((values, i) => ({
        rowNumber: i + 2,
        values,
        isEmpty: values.every((v) => v === null),
      })),
      configurable ? mapping : mapping.slice(0, 6),
    );
  const row: ExcelValue[] = [
    'P',
    'Shirt',
    'RED-M',
    '10',
    '12.50',
    3,
    'Red',
    'M',
  ];
  it('groups product rows into arbitrary option definitions and independent variants', () => {
    const r = validate([
      row,
      ['P', 'Shirt', 'BLUE-M', '10', null, 8, 'Blue', 'M'],
    ]);
    expect(r.summary.validRows).toBe(2);
    expect(r.validRows[0].data).toMatchObject({
      basePrice: '10.00',
      unitPrice: '12.50',
      stockQuantity: 3,
      options: { color: ['Red', 'Blue'], size: ['M'] },
    });
  });
  it('supports simple products with {} options and an optional default SKU', () => {
    const r = validate([['TEA', 'Tea', null, '5', null, null]], false);
    expect(r.summary.validRows).toBe(1);
    expect(r.validRows[0].data.options).toEqual({});
    expect(r.validRows[0].data.stockQuantity).toBeNull();
  });
  it.each([0, 5, 2147483647])('normalizes quantity %s', (q) => {
    expect(
      validate([row.map((v, i) => (i === 5 ? q : v))]).validRows[0].data
        .stockQuantity,
    ).toBe(q);
  });
  it.each([-1, 1.5, '1e2', '1,000', 2147483648])(
    'rejects invalid quantity %s',
    (q) => {
      expect(
        validate([row.map((v, i) => (i === 5 ? q : v))]).summary.invalidRows,
      ).toBe(1);
    },
  );
  it.each(['-1', '1.234', '1e3', '10000000000', '$2'])(
    'rejects invalid price %s',
    (p) => {
      expect(
        validate([row.map((v, i) => (i === 3 ? p : v))]).summary.invalidRows,
      ).toBe(1);
    },
  );
  it.each([0, 1, 2, 6, 7])(
    'requires identity/name/selected option cell %s',
    (index) => {
      expect(
        validate([row.map((v, i) => (i === index ? null : v))]).summary
          .invalidRows,
      ).toBe(1);
    },
  );
  it('rejects duplicate option combinations even with different SKUs', () => {
    expect(
      validate([row, row.map((v, i) => (i === 2 ? 'OTHER' : v))]).summary
        .invalidRows,
    ).toBe(2);
  });
  it('rejects duplicate SKUs across product groups', () => {
    expect(
      validate([row, row.map((v, i) => (i === 0 ? 'OTHER' : v))]).summary
        .invalidRows,
    ).toBe(2);
  });
  it('rejects inconsistent metadata across rows of one product', () => {
    expect(
      validate([row, ['P', 'Different', 'BLUE', '10', null, 8, 'Blue', 'M']])
        .summary.invalidRows,
    ).toBe(2);
  });
  it('counts physical blanks separately', () => {
    expect(validate([row, [null, null, null]]).summary).toEqual({
      totalRows: 2,
      validRows: 1,
      invalidRows: 0,
      skippedRows: 1,
    });
  });
  it('turns numeric selected values into canonical string values', () => {
    const r = validate([row.map((v, i) => (i === 7 ? 42 : v))]);
    expect(r.validRows[0].data.variantAttributes!.size).toBe('42');
  });
  it('does not let a missing product code collide with a literal missing-row code', () => {
    const result = validate(
      [
        [null, 'Missing', null, null, null, null],
        ['missing:2', 'Valid', null, null, null, null],
      ],
      false,
    );
    expect(result.summary.validRows).toBe(1);
    expect(result.validRows[0].data.externalKey).toBe('missing:2');
    expect(result.summary.invalidRows).toBe(1);
  });
});
