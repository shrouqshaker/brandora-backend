import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-code';
import { createPagination } from '../common/pagination/pagination';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fail } from '../products/product-access.service';
import { CategoryDto } from './dto/category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(businessId: string, dto: CategoryDto) {
    if (
      !(await this.prisma.business.findUnique({
        where: { id: businessId },
        select: { id: true },
      }))
    )
      fail(
        ErrorCode.BUSINESS_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Business not found',
      );
    try {
      return await this.prisma.category.create({
        data: { businessId, name: dto.name },
      });
    } catch (error) {
      this.rethrow(error, false);
    }
  }

  list(businessId: string, page: PaginationQueryDto) {
    return this.prisma.$transaction(
      async (tx) => {
        if (
          !(await tx.business.findUnique({
            where: { id: businessId },
            select: { id: true },
          }))
        )
          fail(
            ErrorCode.BUSINESS_NOT_FOUND,
            HttpStatus.NOT_FOUND,
            'Business not found',
          );
        const where = { businessId };
        const totalCount = await tx.category.count({ where });
        const items =
          page.offset >= totalCount
            ? []
            : await tx.category.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: page.limit,
                skip: page.offset,
              });
        return { pagination: createPagination(page, totalCount), items };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async get(businessId: string, id: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, businessId },
    });
    if (!category) this.notFound();
    return category;
  }

  async update(businessId: string, id: string, dto: CategoryDto) {
    try {
      return await this.prisma.category.update({
        where: { id, businessId },
        data: { name: dto.name },
      });
    } catch (error) {
      this.rethrow(error, false);
    }
  }

  async remove(businessId: string, id: string) {
    try {
      await this.prisma.category.delete({ where: { id, businessId } });
    } catch (error) {
      this.rethrow(error, true);
    }
  }

  private notFound(): never {
    fail(
      ErrorCode.CATEGORY_NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Category not found',
    );
  }
  private rethrow(error: unknown, deleting: boolean): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') this.notFound();
      if (error.code === 'P2002')
        fail(
          ErrorCode.CATEGORY_NAME_CONFLICT,
          HttpStatus.CONFLICT,
          'A category with this normalized name already exists in this business',
        );
      if (error.code === 'P2003') {
        if (deleting)
          fail(
            ErrorCode.CATEGORY_IN_USE,
            HttpStatus.CONFLICT,
            'Category is referenced by a product',
          );
        fail(
          ErrorCode.BUSINESS_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Business not found',
        );
      }
    }
    throw error;
  }
}
