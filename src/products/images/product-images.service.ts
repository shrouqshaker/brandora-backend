import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, ProductImage } from '../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProductAccessService,
  fail,
  writeError,
} from '../product-access.service';
import { imageResponse } from '../product-presenter';
import { CloudinaryService, imageFile } from './cloudinary.service';
import { ProductImageDto } from './product-image.dto';

export const MAX_PRODUCT_IMAGES = 5;
const order = [
  { position: 'asc' as const },
  { createdAt: 'asc' as const },
  { id: 'asc' as const },
];
const invalid = (message: string): never =>
  fail(ErrorCode.PRODUCT_IMAGE_INVALID, HttpStatus.BAD_REQUEST, message);
const missing = (): never =>
  fail(
    ErrorCode.PRODUCT_IMAGE_NOT_FOUND,
    HttpStatus.NOT_FOUND,
    'Product image not found',
  );

@Injectable()
export class ProductImagesService {
  private readonly logger = new Logger(ProductImagesService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
    private readonly cloud: CloudinaryService,
  ) {}

  private active(
    tx: Prisma.TransactionClient,
    businessId: string,
    productId: string,
  ) {
    return tx.productImage.findMany({
      where: { businessId, productId, status: 'ACTIVE' },
      orderBy: order,
    });
  }

  async list(businessId: string, productId: string) {
    await this.access.product(businessId, productId);
    return {
      items: (await this.active(this.prisma, businessId, productId)).map(
        imageResponse,
      ),
    };
  }

  // A partial unique index cannot defer a position swap. Temporarily release
  // the ACTIVE slots INSIDE this transaction, then restore every row. Readers
  // see the old or new order, never this intermediate state. Hold parent lock.
  private async assign(
    tx: Prisma.TransactionClient,
    businessId: string,
    productId: string,
    ids: string[],
  ) {
    await tx.productImage.updateMany({
      where: { id: { in: ids }, businessId, productId, status: 'ACTIVE' },
      data: { status: 'UPLOADING' },
    });
    const saved: ProductImage[] = [];
    for (let position = 0; position < ids.length; position++) {
      saved.push(
        await tx.productImage.update({
          where: {
            id: ids[position],
            businessId,
            productId,
            status: 'UPLOADING',
          },
          data: { position, status: 'ACTIVE' },
        }),
      );
    }
    return saved;
  }

  async upload(
    businessId: string,
    productId: string,
    dto: ProductImageDto,
    file?: Express.Multer.File,
  ) {
    const result = await this.uploadBatch(
      businessId,
      productId,
      dto,
      file ? [file] : [],
    );
    return { ...result.items[0], cleanupPending: result.cleanupPending };
  }

