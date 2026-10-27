import { CatalogItem, ProductVariant } from '../generated/prisma/client';
import { createPagination } from '../common/pagination/pagination';

export const variantOrder = [
  { createdAt: 'desc' as const },
  { id: 'desc' as const },
];
export const productInclude = {
  variants: { take: 20, orderBy: variantOrder },
  _count: { select: { variants: true } },
} as const;

export function variantResponse(
  variant: ProductVariant,
  basePrice: CatalogItem['basePrice'],
) {
  return {
    ...variant,
    unitPrice: variant.unitPrice?.toFixed(2) ?? null,
    effectivePrice: (variant.unitPrice ?? basePrice)?.toFixed(2) ?? null,
  };
}

export function productResponse(
  product: CatalogItem & {
    variants: ProductVariant[];
    _count: { variants: number };
  },
  pricedActiveVariant: boolean,
) {
  return {
    id: product.id,
    businessId: product.businessId,
    name: product.name,
    description: product.description,
    categoryId: product.categoryId,
    externalKey: product.externalKey,
    category: product.category,
    basePrice: product.basePrice?.toFixed(2) ?? null,
    options: product.options,
    attributes: product.attributes,
    isActive: product.isActive,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    isSellable: product.isActive && pricedActiveVariant,
    variants: product.variants.map((variant) =>
      variantResponse(variant, product.basePrice),
    ),
    variantsPagination: createPagination(
      { limit: 20, offset: 0 },
      product._count.variants,
    ),
  };
}
