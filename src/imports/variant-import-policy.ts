import { Prisma, ProductVariant } from '../generated/prisma/client';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import {
  productOptions,
  variantOptions,
  ProductOptions,
  attributes,
} from '../products/product-validation';
import {
  RowValidationResult,
  NormalizedRow,
  RowError,
} from './validation/row.types';
import { combinationKey } from './validation/row-validator';

export function mergedOptions(
  incoming: ProductOptions,
  existing?: Prisma.JsonValue,
): ProductOptions {
  if (existing === undefined) return productOptions(incoming);
  const previous = productOptions(existing);
  if (
    combinationKey(
      Object.fromEntries(Object.keys(previous).map((k) => [k, true])),
    ) !==
    combinationKey(
      Object.fromEntries(Object.keys(incoming).map((k) => [k, true])),
    )
  )
    throw new Error(
      'Import cannot change option names or convert a simple product; use reviewed Product CRUD',
    );
  return productOptions(
    Object.fromEntries(
      Object.keys(previous).map((k) => [
        k,
        [...new Set([...previous[k], ...incoming[k]])],
      ]),
    ),
  );
}
export function selectedOptions(row: NormalizedRow) {
  return Object.fromEntries(
    Object.entries(row.variantAttributes ?? {}).map(([k, v]) => [k, String(v)]),
  );
}

export interface ImportCategoryResolution {
  name: string;
  id: string | null;
}
export type ImportCategories = Map<string, ImportCategoryResolution>;
export const importCategoryName = (value: string) =>
  value.trim().replace(/\s+/g, ' ');

// PostgreSQL performs case folding, matching the database expression index.
// Reads only; validation and preview must never create category records.
export async function resolveImportCategories(
  names: string[],
  businessId: string,
  db: Prisma.TransactionClient,
): Promise<ImportCategories> {
  const distinct = [...new Set(names.map(importCategoryName))];
  const resolutions: ImportCategories = new Map();
  for (let offset = 0; offset < distinct.length; offset += 1000) {
    const batch = distinct.slice(offset, offset + 1000);
    const matches = await db.$queryRaw<{ name: string; id: string | null }[]>`
      SELECT input.name, c.id FROM unnest(${batch}::text[]) AS input(name)
      LEFT JOIN "Category" c ON c."businessId"=${businessId}::uuid
      AND lower(btrim(regexp_replace(c.name, '[[:space:]]+', ' ', 'g'))) = lower(input.name)`;
    for (const match of matches) resolutions.set(match.name, match);
  }
  return resolutions;
}

