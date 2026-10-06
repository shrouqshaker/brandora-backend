import { Injectable } from '@nestjs/common';
import { ExcelDataRow } from '../adapters/excel.adapter';
import { SavedColumnMapping } from '../mapping.service';
import { RowNormalizer } from './row-normalizer';
import { RowError, RowValidationResult } from './row.types';

@Injectable()
export class RowValidator {
  constructor(private readonly normalizer: RowNormalizer) {}

  validate(rows: ExcelDataRow[], mapping: SavedColumnMapping[]): RowValidationResult {
    const candidates: { rowNumber: number; data: ReturnType<RowNormalizer['normalize']>['data']; errors: RowError[] }[] = [];
    const keys = new Map<string, number>();
    let skippedRows = 0;
    for (const row of rows) {
      if (row.isEmpty) { skippedRows++; continue; }
      const normalized = this.normalizer.normalize(row.values, mapping);
      if (!normalized.data.name) {
        normalized.errors.push({ field: 'name', code: 'REQUIRED', message: 'Product name is required' });
      }
      for (const field of ['name', 'externalKey', 'category'] as const) {
        if ((normalized.data[field]?.length ?? 0) > 200) {
          normalized.errors.push({ field, code: 'TEXT_TOO_LONG', message: `${field} must be at most 200 characters` });
        }
      }
      if (normalized.data.externalKey !== null && normalized.data.externalKey !== undefined) {
        keys.set(normalized.data.externalKey, (keys.get(normalized.data.externalKey) ?? 0) + 1);
      }
      candidates.push({ rowNumber: row.rowNumber, ...normalized });
    }
    const result: RowValidationResult = {
      summary: { totalRows: rows.length, validRows: 0, invalidRows: 0, skippedRows }, validRows: [], invalidRows: [],
    };
    for (const row of candidates) {
      const key = row.data.externalKey;
      if (key != null && (keys.get(key) ?? 0) > 1) {
        row.errors.push({ field: 'externalKey', code: 'DUPLICATE_EXTERNAL_KEY', message: 'Product code occurs more than once in this workbook' });
      }
      if (row.errors.length) result.invalidRows.push({ rowNumber: row.rowNumber, errors: row.errors });
      else result.validRows.push({ rowNumber: row.rowNumber, data: row.data });
    }
    result.summary.validRows = result.validRows.length;
    result.summary.invalidRows = result.invalidRows.length;
    return result;
  }
}
