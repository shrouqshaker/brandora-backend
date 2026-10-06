import { ExcelValue } from '../adapters/excel.adapter';
import { StandardTarget } from '../mapping-fields';

export type NormalizedRow = Partial<Record<Exclude<StandardTarget, 'stockQuantity'>, string | null>> & {
  stockQuantity?: number | null;
  attributes?: Record<string, ExcelValue>;
  variantAttributes?: Record<string, ExcelValue>;
};

export interface RowError {
  field: string;
  code: string;
  message: string;
}

export interface InvalidRow {
  rowNumber: number;
  errors: RowError[];
}

export interface RowValidationResult {
  summary: { totalRows: number; validRows: number; invalidRows: number; skippedRows: number };
  validRows: { rowNumber: number; data: NormalizedRow }[];
  invalidRows: InvalidRow[];
}