export async function ensureImportCategory(
  resolution: ImportCategoryResolution,
  businessId: string,
  tx: Prisma.TransactionClient,
): Promise<string> {
  if (resolution.id) return resolution.id;
  // Do not abort the whole transaction merely because another product group
  // created this normalized category first. Serializable races are retried by
  // the group runner, using a new snapshot only after the aborted attempt.
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "Category" (id, "businessId", name, "createdAt", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${businessId}::uuid, ${resolution.name}, now(), now())
    ON CONFLICT DO NOTHING RETURNING id`;
  if (inserted[0]) return inserted[0].id;
  const current = (
    await resolveImportCategories([resolution.name], businessId, tx)
  ).get(resolution.name);
  if (!current?.id)
    throw new ConflictException(
      'Category changed concurrently; retry this product group',
    );
  return current.id;
}

export function mergedImportAttributes(
  row: NormalizedRow,
  previous?: Prisma.JsonValue,
): Prisma.InputJsonObject {
  const incoming = attributes(row.attributes ?? {});
  return attributes({
    ...attributes(previous ?? {}),
    ...Object.fromEntries(
      Object.entries(incoming).filter(([, value]) => value !== null),
    ),
  });
}

/** Workbook validation and execution both use this read-only scoped check.
 * Execution repeats it under parent locks; preview is advisory, not a reservation. */
export async function prepareImportContext(
  result: RowValidationResult,
  businessId: string,
  db: Prisma.TransactionClient,
) {
  const keys = [
    ...new Set(result.validRows.map((row) => row.data.externalKey!)),
  ];
  const skus = result.validRows.flatMap((row) =>
    row.data.sku ? [row.data.sku] : [],
  );
  const products: Prisma.CatalogItemGetPayload<{
    include: { variants: true };
  }>[] = [];
  const reserved: ProductVariant[] = [];
  for (let offset = 0; offset < keys.length; offset += 1000)
    products.push(
      ...(await db.catalogItem.findMany({
        where: {
          businessId,
          externalKey: { in: keys.slice(offset, offset + 1000) },
        },
        include: { variants: true },
      })),
    );
  for (let offset = 0; offset < skus.length; offset += 1000)
    reserved.push(
      ...(await db.productVariant.findMany({
        where: { businessId, sku: { in: skus.slice(offset, offset + 1000) } },
      })),
    );
  const byKey = new Map(products.map((p) => [p.externalKey, p]));
  const bySku = new Map(reserved.map((v) => [v.sku, v]));
  const categories = await resolveImportCategories(
    result.validRows.flatMap((row) =>
      row.data.category ? [row.data.category] : [],
    ),
    businessId,
    db,
  );
  const problems = new Map<string, RowError>();
  const definitionsByKey = new Map<string, ProductOptions>();
  const variantsByKey = new Map<string, Map<string, ProductVariant>>();
  for (const row of result.validRows) {
    const key = row.data.externalKey!;
    if (problems.has(key)) continue;
    const product = byKey.get(key);
    try {
      try {
        mergedImportAttributes(row.data, product?.attributes);
      } catch {
        problems.set(key, {
          field: 'attributes',
          code: 'MERGED_ATTRIBUTES_INVALID',
          message:
            'Merged product attributes must be a JSON object within 16384 UTF-8 bytes and 10 nesting levels',
        });
        continue;
      }
      let definitions = definitionsByKey.get(key);
      if (!definitions) {
        definitions = mergedOptions(row.data.options ?? {}, product?.options);
        if (product && !product.isActive) {
          problems.set(key, {
            field: 'externalKey',
            code: 'PRODUCT_INACTIVE',
            message: 'Reactivate this product before importing its variants',
          });
          continue;
        }
        const variants = new Map<string, ProductVariant>();
        for (const variant of product?.variants ?? []) {
          variantOptions(variant.optionValues, definitions);
          variants.set(
            combinationKey(variant.optionValues as Record<string, unknown>),
            variant,
          );
        }
        definitionsByKey.set(key, definitions);
        variantsByKey.set(key, variants);
      }
      const selection = variantOptions(selectedOptions(row.data), definitions);
      const variant = variantsByKey.get(key)!.get(combinationKey(selection));
      if (variant && !variant.isActive) {
        problems.set(key, {
          field: 'sku',
          code: 'VARIANT_INACTIVE',
          message: 'Reactivate this variant before importing',
        });
        continue;
      }
      const sku = row.data.sku ? bySku.get(row.data.sku) : undefined;
      if (sku && (sku.catalogItemId !== product?.id || sku.id !== variant?.id))
        problems.set(key, {
          field: 'sku',
          code: 'SKU_RESERVED',
          message:
            'SKU is already assigned to another product or option combination in this business',
        });
    } catch {
      problems.set(key, {
        field: 'variantAttributes',
        code: 'OPTIONS_CONFLICT',
        message:
          'Option keys/selections must match the existing product; imports may extend allowed values but cannot change option names or invalidate retained variants',
      });
    }
  }
  const rejected = result.validRows.filter((row) =>
    problems.has(row.data.externalKey!),
  );
  const validRows = result.validRows.filter(
    (row) => !problems.has(row.data.externalKey!),
  );
  const invalidRows = [
    ...result.invalidRows,
    ...rejected.map((row) => ({
      rowNumber: row.rowNumber,
      errors: [{ ...problems.get(row.data.externalKey!)! }],
    })),
  ].sort((a, b) => a.rowNumber - b.rowNumber);
  const validation: RowValidationResult = {
    summary: {
      ...result.summary,
      validRows: validRows.length,
      invalidRows: invalidRows.length,
    },
    validRows,
    invalidRows,
  };
  return { validation, products, categories };
}

export async function checkImportDatabase(
  result: RowValidationResult,
  businessId: string,
  db: Prisma.TransactionClient,
): Promise<RowValidationResult> {
  return (await prepareImportContext(result, businessId, db)).validation;
}
