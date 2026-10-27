import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-code';
import { createPagination } from '../common/pagination/pagination';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  fail,
  ProductAccessService,
  writeError,
} from '../products/product-access.service';
import { variantOrder, variantResponse } from '../products/product-presenter';
import {
  productOptions,
  requirePatch,
  variantOptions,
} from '../products/product-validation';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';

@Injectable()
export class VariantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
  ) {}

  async create(businessId: string, productId: string, dto: CreateVariantDto) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const parent = await this.access.lock(businessId, productId, tx);
          if (!parent.isActive)
            fail(
              ErrorCode.PRODUCT_INACTIVE,
              HttpStatus.CONFLICT,
              'Reactivate the product before adding variants',
            );
          const options = variantOptions(
            dto.optionValues,
            productOptions(parent.options),
          );
          const variant = await tx.productVariant.create({
            data: {
              businessId,
              catalogItemId: productId,
              sku: dto.sku,
              optionValues: options,
              unitPrice:
                dto.unitPrice == null
                  ? null
                  : new Prisma.Decimal(dto.unitPrice),
            },
          });
          return variantResponse(variant, parent.basePrice);
        },
        { maxWait: 5000, timeout: 10000 },
      );
    } catch (error) {
      return this.rethrow(error, businessId, dto.sku);
    }
  }

  list(businessId: string, productId: string, page: PaginationQueryDto) {
    return this.prisma.$transaction(
      async (tx) => {
        const parent = await this.access.product(businessId, productId, tx);
        const where = { businessId, catalogItemId: productId };
        const totalCount = await tx.productVariant.count({ where });
        const variants =
          page.offset >= totalCount
            ? []
            : await tx.productVariant.findMany({
                where,
                orderBy: variantOrder,
                take: page.limit,
                skip: page.offset,
              });
        return {
          pagination: createPagination(page, totalCount),
          items: variants.map((v) => variantResponse(v, parent.basePrice)),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  get(businessId: string, productId: string, id: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const parent = await this.access.product(businessId, productId, tx);
        const variant = await this.scoped(tx, businessId, productId, id);
        return variantResponse(variant, parent.basePrice);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async update(
    businessId: string,
    productId: string,
    id: string,
    dto: UpdateVariantDto,
  ) {
    requirePatch(dto);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const parent = await this.access.lock(businessId, productId, tx);
          const variant = await this.scoped(tx, businessId, productId, id);
          if (dto.isActive === true && !parent.isActive)
            fail(
              ErrorCode.PRODUCT_INACTIVE,
              HttpStatus.CONFLICT,
              'Reactivate the product before reactivating variants',
            );
          // State-only withdrawal must remain possible for stale legacy options.
          const withdrawingOnly =
            dto.isActive === false &&
            dto.sku === undefined &&
            dto.unitPrice === undefined &&
            dto.optionValues === undefined;
          const options = withdrawingOnly
            ? undefined
            : variantOptions(
                dto.optionValues === undefined
                  ? variant.optionValues
                  : dto.optionValues,
                productOptions(parent.options),
              );
          const updated = await tx.productVariant.update({
            where: { id, businessId, catalogItemId: productId },
            data: {
              ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
              ...(dto.sku !== undefined ? { sku: dto.sku } : {}),
              ...(dto.unitPrice !== undefined
                ? {
                    unitPrice:
                      dto.unitPrice === null
                        ? null
                        : new Prisma.Decimal(dto.unitPrice),
                  }
                : {}),
              ...(dto.optionValues !== undefined
                ? { optionValues: options }
                : {}),
            },
          });
          return variantResponse(updated, parent.basePrice);
        },
        { maxWait: 5000, timeout: 10000 },
      );
    } catch (error) {
      return this.rethrow(error, businessId, dto.sku, id);
    }
  }

  async remove(businessId: string, productId: string, id: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.access.lock(businessId, productId, tx);
        await this.scoped(tx, businessId, productId, id);
        await tx.productVariant.update({
          where: { id, businessId, catalogItemId: productId },
          data: { isActive: false },
        });
      });
    } catch (error) {
      return this.rethrow(error, businessId);
    }
  }

  private async scoped(
    tx: Prisma.TransactionClient,
    businessId: string,
    productId: string,
    id: string,
  ) {
    const variant = await tx.productVariant.findFirst({
      where: { id, businessId, catalogItemId: productId },
    });
    if (!variant)
      fail(
        ErrorCode.VARIANT_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Variant not found',
      );
    return variant;
  }

  private async rethrow(
    error: unknown,
    businessId: string,
    sku?: string | null,
    id?: string,
  ): Promise<never> {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025')
        fail(
          ErrorCode.VARIANT_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Variant not found',
        );
      if (error.code === 'P2003')
        fail(
          ErrorCode.PRODUCT_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Product not found',
        );
      if (error.code === 'P2002') {
        const target = JSON.stringify(error.meta ?? {}).toLowerCase();
        // Adapters may expose a constraint name or a field list. For adapters
        // omitting both, inspect only the scoped SKU after the failed tx rolls back.
        const skuTaken =
          target.includes('sku') ||
          (sku != null &&
            (await this.prisma.productVariant.findFirst({
              where: { businessId, sku, ...(id ? { id: { not: id } } : {}) },
              select: { id: true },
            })));
        if (skuTaken)
          fail(
            ErrorCode.VARIANT_SKU_CONFLICT,
            HttpStatus.CONFLICT,
            'SKU is already reserved in this business',
          );
        fail(
          ErrorCode.VARIANT_OPTIONS_CONFLICT,
          HttpStatus.CONFLICT,
          'This option combination is already reserved for this product',
        );
      }
    }
    writeError(error);
  }
}
