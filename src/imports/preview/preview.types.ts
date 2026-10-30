import {
  CatalogItem,
  ProductVariant,
  Prisma,
} from '../../generated/prisma/client';
import { ExcelValue } from '../adapters/excel.adapter';
import { NormalizedRow } from '../validation/row.types';

export type ExistingCatalogItem = Pick<
  CatalogItem,
  | 'id'
  | 'businessId'
  | 'externalKey'
  | 'name'
  | 'description'
  | 'category'
  | 'basePrice'
  | 'attributes'
> & {
  variants?: ProductVariant[];
  options?: Prisma.JsonValue;
  isActive?: boolean;
  categoryId?: string | null;
};

interface PlannedRow {
  rowNumber: number;
  externalKey: string | null;
  variantId?: string;
  variantAttributes?: Record<string, ExcelValue>;
}

export interface PlannedInsert extends PlannedRow {
  action: 'INSERT';
  data: Omit<NormalizedRow, 'variantAttributes'>;
}

export interface PlannedUpdate extends PlannedRow {
  action: 'UPDATE';
  catalogItemId: string;
  changes: Record<string, { from: Prisma.JsonValue; to: Prisma.JsonValue }>;
}

export interface PlannedUnchanged extends PlannedRow {
  action: 'UNCHANGED';
  catalogItemId: string;
}

export interface ImportPlan {
  inserts: PlannedInsert[];
  updates: PlannedUpdate[];
  unchanged: PlannedUnchanged[];
}