  async uploadBatch(
    businessId: string,
    productId: string,
    dto: ProductImageDto,
    files: Express.Multer.File[],
  ) {
    if (Object.keys(dto).length)
      invalid('Images are independent of Variant attributes; send files only');
    if (!files.length || files.length > MAX_PRODUCT_IMAGES)
      invalid('Send one to five image files');
    // Validate the WHOLE batch before reserving slots or issuing provider calls.
    const contents = files.map(imageFile);
    this.cloud.assertReady();
    const reservations = files.map(() => {
      const id = randomUUID();
      return {
        id,
        publicId:
          'brandora/products/' + businessId + '/' + productId + '/' + id,
      };
    });
    await this.prisma.$transaction(async (tx) => {
      await this.access.lock(businessId, productId, tx);
      const occupied = await tx.productImage.findMany({
        where: {
          businessId,
          productId,
          status: { in: ['ACTIVE', 'UPLOADING'] },
        },
        select: { id: true },
      });
      if (occupied.length + files.length > MAX_PRODUCT_IMAGES)
        invalid(
          'A Product can have at most five images, including uploads in progress',
        );
      for (const reservation of reservations)
        await tx.productImage.create({
          data: { ...reservation, businessId, productId },
        });
    });
    try {
      // Await every started request before compensation; never leave a sibling
      // upload running after batch failure. No retries and no DB lock over HTTPS.
      const outcomes = await Promise.allSettled(
        reservations.map(async (r, i) =>
          this.cloud.upload(r.publicId, contents[i]),
        ),
      );
      const failed = outcomes.find((r) => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const saved = await this.prisma.$transaction(async (tx) => {
        await this.access.lock(businessId, productId, tx);
        const active = await this.active(tx, businessId, productId);
        if (active.length + reservations.length > MAX_PRODUCT_IMAGES)
          invalid('A Product can have at most five images');
        for (let i = 0; i < reservations.length; i++) {
          const result = outcomes[i];
          if (result.status !== 'fulfilled')
            throw new Error('Image batch failed');
          await tx.productImage.update({
            where: {
              id: reservations[i].id,
              businessId,
              productId,
              status: 'UPLOADING',
            },
            data: result.value,
          });
        }
        const ordered = await this.assign(tx, businessId, productId, [
          ...active.map((r) => r.id),
          ...reservations.map((r) => r.id),
        ]);
        return ordered.slice(active.length);
      });
      return { items: saved.map(imageResponse), cleanupPending: false };
    } catch (error) {
      // COMMIT can be ambiguous. Only confirmed nonactive reservations may be
      // destroyed. ACTIVE rows (possibly committed successfully) are untouched.
      try {
        await this.prisma.productImage.updateMany({
          where: {
            id: { in: reservations.map((r) => r.id) },
            businessId,
            productId,
            status: 'UPLOADING',
          },
          data: { status: 'DELETE_PENDING' },
        });
        for (const r of reservations)
          await this.cleanup(businessId, productId, r.id);
      } catch {
        for (const r of reservations) this.pending(r.id);
      }
      writeError(error);
    }
  }

  async reorder(businessId: string, productId: string, imageIds: string[]) {
    if (
      !Array.isArray(imageIds) ||
      !imageIds.length ||
      imageIds.length > MAX_PRODUCT_IMAGES ||
      new Set(imageIds).size !== imageIds.length
    )
      invalid(
        'Supply every active image ID exactly once, in the desired order',
      );
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.access.lock(businessId, productId, tx);
        const active = await this.active(tx, businessId, productId);
        if (imageIds.some((id) => !active.some((r) => r.id === id))) missing();
        if (imageIds.length !== active.length)
          invalid(
            'Supply every active image ID exactly once, in the desired order',
          );
        return {
          items: (await this.assign(tx, businessId, productId, imageIds)).map(
            imageResponse,
          ),
        };
      });
    } catch (error) {
      writeError(error);
    }
  }

  async setMain(businessId: string, productId: string, id: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.access.lock(businessId, productId, tx);
        const active = await this.active(tx, businessId, productId);
        if (!active.some((r) => r.id === id)) missing();
        const ids = [id, ...active.filter((r) => r.id !== id).map((r) => r.id)];
        return {
          items: (await this.assign(tx, businessId, productId, ids)).map(
            imageResponse,
          ),
        };
      });
    } catch (error) {
      writeError(error);
    }
  }

  async remove(businessId: string, productId: string, id: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.access.lock(businessId, productId, tx);
        const image = await tx.productImage.findFirst({
          where: { id, businessId, productId },
        });
        if (!image) return missing();
        if (
          image.status === 'UPLOADING' &&
          Date.now() - image.createdAt.getTime() < 120000
        )
          fail(
            ErrorCode.PRODUCT_WRITE_CONFLICT,
            HttpStatus.CONFLICT,
            'Image upload is in progress; retry later',
          );
        await tx.productImage.update({
          where: { id, businessId, productId },
          data: { status: 'DELETE_PENDING' },
        });
        const remaining = await this.active(tx, businessId, productId);
        await this.assign(
          tx,
          businessId,
          productId,
          remaining.map((r) => r.id),
        );
      });
    } catch (error) {
      writeError(error);
    }
    return {
      deleted: true,
      cleanupPending: !(await this.cleanup(businessId, productId, id)),
    };
  }

  private pending(id: string) {
    this.logger.warn(`Product image cleanup requires review; imageId=${id}`);
  }

  private async cleanup(
    businessId: string,
    productId: string,
    id: string,
  ): Promise<boolean> {
    try {
      const image = await this.prisma.productImage.findFirst({
        where: { id, businessId, productId, status: 'DELETE_PENDING' },
      });
      if (!image) return true;
      const result = await this.cloud.destroy(image.publicId);
      // An aborted upload can still finish remotely. Keep its public ID for a
      // later explicit retry when immediate destruction cannot find it yet.
      if (
        result === 'not found' &&
        Date.now() - image.createdAt.getTime() < 120000
      ) {
        this.pending(id);
        return false;
      }
      await this.prisma.productImage.delete({
        where: { id, businessId, productId, status: 'DELETE_PENDING' },
      });
      return true;
    } catch {
      this.pending(id);
      return false;
    }
  }
}
