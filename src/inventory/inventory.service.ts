import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import {
  CatalogItem,
  InventoryMovementType,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface InventoryReference {
  type: string;
  id?: string | null;
}

export interface QuantityChangeResult {
  changed: boolean;
  quantityBefore: number | null;
  quantityAfter: number;
  quantityDelta: number;
  movementId: string | null;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async setQuantity(
    item: Pick<CatalogItem, 'id' | 'businessId'>,
    targetQuantity: number,
    type: InventoryMovementType,
    reference?: InventoryReference,
    transaction?: Prisma.TransactionClient,
  ): Promise<QuantityChangeResult> {
    if (
      !Number.isInteger(targetQuantity) ||
      targetQuantity < 0 ||
      targetQuantity > 2147483647
    ) {
      throw new AppHttpException(
        ErrorCode.INVENTORY_QUANTITY_INVALID,
        HttpStatus.BAD_REQUEST,
        'Target quantity must be an integer between 0 and 2147483647',
      );
    }
    if (!Object.values(InventoryMovementType).includes(type))
      throw new AppHttpException(
        ErrorCode.INVENTORY_MOVEMENT_TYPE_INVALID,
        HttpStatus.BAD_REQUEST,
        'Unknown inventory movement type',
      );
    const referenceType = reference?.type?.trim() ?? null;
    const referenceId = reference?.id?.trim() ?? null;
    if (
      reference &&
      (!referenceType ||
        referenceType.length > 50 ||
        (reference.id != null && (!referenceId || referenceId.length > 200)))
    ) {
      throw new AppHttpException(
        ErrorCode.INVENTORY_REFERENCE_INVALID,
        HttpStatus.BAD_REQUEST,
        'Reference type must be 1 to 50 characters and reference ID, when supplied, 1 to 200 characters',
      );
    }

    const change = async (
      tx: Prisma.TransactionClient,
    ): Promise<QuantityChangeResult> => {
      // Ignore any caller-supplied stock snapshot; use the current, scoped row.
      const current = await tx.catalogItem.findFirst({
        where: { id: item.id, businessId: item.businessId },
        select: { stockQuantity: true },
      });
      if (!current)
        throw new AppHttpException(
          ErrorCode.CATALOG_ITEM_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Catalog item not found in this business',
        );
      const quantityBefore = current.stockQuantity;
      if (quantityBefore === targetQuantity) {
        return {
          changed: false,
          quantityBefore,
          quantityAfter: targetQuantity,
          quantityDelta: 0,
          movementId: null,
        };
      }
      // Unknown initial stock uses a zero baseline; retain null in the audit.
      const quantityDelta = targetQuantity - (quantityBefore ?? 0);
      const updated = await tx.catalogItem.updateMany({
        where: {
          id: item.id,
          businessId: item.businessId,
          stockQuantity: quantityBefore,
        },
        data: { stockQuantity: targetQuantity },
      });
      if (updated.count !== 1)
        throw new AppHttpException(
          ErrorCode.INVENTORY_CONFLICT,
          HttpStatus.CONFLICT,
          'Stock changed concurrently; retry the operation',
        );
      const movement = await tx.inventoryMovement.create({
        data: {
          businessId: item.businessId,
          catalogItemId: item.id,
          type,
          quantityBefore,
          quantityAfter: targetQuantity,
          quantityDelta,
          referenceType,
          referenceId,
        },
        select: { id: true },
      });
      return {
        changed: true,
        quantityBefore,
        quantityAfter: targetQuantity,
        quantityDelta,
        movementId: movement.id,
      };
    };

    // Reuse the caller's transaction; never start a nested transaction.
    return transaction ? change(transaction) : this.prisma.$transaction(change);
  }
}
