import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { createPagination } from '../common/pagination/pagination';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

  async list(businessId: string, pagination: PaginationQueryDto) {
    await this.requireBusiness(businessId);
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

  private async requireBusiness(businessId: string): Promise<void> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business)
      throw new AppHttpException(
        ErrorCode.BUSINESS_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Business not found',
      );
  }
}
