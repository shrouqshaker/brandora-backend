import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ProductAccessService } from '../products/product-access.service';
import {
  CloudinaryService,
  imageFile,
} from '../products/images/cloudinary.service';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';

@Injectable()
export class BusinessLogoService {
  private readonly logger = new Logger(BusinessLogoService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
    private readonly cloud: CloudinaryService,
  ) {}

  async upload(businessId: string, file?: Express.Multer.File) {
    await this.access.business(businessId);
    let content: ReturnType<typeof imageFile>;
    try {
      content = imageFile(file);
      this.cloud.assertReady();
    } catch (error) {
      this.imageError(error);
    }
    const publicId = `brandora/businesses/${businessId}/logo/${randomUUID()}`;
    // Reserve cleanup identity before contacting the provider. Credentials/public IDs never reach Android.
    await this.prisma.businessLogoCleanup.create({
      data: { publicId, businessId },
    });
    let uploaded = false;
    try {
      const asset = await this.cloud.upload(publicId, content!);
      uploaded = true;
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Business" WHERE "id" = ${businessId}::uuid FOR UPDATE`;
        const business = await tx.business.findUnique({
          where: { id: businessId },
          select: { logoPublicId: true },
        });
        if (!business)
          throw new AppHttpException(
            ErrorCode.BUSINESS_NOT_FOUND,
            HttpStatus.NOT_FOUND,
            'Business not found',
          );
        if (business.logoPublicId)
          await tx.businessLogoCleanup.upsert({
            where: { publicId: business.logoPublicId },
            create: {
              publicId: business.logoPublicId,
              businessId,
              status: 'PENDING',
            },
            update: { status: 'PENDING' },
          });
        await tx.business.update({
          where: { id: businessId },
          data: { logoPublicId: publicId, logoUrl: asset.secureUrl },
        });
        await tx.businessLogoCleanup.delete({ where: { publicId } });
      });
      const cleanupPending = await this.cleanup(businessId);
      return { logoUrl: asset.secureUrl, cleanupPending };
    } catch (error) {
      // Even a timed-out upload may have created the asset. Keep durable cleanup work.
      try {
        await this.prisma.businessLogoCleanup.update({
          where: { publicId },
          data: { status: 'PENDING' },
        });
        await this.cleanup(businessId);
      } catch {
        this.logger.warn('Logo cleanup requires retry');
      }
      if (
        uploaded &&
        error instanceof AppHttpException &&
        error.code === ErrorCode.BUSINESS_NOT_FOUND
      )
        throw error;
      this.imageError(error);
    }
  }

  async remove(businessId: string) {
    await this.access.business(businessId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Business" WHERE "id" = ${businessId}::uuid FOR UPDATE`;
      const business = await tx.business.findUnique({
        where: { id: businessId },
        select: { logoPublicId: true },
      });
      if (!business)
        throw new AppHttpException(
          ErrorCode.BUSINESS_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Business not found',
        );
      if (business.logoPublicId)
        await tx.businessLogoCleanup.upsert({
          where: { publicId: business.logoPublicId },
          create: {
            publicId: business.logoPublicId,
            businessId,
            status: 'PENDING',
          },
          update: { status: 'PENDING' },
        });
      await tx.business.update({
        where: { id: businessId },
        data: { logoPublicId: null, logoUrl: null },
      });
    });
    return { logoUrl: null, cleanupPending: await this.cleanup(businessId) };
  }

  private async cleanup(businessId: string) {
    try {
      const rows = await this.prisma.businessLogoCleanup.findMany({
        where: { businessId, status: 'PENDING' },
        take: 20,
        orderBy: { createdAt: 'asc' },
      });
      for (const row of rows) {
        try {
          await this.cloud.destroy(row.publicId);
          await this.prisma.businessLogoCleanup.deleteMany({
            where: { publicId: row.publicId, businessId, status: 'PENDING' },
          });
        } catch {
          this.logger.warn('Logo cleanup requires retry');
        }
      }
      return (
        (await this.prisma.businessLogoCleanup.count({
          where: { businessId, status: 'PENDING' },
        })) > 0
      );
    } catch {
      this.logger.warn('Logo cleanup requires retry');
      return true;
    }
  }
  private imageError(error: unknown): never {
    if (
      error instanceof AppHttpException &&
      error.code === ErrorCode.PRODUCT_IMAGE_TOO_LARGE
    )
      throw new AppHttpException(
        ErrorCode.BUSINESS_LOGO_TOO_LARGE,
        HttpStatus.PAYLOAD_TOO_LARGE,
        'Logo exceeds 10 MB',
      );
    if (
      error instanceof AppHttpException &&
      error.code === ErrorCode.PRODUCT_IMAGE_INVALID
    )
      throw new AppHttpException(
        ErrorCode.BUSINESS_LOGO_INVALID,
        HttpStatus.BAD_REQUEST,
        'A matching JPEG, PNG or WebP image is required',
      );
    throw new AppHttpException(
      ErrorCode.BUSINESS_LOGO_UNAVAILABLE,
      HttpStatus.SERVICE_UNAVAILABLE,
      'Logo storage is temporarily unavailable',
    );
  }
}
