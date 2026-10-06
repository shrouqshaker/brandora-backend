import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCatalogItemDto } from './dto/create-catalog-item.dto';
import { ListCatalogItemsDto } from './dto/list-catalog-items.dto';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCatalogItemDto) {
    try {
      return await this.prisma.catalogItem.create({
        data: {
          businessId: dto.businessId,
          name: dto.name,
          description: dto.description,
          basePrice: dto.basePrice == null ? null : new Prisma.Decimal(dto.basePrice),
        },
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new NotFoundException('Business not found');
      }
      throw error;
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
}
