import { Injectable } from '@nestjs/common';
import { ExcelDataRow } from '../adapters/excel.adapter';
import { SavedColumnMapping } from '../mapping.service';
import { RowNormalizer } from './row-normalizer';
import { RowError, RowValidationResult } from './row.types';
import {
  productOptions,
  variantOptions,
} from '../../products/product-validation';

export const combinationKey = (value: Record<string, unknown>) =>
  JSON.stringify(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

@Injectable()
export class RowValidator {
  constructor(private readonly normalizer: RowNormalizer) {}
  validate(
    rows: ExcelDataRow[],
    mapping: SavedColumnMapping[],
  ): RowValidationResult {
    const candidates: {
      rowNumber: number;
      data: ReturnType<RowNormalizer['normalize']>['data'];
      errors: RowError[];
    }[] = [];
    let skippedRows = 0;
    for (const row of rows) {
      if (row.isEmpty) {
        skippedRows++;
        continue;
      }
      const normalized = this.normalizer.normalize(row.values, mapping);
      if ((normalized.data.description?.length ?? 0) > 5000)
        normalized.errors.push({
          field: 'description',
          code: 'TEXT_TOO_LONG',
          message: 'description must be at most 5000 characters',
        });
      for (const field of ['name', 'externalKey'] as const)
        if (!normalized.data[field])
          normalized.errors.push({
            field,
            code: 'REQUIRED',
            message: `${field} is required; product code is the stable product identity`,
          });
      for (const field of ['name', 'externalKey', 'sku', 'category'] as const)
        if ((normalized.data[field]?.length ?? 0) > 200)
          normalized.errors.push({
            field,
            code: 'TEXT_TOO_LONG',
            message: `${field} must be at most 200 characters`,
          });
      // VARIANT_ATTRIBUTE now defines a real selected option, never inert metadata.
      if (normalized.data.variantAttributes) {
        for (const [key, value] of Object.entries(
          normalized.data.variantAttributes,
        )) {
          if (value === null || String(value).trim() === '')
            normalized.errors.push({
              field: key,
              code: 'REQUIRED_OPTION',
              message: 'Every mapped option requires a selected value',
            });
          else normalized.data.variantAttributes[key] = String(value).trim();
        }
        if (!normalized.data.sku)
          normalized.errors.push({
            field: 'sku',
            code: 'REQUIRED',
            message: 'Configurable variants require a stable SKU',
          });
      }
      candidates.push({ rowNumber: row.rowNumber, ...normalized });
    }
    const skus = new Map<string, number>();
    for (const row of candidates)
      if (row.data.sku)
        skus.set(row.data.sku, (skus.get(row.data.sku) ?? 0) + 1);
    const groups = new Map<string | symbol, typeof candidates>();
    for (const row of candidates) {
      const key = row.data.externalKey ?? Symbol('missing product code');
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const options: Record<string, string[]> = Object.create(null);
      const seen = new Set<string>();
      const metadata = (data: (typeof group)[number]['data']) =>
        JSON.stringify([
          data.name,
          data.description,
          data.category,
          data.basePrice,
          combinationKey(data.attributes ?? {}),
        ]);
      for (const row of group) {
        if (metadata(row.data) !== metadata(group[0].data))
          row.errors.push({
            field: 'externalKey',
            code: 'CONFLICTING_PRODUCT_ROWS',
            message:
              'Rows sharing a product code must agree on all product metadata',
          });
        if (row.data.sku && (skus.get(row.data.sku) ?? 0) > 1)
          row.errors.push({
            field: 'sku',
            code: 'DUPLICATE_SKU',
            message: 'SKU occurs more than once in this workbook',
          });
        const key = combinationKey(row.data.variantAttributes ?? {});
        if (seen.has(key))
          row.errors.push({
            field: 'variantAttributes',
            code: 'DUPLICATE_COMBINATION',
            message: 'One row per product/option combination is required',
          });
        seen.add(key);
        for (const [name, value] of Object.entries(
          row.data.variantAttributes ?? {},
        )) {
          const values = (options[name] ??= []);
          if (value !== null && !values.includes(String(value)))
            values.push(String(value));
        }
      }
      try {
        productOptions(options);
        for (const row of group)
          variantOptions(row.data.variantAttributes ?? {}, options);
      } catch {
        group[0].errors.push({
          field: 'variantAttributes',
          code: 'INVALID_OPTIONS',
          message:
            'Option definitions/selections exceed product rules or are incomplete',
        });
      }
      const failed = group.some((row) => row.errors.length);
      for (const row of group) {
        row.data.options = options;
        if (failed && !row.errors.length)
          row.errors.push({
            field: 'externalKey',
            code: 'PRODUCT_GROUP_INVALID',
            message:
              'Another row in this product group is invalid; the group will not be applied',
          });
      }
    }
    const validRows = candidates
      .filter((row) => !row.errors.length)
      .map(({ rowNumber, data }) => ({ rowNumber, data }));
    const invalidRows = candidates
      .filter((row) => row.errors.length)
      .map(({ rowNumber, errors }) => ({ rowNumber, errors }));
    return {
      summary: {
        totalRows: rows.length,
        validRows: validRows.length,
        invalidRows: invalidRows.length,
        skippedRows,
      },
      validRows,
      invalidRows,
    };
  }
}
