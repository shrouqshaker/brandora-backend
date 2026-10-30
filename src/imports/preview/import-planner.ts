import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { RowValidationResult } from '../validation/row.types';
import { combinationKey } from '../validation/row-validator';
import {
  ExistingCatalogItem,
  ImportPlan,
  PlannedUpdate,
} from './preview.types';
import {
  mergedOptions,
  selectedOptions,
  mergedImportAttributes,
  importCategoryName,
  ImportCategories,
} from '../variant-import-policy';
import { NormalizedRow } from '../validation/row.types';

@Injectable()
export class ImportPlanner {
  productChanges(
    data: NormalizedRow,
    item: ExistingCatalogItem,
    categories: ImportCategories = new Map(),
  ): PlannedUpdate['changes'] {
    const changes: PlannedUpdate['changes'] = {};
    for (const field of [
      'name',
      'description',
      'category',
      'basePrice',
    ] as const) {
      const incoming = data[field];
      const previous =
        field === 'basePrice'
          ? (item.basePrice?.toFixed(2) ?? null)
          : item[field];
      if (incoming != null && incoming !== previous)
        changes[field] = { from: previous, to: incoming };
    }
    if (data.category) {
      const name = importCategoryName(data.category);
      const resolved = categories.get(name);
      if (!resolved?.id || resolved.id !== item.categoryId)
        changes.categoryId = {
          from: item.categoryId ?? null,
          to: resolved?.id ?? { create: name },
        };
    }
    const options = mergedOptions(data.options ?? {}, item.options);
    if (
      combinationKey(options) !==
      combinationKey((item.options ?? {}) as Record<string, unknown>)
    )
      changes.options = { from: item.options ?? {}, to: options };
    const merged = mergedImportAttributes(data, item.attributes);
    if (
      combinationKey(merged) !==
      combinationKey((item.attributes ?? {}) as Record<string, unknown>)
    )
      changes.attributes = {
        from: item.attributes,
        to: merged as Prisma.JsonObject,
      };
    return changes;
  }
  plan(
    businessId: string,
    rows: RowValidationResult['validRows'],
    existing: ExistingCatalogItem[],
    categories: ImportCategories = new Map(),
  ): ImportPlan {
    const plan: ImportPlan = { inserts: [], updates: [], unchanged: [] };
    for (const row of rows) {
      const item = existing.find(
        (p) =>
          p.businessId === businessId && p.externalKey === row.data.externalKey,
      );
      const selection = selectedOptions(row.data);
      const variant = item?.variants?.find(
        (v) =>
          combinationKey(v.optionValues as Record<string, unknown>) ===
          combinationKey(selection),
      );
      const identity = {
        rowNumber: row.rowNumber,
        externalKey: row.data.externalKey ?? null,
        variantAttributes: row.data.variantAttributes,
        ...(variant ? { variantId: variant.id } : {}),
      };
      if (!item || !variant) {
        plan.inserts.push({ ...identity, action: 'INSERT', data: row.data });
        continue;
      }
      const changes = this.productChanges(row.data, item, categories);
      for (const field of ['sku', 'unitPrice', 'stockQuantity'] as const) {
        const incoming = row.data[field];
        const previous =
          field === 'unitPrice'
            ? (variant.unitPrice?.toFixed(2) ?? null)
            : variant[field];
        if (incoming != null && incoming !== previous)
          changes[field] = { from: previous, to: incoming };
      }
      if (Object.keys(changes).length)
        plan.updates.push({
          ...identity,
          action: 'UPDATE',
          catalogItemId: item.id,
          changes,
        });
      else
        plan.unchanged.push({
          ...identity,
          action: 'UNCHANGED',
          catalogItemId: item.id,
        });
    }
    return plan;
  }
}
