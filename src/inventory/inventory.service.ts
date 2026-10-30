import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { InventoryMovementType, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { createPagination } from '../common/pagination/pagination';

export interface VariantScope {
  businessId: string;
  catalogItemId: string;
  id: string;
}
export interface InventoryReference {
  type: string;
  id: string;
}
export interface QuantityChangeResult {
  changed: boolean;
  quantityBefore: number | null;
  quantityAfter: number | null;
  quantityDelta: number;
  movementId: string | null;
}
const movementSelect = {
  id: true,
  catalogItemId: true,
  variantId: true,
  type: true,
  quantityBefore: true,
  quantityAfter: true,
  quantityDelta: true,
  trackingBefore: true,
  trackingAfter: true,
  requestedQuantity: true,
  referenceType: true,
  referenceId: true,
  createdAt: true,
} satisfies Prisma.InventoryMovementSelect;

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}
  private fail(
    code: ErrorCode,
    message: string,
    status = HttpStatus.CONFLICT,
  ): never {
    throw new AppHttpException(code, status, message);
  }
  private quantity(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 2147483647)
      this.fail(
        ErrorCode.INVENTORY_QUANTITY_INVALID,
        'Quantity must be an integer between 0 and 2147483647',
        HttpStatus.BAD_REQUEST,
      );
  }
  private reference(reference?: InventoryReference) {
    if (
      reference &&
      (!reference.type?.trim() ||
        reference.type.trim().length > 50 ||
        !reference.id?.trim() ||
        reference.id.trim().length > 200)
    )
      this.fail(
        ErrorCode.INVENTORY_REFERENCE_INVALID,
        'A reference needs a type (1–50) and ID (1–200)',
        HttpStatus.BAD_REQUEST,
      );
    return {
      referenceType: reference?.type.trim() ?? null,
      referenceId: reference?.id.trim() ?? null,
    };
  }
  private async locked(tx: Prisma.TransactionClient, scope: VariantScope) {
    // Parent-first ordering matches product/variant lifecycle writers.
    const parent = await tx.$queryRaw<{ id: string; isActive: boolean }[]>`
      SELECT "id", "isActive" FROM "CatalogItem"
      WHERE "id"=${scope.catalogItemId}::uuid AND "businessId"=${scope.businessId}::uuid FOR UPDATE`;
    if (!parent.length)
      this.fail(
        ErrorCode.PRODUCT_NOT_FOUND,
        'Product not found',
        HttpStatus.NOT_FOUND,
      );
    const variant = await tx.productVariant.findFirst({
      where: {
        id: scope.id,
        businessId: scope.businessId,
        catalogItemId: scope.catalogItemId,
      },
    });
    if (!variant)
      this.fail(
        ErrorCode.VARIANT_NOT_FOUND,
        'Variant not found',
        HttpStatus.NOT_FOUND,
      );
    return { variant, parent: parent[0] };
  }
  async listVariantMovements(
    scope: VariantScope,
    pagination: PaginationQueryDto,
  ) {
    const variant = await this.prisma.productVariant.findFirst({
      where: {
        id: scope.id,
        businessId: scope.businessId,
        catalogItemId: scope.catalogItemId,
      },
      select: { id: true },
    });
    if (!variant)
      this.fail(
        ErrorCode.VARIANT_NOT_FOUND,
        'Variant not found',
        HttpStatus.NOT_FOUND,
      );
    return this.listMovements(
      { businessId: scope.businessId, variantId: scope.id },
      pagination,
    );
  }
  async listBusinessMovements(
    businessId: string,
    pagination: PaginationQueryDto,
  ) {
    if (
      !(await this.prisma.business.findUnique({
        where: { id: businessId },
        select: { id: true },
      }))
    )
      this.fail(
        ErrorCode.BUSINESS_NOT_FOUND,
        'Business not found',
        HttpStatus.NOT_FOUND,
      );
    return this.listMovements({ businessId }, pagination);
  }
  private async listMovements(
    where: Prisma.InventoryMovementWhereInput,
    pagination: PaginationQueryDto,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const totalCount = await tx.inventoryMovement.count({ where });
        const items =
          pagination.offset >= totalCount
            ? []
            : await tx.inventoryMovement.findMany({
                where,
                select: movementSelect,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: pagination.limit,
                skip: pagination.offset,
              });
        return { pagination: createPagination(pagination, totalCount), items };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  private result(m: {
    id: string;
    quantityBefore: number | null;
    quantityAfter: number | null;
    quantityDelta: number;
  }): QuantityChangeResult {
    return {
      changed: true,
      quantityBefore: m.quantityBefore,
      quantityAfter: m.quantityAfter,
      quantityDelta: m.quantityDelta,
      movementId: m.id,
    };
  }
  private async persist(
    tx: Prisma.TransactionClient,
    scope: VariantScope,
    before: { trackInventory: boolean; stockQuantity: number | null },
    after: number | null,
    tracking: boolean,
    type: InventoryMovementType,
    reference?: InventoryReference,
    requestedQuantity?: number,
    force = false,
  ) {
    const changed =
      before.stockQuantity !== after || before.trackInventory !== tracking;
    if (!changed && !force)
      return {
        changed: false,
        quantityBefore: after,
        quantityAfter: after,
        quantityDelta: 0,
        movementId: null,
      };
    await tx.productVariant.update({
      where: {
        id: scope.id,
        businessId: scope.businessId,
        catalogItemId: scope.catalogItemId,
      },
      data: { trackInventory: tracking, stockQuantity: after },
    });
    const movement = await tx.inventoryMovement.create({
      data: {
        businessId: scope.businessId,
        catalogItemId: scope.catalogItemId,
        variantId: scope.id,
        type,
        quantityBefore: before.stockQuantity,
        quantityAfter: after,
        quantityDelta: (after ?? 0) - (before.stockQuantity ?? 0),
        trackingBefore: before.trackInventory,
        trackingAfter: tracking,
        requestedQuantity,
        ...this.reference(reference),
      },
    });
    return { ...this.result(movement), changed };
  }
  /** Absolute quantity; blank imports never call this method. */
  async setQuantity(
    scope: VariantScope,
    targetQuantity: number | null,
    type: InventoryMovementType = InventoryMovementType.MANUAL_ADJUSTMENT,
    reference?: InventoryReference,
    transaction?: Prisma.TransactionClient,
    trackInventory = true,
  ): Promise<QuantityChangeResult> {
    const allowed: InventoryMovementType[] = [
      InventoryMovementType.MANUAL_ADJUSTMENT,
      InventoryMovementType.INITIAL_IMPORT,
      InventoryMovementType.IMPORT_UPDATE,
    ];
    if (!allowed.includes(type))
      this.fail(
        ErrorCode.INVENTORY_MOVEMENT_TYPE_INVALID,
        'Use order methods for order movements',
        HttpStatus.BAD_REQUEST,
      );
    if (trackInventory) this.quantity(targetQuantity as number);
    else if (targetQuantity !== null)
      this.fail(
        ErrorCode.INVENTORY_QUANTITY_INVALID,
        'Untracked stock requires null quantity',
        HttpStatus.BAD_REQUEST,
      );
    this.reference(reference);
    const change = async (tx: Prisma.TransactionClient) => {
      const { variant, parent } = await this.locked(tx, scope);
      if (!parent.isActive || !variant.isActive)
        this.fail(
          ErrorCode.INVENTORY_INACTIVE,
          'Activate the product and variant before setting stock',
        );
      if (variant.trackInventory !== trackInventory) {
        const orders = await tx.inventoryMovement.findMany({
          where: {
            businessId: scope.businessId,
            variantId: scope.id,
            referenceType: 'ORDER_LINE',
          },
        });
        const restored = new Set(
          orders
            .filter((m) => m.type === InventoryMovementType.ORDER_CANCELLED)
            .map((m) => m.referenceId),
        );
        if (
          orders.some(
            (m) =>
              m.type === InventoryMovementType.ORDER_APPROVED &&
              !restored.has(m.referenceId),
          )
        )
          this.fail(
            ErrorCode.INVENTORY_CONFLICT,
            'Restore outstanding order deductions before changing tracking',
          );
      }
      if (reference) {
        const prior = await tx.inventoryMovement.findFirst({
          where: {
            businessId: scope.businessId,
            variantId: scope.id,
            type,
            ...this.reference(reference),
          },
        });
        if (prior) {
          if (
            prior.quantityAfter !== targetQuantity ||
            prior.trackingAfter !== trackInventory
          )
            this.fail(
              ErrorCode.INVENTORY_CONFLICT,
              'Reference already used with different stock',
            );
          return { ...this.result(prior), changed: false };
        }
      }
      return this.persist(
        tx,
        scope,
        variant,
        targetQuantity,
        trackInventory,
        type,
        reference,
        undefined,
        !!reference,
      );
    };
    return transaction
      ? change(transaction)
      : this.prisma.$transaction(change, { timeout: 15000 });
  }
  /** Atomic with caller order state. Use a stable order-line ID on every retry. */
  deductForOrder(
    tx: Prisma.TransactionClient,
    scope: VariantScope,
    quantity: number,
    orderLineId: string,
  ) {
    return this.orderChange(tx, scope, quantity, orderLineId, false);
  }
  restoreForOrder(
    tx: Prisma.TransactionClient,
    scope: VariantScope,
    quantity: number,
    orderLineId: string,
  ) {
    return this.orderChange(tx, scope, quantity, orderLineId, true);
  }
  private async orderChange(
    tx: Prisma.TransactionClient,
    scope: VariantScope,
    quantity: number,
    orderLineId: string,
    restoring: boolean,
  ) {
    this.quantity(quantity);
    if (!quantity)
      this.fail(
        ErrorCode.INVENTORY_QUANTITY_INVALID,
        'Order quantity must be positive',
        HttpStatus.BAD_REQUEST,
      );
    const reference = { type: 'ORDER_LINE', id: orderLineId };
    this.reference(reference);
    const { variant, parent } = await this.locked(tx, scope);
    const type = restoring
      ? InventoryMovementType.ORDER_CANCELLED
      : InventoryMovementType.ORDER_APPROVED;
    const movements = await tx.inventoryMovement.findMany({
      where: {
        businessId: scope.businessId,
        ...this.reference(reference),
      },
    });
    const previous = movements.find((m) => m.type === type);
    if (previous) {
      if (
        previous.requestedQuantity !== quantity ||
        previous.variantId !== scope.id
      )
        this.fail(
          ErrorCode.INVENTORY_CONFLICT,
          'Order line already used with another quantity',
        );
      return { ...this.result(previous), changed: false };
    }
    const deduction = movements.find(
      (m) => m.type === InventoryMovementType.ORDER_APPROVED,
    );
    if (deduction && deduction.variantId !== scope.id)
      this.fail(
        ErrorCode.INVENTORY_CONFLICT,
        'Order line belongs to another variant',
      );
    if (restoring && (!deduction || deduction.requestedQuantity !== quantity))
      this.fail(
        ErrorCode.INVENTORY_CONFLICT,
        'Matching deduction required before restoration',
      );
    if (!restoring && (!parent.isActive || !variant.isActive))
      this.fail(ErrorCode.INVENTORY_INACTIVE, 'Inactive stock cannot be sold');
    if (restoring && deduction!.trackingAfter !== variant.trackInventory)
      this.fail(
        ErrorCode.INVENTORY_CONFLICT,
        'Tracking changed since deduction; reconcile before restoring',
      );
    const after = variant.trackInventory
      ? variant.stockQuantity! + (restoring ? quantity : -quantity)
      : null;
    if (after !== null && after < 0)
      this.fail(
        ErrorCode.INVENTORY_INSUFFICIENT_STOCK,
        'Insufficient variant stock',
      );
    if (after !== null) this.quantity(after);
    return this.persist(
      tx,
      scope,
      variant,
      after,
      variant.trackInventory,
      type,
      reference,
      quantity,
      true,
    );
  }
}
