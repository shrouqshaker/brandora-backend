import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../../common/errors/app-http.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { Prisma } from '../../generated/prisma/client';
import { STANDARD_FIELDS } from '../mapping-fields';
import { RowValidationResult } from '../validation/row.types';
import {
  ExistingCatalogItem,
  ImportPlan,
  PlannedUpdate,
} from './preview.types';

@Injectable()
export class ImportPlanner {
  plan(
    businessId: string,
    rows: RowValidationResult['validRows'],
    existing: ExistingCatalogItem[],
  ): ImportPlan {
    const byKey = new Map(
      existing
        .filter(
          (item) => item.businessId === businessId && item.externalKey !== null,
        )
        .map((item) => [item.externalKey!, item]),
    );
    const plan: ImportPlan = { inserts: [], updates: [], unchanged: [] };
    for (const row of rows) {
      const externalKey = row.data.externalKey ?? null;
      const item = externalKey === null ? undefined : byKey.get(externalKey);
      const { variantAttributes, attributes, ...standardData } = row.data;
      const metadata =
        variantAttributes === undefined ? {} : { variantAttributes };
      const identity = { rowNumber: row.rowNumber, externalKey, ...metadata };
      const attributeValues = Object.entries(attributes ?? {}).filter(
        ([_key, value]) => value !== null,
      );
      if (!item) {
        plan.inserts.push({
          ...identity,
          action: 'INSERT',
          data: {
            ...standardData,
            ...(attributeValues.length
              ? { attributes: Object.fromEntries(attributeValues) }
              : {}),
          },
        });
        continue;
      }
      const changes: PlannedUpdate['changes'] = {};
      // Unmapped fields are absent from normalized data; mapped blanks are null.
      for (const { target } of STANDARD_FIELDS) {
        const incoming = row.data[target];
        if (incoming === undefined || incoming === null) continue;
        const previous =
          target === 'basePrice'
            ? (item.basePrice?.toFixed(2) ?? null)
            : item[target];
        if (previous !== incoming)
          changes[target] = { from: previous, to: incoming };
      }
      if (attributeValues.length) {
        if (
          item.attributes !== null &&
          (typeof item.attributes !== 'object' ||
            Array.isArray(item.attributes))
        ) {
          throw new AppHttpException(
            ErrorCode.CATALOG_ATTRIBUTES_INVALID,
            HttpStatus.CONFLICT,
            'Existing catalog attributes must be a JSON object before merging mapped attributes',
          );
        }
        const previous = item.attributes as Prisma.JsonObject | null;
        const merged: Prisma.JsonObject = { ...(previous ?? {}) };
        let changed = false;
        for (const [key, value] of attributeValues) {
          if (!Object.hasOwn(merged, key) || merged[key] !== value) {
            merged[key] = value;
            changed = true;
          }
        }
        if (changed) changes.attributes = { from: previous, to: merged };
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
