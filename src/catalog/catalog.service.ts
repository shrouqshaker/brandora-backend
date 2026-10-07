import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCatalogItemDto } from './dto/create-catalog-item.dto';
import { ListCatalogItemsDto } from './dto/list-catalog-items.dto';
import { UpdateCatalogItemDto } from './dto/update-catalog-item.dto';
import { CatalogItemMetadataDto } from './dto/catalog-item-metadata.dto';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCatalogItemDto) {
    const metadata = this.metadata(dto);
    try {
      return await this.prisma.catalogItem.create({
        data: {
          businessId: dto.businessId,
          name: dto.name,
          ...metadata,
          basePrice: metadata.basePrice ?? null,
        },
      });
    } catch (error: unknown) {
      this.rethrowPrismaError(error);
    }
  }

  list(query: ListCatalogItemsDto) {
    return this.prisma.catalogItem.findMany({
      where: { businessId: query.businessId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      skip: query.offset,
    });
  }

  async getOne(id: string, businessId: string) {
    const item = await this.prisma.catalogItem.findFirst({
      where: { id, businessId },
    });
    if (!item) throw this.itemNotFound();
    return item;
  }

  async update(id: string, dto: UpdateCatalogItemDto) {
    const data = {
      ...this.metadata(dto),
      ...(dto.name !== undefined ? { name: dto.name } : {}),
    };
    if (Object.keys(data).length === 0) {
      throw new AppHttpException(
        ErrorCode.VALIDATION_ERROR,
        HttpStatus.BAD_REQUEST,
        'At least one editable catalog field must be supplied',
      );
    }
    try {
      // Extended unique filters make business scoping part of the write itself.
      return await this.prisma.catalogItem.update({
        where: { id, businessId: dto.businessId },
        data,
      });
    } catch (error: unknown) {
      this.rethrowPrismaError(error);
    }
  }

  async deactivate(id: string, businessId: string) {
    try {
      return await this.prisma.catalogItem.update({
        where: { id, businessId },
        data: { isActive: false },
      });
    } catch (error: unknown) {
      this.rethrowPrismaError(error);
    }
  }

  private metadata(dto: CatalogItemMetadataDto) {
    const data: {
      externalKey?: string | null;
      description?: string | null;
      category?: string | null;
      basePrice?: Prisma.Decimal | null;
      attributes?: Prisma.InputJsonObject | typeof Prisma.DbNull;
      isActive?: boolean;
    } = {};
    for (const field of ['externalKey', 'description', 'category'] as const) {
      if (dto[field] !== undefined) data[field] = dto[field];
    }
    if (dto.basePrice !== undefined)
      data.basePrice =
        dto.basePrice === null ? null : new Prisma.Decimal(dto.basePrice);
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.attributes !== undefined) {
      if (
        dto.attributes !== null &&
        (typeof dto.attributes !== 'object' ||
          Array.isArray(dto.attributes) ||
          ![Object.prototype, null].includes(
            Object.getPrototypeOf(dto.attributes),
          ))
      ) {
        throw new AppHttpException(
          ErrorCode.CATALOG_ATTRIBUTES_INVALID,
          HttpStatus.BAD_REQUEST,
          'Catalog attributes must be a JSON object or null',
        );
      }
      // Clear the nullable database column, rather than storing a JSON null literal.
      data.attributes =
        dto.attributes === null ? Prisma.DbNull : dto.attributes;
    }
    return data;
  }

  private itemNotFound() {
    return new AppHttpException(
      ErrorCode.CATALOG_ITEM_NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Catalog item not found',
    );
  }

  private rethrowPrismaError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002')
        throw new AppHttpException(
          ErrorCode.CATALOG_EXTERNAL_KEY_CONFLICT,
          HttpStatus.CONFLICT,
          'A catalog item with this external key already exists in this business',
        );
      if (error.code === 'P2025') throw this.itemNotFound();
      if (error.code === 'P2003')
        throw new AppHttpException(
          ErrorCode.BUSINESS_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Business not found',
        );
    }
    throw error;
  }
}
