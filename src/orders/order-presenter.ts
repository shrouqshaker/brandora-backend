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

/** The WhatsApp text for the customer, built from the saved order (not the AI). */
export function confirmationText(order: OrderView): string {
  if (order.status === 'CANCELLED') {
    const reason = order.cancelReason ? `\nالسبب: ${order.cancelReason}` : '';
    return `للأسف مش هنقدر ننفذ طلبك المرة دي.${reason}`;
  }
  const lines = order.items.map((item) => {
    const options = Object.values(
      (item.selectedOptions ?? {}) as Record<string, string>,
    ).join(' / ');
    return `- ${item.productName}${options ? ` (${options})` : ''} × ${item.quantity}`;
  });
  return [
    'تم تأكيد طلبك ✅',
    ...lines,
    `الإجمالي: ${order.total} ${order.currency}`,
  ].join('\n');
}
