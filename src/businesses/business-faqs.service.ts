import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProductAccessService } from '../products/product-access.service';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { createPagination } from '../common/pagination/pagination';
import { Prisma } from '../generated/prisma/client';
import {
  CreateBusinessFaqDto,
  UpdateBusinessFaqDto,
} from './dto/business-faq.dto';

@Injectable()
export class BusinessFaqsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
  ) {}
  async list(businessId: string, page: PaginationQueryDto) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.business(businessId, tx);
        const where = { businessId };
        const totalCount = await tx.businessFaq.count({ where });
        const items = await tx.businessFaq.findMany({
          where,
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          take: page.limit,
          skip: page.offset,
        });
        return { items, pagination: createPagination(page, totalCount) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async create(businessId: string, dto: CreateBusinessFaqDto) {
    await this.access.business(businessId);
    try {
      return await this.prisma.businessFaq.create({
        data: {
          businessId,
          question: dto.question,
          answer: dto.answer,
          position: dto.position,
          isActive: dto.isActive,
        },
      });
    } catch (error) {
      return this.writeError(error);
    }
  }
  async update(businessId: string, id: string, dto: UpdateBusinessFaqDto) {
    if (!Object.values(dto).some((v) => v !== undefined))
      throw new AppHttpException(
        ErrorCode.VALIDATION_ERROR,
        HttpStatus.BAD_REQUEST,
        'At least one editable field must be supplied',
      );
    try {
      return await this.prisma.businessFaq.update({
        where: { id, businessId },
        data: {
          question: dto.question,
          answer: dto.answer,
          position: dto.position,
          isActive: dto.isActive,
        },
      });
    } catch (error) {
      return this.writeError(error);
    }
  }
  async remove(businessId: string, id: string) {
    try {
      await this.prisma.businessFaq.delete({ where: { id, businessId } });
    } catch (error) {
      this.writeError(error);
    }
  }
  private writeError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    )
      throw new AppHttpException(
        ErrorCode.BUSINESS_FAQ_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'FAQ not found in this business',
      );
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003'
    )
      throw new AppHttpException(
        ErrorCode.BUSINESS_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Business not found',
      );
    throw error;
  }
}
