import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { ExcelValue } from '../adapters/excel.adapter';
import { SavedColumnMapping } from '../mapping.service';
import { MappingType, StandardTarget } from '../mapping-fields';
import { NormalizedRow, RowError } from './row.types';

@Injectable()
export class RowNormalizer {
  normalize(
    values: ExcelValue[],
    mapping: SavedColumnMapping[],
  ): { data: NormalizedRow; errors: RowError[] } {
    const data: NormalizedRow = {};
    const errors: RowError[] = [];
    for (const entry of mapping) {
      if (
        entry.type === MappingType.IGNORE ||
        entry.type === MappingType.UNMAPPED
      )
        continue;
      const value = this.trim(values[entry.sourceColumnIndex - 1] ?? null);
      if (
        entry.type === MappingType.ATTRIBUTE ||
        entry.type === MappingType.VARIANT_ATTRIBUTE
      ) {
        const field =
          entry.type === MappingType.ATTRIBUTE
            ? 'attributes'
            : 'variantAttributes';
        data[field] ??= {};
        data[field]![entry.target!] = value;
        continue;
      }
      const field = entry.target as StandardTarget;
      const text = value === null ? null : String(value);
      if (field === 'basePrice' || field === 'unitPrice') {
        data[field] = null;
        if (text === null) continue;
        // No currency/grouping separators, exponent notation, or implicit rounding.
        if (!/^\+?(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) {
          errors.push(this.priceError(field));
          continue;
        }
        const decimal = new Prisma.Decimal(text);
        if (decimal.greaterThanOrEqualTo('10000000000')) {
          errors.push(this.priceError(field));
          continue;
        }
        data[field] = decimal.toFixed(2);
      } else if (field === 'stockQuantity') {
        data.stockQuantity = null;
        if (text === null) continue;
        const quantity = Number(text);
        if (
          !/^\+?\d+$/.test(text) ||
          !Number.isInteger(quantity) ||
          quantity > 2147483647
        ) {
          errors.push({
            field,
            code: 'INVALID_INTEGER',
            message:
              'Available quantity must be a non-negative integer no greater than 2147483647',
          });
          continue;
        }
        data.stockQuantity = quantity;
      } else {
        data[field] = text;
      }
    }
    return { data, errors };
  }

  private trim(value: ExcelValue): ExcelValue {
    return typeof value === 'string' ? value.trim() || null : value;
  }

  private priceError(field: 'basePrice' | 'unitPrice'): RowError {
    return {
      field,
      code: 'INVALID_DECIMAL',
      message:
        'Price must be a non-negative number with at most 2 decimal places and at most 10 integer digits',
    };
  }
}
