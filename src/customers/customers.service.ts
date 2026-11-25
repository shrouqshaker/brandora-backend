import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { createPagination } from '../common/pagination/pagination';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProductAccessService } from '../products/product-access.service';

export const customerSelect = {
  id: true,
  businessId: true,
  phone: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerSelect;

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
  ) {}

  async list(businessId: string, pagination: PaginationQueryDto) {
    await this.access.business(businessId);
    const where = { businessId };
    const totalCount = await this.prisma.customer.count({ where });
    const items =
      pagination.offset >= totalCount
        ? []
        : await this.prisma.customer.findMany({
            where,
            select: customerSelect,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: pagination.limit,
            skip: pagination.offset,
          });
    return { pagination: createPagination(pagination, totalCount), items };
  }

  async getOne(businessId: string, customerId: string) {
    // id + businessId together: an id from another business is simply "not found".
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
      select: customerSelect,
    });
    if (!customer)
      throw new AppHttpException(
        ErrorCode.CUSTOMER_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Customer not found in this business',
      );
    return customer;
  }

  /** Used by ConversationsService inside its transaction. */
  findOrCreateByPhone(
    tx: Prisma.TransactionClient,
    businessId: string,
    phone: string,
    name?: string,
  ) {
    return tx.customer.upsert({
      where: { businessId_phone: { businessId, phone } },
      create: { businessId, phone, name },
      // A newer WhatsApp profile name replaces the old one.
      update: name ? { name } : {},
      select: customerSelect,
    });
  }
}
