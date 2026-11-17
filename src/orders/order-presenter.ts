import { Prisma } from '../generated/prisma/client';

/** Every order answer includes its lines and the customer's basic data. */
export const orderInclude = {
  items: { orderBy: { position: 'asc' } },
  customer: { select: { id: true, phone: true, name: true } },
} satisfies Prisma.OrderInclude;

export type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

/** Money leaves the API as text with 2 decimals ("250.00"), like Products. */
export function orderResponse(order: OrderRow) {
  return {
    id: order.id,
    businessId: order.businessId,
    conversationId: order.conversationId,
    sourceMessageId: order.sourceMessageId,
    status: order.status,
    currency: order.currency,
    subtotal: order.subtotal.toFixed(2),
    total: order.total.toFixed(2),
    notes: order.notes,
    requiresReview: order.requiresReview,
    reviewReason: order.reviewReason,
    approvedAt: order.approvedAt,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    customer: order.customer,
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      productName: item.productName,
      selectedOptions: item.selectedOptions,
      unitPrice: item.unitPrice.toFixed(2),
      quantity: item.quantity,
      lineTotal: item.lineTotal.toFixed(2),
    })),
  };
}

export type OrderView = ReturnType<typeof orderResponse>;
