import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { isUniqueViolation } from '../common/database/is-unique-violation';
import { createPagination } from '../common/pagination/pagination';
import { Prisma } from '../generated/prisma/client';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../products/products.service';
import { VariantsService } from '../variants/variants.service';
import { WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersDto } from './dto/list-orders.dto';
import {
  confirmationText,
  orderInclude,
  orderResponse,
  OrderView,
} from './order-presenter';

/** Did the customer get the WhatsApp message about the decision? PENDING = Meta was busy, it is tried again. */
export type CustomerNotification = 'SENT' | 'PENDING' | 'FAILED';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly variants: VariantsService,
    private readonly inventory: InventoryService,
    private readonly sender: WhatsAppSenderService,
  ) {}

  /**
   * A PENDING_APPROVAL order from a customer message. Names and prices are
   * read from the database here; the request only says "which and how many".
   * Stock is checked (a warning), not taken: that happens on approve.
   */
  async create(
    businessId: string,
    userId: string,
    dto: CreateOrderDto,
  ): Promise<{ order: OrderView; created: boolean }> {
    const source = await this.prisma.message.findFirst({
      where: { id: dto.sourceMessageId, businessId, senderType: 'CUSTOMER' },
      select: {
        conversationId: true,
        conversation: { select: { customerId: true } },
      },
    });
    if (!source)
      throw new AppHttpException(
        ErrorCode.MESSAGE_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Customer message not found in this business',
      );
    const existing = await this.findBySource(businessId, dto.sourceMessageId);
    if (existing) return { order: existing, created: false };
    if (new Set(dto.items.map((i) => i.variantId)).size !== dto.items.length)
      throw new AppHttpException(
        ErrorCode.VALIDATION_ERROR,
        HttpStatus.BAD_REQUEST,
        'Each variant can appear only once in an order',
      );

    let subtotal = new Prisma.Decimal(0);
    let lowStock = false;
    const lines: Prisma.OrderItemCreateWithoutOrderInput[] = [];
    for (const [index, item] of dto.items.entries()) {
      // ProductsService / VariantsService: 404 if not in THIS business.
      const product = await this.products.get(businessId, item.productId);
      const variant = await this.variants.get(
        businessId,
        item.productId,
        item.variantId,
      );
      if (
        !product.isActive ||
        !variant.isActive ||
        variant.effectivePrice === null
      )
        throw new AppHttpException(
          ErrorCode.ORDER_ITEM_UNAVAILABLE,
          HttpStatus.CONFLICT,
          'A product in the order is inactive or has no price',
        );
      if (
        variant.trackInventory &&
        (variant.stockQuantity ?? 0) < item.quantity
      )
        lowStock = true;
      const unitPrice = new Prisma.Decimal(variant.effectivePrice);
      const lineTotal = unitPrice.mul(item.quantity);
      subtotal = subtotal.add(lineTotal);
      lines.push({
        position: index + 1,
        productId: item.productId,
        variantId: item.variantId,
        productName: product.name,
        selectedOptions: variant.optionValues ?? {},
        unitPrice,
        quantity: item.quantity,
        lineTotal,
      });
    }

    try {
      const order = await this.prisma.order.create({
        data: {
          businessId,
          customerId: source.conversation.customerId,
          conversationId: source.conversationId,
          sourceMessageId: dto.sourceMessageId,
          subtotal,
          total: subtotal,
          notes: dto.notes ?? null,
          requiresReview: lowStock,
          reviewReason: lowStock ? 'LOW_STOCK' : null,
          createdByUserId: userId,
          items: { create: lines },
        },
        include: orderInclude,
      });
      return { order: orderResponse(order), created: true };
    } catch (error: unknown) {
      // Two taps at the same moment: the first one won, return its order.
      if (!isUniqueViolation(error)) throw error;
      const first = await this.findBySource(businessId, dto.sourceMessageId);
      if (!first) throw error;
      return { order: first, created: false };
    }
  }

  async list(businessId: string, query: ListOrdersDto) {
    const where: Prisma.OrderWhereInput = {
      businessId,
      ...(query.status ? { status: query.status } : {}),
    };
    const totalCount = await this.prisma.order.count({ where });
    const rows =
      query.offset >= totalCount
        ? []
        : await this.prisma.order.findMany({
            where,
            include: orderInclude,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: query.limit,
            skip: query.offset,
          });
    return {
      pagination: createPagination(query, totalCount),
      items: rows.map(orderResponse),
    };
  }

  async getOne(businessId: string, orderId: string): Promise<OrderView> {
    // id + businessId: another business's order is simply "not found".
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, businessId },
      include: orderInclude,
    });
    if (!order) throw this.notFound();
    return orderResponse(order);
  }

  /**
   * PENDING_APPROVAL -> IN_PROGRESS and take the stock of every line, in ONE
   * transaction: all of it happens, or none of it (the order stays pending).
   */
  async approve(
    businessId: string,
    orderId: string,
    userId: string,
  ): Promise<OrderView & { customerNotification: CustomerNotification }> {
    await this.prisma.$transaction(async (tx) => {
      // Only a pending order can move. Two taps at once: one wins, one gets 409.
      const moved = await tx.order.updateMany({
        where: { id: orderId, businessId, status: 'PENDING_APPROVAL' },
        data: {
          status: 'IN_PROGRESS',
          approvedAt: new Date(),
          approvedByUserId: userId,
        },
      });
      if (moved.count === 0)
        throw await this.whyNotPending(tx, businessId, orderId);
      const items = await tx.orderItem.findMany({
        where: { businessId, orderId },
        orderBy: { position: 'asc' },
      });
      for (const item of items)
        // InventoryService, inside OUR transaction. item.id makes it
        // idempotent: the same line is never taken twice. Not enough stock ->
        // 409 INVENTORY_INSUFFICIENT_STOCK and everything above is undone.
        await this.inventory.deductForOrder(
          tx,
          { businessId, productId: item.productId, id: item.variantId },
          item.quantity,
          item.id,
        );
    });
    // After the commit: the customer hears "confirmed" only when it is true.
    return this.tellCustomer(
      businessId,
      await this.getOne(businessId, orderId),
    );
  }

  /** PENDING_APPROVAL -> CANCELLED. Nothing was taken from stock yet. */
  async reject(
    businessId: string,
    orderId: string,
    reason?: string,
  ): Promise<OrderView & { customerNotification: CustomerNotification }> {
    const moved = await this.prisma.order.updateMany({
      where: { id: orderId, businessId, status: 'PENDING_APPROVAL' },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: reason ?? null,
      },
    });
    if (moved.count === 0)
      throw await this.whyNotPending(this.prisma, businessId, orderId);
    return this.tellCustomer(
      businessId,
      await this.getOne(businessId, orderId),
    );
  }

  /**
   * Sends the decision on WhatsApp. Never undoes it: if Meta refuses (for
   * example after the 24-hour window) the app just sees "FAILED".
   */
  private async tellCustomer(businessId: string, order: OrderView) {
    const message = await this.sender.send({
      businessId,
      conversationId: order.conversationId,
      senderType: 'OWNER',
      content: confirmationText(order),
      aiMeta: { intent: 'ORDER_STATUS', orderId: order.id, source: 'backend' },
    });
    const customerNotification: CustomerNotification =
      message.status === 'FAILED' || message.status === 'PENDING'
        ? message.status
        : 'SENT';
    return { ...order, customerNotification };
  }

  /** 404 if it is not this business's order, 409 if it already moved on. */
  private async whyNotPending(
    db: Prisma.TransactionClient,
    businessId: string,
    orderId: string,
  ): Promise<AppHttpException> {
    const order = await db.order.findFirst({
      where: { id: orderId, businessId },
      select: { status: true },
    });
    if (!order) return this.notFound();
    return new AppHttpException(
      ErrorCode.ORDER_NOT_PENDING,
      HttpStatus.CONFLICT,
      `The order is ${order.status}, not PENDING_APPROVAL`,
    );
  }

  private async findBySource(businessId: string, sourceMessageId: string) {
    const order = await this.prisma.order.findFirst({
      where: { businessId, sourceMessageId },
      include: orderInclude,
    });
    return order ? orderResponse(order) : null;
  }

  private notFound(): AppHttpException {
    return new AppHttpException(
      ErrorCode.ORDER_NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Order not found in this business',
    );
  }
}
