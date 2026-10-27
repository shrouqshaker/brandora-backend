import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export function fail(
  code: ErrorCode,
  status: HttpStatus,
  message: string,
): never {
  throw new AppHttpException(code, status, message);
}

export function writeError(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ['P2028', 'P2034'].includes(error.code)
  )
    fail(
      ErrorCode.PRODUCT_WRITE_CONFLICT,
      HttpStatus.CONFLICT,
      'Product changed concurrently; refresh and retry',
    );
  throw error;
}

@Injectable()
export class ProductAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async business(
    businessId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
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
  }

  async product(
    businessId: string,
    id: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const product = await tx.catalogItem.findFirst({
      where: { id, businessId },
    });
    if (!product)
      fail(
        ErrorCode.PRODUCT_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Product not found',
      );
    return product;
  }

  async lock(businessId: string, id: string, tx: Prisma.TransactionClient) {
    // Every new product/variant writer takes this scoped parent lock first.
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "CatalogItem" WHERE "id" = ${id}::uuid
      AND "businessId" = ${businessId}::uuid FOR UPDATE`;
    if (!rows.length)
      fail(
        ErrorCode.PRODUCT_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Product not found',
      );
    return this.product(businessId, id, tx);
  }

  async category(
    businessId: string,
    id: string | null | undefined,
    tx: Prisma.TransactionClient,
  ) {
    if (
      id &&
      !(await tx.category.findFirst({
        where: { id, businessId },
        select: { id: true },
      }))
    )
      fail(
        ErrorCode.CATEGORY_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Category not found',
      );
  }
}
