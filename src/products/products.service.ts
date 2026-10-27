import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-code';
import { createPagination } from '../common/pagination/pagination';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import {
  fail,
  ProductAccessService,
  writeError,
} from './product-access.service';
import { productInclude, productResponse } from './product-presenter';
import {
  attributes,
  productOptions,
  requirePatch,
  variantOptions,
} from './product-validation';

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
  ) {}

  private metadata(
    dto: CreateProductDto | UpdateProductDto,
  ): Prisma.CatalogItemUncheckedUpdateInput {
    return {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
      ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
      ...(dto.basePrice !== undefined
        ? {
            basePrice:
              dto.basePrice === null ? null : new Prisma.Decimal(dto.basePrice),
          }
        : {}),
      ...(dto.attributes !== undefined
        ? { attributes: attributes(dto.attributes) }
        : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };
  }

  async create(businessId: string, dto: CreateProductDto) {
    const options = productOptions(
      dto.options === undefined ? {} : dto.options,
    );
    // Use a create-specific whitelist. Never forward inventory or legacy identity fields.
    const data: Prisma.CatalogItemUncheckedCreateInput = {
      businessId,
      name: dto.name,
      description: dto.description,
      categoryId: dto.categoryId,
      basePrice:
        dto.basePrice == null ? null : new Prisma.Decimal(dto.basePrice),
      options,
      isActive: dto.isActive,
      ...(dto.attributes !== undefined
        ? { attributes: attributes(dto.attributes) }
        : {}),
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.access.business(businessId, tx);
        await this.access.category(businessId, dto.categoryId, tx);
        const product = await tx.catalogItem.create({ data });
        if (!Object.keys(options).length)
          await tx.productVariant.create({
            data: { businessId, catalogItemId: product.id },
          });
        return this.read(tx, businessId, product.id);
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  list(businessId: string, page: PaginationQueryDto) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.business(businessId, tx);
        const where = { businessId };
        const totalCount = await tx.catalogItem.count({ where });
        const products =
          page.offset >= totalCount
            ? []
            : await tx.catalogItem.findMany({
                where,
                take: page.limit,
                skip: page.offset,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                include: productInclude,
              });
        const eligible = await this.eligible(
          tx,
          businessId,
          products.map((p) => p.id),
        );
        return {
          pagination: createPagination(page, totalCount),
          items: products.map((p) => productResponse(p, eligible.has(p.id))),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  get(businessId: string, id: string) {
    return this.prisma.$transaction((tx) => this.read(tx, businessId, id), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  async update(businessId: string, id: string, dto: UpdateProductDto) {
    requirePatch(dto);
    const data = this.metadata(dto);
    const proposed =
      dto.options === undefined ? undefined : productOptions(dto.options);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await this.access.lock(businessId, id, tx);
          await this.access.category(businessId, dto.categoryId, tx);
          if (proposed !== undefined) {
            const variants = await tx.productVariant.findMany({
              where: { businessId, catalogItemId: id },
              select: { optionValues: true },
            });
            for (const variant of variants) {
              try {
                variantOptions(variant.optionValues, proposed);
              } catch {
                fail(
                  ErrorCode.PRODUCT_OPTIONS_IN_USE,
                  HttpStatus.CONFLICT,
                  'Proposed options invalidate an existing variant, including inactive variants',
                );
              }
            }
            data.options = proposed;
            // A formerly configurable product can become simple only with zero
            // variants. An existing {} combination is already its default.
            if (!Object.keys(proposed).length && !variants.length)
              await tx.productVariant.create({
                data: { businessId, catalogItemId: id },
              });
          }
          await tx.catalogItem.update({ where: { id, businessId }, data });
          return this.read(tx, businessId, id);
        },
        { maxWait: 5000, timeout: 10000 },
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  async remove(businessId: string, id: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.access.lock(businessId, id, tx);
        await tx.catalogItem.update({
          where: { id, businessId },
          data: { isActive: false },
        });
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  private async eligible(
    tx: Prisma.TransactionClient,
    businessId: string,
    ids: string[],
  ) {
    if (!ids.length) return new Set<string>();
    const rows = await tx.productVariant.groupBy({
      by: ['catalogItemId'],
      where: {
        businessId,
        catalogItemId: { in: ids },
        isActive: true,
        OR: [
          { unitPrice: { not: null } },
          { catalogItem: { basePrice: { not: null } } },
        ],
      },
    });
    return new Set(rows.map((row) => row.catalogItemId));
  }

  private async read(
    tx: Prisma.TransactionClient,
    businessId: string,
    id: string,
  ) {
    const product = await tx.catalogItem.findFirst({
      where: { id, businessId },
      include: productInclude,
    });
    if (!product)
      fail(
        ErrorCode.PRODUCT_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Product not found',
      );
    return productResponse(
      product,
      (await this.eligible(tx, businessId, [id])).has(id),
    );
  }

  private rethrow(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025')
        fail(
          ErrorCode.PRODUCT_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Product not found',
        );
      if (error.code === 'P2003')
        fail(
          ErrorCode.CATEGORY_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Category or business no longer exists',
        );
    }
    writeError(error);
  }
}
