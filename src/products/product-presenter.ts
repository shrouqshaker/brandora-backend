import {
  Product,
  ProductImage,
  ProductVariant,
} from '../generated/prisma/client';
import { createPagination } from '../common/pagination/pagination';

export const variantOrder = [
  { createdAt: 'desc' as const },
  { id: 'desc' as const },
];
export const productImageOrder = [
  { position: 'asc' as const },
  { createdAt: 'asc' as const },
  { id: 'asc' as const },
];
export const productInclude = {
  images: {
    where: { status: 'ACTIVE' },
    orderBy: productImageOrder,
  },
  variants: { take: 20, orderBy: variantOrder },
  _count: { select: { variants: true } },
} as const;

export function variantResponse(
  variant: ProductVariant,
  basePrice: Product['basePrice'],
) {
  return {
    ...variant,
    // Retain the existing wire field while internal storage uses productId.
    catalogItemId: variant.productId,
    unitPrice: variant.unitPrice?.toFixed(2) ?? null,
    effectivePrice: (variant.unitPrice ?? basePrice)?.toFixed(2) ?? null,
  };
}

export function productResponse(
  product: Product & {
    images?: ProductImage[];
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
    colorOptionName: product.colorOptionName ?? null,
    images: (product.images ?? []).map(imageResponse),
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

export function imageResponse(image: ProductImage) {
  return {
    id: image.id,
    productId: image.productId,
    secureUrl: image.secureUrl,
    position: image.position,
    isMain: image.position === 0,
    optionName: image.optionName,
    optionValue: image.optionValue,
    width: image.width,
    height: image.height,
    bytes: image.bytes,
    format: image.format,
    createdAt: image.createdAt,
    updatedAt: image.updatedAt,
  };
}
